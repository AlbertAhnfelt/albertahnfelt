/**
 * What every connector is, reduced to the part that differs.
 *
 * The shared half — talking to D1, deciding which pages to rebuild, recording
 * that a run happened — lives in `run.ts` and is written once. A connector is
 * only the two things nothing else can know: how to ask its source what is new,
 * and how that turns into a page someone would want to read.
 */

/** One thing that happened, in the shape D1 stores it. */
export type RawEvent = {
  /**
   * The source's own id for this thing. Must be stable across fetches — it is
   * the primary key half that makes re-ingesting a window a no-op.
   */
  externalId: string;
  /** When it happened out in the world, in epoch milliseconds. */
  occurredAt: number;
  /** Normalised fields the renderer will read back. Stored as JSON. */
  payload: Record<string, unknown>;
};

/** A row on the way back out of D1. */
export type StoredEvent = {
  externalId: string;
  occurredAt: number;
  payload: Record<string, unknown>;
};

export type FetchResult = {
  events: RawEvent[];
  /**
   * Where to resume next time, or null to leave the stored cursor alone. Only
   * written after the events above are safely in D1, so a crash between the two
   * re-fetches rather than skips.
   */
  cursor?: string | null;
};

/** What the index page is rendered from: the whole history, in summary. */
export type IndexInput = {
  total: number;
  /** `{ month: "2026-08", count: 12 }`, newest month first. */
  months: { month: string; count: number }[];
  /** The most recent events, newest first, for a "lately" section. */
  recent: StoredEvent[];
};

/**
 * Why a connector did not run. Distinct from a failure: a connector nobody has
 * configured yet is not broken, and the status page should not cry wolf about
 * one. `reason` is shown to Albert verbatim, so it says what to do.
 */
export type NotConfigured = { configured: false; reason: string };

export type Connector = {
  /** Stable key. Names the D1 rows and the data/<source>/ folder. */
  source: string;
  /** For the status page. */
  label: string;
  /**
   * Whether this connector has what it needs. Checked before fetching, so a
   * missing username reads as "not set up" rather than as a failed HTTP call.
   */
  check(env: Cloudflare.Env): Promise<true | NotConfigured>;
  /** Ask the source what is new. `cursor` is whatever this connector last stored. */
  fetch(env: Cloudflare.Env, cursor: string | null): Promise<FetchResult>;
  /** Body of `data/<source>/<month>.md`. Frontmatter is added by the writer. */
  renderMonth(month: string, events: StoredEvent[]): string;
  /** Body of `data/<source>/index.md`. */
  renderIndex(input: IndexInput): string;
};
