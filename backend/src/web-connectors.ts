/**
 * /web/connectors and /web/connect/* — the connectors' browser surface.
 *
 * Two jobs. One is a status read the /connections page polls; the other is the
 * Strava OAuth round trip, which is the only part of this whole feature that
 * cannot be done from a cron.
 *
 * Everything here requires the website session, including the OAuth callback.
 * That last one matters more than it looks: without a session check on the way
 * back, anyone who could get a browser to fetch the callback URL with their own
 * `code` would attach *their* Strava account to Albert's vault, and the next
 * cron would quietly fill data/strava/ with a stranger's runs. The state
 * parameter is signed and carries the session's email for the same reason.
 */

import { sign, unsign } from "./google";
import { page, escapeHtml } from "./html";
import { authorizeUrl, clearTokens, exchangeCode } from "./connectors/strava";
import { connectorStatus } from "./connectors/run";
import { currentSession } from "./web-session";

const CACHE = "private, no-store";

/** How long a started OAuth flow stays valid. Long enough to log in, not to sit on. */
const STATE_TTL_MS = 10 * 60 * 1000;

type StravaState = { email: string; expires: number; nonce: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": CACHE,
      "x-content-type-options": "nosniff",
    },
  });
}

/** Where Strava sends the browser back. Must match the app's Authorization Callback Domain. */
function redirectUri(env: Cloudflare.Env): string {
  return `${env.SITE_ORIGIN}${env.API_BASE_PATH}/web/connect/strava/callback`;
}

function notice(title: string, message: string, status = 200): Response {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
      `<p><a href="/connections">Back to connections</a></p>`,
    status,
  );
}

/* -------------------------------------------------------------------- status */

async function handleStatus(env: Cloudflare.Env): Promise<Response> {
  return json({ connectors: await connectorStatus(env) });
}

/* --------------------------------------------------------------- strava oauth */

async function handleStravaStart(env: Cloudflare.Env, email: string): Promise<Response> {
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) {
    return notice(
      "Strava is not configured",
      "STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET have not been set on the Worker yet.",
      503,
    );
  }

  const nonce = crypto.randomUUID();
  const state = await sign(env, {
    email,
    expires: Date.now() + STATE_TTL_MS,
    nonce,
  } satisfies StravaState);

  return Response.redirect(authorizeUrl(env, redirectUri(env), state), 302);
}

async function handleStravaCallback(
  request: Request,
  env: Cloudflare.Env,
  email: string,
): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Strava sends the user back here with `error=access_denied` when they
  // decline, which is not a failure worth a stack trace.
  if (params.get("error")) {
    return notice("Strava was not connected", "The authorization was declined.", 400);
  }

  const state = await unsign<StravaState>(env, params.get("state") ?? "");
  if (!state || typeof state.expires !== "number" || state.expires < Date.now()) {
    return notice("Strava was not connected", "That sign-in link has expired. Try again.", 400);
  }

  // The signature proves we minted the state; this proves it was minted for the
  // person holding the session cookie right now.
  if (state.email !== email) {
    return notice("Strava was not connected", "That sign-in belongs to a different session.", 403);
  }

  const code = params.get("code");
  if (!code) return notice("Strava was not connected", "Strava sent no authorization code.", 400);

  try {
    await exchangeCode(env, code);
  } catch (cause) {
    console.error("strava: code exchange failed —", cause instanceof Error ? cause.message : cause);
    return notice(
      "Strava was not connected",
      "Strava refused the authorization code. Check the client ID and secret, then try again.",
      502,
    );
  }

  return notice(
    "Strava connected",
    "Activities will be pulled on the next nightly run, and the first one backfills your history.",
  );
}

async function handleStravaDisconnect(env: Cloudflare.Env): Promise<Response> {
  await clearTokens(env.OAUTH_KV);
  return json({ ok: true });
}

/* ------------------------------------------------------------------- routing */

export async function handleConnectors(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  const session = await currentSession(request, env);
  if (!session) {
    // The OAuth return is a top-level navigation, so a JSON 401 would be shown
    // to a person rather than parsed by anything. It gets a page.
    if (pathname.startsWith("/web/connect/")) {
      return notice("Not signed in", "Sign in on the website first, then connect Strava.", 401);
    }
    return json({ error: "not signed in" }, 401);
  }

  if (pathname === "/web/connectors" && (method === "GET" || method === "HEAD")) {
    return handleStatus(env);
  }

  if (pathname === "/web/connect/strava" && method === "GET") {
    return handleStravaStart(env, session.email);
  }

  if (pathname === "/web/connect/strava/callback" && method === "GET") {
    return handleStravaCallback(request, env, session.email);
  }

  // POST, so it cannot be triggered by a link or an image. SameSite=Lax keeps
  // it off cross-site form posts, which is the same footing /web/logout is on.
  if (pathname === "/web/connect/strava/disconnect" && method === "POST") {
    return handleStravaDisconnect(env);
  }

  return json({ error: "not found" }, 404);
}
