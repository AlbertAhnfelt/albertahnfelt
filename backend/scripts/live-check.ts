/**
 * Runs the connectors against real, already-downloaded responses and prints the
 * pages they would write. Temporary — a way to look at the output before a
 * single byte reaches the vault.
 *
 *   curl -s https://letterboxd.com/<user>/rss/ -o /tmp/lb.xml
 *   curl -s -H 'user-agent: ...' .../games/archives -o /tmp/arch.json
 *   curl -s -H 'user-agent: ...' .../games/YYYY/MM -o /tmp/games.json
 *   npm run live
 */

import { readFileSync } from "node:fs";
import { chess, pgnFor } from "../src/connectors/chess";
import { letterboxd } from "../src/connectors/letterboxd";
import { monthOf } from "../src/connectors/page";

const rss = readFileSync("/tmp/lb.xml", "utf8");
const archives = readFileSync("/tmp/arch.json", "utf8");
const games = readFileSync("/tmp/games.json", "utf8");

function stub(routes: Record<string, string>) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    if (!key) throw new Error(`unstubbed: ${url}`);
    return new Response(routes[key], { status: 200 });
  };
}

const asStored = (e: { externalId: string; occurredAt: number; payload: object }) => ({
  externalId: e.externalId,
  occurredAt: e.occurredAt,
  payload: e.payload as Record<string, unknown>,
});

const byMonth = (events: ReturnType<typeof asStored>[]) => {
  const groups = new Map<string, ReturnType<typeof asStored>[]>();
  for (const event of events) {
    const month = monthOf(event.occurredAt);
    groups.set(month, [...(groups.get(month) ?? []), event]);
  }
  return groups;
};

stub({ "https://letterboxd.com/": rss });
const lb = (await letterboxd.fetch({ LETTERBOXD_USERNAME: "albertahnfelt" } as never, null)).events.map(
  asStored,
);
console.log(`\n=== LETTERBOXD: ${lb.length} diary entries ===`);
const lbMonths = byMonth(lb);
console.log(`months: ${[...lbMonths.keys()].sort().join(", ")}\n`);
const newestLb = [...lbMonths.keys()].sort().reverse()[0];
console.log(letterboxd.renderMonth(newestLb, lbMonths.get(newestLb)!));

stub({
  "https://api.chess.com/pub/player/garlicninja/games/archives": archives,
  "https://api.chess.com/pub/player/garlicninja/games/": games,
});
// Cursor set to the month before the archive we downloaded, so only that one is
// requested — the stub returns the same body for every archive URL.
const ch = (await chess.fetch({ CHESS_USERNAME: "garlicninja" } as never, "2026-07")).events.map(
  asStored,
);
console.log(`\n\n=== CHESS: ${ch.length} games ===`);
const chMonths = byMonth(ch);
const newestCh = [...chMonths.keys()].sort().reverse()[0];
console.log(chess.renderMonth(newestCh, chMonths.get(newestCh)!));
console.log(`\n--- ${newestCh}.pgn would be ${pgnFor(chMonths.get(newestCh)!).length} bytes ---`);
