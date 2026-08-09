/**
 * Drives the connectors with canned responses, so the parsing and the text
 * neutralisation are exercised without credentials or network.
 * Temporary scaffolding — not part of the build.
 */

import { cell, dayOf, monthBounds, monthOf, plain, quote } from "../src/connectors/page";
import { letterboxd } from "../src/connectors/letterboxd";
import { chess, pgnFor } from "../src/connectors/chess";
import { isDataKey, isWritableKey } from "../src/vault";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(name: string, condition: boolean) {
  check(name, condition, true);
}

/* ------------------------------------------------------- text neutralisation */

console.log("\ntext:");
check("pipe is escaped for a table cell", cell("Fear|Loathing"), "Fear\\|Loathing");
check("backslash escaped before pipe", cell("a\\|b"), "a\\\\\\|b");
check("newlines cannot break a row", cell("two\nlines"), "two lines");
check("tabs collapse", plain("a\tb"), "a b");
check("html tags are removed", plain("<b>Sinners</b>"), "Sinners");
check("entities decode", plain("Tom &amp; Jerry"), "Tom & Jerry");
check(
  "double-encoded markup does not reassemble",
  plain("&#38;lt;script&#38;gt;"),
  "&lt;script&gt;",
);
check("empty cell shows a dash", cell(""), "—");
check("null is empty, not the string null", plain(null), "");
ok("long values are clipped", plain("x".repeat(500)).length <= 200);
ok("U+2028 is stripped", !plain("a\u2028b").includes("\u2028"));
ok("DEL is stripped", !plain("a\u007Fb").includes("\u007F"));
ok("NUL is stripped", !plain("a\u0000b").includes("\u0000"));

console.log("\nquote:");
check("prose becomes a blockquote", quote("<p>First</p><p>Second</p>"), "> First\n>\n> Second");
check(
  "a horizontal rule inside a review cannot escape the quote",
  quote("---\n# heading"),
  "> ---\n> # heading",
);
check("a poster-only description is empty", quote('<p><img src="x.jpg"/></p>'), "");

/* -------------------------------------------------------------- month maths */

console.log("\nmonths:");
check("month of an instant", monthOf(Date.UTC(2026, 7, 9, 10)), "2026-08");
check("day of an instant", dayOf(Date.UTC(2026, 7, 9, 10)), "2026-08-09");
const march = monthBounds("2026-03");
check(
  "March starts at 23:00 UTC on Feb 28",
  new Date(march.from).toISOString(),
  "2026-02-28T23:00:00.000Z",
);
check(
  "March ends at 22:00 UTC on Mar 31 (DST)",
  new Date(march.to).toISOString(),
  "2026-03-31T22:00:00.000Z",
);
check(
  "December rolls into January",
  new Date(monthBounds("2026-12").to).toISOString(),
  "2026-12-31T23:00:00.000Z",
);
check(
  "late-evening UTC is already the next Stockholm month",
  monthOf(Date.UTC(2026, 6, 31, 23, 30)),
  "2026-08",
);

/* -------------------------------------------------------------- write scopes */

console.log("\nscopes:");
ok("data/ pages are not tool-writable", !isWritableKey("data/chess/2026-08.md"));
ok("data/ md is a data key", isDataKey("data/chess/2026-08.md"));
ok("data/ pgn is a data key", isDataKey("data/chess/2026-08.pgn"));
ok("other extensions are refused", !isDataKey("data/chess/2026-08.js"));
ok("traversal is refused", !isDataKey("data/../wiki/index.md"));
ok("wiki is still tool-writable", isWritableKey("wiki/index.md"));

/* ------------------------------------------------------------------ fetching */

