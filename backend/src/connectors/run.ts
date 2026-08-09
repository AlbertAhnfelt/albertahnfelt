/**
 * The nightly connector run.
 *
 * The same shape as `sweep.ts`, and for the same reason: something happens on a
 * schedule with nobody watching, so the interesting design is all in what
 * happens when it goes wrong. One connector failing must not take the others
 * with it, a failure must be visible tomorrow morning rather than in November,
 * and a run that dies halfway must leave the next one able to pick up rather
 * than a hole nothing will ever go back for.
 *
 * The ordering that makes the last of those work: events are written to D1
 * first, pages are rendered from D1 second, and the cursor moves last. Every
 * step is therefore safe to repeat. A crash after the insert re-fetches the
 * same window tomorrow and the primary key discards it; a crash before the
 * cursor moves does the same. Nothing is ever marked as done before it is.
 */

import { chess, pgnFor } from "./chess";
import { letterboxd } from "./letterboxd";
import {
  eventsBetween,
  indexInput,
  insertEvents,
  readAllState,
  readState,
  recordRun,
} from "./store";
import { isMonth, monthBounds, monthOf, writeDataFile, writeDataPage } from "./page";
import { strava } from "./strava";
import type { Connector } from "./types";
import { DATA_PREFIX, vaultDate } from "../vault";

export const CONNECTORS: Connector[] = [letterboxd, chess, strava];

export const CONNECTORS_BY_SOURCE = new Map(CONNECTORS.map((c) => [c.source, c]));

/**
 * Month pages rebuilt in one run.
 *
 * A first run with years of history would otherwise render every month it ever
 * touched in one invocation. The months are taken newest-first, so a capped run
 * always produces the pages someone is most likely to open, and the rest follow
 * on subsequent nights as the backfill walks on.
 */
const MAX_MONTHS_PER_RUN = 24;

export type RunReport = {
  source: string;
  outcome: "ok" | "failed" | "skipped";
  newEvents?: number;
  pagesWritten?: number;
  detail?: string;
};

/** Guard for anything that becomes part of a key. Sources are ours, months are derived. */
function dataKey(source: string, name: string): string {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(source)) {
    throw new Error(`unusable connector source name: ${source}`);
  }
  return `${DATA_PREFIX}${source}/${name}`;
}

/**
 * Rebuild every page a connector owns for the months it just touched, plus its
 * index.
 *
 * Rendered from D1 rather than from what the fetch returned, which is what
 * makes a page the whole month rather than the part of it that happened to be
 * in this run's window.
 */
async function renderPages(
  env: Cloudflare.Env,
  connector: Connector,
  months: string[],
): Promise<number> {
  let written = 0;

  const wanted = months.filter(isMonth).sort().reverse().slice(0, MAX_MONTHS_PER_RUN);

  for (const month of wanted) {
    const events = await eventsBetween(env.DB, connector.source, monthBounds(month));
    if (events.length === 0) continue;

    const outcome = await writeDataPage(
      env.VAULT,
      dataKey(connector.source, `${month}.md`),
      { source: connector.source, month, date: vaultDate() },
      connector.renderMonth(month, events),
    );
    if (outcome === "written") written++;

    // The chess connector is the only one with an archive format worth keeping
    // beside the page. Asking the module rather than the Connector interface
    // keeps a one-source concern out of all three.
    if (connector.source === chess.source) {
      const pgn = pgnFor(events);
      if (pgn) {
        const result = await writeDataFile(
          env.VAULT,
          dataKey(connector.source, `${month}.pgn`),
          "application/x-chess-pgn; charset=utf-8",
          pgn,
        );
        if (result === "written") written++;
      }
    }
  }

  const index = await indexInput(env.DB, connector.source, monthOf);
  if (index.total > 0) {
    const outcome = await writeDataPage(
      env.VAULT,
      dataKey(connector.source, "index.md"),
      { source: connector.source, date: vaultDate() },
      connector.renderIndex(index),
    );
    if (outcome === "written") written++;
  }

  return written;
}

/** One connector, start to finish. Never throws. */
async function runOne(env: Cloudflare.Env, connector: Connector): Promise<RunReport> {
  const configured = await connector.check(env);
  if (configured !== true) {
    // Not written to connector_state: a connector nobody has set up yet has no
    // run history, and recording a "failure" for it would put a red mark on the
    // status page for something that is merely not switched on.
    return { source: connector.source, outcome: "skipped", detail: configured.reason };
  }

  try {
    const state = await readState(env.DB, connector.source);
    const { events, cursor } = await connector.fetch(env, state?.cursor ?? null);

    const newEvents = await insertEvents(env.DB, connector.source, events);

    // Every month the fetch touched, whether or not the event was new. A run
    // that finds nothing new still re-renders, which is what lets a page fix
    // itself after a bad deploy without waiting for new activity.
    const months = [...new Set(events.map((event) => monthOf(event.occurredAt)))];
    const pagesWritten = await renderPages(env, connector, months);

    // Last, and only now. Everything above is safe to repeat; this is the step
    // that says it does not have to be.
    await recordRun(env.DB, connector.source, { ok: true, cursor, newEvents });

    return { source: connector.source, outcome: "ok", newEvents, pagesWritten };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unexpected error";
    await recordRun(env.DB, connector.source, { ok: false, error: detail });
    console.error(`connectors: ${connector.source} failed — ${detail}`);
    return { source: connector.source, outcome: "failed", detail };
  }
}

/**
 * One pass over every connector. Called from the Worker's `scheduled` handler.
 *
 * Sequential, like the sweep. Three concurrent runs would each be waiting on a
 * different third party and would finish sooner, but they also share a D1
 * database and an R2 bucket, and the wall-clock saving on a nightly job that
 * takes seconds is not worth reasoning about interleaved failure for.
 */
export async function runConnectors(
  env: Cloudflare.Env,
  only?: string[],
): Promise<RunReport[]> {
  const chosen = only?.length
    ? CONNECTORS.filter((connector) => only.includes(connector.source))
    : CONNECTORS;

  const reports: RunReport[] = [];
  for (const connector of chosen) {
    reports.push(await runOne(env, connector));
  }

  const summary = reports
    .map((report) =>
      report.outcome === "ok"
        ? `${report.source}: +${report.newEvents} (${report.pagesWritten} pages)`
        : `${report.source}: ${report.outcome}`,
    )
    .join(", ");
  console.log(`connectors: ${summary}`);

  return reports;
}

/** Status of every connector, for the /web/connectors endpoint. */
export async function connectorStatus(env: Cloudflare.Env) {
  const state = new Map((await readAllState(env.DB)).map((row) => [row.source, row]));

  return Promise.all(
    CONNECTORS.map(async (connector) => {
      const configured = await connector.check(env);
      const row = state.get(connector.source);
      return {
        source: connector.source,
        label: connector.label,
        configured: configured === true,
        reason: configured === true ? null : configured.reason,
        lastRunAt: row?.last_run_at ?? null,
        lastOkAt: row?.last_ok_at ?? null,
        lastError: row?.last_error ?? null,
        consecutiveFailures: row?.consecutive_failures ?? 0,
        lastNewEvents: row?.last_new_events ?? 0,
      };
    }),
  );
}
