/**
 * Chess.com — every game, and the PGN to go with it.
 *
 * The published-data API needs no key, no login and no registration; it only
 * insists on a descriptive User-Agent, which `http.ts` sends. Games are served
 * as monthly archives, which happens to be exactly the shape the vault pages
 * want, so this connector is mostly bookkeeping about which archives it has
 * already read.
 *
 * It also writes the month's PGN alongside the markdown, as `<month>.pgn`. That
 * is the part Albert actually asked for — the games themselves, in the vault,
 * in the format every chess tool in the world already opens — and it is why
 * data/ allows one non-markdown extension.
 */

import { getJson } from "./http";
import { cell, dayOf, isMonth, plain, table, timeOf } from "./page";
import type { Connector, FetchResult, IndexInput, RawEvent, StoredEvent } from "./types";

/**
 * Monthly archives fetched per run.
 *
 * The first run has the whole history to get through and every archive is a
 * request; a cap turns "ten years of chess" into a backfill that finishes over
 * a few nights instead of one invocation that runs out of time and stores
 * nothing. Steady state is one archive a run — the current month — so this only
 * ever bites while catching up.
 */
const MAX_ARCHIVES_PER_RUN = 12;

/** Results that are draws. Everything else that is not "win" is a loss. */
const DRAWS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

type Outcome = "win" | "draw" | "loss";

type Side = { username?: string; rating?: number; result?: string };

type ApiGame = {
  url?: string;
  pgn?: string;
  end_time?: number;
  rated?: boolean;
  time_class?: string;
  time_control?: string;
  rules?: string;
  eco?: string;
  white?: Side;
  black?: Side;
};

type Game = {
  colour: "white" | "black";
  opponent: string;
  myRating: number | null;
  theirRating: number | null;
  outcome: Outcome;
  reason: string;
  timeClass: string;
  rated: boolean;
  eco: string;
  url: string;
  pgn: string;
};

function outcomeOf(result: string | undefined): Outcome {
  if (result === "win") return "win";
  return DRAWS.has(result ?? "") ? "draw" : "loss";
}

/** The ECO opening name, which chess.com gives as a URL rather than a string. */
function openingFrom(eco: string | undefined): string {
  if (!eco) return "";
  try {
    const last = new URL(eco).pathname.split("/").filter(Boolean).pop() ?? "";
    return plain(decodeURIComponent(last).replace(/-/g, " "), 80);
  } catch {
    return plain(eco, 80);
  }
}

/**
 * Turn one archive entry into an event.
 *
 * Returns null for anything without the two fields that make a game a game
 * here: a url to key it by, and an end time to file it under.
 */
function toEvent(game: ApiGame, username: string): RawEvent | null {
  const url = typeof game.url === "string" ? game.url : "";
  const endTime = typeof game.end_time === "number" ? game.end_time : 0;
  if (!url || !endTime) return null;

  const me = username.toLowerCase();
  const whiteName = (game.white?.username ?? "").toLowerCase();
  // Whichever side is not Albert is the opponent. If neither matches — an
  // archive belonging to someone else, which should not happen — white is
  // assumed, and the page will show it as such rather than silently claiming a
  // result that is not his.
  const colour: "white" | "black" = whiteName === me ? "white" : "black";
  const mine = colour === "white" ? game.white : game.black;
  const theirs = colour === "white" ? game.black : game.white;

  const payload: Game = {
    colour,
    opponent: plain(theirs?.username ?? "", 60),
    myRating: typeof mine?.rating === "number" ? mine.rating : null,
    theirRating: typeof theirs?.rating === "number" ? theirs.rating : null,
    outcome: outcomeOf(mine?.result),
    reason: plain(mine?.result ?? "", 40),
    timeClass: plain(game.time_class ?? "", 20),
    rated: game.rated !== false,
    eco: openingFrom(game.eco),
    url: plain(url, 300),
    // Kept whole. It is the one field here that is worth more than the summary
    // around it, and it is what `<month>.pgn` is rebuilt from.
    pgn: typeof game.pgn === "string" ? game.pgn : "",
  };

  return { externalId: url, occurredAt: endTime * 1000, payload: { ...payload } };
}

/** "https://api.chess.com/pub/player/x/games/2026/08" → "2026-08". */
function monthFromArchiveUrl(url: string): string | null {
  const match = /\/games\/(\d{4})\/(\d{2})\/?$/.exec(url);
  const month = match ? `${match[1]}-${match[2]}` : null;
  return month && isMonth(month) ? month : null;
}

function asGame(event: StoredEvent): Game {
  const p = event.payload;
  const outcome = p.outcome;
  return {
    colour: p.colour === "black" ? "black" : "white",
    opponent: typeof p.opponent === "string" ? p.opponent : "",
    myRating: typeof p.myRating === "number" ? p.myRating : null,
    theirRating: typeof p.theirRating === "number" ? p.theirRating : null,
    outcome: outcome === "win" || outcome === "draw" || outcome === "loss" ? outcome : "loss",
    reason: typeof p.reason === "string" ? p.reason : "",
    timeClass: typeof p.timeClass === "string" ? p.timeClass : "",
    rated: p.rated === true,
    eco: typeof p.eco === "string" ? p.eco : "",
    url: typeof p.url === "string" ? p.url : "",
    pgn: typeof p.pgn === "string" ? p.pgn : "",
  };
}

