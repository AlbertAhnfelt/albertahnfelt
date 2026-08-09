/**
 * Letterboxd — the film diary.
 *
 * Over RSS, not the official API, and that is a decision rather than a
 * shortcut. Letterboxd's API is granted by application only, and they say
 * plainly what they will not grant it for: private or personal projects, and
 * LLM-related use. This is both. The per-member RSS feed is public, documented
 * on every profile page, and carries the whole diary entry — title, year,
 * rating, watched date, rewatch flag and the review text — so nothing is
 * actually lost by staying on the supported-for-this side of the line.
 *
 * The one real cost: the feed is a fixed window of the most recent entries, so
 * this connector can keep up with the present but cannot reach into the past.
 * Backfilling the back catalogue means Letterboxd's own CSV export, which is a
 * separate job and not one a cron can do.
 */

import { getText } from "./http";
import { cell, dayOf, plain, quote, table } from "./page";
import type { Connector, FetchResult, IndexInput, StoredEvent } from "./types";

/** Entries in a single feed. Letterboxd serves about 50; this is a sanity bound. */
const MAX_ITEMS = 200;

type Diary = {
  film: string;
  year: string;
  rating: number | null;
  rewatch: boolean;
  review: string;
  url: string;
};

/* -------------------------------------------------------------------- parsing */

/**
 * Pull one element's contents out of an item.
 *
 * A hand-written scanner rather than a parser, because Workers has no
 * DOMParser and this is a feed with a fixed, published shape — an XML library
 * would be a dependency bought to read six known element names. It is
 * deliberately narrow: it finds the first matching element, unwraps CDATA if
 * present, and understands nothing else. Anything it fails to find comes back
 * null and the caller decides whether that matters.
 */
function element(item: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, "i").exec(item);
  if (!match) return null;
  const raw = match[1];
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? cdata[1] : raw;
}

/**
 * When a diary entry happened, as epoch milliseconds.
 *
 * `letterboxd:watchedDate` is a bare `YYYY-MM-DD` with no time in it, so some
 * instant inside that day has to be chosen. Noon UTC is the one that cannot go
 * wrong: Stockholm is UTC+1 or +2, so noon UTC is early afternoon there and
 * lands on the same calendar day whichever side of a DST change it falls, which
 * is what keeps an entry on the month page its own date claims.
 */
function watchedAt(item: string): number | null {
  const watched = element(item, "letterboxd:watchedDate")?.trim();
  const match = watched ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(watched) : null;
  if (match) {
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  }

  // No watched date on a feed item means it is not a diary entry — but pubDate
  // is there for everything, and an entry we can place roughly beats one
  // dropped on the floor.
  const published = element(item, "pubDate")?.trim();
  const parsed = published ? Date.parse(published) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/** A rating out of five, in half-steps, or null when the entry carries none. */
function rating(item: string): number | null {
  const raw = element(item, "letterboxd:memberRating")?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
}

/** "★★★★" / "★★★½". Empty string for unrated, which reads better than "—" in a list. */
export function stars(value: number | null): string {
  if (value === null) return "";
  const full = Math.floor(value);
  return "★".repeat(full) + (value - full >= 0.5 ? "½" : "");
}

function parseFeed(xml: string): { id: string; at: number; diary: Diary }[] {
  const out: { id: string; at: number; diary: Diary }[] = [];

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    if (out.length >= MAX_ITEMS) break;
    const item = match[1];

    // The feed carries lists and plain reviews alongside diary entries. A film
    // title is what makes something a watch, so anything without one is skipped
    // rather than stored as an event with no shape.
    const film = element(item, "letterboxd:filmTitle");
    if (!film) continue;

    const at = watchedAt(item);
    if (at === null) continue;

    // guid is Letterboxd's own id for the entry and is what makes re-reading
    // the feed idempotent. Falling back to the link keeps an entry with a
    // malformed guid out of the duplicate business.
    const id = plain(element(item, "guid") ?? element(item, "link") ?? "", 200);
    if (!id) continue;

    out.push({
      id,
      at,
      diary: {
        film: plain(film),
        year: plain(element(item, "letterboxd:filmYear") ?? "", 8),
        rating: rating(item),
        rewatch: (element(item, "letterboxd:rewatch") ?? "").trim().toLowerCase() === "yes",
        // The description is HTML in CDATA: a poster image, then the review if
        // there is one. `quote` strips the markup, so an entry without a review
        // reduces to nothing and the section is dropped.
        review: quote(element(item, "description") ?? ""),
        url: plain(element(item, "link") ?? "", 300),
      },
    });
  }

  return out;
}

