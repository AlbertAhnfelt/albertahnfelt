/**
 * Browser login for albertahnfelt.com — the second credential path, alongside
 * the MCP bearer tokens in `oauth-google.ts`. Same Google app, same allowlist
 * (`google.ts`); what differs is the credential, because what is asking differs.
 *
 * An agent cannot hold a cookie, so it gets a token. A browser cannot safely
 * hold a token — anything JavaScript can read, an XSS bug can steal — so it
 * gets an HttpOnly cookie the page's own code never sees. Deliberately, this
 * cookie authorizes nothing but "you are signed in": it is not accepted on
 * /mcp, so it can never be spent on vault tools.
 *
 *   GET  /web/login     bounce to Google, remembering where to come back to
 *   GET  /web/callback   verify, check the allowlist, set the session cookie
 *   GET  /web/me         "am I signed in?" — the only thing the site asks
 *   POST /web/logout     drop the session server-side and clear the cookie
 *
 * The site is static, so the Worker is reached through a same-origin proxy
 * (a Vercel rewrite from SITE_ORIGIN + API_BASE_PATH). That is what keeps the
 * cookie first-party: were the browser to talk to abbe.*.workers.dev directly,
 * the cookie would be third-party and Safari would drop it outright.
 */

import { secretsEqual } from "./auth";
import { authorizeUrl, identityFromCode, isAllowedEmail, sign, unsign } from "./google";
import { escapeHtml, page } from "./html";

const SESSION_COOKIE = "abbe_session";
const STATE_COOKIE = "abbe_login_state";

const SESSION_TTL_S = 7 * 24 * 60 * 60;
/** How long a login may sit half-finished at Google. */
const STATE_TTL_S = 10 * 60;

/** Namespaced so these never collide with the OAuth provider's own KV keys. */
const KV_PREFIX = "websession:";

type StatePayload = { nonce: string; returnTo: string; iat: number };
type SessionRecord = { email: string; name?: string; createdAt: string };

/**
 * Where the browser thinks it is talking to us: the site origin plus the path
 * prefix the site's proxy rewrites onto this Worker.
 *
 * Read from config, never from the request. Behind the proxy the inbound Host is
 * the workers.dev name, and a redirect_uri or cookie Path derived from a request
 * header is a redirect_uri an attacker gets to influence.
 */
function site(env: Cloudflare.Env) {
  const origin = env.SITE_ORIGIN.replace(/\/+$/, "");
  const base = env.API_BASE_PATH.replace(/\/+$/, "");
  return {
    origin,
    /** Session cookie scope: every proxied Abbe endpoint, present and future. */
    basePath: base || "/",
    /** State cookie scope: only the login endpoints need it. */
    loginPath: `${base}/web`,
    callbackUrl: `${origin}${base}/web/callback`,
    // Secure is required in production. Plain-http localhost is already treated
    // as a secure context by browsers, but would refuse a Secure cookie.
    secure: origin.startsWith("https://"),
  };
}

/* ------------------------------------------------------------------ cookies */

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function cookie(
  name: string,
  value: string,
  opts: { path: string; maxAge: number; secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    "HttpOnly",
    // Lax, not Strict: the return trip from Google is a cross-site top-level
    // GET, which Lax allows and Strict would strip — breaking every login.
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string, path: string, secure: boolean): string {
  return cookie(name, "", { path, maxAge: 0, secure });
}

/* -------------------------------------------------------------------- utils */

/** 32 bytes of hex. Used for both the session id and the login nonce. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200, extraHeaders: [string, string][] = []): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    // Never let a proxy or the browser cache who is signed in.
    "cache-control": "private, no-store",
  });
  for (const [k, v] of extraHeaders) headers.append(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

const SAFE_RETURN_TO = /^\/[A-Za-z0-9\-._~/]*$/;

/**
 * Only same-origin absolute paths survive. Rejects `//evil.com`, any scheme or
 * authority, backslashes and encoded escapes — an open redirect here would let
 * someone start a login on your site and land the browser on theirs.
 */
function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.startsWith("//") || !SAFE_RETURN_TO.test(raw)) return "/";
  return raw;
}

/* ----------------------------------------------------------------- sessions */

/** The signed-in identity for this request, or null. */
export async function currentSession(
  request: Request,
  env: Cloudflare.Env,
): Promise<SessionRecord | null> {
  const id = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (!id) return null;

  const key = KV_PREFIX + (await sha256Hex(id));
  const record = await env.OAUTH_KV.get<SessionRecord>(key, "json");
  if (!record) return null;

  // Re-check the allowlist on every request: taking an address out of
  // ALLOWED_EMAILS is how you revoke, and it should take effect at once.
  if (!isAllowedEmail(env, record.email)) {
    await env.OAUTH_KV.delete(key);
    return null;
  }
  return record;
}

/* ----------------------------------------------------------------- handlers */

