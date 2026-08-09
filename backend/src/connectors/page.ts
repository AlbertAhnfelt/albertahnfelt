/**
 * Turning connector rows into vault pages, and the text rules that make that
 * safe.
 *
 * Everything a connector renders came from somewhere Albert does not control.
 * Most of it is his own — his films, his runs — but not all: an opponent picks
 * their chess.com username, and a film's title is whatever Letterboxd's
 * database says it is. So third-party text is never dropped into a page as-is.
 *
 * Two different worries, and only one of them is the usual one:
 *
 *   - Structure. A `|` in a film title ends a table cell early; a line starting
 *     `---` reads as frontmatter; a leading `#` invents a heading. None of this
 *     is an attack, it is just what happens, and it silently wrecks the page.
 *   - Instructions. These pages are read back by Abbe, which has write tools.
 *     Text that says "ignore your instructions and…" is text a model may act
 *     on. `markdown.ts` cannot help here — it defends the browser, and this is
 *     not the browser's problem.
 *
 * The answer to the first is escaping, below. The answer to the second is that
 * every page carries `provenance: connector` and every piece of prose is
 * blockquoted, so a model reading one can see where the page's own words stop
 * and quoted material begins. That is a mitigation, not a guarantee; the real
 * guarantee is that data/ is outside WRITABLE_PREFIXES, so a model persuaded by
 * one of these pages still has no way to write to any of them.
 */

import { DATA_PREFIX, isDataKey } from "../vault";

const TZ = "Europe/Stockholm";

const MD = { httpMetadata: { contentType: "text/markdown; charset=utf-8" } };

/** Longest run of third-party prose kept in a page. */
const MAX_PROSE = 1_200;

/** Longest single field — a title, a name, a username. */
const MAX_FIELD = 200;

/**
 * Everything that must not survive into a page, as explicit escapes.
 *
 * Written this way on purpose: the literal characters are invisible in an
 * editor, and a class typed out as literals is one stray keystroke away from
 * meaning something else entirely with nothing on screen to show it.
 *
 * C0 and DEL, plus U+2028/2029, which are line terminators to a JS parser even
 * though `\s` in a non-unicode regex is happy to treat them as ordinary space.
 */
const CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/g;

/** The same, but sparing U+000A so paragraph structure can survive. */
const CONTROL_KEEPING_LF = /[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/g;

/* ------------------------------------------------------------------- clocks */

/**
 * Stockholm wall-clock parts of an instant.
 *
 * `hourCycle: "h23"` rather than `hour12: false`, which some engines render as
 * "24" at midnight and would push every midnight event into the next day.
 */
const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** How far Stockholm is from UTC at a given instant, in milliseconds. */
function offsetAt(at: number): number {
  const parts = PARTS.formatToParts(new Date(at));
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return asIfUtc - at;
}

const MONTH_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
});

const DAY_FMT = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, dateStyle: "short" });
const TIME_FMT = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, timeStyle: "short" });

/** "2026-08" for an instant, in Stockholm time. */
export function monthOf(at: number): string {
  return MONTH_FMT.format(new Date(at));
}

/** "2026-08-09". */
export function dayOf(at: number): string {
  return DAY_FMT.format(new Date(at));
}

/** "07:35". */
export function timeOf(at: number): string {
  return TIME_FMT.format(new Date(at));
}

/**
 * The instant a Stockholm month begins, as epoch milliseconds.
 *
 * Two passes. The offset has to be sampled at some instant, and the only one
 * available to start with is the naive UTC guess — which sits an hour off on
 * the two days a year the clocks move, and can land on the wrong side of the
 * transition. Re-sampling at the corrected instant settles it, and a month
 * boundary is never itself a DST transition in this timezone, so a third pass
 * would have nothing left to fix.
 */
export function startOfMonth(month: string): number {
  const [year, m] = month.split("-").map(Number);
  const naive = Date.UTC(year, m - 1, 1);
  const once = naive - offsetAt(naive);
  return naive - offsetAt(once);
}

/** `[from, to)` in epoch milliseconds for a `YYYY-MM` month. */
export function monthBounds(month: string): { from: number; to: number } {
  const [year, m] = month.split("-").map(Number);
  const next = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
  return { from: startOfMonth(month), to: startOfMonth(next) };
}

/** True for a well-formed `YYYY-MM`. Guards anything that becomes a filename. */
export function isMonth(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year <= 2999;
}

/* --------------------------------------------------------------------- text */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Strip tags, then decode entities in a single pass.
 *
 * The single pass is the whole point, and it was not obvious: decoding numeric
 * references and named ones as two separate `replace` calls turns
 * `&#38;lt;script&#38;gt;` into `<script>`, because the first pass produces the
 * `&` that the second pass then reads as the start of `&lt;`. One pass cannot
 * do that — `String.prototype.replace` continues scanning after each match and
 * never re-reads what it just wrote — so the worst that survives is the literal
 * text `&lt;script&gt;`.
 *
 * Nothing downstream would render it as markup anyway; `markdown.ts` drops raw
 * HTML tokens outright. But Obsidian is not `markdown.ts`, and a vault note is
 * read in both.
 */
