/**
 * Strava — activities, and the OAuth that makes them reachable.
 *
 * The only connector here that needs a credential, which brings two things the
 * others do not have: tokens in KV, and a refresh that must be persisted the
 * moment it happens. Strava rotates the refresh token on every refresh and
 * invalidates the old one, so a refresh that succeeds against Strava and then
 * fails to be written here has locked us out — the token we still hold is the
 * one that no longer works. That is why `refresh` writes before it returns and
 * why nothing else in this file caches a token across a request.
 *
 * On terms: Strava's API agreement forbids third parties putting Strava data
 * into AI models, and separately allows a developer to bring their own AI
 * application to their own data for personal use. This is the second of those,
 * and it stays that way only while these pages are not readable by anything
 * public — see the note in the PR and in data/strava/index.md.
 */

import { getJson } from "./http";
import { cell, dayOf, plain, table } from "./page";
import type { Connector, FetchResult, IndexInput, RawEvent, StoredEvent } from "./types";

const AUTHORIZE = "https://www.strava.com/oauth/authorize";
const TOKEN = "https://www.strava.com/oauth/token";
const ACTIVITIES = "https://www.strava.com/api/v3/athlete/activities";

/** Where the tokens live. One athlete, one key. */
export const TOKENS_KEY = "conn:strava";

/**
 * What the app asks for. `activity:read_all` rather than `activity:read`
 * because the narrower scope silently omits activities marked private, and a
 * vault missing the runs Albert chose not to publish would be wrong in a way
 * nothing on the page would reveal.
 */
export const SCOPE = "activity:read_all";

const PER_PAGE = 100;

/**
 * Two cursors, because one cannot be correct here.
 *
 * Strava serves activities newest-first and offers no ascending order, so
 * "everything after X" and "everything before Y" are different walks and only
 * the second one terminates on a history of unknown length. A single
 * high-water mark would either re-read the whole account nightly or, if
 * advanced after a run that stopped early, step over the un-read middle for
 * good.
 *
 * So: `newest` moves forward and picks up new activities, which in steady state
 * is one page or none. `oldest` moves backward a bounded number of pages a
 * night until Strava runs out of history, at which point `done` latches and the
 * backward walk stops for ever.
 */
type Cursor = { newest: number; oldest: number | null; done: boolean };

/** Pages of forward catch-up. Only ever more than one after an outage. */
const MAX_FORWARD_PAGES = 20;

/** Pages of history per run. A thousand activities a night finishes any account. */
const MAX_BACKFILL_PAGES = 10;

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { newest: 0, oldest: null, done: false };
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return {
      newest: typeof parsed.newest === "number" ? parsed.newest : 0,
      oldest: typeof parsed.oldest === "number" ? parsed.oldest : null,
      done: parsed.done === true,
    };
  } catch {
    // An unreadable cursor is treated as no cursor: the forward walk starts
    // over and the backfill runs again, and every event it re-reads is a
    // duplicate the primary key throws away. Slow, not lossy.
    return { newest: 0, oldest: null, done: false };
  }
}

/** Refresh this long before expiry, so a slow run cannot straddle the boundary. */
const REFRESH_MARGIN_S = 300;

export type StravaTokens = {
  access_token: string;
  refresh_token: string;
  /** Epoch seconds, as Strava sends it. */
  expires_at: number;
  athlete_id?: number;
};

/* ------------------------------------------------------------------- tokens */

export async function readTokens(kv: KVNamespace): Promise<StravaTokens | null> {
  return kv.get<StravaTokens>(TOKENS_KEY, "json");
}

export async function writeTokens(kv: KVNamespace, tokens: StravaTokens): Promise<void> {
  await kv.put(TOKENS_KEY, JSON.stringify(tokens));
}

export async function clearTokens(kv: KVNamespace): Promise<void> {
  await kv.delete(TOKENS_KEY);
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  athlete?: { id?: number };
};

/** Shape-check a token response before it is stored or used. */
function toTokens(body: TokenResponse, previous?: StravaTokens): StravaTokens | null {
  const access = body.access_token;
  // Strava always returns a refresh token on both grants; keeping the previous
  // one as a fallback means a response that omits it cannot erase what we have.
  const refresh = body.refresh_token ?? previous?.refresh_token;
  if (typeof access !== "string" || !access) return null;
  if (typeof refresh !== "string" || !refresh) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: typeof body.expires_at === "number" ? body.expires_at : 0,
    athlete_id: body.athlete?.id ?? previous?.athlete_id,
  };
}

async function postToken(
  env: Cloudflare.Env,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      ...params,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    // The body can carry the client secret back in an error echo, so only the
    // status is surfaced. Strava says 401 for a refresh token it has retired,
    // which is the one worth telling apart on the status page.
    throw new Error(`Strava token endpoint answered ${response.status}`);
  }
  return (await response.json()) as TokenResponse;
}

