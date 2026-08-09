/**
 * The connectors' half of D1 — the only file here that speaks SQL.
 *
 * Same rules as `chats.ts`: prepared statements with .bind() throughout, and
 * nothing is ever interpolated into a query string. That matters more here than
 * it does there, because most of what these tables hold arrived over the network
 * from somewhere Albert does not control — a film title, an opponent's chosen
 * username, whatever someone named their morning run.
 */

import type { IndexInput, RawEvent, StoredEvent } from "./types";

/**
 * Statements per D1 batch. Batches are atomic, so this is also the unit that
 * either lands or doesn't; a backfill of a few thousand games becomes a few
 * dozen of these rather than one statement that has to be perfect.
 */
const INSERT_CHUNK = 50;

/** How many events the index page's "lately" section reads back. */
export const RECENT_LIMIT = 25;

export type ConnectorState = {
  source: string;
  cursor: string | null;
  last_run_at: number | null;
  last_ok_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  last_new_events: number;
};

/** Longest error text kept. Enough to recognise, not enough to fill a page. */
const MAX_ERROR_CHARS = 500;

/* -------------------------------------------------------------------- state */

export async function readState(
  db: D1Database,
  source: string,
): Promise<ConnectorState | null> {
  return db
    .prepare(
      `SELECT source, cursor, last_run_at, last_ok_at, last_error,
              consecutive_failures, last_new_events
         FROM connector_state WHERE source = ?1`,
    )
    .bind(source)
    .first<ConnectorState>();
}

export async function readAllState(db: D1Database): Promise<ConnectorState[]> {
  const { results } = await db
    .prepare(
      `SELECT source, cursor, last_run_at, last_ok_at, last_error,
              consecutive_failures, last_new_events
         FROM connector_state ORDER BY source`,
    )
    .all<ConnectorState>();
  return results;
}

/**
 * Record that a run happened and how it went.
 *
 * One upsert for both outcomes, because the columns that must move together
 * are the ones that would drift if success and failure were written by
 * different statements: a success has to clear `last_error` and reset the
 * failure count, and a failure must leave `cursor` and `last_ok_at` exactly
 * where they were. Doing that in one place is what keeps "last succeeded"
 * honest.
 *
 * `cursor` is only overwritten when a run supplies one — a failed run passes
 * undefined and the stored value survives, so tomorrow resumes from the last
 * point that actually worked rather than from the start.
 */
export async function recordRun(
  db: D1Database,
  source: string,
  outcome:
    | { ok: true; cursor?: string | null; newEvents: number }
    | { ok: false; error: string },
): Promise<void> {
  const now = Date.now();

  if (!outcome.ok) {
    await db
      .prepare(
        `INSERT INTO connector_state (source, last_run_at, last_error, consecutive_failures)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT (source) DO UPDATE SET
           last_run_at = ?2,
           last_error = ?3,
           consecutive_failures = connector_state.consecutive_failures + 1`,
      )
      .bind(source, now, outcome.error.slice(0, MAX_ERROR_CHARS))
      .run();
    return;
  }

  // COALESCE rather than a second statement: passing null for the cursor means
  // "this connector has no cursor to move", and both of those want the stored
  // value left alone.
  await db
    .prepare(
      `INSERT INTO connector_state
         (source, cursor, last_run_at, last_ok_at, last_error,
          consecutive_failures, last_new_events)
       VALUES (?1, ?2, ?3, ?3, NULL, 0, ?4)
       ON CONFLICT (source) DO UPDATE SET
         cursor = COALESCE(?2, connector_state.cursor),
         last_run_at = ?3,
         last_ok_at = ?3,
         last_error = NULL,
         consecutive_failures = 0,
         last_new_events = ?4`,
    )
    .bind(source, outcome.cursor ?? null, now, outcome.newEvents)
    .run();
}

/* ------------------------------------------------------------------- events */

/**
 * Store what a fetch returned, ignoring anything already held.
 *
 * Returns how many rows were genuinely new. That number is the one worth
 * logging and showing: "fetched 30" is the same every day whether or not
 * anything happened, and "stored 2" is the day's actual news.
 */
export async function insertEvents(
  db: D1Database,
  source: string,
  events: RawEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const now = Date.now();
  const statement = db.prepare(
    `INSERT OR IGNORE INTO connector_events
       (source, external_id, occurred_at, payload, ingested_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  );

  let inserted = 0;
  for (let i = 0; i < events.length; i += INSERT_CHUNK) {
    const chunk = events.slice(i, i + INSERT_CHUNK);
    const results = await db.batch(
      chunk.map((event) =>
        statement.bind(
          source,
          event.externalId,
          event.occurredAt,
          JSON.stringify(event.payload),
          now,
        ),
      ),
    );
    // OR IGNORE makes a duplicate a zero-change success rather than an error,
    // so the count has to come from the meta rather than from the absence of a
    // throw.
    for (const result of results) inserted += result.meta.changes ?? 0;
  }

  return inserted;
}

/** Parse a stored row, tolerating a payload that somehow isn't an object. */
function toStored(row: { external_id: string; occurred_at: number; payload: string }): StoredEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // A row we cannot parse is a row the renderer will show as blank fields,
    // which is visible and recoverable. Throwing here would take a whole
    // month's page down over one bad record.
  }
  return { externalId: row.external_id, occurredAt: row.occurred_at, payload };
}

type EventRow = { external_id: string; occurred_at: number; payload: string };

/**
 * Every event between two instants, oldest first.
 *
 * Takes bounds rather than a `YYYY-MM` string because the month a row belongs
 * to depends on Stockholm time, which SQLite here has no notion of. The caller
 * converts once; this just reads the range. A film watched at half past
 * midnight then belongs to the day Albert would say he watched it, and the page
 * it lands on agrees with the date printed in its own table.
 */
export async function eventsBetween(
  db: D1Database,
  source: string,
  bounds: { from: number; to: number },
): Promise<StoredEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT external_id, occurred_at, payload FROM connector_events
        WHERE source = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
        ORDER BY occurred_at ASC`,
    )
    .bind(source, bounds.from, bounds.to)
    .all<EventRow>();
  return results.map(toStored);
}

/** What the index page needs: a total, a per-month tally, and the latest few. */
export async function indexInput(
  db: D1Database,
  source: string,
  monthOf: (ms: number) => string,
): Promise<IndexInput> {
  const [total, recent, all] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM connector_events WHERE source = ?1")
      .bind(source)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT external_id, occurred_at, payload FROM connector_events
          WHERE source = ?1 ORDER BY occurred_at DESC LIMIT ?2`,
      )
      .bind(source, RECENT_LIMIT)
      .all<EventRow>(),
    // Timestamps only. The month a row belongs to depends on a timezone SQLite
    // does not know about, so the bucketing happens in JS — but pulling every
    // payload back to count them would be reading the whole archive to produce
    // a dozen numbers.
    db
      .prepare("SELECT occurred_at FROM connector_events WHERE source = ?1")
      .bind(source)
      .all<{ occurred_at: number }>(),
  ]);

  const tally = new Map<string, number>();
  for (const row of all.results) {
    const month = monthOf(row.occurred_at);
    tally.set(month, (tally.get(month) ?? 0) + 1);
  }

  return {
    total: total?.n ?? 0,
    months: [...tally.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => b.month.localeCompare(a.month)),
    recent: recent.results.map(toStored),
  };
}
