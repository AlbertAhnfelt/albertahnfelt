-- Connectors: raw events pulled from third-party sources, and where each
-- connector got to.
--
-- Two tables, and the split is the whole design. `connector_events` is the
-- archive — every activity, film and game, kept forever in the shape the source
-- gave it. The vault pages under data/ are not that archive; they are a
-- rendering of it, rebuilt from these rows on every run. That is what makes a
-- re-run safe and a backfill able to fix history: the markdown is a pure
-- function of what is stored here, so nothing accumulates in a page that isn't
-- in a row.
--
-- Deliberately generic rather than a table per source. Every connector needs the
-- same three things — dedupe by the source's own id, order by when the thing
-- happened, and "what is new since last time" — and none of them needs SQL to
-- understand a film rating or a chess opening. The per-source shape lives in the
-- JSON payload and in the renderer that reads it, which is the layer that
-- actually changes when a source changes.
--
-- Times are integer milliseconds since the epoch, matching 0001.

CREATE TABLE connector_events (
  -- "letterboxd" | "chess" | "strava". Set by the connector, never by a
  -- response — a source that could name itself could overwrite another's rows.
  source TEXT NOT NULL,
  -- The source's own identifier for this thing: a Letterboxd entry guid, a
  -- chess.com game url, a Strava activity id. Whatever it is, it must be stable
  -- across fetches, because it is the entire dedupe story.
  external_id TEXT NOT NULL,
  -- When the thing happened out in the world (watched, played, ran) — not when
  -- we heard about it. This is what decides which month's page it lands on, so
  -- a late-arriving event still files itself under the month it belongs to.
  occurred_at INTEGER NOT NULL,
  -- The normalised event as JSON. Normalised, not raw: each connector picks the
  -- fields its renderer needs and drops the rest, so a page is never rebuilt
  -- from a shape nothing here has ever read.
  payload TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  -- Composite, so re-ingesting the same window is a no-op rather than a
  -- duplicate. Every write is INSERT OR IGNORE against this.
  PRIMARY KEY (source, external_id)
);

-- The only read pattern the renderers have: one source, one month, in order.
CREATE INDEX connector_events_by_time ON connector_events (source, occurred_at);

CREATE TABLE connector_state (
  source TEXT PRIMARY KEY,
  -- Opaque to everything but the connector that wrote it. Strava stores an
  -- epoch second, chess.com an archive month, Letterboxd nothing at all — its
  -- feed is a fixed window, so it re-reads the whole thing every time and lets
  -- the primary key above throw away what it already has.
  cursor TEXT,
  -- Every attempt moves last_run_at; only a successful one moves last_ok_at.
  -- Two columns rather than one status field because the gap between them is
  -- the thing worth seeing: a connector that ran an hour ago and last succeeded
  -- in March is the failure mode this whole table exists to make visible.
  last_run_at INTEGER,
  last_ok_at INTEGER,
  last_error TEXT,
  -- Reset to 0 on success. Not a retry budget — the daily cron will try again
  -- tomorrow regardless — but the number the status page reads to decide
  -- whether this is a blip or something that has been broken for a fortnight.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- How many events the last successful run actually stored (new ones only).
  last_new_events INTEGER NOT NULL DEFAULT 0
);