/* ------------------------------------------------------------------ rendering */

function asDiary(event: StoredEvent): Diary {
  const p = event.payload;
  return {
    film: typeof p.film === "string" ? p.film : "",
    year: typeof p.year === "string" ? p.year : "",
    rating: typeof p.rating === "number" ? p.rating : null,
    rewatch: p.rewatch === true,
    review: typeof p.review === "string" ? p.review : "",
    url: typeof p.url === "string" ? p.url : "",
  };
}

/**
 * A link only when the URL is one, and only to letterboxd.
 *
 * The URL came out of a feed, and markdown link syntax would happily carry a
 * `javascript:` scheme into a page. `markdown.ts` refuses to render one, so
 * this is the second of two locks rather than the only one — but a page in
 * Obsidian goes through neither, and Obsidian is where these are mostly read.
 */
function filmLink(diary: Diary): string {
  const label = cell(diary.film);
  try {
    const url = new URL(diary.url);
    if (url.protocol !== "https:" || !url.host.endsWith("letterboxd.com")) return label;
    return `[${label}](${url.href})`;
  } catch {
    return label;
  }
}

export const letterboxd: Connector = {
  source: "letterboxd",
  label: "Letterboxd",

  async check(env) {
    if (!env.LETTERBOXD_USERNAME) {
      return { configured: false, reason: "LETTERBOXD_USERNAME is not set" };
    }
    return true;
  },

  async fetch(env): Promise<FetchResult> {
    // Encoded, so a username with a slash in it cannot reach for another path.
    const url = `https://letterboxd.com/${encodeURIComponent(env.LETTERBOXD_USERNAME)}/rss/`;
    const items = parseFeed(await getText(url));

    return {
      events: items.map((item) => ({
        externalId: item.id,
        occurredAt: item.at,
        payload: { ...item.diary },
      })),
      // No cursor. The feed is a window, not a stream: it always returns the
      // same recent entries, and the primary key on connector_events is what
      // turns re-reading them into a no-op.
      cursor: null,
    };
  },

  renderMonth(month, events) {
    const entries = events.map((event) => ({ at: event.occurredAt, diary: asDiary(event) }));

    const rows = entries.map(({ at, diary }) => [
      cell(dayOf(at)),
      filmLink(diary),
      cell(diary.year, 8),
      stars(diary.rating) || "—",
      diary.rewatch ? "↻" : "",
    ]);

    const rated = entries.filter((e) => e.diary.rating !== null);
    const mean =
      rated.length > 0
        ? (rated.reduce((sum, e) => sum + (e.diary.rating ?? 0), 0) / rated.length).toFixed(2)
        : null;

    const parts = [
      `# Film — ${month}`,
      "",
      `${entries.length} ${entries.length === 1 ? "film" : "films"}` +
        (mean ? `, average ${mean}★ over ${rated.length} rated` : ""),
      "",
      table(["Date", "Film", "Year", "Rating", "Rewatch"], rows),
    ];

    const reviews = entries.filter((e) => e.diary.review);
    if (reviews.length > 0) {
      parts.push("", "## Reviews", "");
      for (const { at, diary } of reviews) {
        parts.push(`### ${plain(diary.film)} — ${dayOf(at)}`, "", diary.review, "");
      }
    }

    return parts.join("\n");
  },

  renderIndex(input: IndexInput) {
    const recent = input.recent.map((event) => {
      const diary = asDiary(event);
      return [
        cell(dayOf(event.occurredAt)),
        filmLink(diary),
        cell(diary.year, 8),
        stars(diary.rating) || "—",
      ];
    });

    return [
      "# Letterboxd",
      "",
      `${input.total} diary ${input.total === 1 ? "entry" : "entries"} across ` +
        `${input.months.length} ${input.months.length === 1 ? "month" : "months"}.`,
      "",
      "## Lately",
      "",
      table(["Date", "Film", "Year", "Rating"], recent),
      "",
      "## By month",
      "",
      // Not wikilinks. Every connector names its month pages the same way, so
      // `[[2026-08]]` is three different files and Obsidian resolves it by
      // basename to whichever it saw first — a link that silently points at the
      // wrong folder is worse than no link, and the pages sit in this one.
      table(
        ["Month", "Films"],
        input.months.map((m) => [m.month, String(m.count)]),
      ),
      "",
      "---",
      "",
      "Diary entries only, pulled from the public RSS feed, which carries roughly the",
      "last 50. Anything older than that window has to come from a Letterboxd CSV",
      "export rather than from this connector.",
    ].join("\n");
  },
};