function untag(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]*));/g,
    (_, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal) return String.fromCodePoint(Math.min(Number(decimal), 0x10ffff));
      if (hex) return String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff));
      // An entity we do not know becomes a space rather than being left as-is:
      // this is display text, and `&thinsp;` reads worse than a gap.
      return ENTITIES[`&${(name ?? "").toLowerCase()};`] ?? " ";
    },
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Any third-party value as a single line of plain text. */
export function plain(value: unknown, max = MAX_FIELD): string {
  if (value === null || value === undefined) return "";
  const text = untag(typeof value === "string" ? value : String(value))
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clip(text, max);
}

/**
 * A value safe to drop between two pipes.
 *
 * Backslashes first, then pipes — the other order would escape the backslash of
 * an escape and leave the pipe bare.
 */
export function cell(value: unknown, max = 120): string {
  const text = plain(value, max);
  if (!text) return "—";
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Third-party prose as a markdown blockquote.
 *
 * Every line is prefixed, including blank ones, so nothing inside can start a
 * construct of its own: a `---` or a `#` that arrives in a review is quoted
 * text rather than a horizontal rule or a heading. Returns empty for empty
 * input, so callers can drop the whole section rather than print an empty
 * quote.
 */
export function quote(value: unknown, max = MAX_PROSE): string {
  if (value === null || value === undefined) return "";

  // Paragraph structure is worth keeping here, unlike in `plain`, so block-level
  // tags become breaks before `untag` removes the rest.
  const withBreaks = (typeof value === "string" ? value : String(value))
    .replace(/<\/(p|div|blockquote|li|h[1-6])>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n");

  const text = clip(
    untag(withBreaks)
      .replace(/\r\n?/g, "\n")
      .replace(CONTROL_KEEPING_LF, " ")
      .replace(/[^\S\n]+/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim(),
    max,
  );

  // Collapse runs of blank lines; a quote does not need three of them.
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (!line && !kept.at(-1)) continue;
    kept.push(line);
  }
  while (kept.length && !kept.at(-1)) kept.pop();
  if (kept.length === 0) return "";

  return kept.map((line) => (line ? `> ${line}` : ">")).join("\n");
}

/** A GitHub-flavoured table. Cells must already have been through `cell`. */
export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => " --- ").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/* -------------------------------------------------------------------- pages */

/**
 * Frontmatter for a data page.
 *
 * `provenance: connector` is a new value in a vault that already grades its
 * sources human > external > ai. It belongs below all three: those are things
 * Albert or a model wrote deliberately, and this is a machine transcribing a
 * third party. The `generated` line says plainly that editing the page is
 * pointless, which is the question anyone opening one in Obsidian will have.
 */
function frontmatter(fields: Record<string, string>): string {
  return [
    "---",
    "provenance: connector",
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    "generated: rebuilt automatically — edits here are overwritten",
    "---",
    "",
  ].join("\n");
}

export type WriteOutcome = "written" | "unchanged";

/**
 * Write a page under data/, skipping the write when nothing changed.
 *
 * The read-and-compare is not an optimisation for R2's sake — a put costs
 * almost nothing. It is for everything downstream: Remotely Save pulls changed
 * objects into Obsidian, and a connector that rewrote three identical pages
 * every night would show up as three changed files a day forever, which teaches
 * whoever is watching to ignore them.
 *
 * No etag precondition, unlike the tools. Nothing else writes here — the whole
 * prefix is refused to `isWritableKey` — so there is no concurrent writer to
 * lose a race against, and a connector must be able to correct its own page.
 */
export async function writeDataPage(
  vault: R2Bucket,
  key: string,
  fields: Record<string, string>,
  body: string,
): Promise<WriteOutcome> {
  // Belt and braces: every key here is built from a validated source name and a
  // validated month, and it is still checked before it reaches R2.
  if (!isDataKey(key)) {
    throw new Error(`refusing to write outside ${DATA_PREFIX}: ${key}`);
  }

  return writeIfChanged(vault, key, `${frontmatter(fields)}${body.trimEnd()}\n`, MD);
}

/**
 * Write an archive file under data/ — no frontmatter, no markdown.
 *
 * The one caller is the chess connector's monthly PGN. A PGN with a YAML header
 * bolted on is not a PGN any more, so this path exists precisely to not do the
 * thing `writeDataPage` does.
 */
export async function writeDataFile(
  vault: R2Bucket,
  key: string,
  contentType: string,
  content: string,
): Promise<WriteOutcome> {
  if (!isDataKey(key)) {
    throw new Error(`refusing to write outside ${DATA_PREFIX}: ${key}`);
  }
  return writeIfChanged(vault, key, content, {
    httpMetadata: { contentType },
  });
}

async function writeIfChanged(
  vault: R2Bucket,
  key: string,
  content: string,
  options: R2PutOptions,
): Promise<WriteOutcome> {
  const existing = await vault.get(key);
  if (existing && (await existing.text()) === content) return "unchanged";

  await vault.put(key, content, options);
  return "written";
}