/** Trade the authorization code from the browser round trip for tokens. */
export async function exchangeCode(env: Cloudflare.Env, code: string): Promise<StravaTokens> {
  const tokens = toTokens(await postToken(env, { code, grant_type: "authorization_code" }));
  if (!tokens) throw new Error("Strava returned an unusable token response");
  await writeTokens(env.OAUTH_KV, tokens);
  return tokens;
}

/**
 * A usable access token, refreshing first if the stored one is near expiry.
 *
 * The new pair is written before this returns, and before any of it is used to
 * make a request — see the note at the top of the file about why that order is
 * the whole point.
 */
async function accessToken(env: Cloudflare.Env): Promise<string> {
  const stored = await readTokens(env.OAUTH_KV);
  if (!stored) throw new Error("Strava is not connected");

  const now = Math.floor(Date.now() / 1000);
  if (stored.expires_at > now + REFRESH_MARGIN_S) return stored.access_token;

  const refreshed = toTokens(
    await postToken(env, {
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
    }),
    stored,
  );
  if (!refreshed) throw new Error("Strava returned an unusable refresh response");

  await writeTokens(env.OAUTH_KV, refreshed);
  return refreshed.access_token;
}

/** Where to send the browser to authorize. `state` should be a signed value. */
export function authorizeUrl(env: Cloudflare.Env, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  // Strava will not re-prompt without this once a grant exists, which makes
  // re-connecting after a scope change silently do nothing.
  url.searchParams.set("approval_prompt", "force");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

/* --------------------------------------------------------------- activities */

type ApiActivity = {
  id?: number;
  name?: string;
  sport_type?: string;
  type?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  total_elevation_gain?: number;
  average_speed?: number;
  average_heartrate?: number;
  start_date?: string;
};

type Activity = {
  name: string;
  sport: string;
  /** Metres. */
  distance: number;
  /** Seconds. */
  movingTime: number;
  elevation: number;
  /** Metres per second. */
  speed: number;
  heartrate: number | null;
  id: string;
};

const FOOT_SPORTS = new Set(["Run", "TrailRun", "Walk", "Hike", "VirtualRun", "Snowshoe"]);

function toEvent(activity: ApiActivity): RawEvent | null {
  const id = typeof activity.id === "number" ? String(activity.id) : "";
  const started = activity.start_date ? Date.parse(activity.start_date) : Number.NaN;
  if (!id || Number.isNaN(started)) return null;

  const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  const payload: Activity = {
    name: plain(activity.name ?? "", 120),
    sport: plain(activity.sport_type ?? activity.type ?? "", 40),
    distance: number(activity.distance),
    movingTime: number(activity.moving_time),
    elevation: number(activity.total_elevation_gain),
    speed: number(activity.average_speed),
    heartrate:
      typeof activity.average_heartrate === "number" ? Math.round(activity.average_heartrate) : null,
    id,
  };

  return { externalId: id, occurredAt: started, payload: { ...payload } };
}

function asActivity(event: StoredEvent): Activity {
  const p = event.payload;
  const number = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {
    name: typeof p.name === "string" ? p.name : "",
    sport: typeof p.sport === "string" ? p.sport : "",
    distance: number(p.distance),
    movingTime: number(p.movingTime),
    elevation: number(p.elevation),
    speed: number(p.speed),
    heartrate: typeof p.heartrate === "number" ? p.heartrate : null,
    id: typeof p.id === "string" ? p.id : "",
  };
}

/** "1:23:45", or "42:10" under an hour. */
export function duration(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Pace for things done on foot, speed for everything else.
 *
 * A cyclist's 4:00 min/km and a runner's 25 km/h are both technically true and
 * neither is what the person who did it would say, so the unit follows the
 * sport rather than the table.
 */
function tempo(activity: Activity): string {
  if (activity.speed <= 0) return "—";
  if (FOOT_SPORTS.has(activity.sport)) {
    const secondsPerKm = 1000 / activity.speed;
    const m = Math.floor(secondsPerKm / 60);
    const s = Math.round(secondsPerKm % 60);
    // 59.5 seconds rounds to 60, which would print as "5:60".
    return s === 60 ? `${m + 1}:00 /km` : `${m}:${String(s).padStart(2, "0")} /km`;
  }
  return `${(activity.speed * 3.6).toFixed(1)} km/h`;
}

function km(metres: number): string {
  return metres > 0 ? `${(metres / 1000).toFixed(2)} km` : "—";
}

/** Link to the activity on Strava. The id is digits, so the URL is ours, not theirs. */
function activityLink(activity: Activity, label: string): string {
  return /^\d+$/.test(activity.id)
    ? `[${label}](https://www.strava.com/activities/${activity.id})`
    : label;
}

function totals(activities: Activity[]) {
  return {
    count: activities.length,
    distance: activities.reduce((sum, a) => sum + a.distance, 0),
    time: activities.reduce((sum, a) => sum + a.movingTime, 0),
    elevation: activities.reduce((sum, a) => sum + a.elevation, 0),
  };
}

export const strava: Connector = {
  source: "strava",
  label: "Strava",

  async check(env) {
    if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) {
      return { configured: false, reason: "STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are not set" };
    }
    if (!(await readTokens(env.OAUTH_KV))) {
      return { configured: false, reason: "not connected — visit /connections and sign in to Strava" };
    }
    return true;
  },

  async fetch(env, cursor): Promise<FetchResult> {
    const token = await accessToken(env);
    const state = parseCursor(cursor);
    const events: RawEvent[] = [];

    const load = async (params: Record<string, string>): Promise<ApiActivity[]> => {
      const url = new URL(ACTIVITIES);
      url.searchParams.set("per_page", String(PER_PAGE));
      url.searchParams.set("page", "1");
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const batch = await getJson<ApiActivity[]>(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      return Array.isArray(batch) ? batch : [];
    };

    const collect = (batch: ApiActivity[]): number[] => {
      const seconds: number[] = [];
      for (const activity of batch) {
        const event = toEvent(activity);
        if (!event) continue;
        events.push(event);
        seconds.push(Math.floor(event.occurredAt / 1000));
      }
      return seconds;
    };

    // Forward: everything since the last run. Paged with `after` and an
    // explicit page number, which is safe because this window is small and
    // stops growing the moment it is drained.
    if (state.newest > 0) {
      for (let page = 1; page <= MAX_FORWARD_PAGES; page++) {
        const batch = await load({ after: String(state.newest), page: String(page) });
        const seconds = collect(batch);
        for (const s of seconds) state.newest = Math.max(state.newest, s);
        if (batch.length < PER_PAGE) break;
      }
    }

    // Backward: a bounded walk into history. `before` moves to the oldest thing
    // seen rather than an incrementing page number, so activities added while
    // this is in progress cannot shift the window under it.
    if (!state.done) {
      for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
        const before = state.oldest ?? Math.floor(Date.now() / 1000);
        const batch = await load({ before: String(before) });
        const seconds = collect(batch);

        if (batch.length === 0) {
          state.done = true;
          break;
        }

        for (const s of seconds) state.newest = Math.max(state.newest, s);
        const oldestHere = seconds.length > 0 ? Math.min(...seconds) : null;

        // No progress — every activity on this page starts at or after the
        // point we asked to go before, which means `before` is not moving and
        // the next request would return the same page for ever.
        if (oldestHere === null || (state.oldest !== null && oldestHere >= state.oldest)) {
          state.done = true;
          break;
        }

        state.oldest = oldestHere;
        if (batch.length < PER_PAGE) {
          state.done = true;
          break;
        }
      }
    }

    return { events, cursor: JSON.stringify(state) };
  },

  renderMonth(month, events) {
    const rows = events.map((event) => {
      const activity = asActivity(event);
      return [
        cell(dayOf(event.occurredAt)),
        activityLink(activity, cell(activity.name || activity.sport)),
        cell(activity.sport, 24),
        km(activity.distance),
        duration(activity.movingTime),
        tempo(activity),
        activity.elevation > 0 ? `${Math.round(activity.elevation)} m` : "—",
        activity.heartrate ? String(activity.heartrate) : "—",
      ];
    });

    const sum = totals(events.map(asActivity));

    return [
      `# Strava — ${month}`,
      "",
      `${sum.count} ${sum.count === 1 ? "activity" : "activities"} — ` +
        `${km(sum.distance)}, ${duration(sum.time)} moving, ` +
        `${Math.round(sum.elevation)} m climbed`,
      "",
      table(
        ["Date", "Activity", "Sport", "Distance", "Time", "Pace", "Climb", "HR"],
        rows,
      ),
    ].join("\n");
  },

  renderIndex(input: IndexInput) {
    const recent = input.recent.map((event) => {
      const activity = asActivity(event);
      return [
        cell(dayOf(event.occurredAt)),
        activityLink(activity, cell(activity.name || activity.sport)),
        cell(activity.sport, 24),
        km(activity.distance),
        duration(activity.movingTime),
      ];
    });

    return [
      "# Strava",
      "",
      `${input.total} ${input.total === 1 ? "activity" : "activities"} across ` +
        `${input.months.length} ${input.months.length === 1 ? "month" : "months"}.`,
      "",
      "## Lately",
      "",
      table(["Date", "Activity", "Sport", "Distance", "Time"], recent),
      "",
      "## By month",
      "",
      table(
        ["Month", "Activities"],
        input.months.map((m) => [m.month, String(m.count)]),
      ),
      "",
      "---",
      "",
      "Strava's API agreement permits a developer to use their own data with their own",
      "AI application for personal use, and forbids third parties putting Strava data",
      "into AI models. Keeping these pages behind the sign-in is what holds this on the",
      "permitted side of that line.",
    ].join("\n");
  },
};