function stubFetch(routes: Record<string, string>) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    if (!key) throw new Error(`unstubbed fetch: ${url}`);
    return new Response(routes[key], { status: 200 });
  };
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:letterboxd="https://letterboxd.com" version="2.0"><channel>
<item>
<title>Sinners, 2025 - &#9733;&#9733;&#9733;&#9733;</title>
<link>https://letterboxd.com/albert/film/sinners/</link>
<guid isPermaLink="false">letterboxd-review-1</guid>
<letterboxd:watchedDate>2026-08-08</letterboxd:watchedDate>
<letterboxd:rewatch>No</letterboxd:rewatch>
<letterboxd:filmTitle>Sinners</letterboxd:filmTitle>
<letterboxd:filmYear>2025</letterboxd:filmYear>
<letterboxd:memberRating>4.0</letterboxd:memberRating>
<description><![CDATA[<p><img src="p.jpg"/></p> <p>Loved the &amp; ending.</p>]]></description>
</item>
<item>
<title>Kill|Bill, 2003</title>
<link>https://letterboxd.com/albert/film/kill-bill/</link>
<guid isPermaLink="false">letterboxd-watch-2</guid>
<letterboxd:watchedDate>2026-08-01</letterboxd:watchedDate>
<letterboxd:rewatch>Yes</letterboxd:rewatch>
<letterboxd:filmTitle>Kill|Bill</letterboxd:filmTitle>
<letterboxd:filmYear>2003</letterboxd:filmYear>
<letterboxd:memberRating>3.5</letterboxd:memberRating>
<description><![CDATA[<p><img src="p.jpg"/></p> <p>Watched on Saturday August 1, 2026.</p>]]></description>
</item>
<item>
<title>A list of things</title>
<link>https://letterboxd.com/albert/list/things/</link>
<guid isPermaLink="false">letterboxd-list-9</guid>
<letterboxd:listId>9</letterboxd:listId>
<description><![CDATA[<p>Not a film.</p>]]></description>
</item>
</channel></rss>`;

const asStored = (e: { externalId: string; occurredAt: number; payload: object }) => ({
  externalId: e.externalId,
  occurredAt: e.occurredAt,
  payload: e.payload as Record<string, unknown>,
});

console.log("\nletterboxd:");
stubFetch({ "https://letterboxd.com/": RSS });
const lb = await letterboxd.fetch({ LETTERBOXD_USERNAME: "albert" } as never, null);
check("lists are skipped, diary entries kept", lb.events.length, 2);
check("guid is the dedupe key", lb.events[0].externalId, "letterboxd-review-1");
check("watched date places the event", monthOf(lb.events[0].occurredAt), "2026-08");
check("review text survives as a quote", lb.events[0].payload.review, "> Loved the & ending.");
check("a bare watch keeps no auto-description as a review", lb.events[1].payload.review, "");
check("rewatch is read", lb.events[1].payload.rewatch, true);

const lbPage = letterboxd.renderMonth("2026-08", lb.events.map(asStored));
check("a row per film", (lbPage.match(/^\| 2026-08/gm) ?? []).length, 2);
ok("pipe in a title did not open a new column", lbPage.includes("Kill\\|Bill"));
ok("rating renders as stars", lbPage.includes("★★★★"));
ok("half star renders", lbPage.includes("★★★½"));
ok("the review is quoted in the page", lbPage.includes("> Loved the & ending."));

console.log("\nchess:");
const ARCHIVES = JSON.stringify({
  archives: [
    "https://api.chess.com/pub/player/albert/games/2026/07",
    "https://api.chess.com/pub/player/albert/games/2026/08",
  ],
});
const GAMES = JSON.stringify({
  games: [
    {
      url: "https://www.chess.com/game/live/1",
      pgn: '[Event "Live Chess"]\n\n1. e4 e5 1-0',
      end_time: Math.floor(Date.UTC(2026, 7, 5, 12) / 1000),
      rated: true,
      time_class: "blitz",
      eco: "https://www.chess.com/openings/Kings-Pawn-Opening",
      white: { username: "Albert", rating: 1200, result: "win" },
      black: { username: "ev|il", rating: 1180, result: "resigned" },
    },
    {
      url: "https://www.chess.com/game/live/2",
      pgn: '[Event "Live Chess"]\n\n1. d4 d5 1/2-1/2',
      end_time: Math.floor(Date.UTC(2026, 7, 6, 12) / 1000),
      time_class: "rapid",
      white: { username: "someone", rating: 1300, result: "agreed" },
      black: { username: "albert", rating: 1210, result: "agreed" },
    },
  ],
});
stubFetch({
  "https://api.chess.com/pub/player/albert/games/archives": ARCHIVES,
  "https://api.chess.com/pub/player/albert/games/": GAMES,
});
const ch = await chess.fetch({ CHESS_USERNAME: "Albert" } as never, null);
check("both archives were read", ch.events.length, 4);
check("cursor is the newest archive month", ch.cursor, "2026-08");
check("my colour is detected case-insensitively", ch.events[0].payload.colour, "white");
check("opponent is the other side", ch.events[0].payload.opponent, "ev|il");
check("a win is a win", ch.events[0].payload.outcome, "win");
check("opening name comes out of the eco url", ch.events[0].payload.eco, "Kings Pawn Opening");
check("playing black is detected", ch.events[1].payload.colour, "black");
check("agreed is a draw", ch.events[1].payload.outcome, "draw");

const chEvents = ch.events.slice(0, 2).map(asStored);
const chPage = chess.renderMonth("2026-08", chEvents);
ok("opponent pipe is escaped in the table", chPage.includes("ev\\|il"));
ok("tally is rendered", chPage.includes("1W / 1D / 0L"));
check("pgn concatenates both games", pgnFor(chEvents).split("[Event").length, 3);

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
if (failures > 0) throw new Error(`${failures} smoke check(s) failed`);