const SYMBOL: Record<Outcome, string> = { win: "1", draw: "½", loss: "0" };

/** A link only to chess.com over https; anything else stays as plain text. */
function gameLink(game: Game, label: string): string {
  try {
    const url = new URL(game.url);
    if (url.protocol !== "https:" || !url.host.endsWith("chess.com")) return label;
    return `[${label}](${url.href})`;
  } catch {
    return label;
  }
}

function tally(games: Game[]): { wins: number; draws: number; losses: number } {
  return {
    wins: games.filter((g) => g.outcome === "win").length,
    draws: games.filter((g) => g.outcome === "draw").length,
    losses: games.filter((g) => g.outcome === "loss").length,
  };
}

export const chess: Connector = {
  source: "chess",
  label: "Chess.com",

  async check(env) {
    if (!env.CHESS_USERNAME) return { configured: false, reason: "CHESS_USERNAME is not set" };
    return true;
  },

  async fetch(env, cursor): Promise<FetchResult> {
    const user = encodeURIComponent(env.CHESS_USERNAME.toLowerCase());
    const { archives } = await getJson<{ archives?: string[] }>(
      `https://api.chess.com/pub/player/${user}/games/archives`,
    );

    // Ascending, which is also the order the API returns them in — but the
    // backfill's correctness depends on it, so it is not left to chance.
    const all = (archives ?? []).filter((url) => monthFromArchiveUrl(url) !== null).sort();
    if (all.length === 0) return { events: [], cursor: null };

    const latest = all[all.length - 1];

    // Everything after the last archive this connector finished, plus the
    // current month unconditionally — that one is never "finished" while the
    // month is still going, and re-reading it is what picks up today's games.
    const after = cursor ? all.filter((url) => (monthFromArchiveUrl(url) ?? "") > cursor) : all;
    const todo = [...new Set([...after.slice(0, MAX_ARCHIVES_PER_RUN), latest])].sort();

    const events: RawEvent[] = [];
    let furthest = cursor ?? "";

    for (const url of todo) {
      const { games } = await getJson<{ games?: ApiGame[] }>(url);
      for (const game of games ?? []) {
        const event = toEvent(game, env.CHESS_USERNAME);
        if (event) events.push(event);
      }
      const month = monthFromArchiveUrl(url);
      if (month && month > furthest) furthest = month;
    }

    return { events, cursor: furthest || null };
  },

  renderMonth(month, events) {
    const games = events.map((event) => ({ at: event.occurredAt, game: asGame(event) }));
    const { wins, draws, losses } = tally(games.map((g) => g.game));

    const rows = games.map(({ at, game }) => [
      cell(`${dayOf(at)} ${timeOf(at)}`),
      SYMBOL[game.outcome],
      game.colour === "white" ? "□" : "■",
      gameLink(game, cell(game.opponent)),
      cell(game.theirRating ?? "—", 8),
      cell(game.myRating ?? "—", 8),
      cell(game.timeClass, 16),
      cell(game.eco, 60),
    ]);

    return [
      `# Chess — ${month}`,
      "",
      `${games.length} ${games.length === 1 ? "game" : "games"} — ` +
        `${wins}W / ${draws}D / ${losses}L`,
      "",
      table(
        ["When", "", "Colour", "Opponent", "Their", "Mine", "Time", "Opening"],
        rows,
      ),
      "",
      `Full move lists for this month are in \`${month}.pgn\`, next to this page.`,
    ].join("\n");
  },

  renderIndex(input: IndexInput) {
    const recent = input.recent.map((event) => {
      const game = asGame(event);
      return [
        cell(dayOf(event.occurredAt)),
        SYMBOL[game.outcome],
        gameLink(game, cell(game.opponent)),
        cell(game.myRating ?? "—", 8),
        cell(game.timeClass, 16),
      ];
    });

    return [
      "# Chess.com",
      "",
      `${input.total} ${input.total === 1 ? "game" : "games"} across ` +
        `${input.months.length} ${input.months.length === 1 ? "month" : "months"}.`,
      "",
      "## Lately",
      "",
      table(["Date", "", "Opponent", "Rating", "Time"], recent),
      "",
      "## By month",
      "",
      table(
        ["Month", "Games"],
        input.months.map((m) => [m.month, String(m.count)]),
      ),
      "",
      "---",
      "",
      "Every game also exists as a PGN file per month in this folder, which is the",
      "archive proper — this page is a way in, not the record.",
    ].join("\n");
  },
};

/**
 * The month's games as one PGN file.
 *
 * Concatenated with blank lines between, which is the standard way to put more
 * than one game in a `.pgn` and what every reader expects. Chess.com's PGN
 * already carries the tag pairs, so nothing is added or rewritten here — this
 * is a transcription, and a PGN that has been "helped" is worse than one that
 * has not.
 */
export function pgnFor(events: StoredEvent[]): string {
  const games = events
    .map((event) => asGame(event).pgn.trim())
    .filter(Boolean);
  return games.length === 0 ? "" : `${games.join("\n\n")}\n`;
}
