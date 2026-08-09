/**
 * Talking to other people's servers.
 *
 * Three rules, applied in one place so no connector has to remember them:
 *
 *   - Identify ourselves. chess.com's published-data API requires a descriptive
 *     User-Agent and will refuse requests without one; the others do not care,
 *     but a personal project fetching someone's data should say who it is
 *     regardless, and a single string means one thing to change.
 *   - Time out. A cron invocation has a wall-clock budget, and a source that
 *     accepts the connection and then never answers would otherwise hold it to
 *     the end. AbortSignal.timeout turns that into a failed connector rather
 *     than a failed run.
 *   - Bound the body. `response.text()` on a stream that never ends is the same
 *     hang wearing a different hat, and these responses are all small enough
 *     that a ceiling costs nothing.
 */

/** Sent on every outbound request. */
const USER_AGENT =
  "abbe-vault/0.1 (personal second-brain connector; +https://albertahnfelt.com)";

const TIMEOUT_MS = 20_000;

/** Largest response body read. A month of chess games is well under a megabyte. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/**
 * A GET whose failures are all the same kind of thing.
 *
 * Everything a connector can do about a 404, a timeout or a truncated body is
 * identical — record it and try again tomorrow — so they all arrive as one
 * error type carrying a message worth putting on the status page.
 */
export async function getText(
  url: string,
  init: { headers?: Record<string, string> } = {},
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "*/*", ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // These are all public or bearer-authenticated reads of our own data;
      // nothing here should ever be served from a shared cache.
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown";
    throw new FetchError(`request to ${hostOf(url)} failed: ${reason}`);
  }

  if (!response.ok) {
    throw new FetchError(
      `${hostOf(url)} answered ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    throw new FetchError(`${hostOf(url)} response too large (${declared} bytes)`);
  }

  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new FetchError(`${hostOf(url)} response too large (${text.length} chars)`);
  }
  return text;
}

/** As `getText`, parsed. A source that answers with prose gets the same error type. */
export async function getJson<T>(
  url: string,
  init: { headers?: Record<string, string> } = {},
): Promise<T> {
  const text = await getText(url, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FetchError(`${hostOf(url)} did not return JSON`);
  }
}

/**
 * The host, for error messages.
 *
 * Errors reach the status page and the Worker log, and a full URL there would
 * carry the access token some of them have in a query string. The host is the
 * part that identifies which connector broke.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "source";
  }
}