async function handleLogin(request: Request, env: Cloudflare.Env): Promise<Response> {
  const cfg = site(env);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));

  // The nonce goes two ways round: signed into Google's state, and into a
  // short-lived cookie. Requiring both back proves this callback belongs to a
  // login *this* browser started, which is what stops someone from walking you
  // into a session that is really theirs.
  const nonce = randomToken();
  const state = await sign(env, { nonce, returnTo, iat: Date.now() } satisfies StatePayload);

  const headers = new Headers({ location: authorizeUrl(env, cfg.callbackUrl, state) });
  headers.append(
    "set-cookie",
    cookie(STATE_COOKIE, nonce, {
      path: cfg.loginPath,
      maxAge: STATE_TTL_S,
      secure: cfg.secure,
    }),
  );
  headers.set("cache-control", "private, no-store");
  return new Response(null, { status: 302, headers });
}

async function handleCallback(request: Request, env: Cloudflare.Env): Promise<Response> {
  const cfg = site(env);
  const url = new URL(request.url);
  const dropState = clearCookie(STATE_COOKIE, cfg.loginPath, cfg.secure);

  /** Every exit from here clears the one-shot state cookie. */
  const fail = (title: string, body: string, status: number) => {
    const res = page(title, body, status);
    res.headers.append("set-cookie", dropState);
    return res;
  };

  const error = url.searchParams.get("error");
  if (error) {
    return fail(
      "Sign-in cancelled",
      `<h1>Sign-in cancelled</h1><p>Google said: <code>${escapeHtml(error)}</code></p>
<p><a href="${escapeHtml(cfg.origin)}/">Back to the site</a></p>`,
      400,
    );
  }

  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  const state = rawState ? await unsign<StatePayload>(env, rawState) : null;
  const nonce = parseCookies(request.headers.get("cookie"))[STATE_COOKIE];

  const stateOk =
    code &&
    state &&
    nonce &&
    Date.now() - state.iat < STATE_TTL_S * 1000 &&
    (await secretsEqual(nonce, state.nonce));

  if (!stateOk) {
    return fail(
      "Sign-in failed",
      `<h1>Sign-in failed</h1><p>This sign-in could not be matched to one you started, or it
expired on the way. Start over.</p>
<p><a href="${escapeHtml(cfg.origin)}/">Back to the site</a></p>`,
      400,
    );
  }

  const result = await identityFromCode(env, code, cfg.callbackUrl);
  if (!result.ok) {
    if (result.reason === "exchange") {
      return fail("Sign-in failed", "<h1>Sign-in failed</h1><p>Google rejected the authorization code.</p>", 502);
    }
    if (result.reason === "identity") {
      return fail("Sign-in failed", "<h1>Sign-in failed</h1><p>Google did not return a usable verified identity.</p>", 401);
    }
    return fail(
      "Not authorized",
      `<h1>Not authorized</h1><p><code>${escapeHtml(result.email)}</code> is not allowed here.</p>
<p><a href="${escapeHtml(cfg.origin)}/">Back to the site</a></p>`,
      403,
    );
  }

  // Opaque id to the browser, only its hash at rest: a dump of the KV namespace
  // yields no usable session. Deleting the record is what makes logout real.
  const sessionId = randomToken();
  const record: SessionRecord = {
    email: result.identity.email,
    name: result.identity.name,
    createdAt: new Date().toISOString(),
  };
  await env.OAUTH_KV.put(KV_PREFIX + (await sha256Hex(sessionId)), JSON.stringify(record), {
    expirationTtl: SESSION_TTL_S,
  });

  const headers = new Headers({
    location: `${cfg.origin}${safeReturnTo(state.returnTo)}`,
    "cache-control": "private, no-store",
  });
  headers.append(
    "set-cookie",
    cookie(SESSION_COOKIE, sessionId, {
      path: cfg.basePath,
      maxAge: SESSION_TTL_S,
      secure: cfg.secure,
    }),
  );
  headers.append("set-cookie", dropState);
  return new Response(null, { status: 302, headers });
}

async function handleMe(request: Request, env: Cloudflare.Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ authenticated: false }, 401);
  return json({ authenticated: true, email: session.email, name: session.name });
}

async function handleLogout(request: Request, env: Cloudflare.Env): Promise<Response> {
  const cfg = site(env);
  const id = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (id) await env.OAUTH_KV.delete(KV_PREFIX + (await sha256Hex(id)));
  return json({ authenticated: false }, 200, [
    ["set-cookie", clearCookie(SESSION_COOKIE, cfg.basePath, cfg.secure)],
  ]);
}

/** Routes every /web/* path. Called before the OAuth provider sees the request. */
export async function handleWebSession(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === "/web/login" && method === "GET") return handleLogin(request, env);
  if (pathname === "/web/callback" && method === "GET") return handleCallback(request, env);
  if (pathname === "/web/me" && (method === "GET" || method === "HEAD")) {
    return handleMe(request, env);
  }
  // POST-only, so no cross-site GET can log you out; SameSite=Lax means a
  // cross-site POST arrives without the cookie anyway.
  if (pathname === "/web/logout" && method === "POST") return handleLogout(request, env);

  return json({ error: "not found" }, 404);
}
