/**
 * Google-backed authentication for Abbe's OAuth provider.
 *
 * This is the OAuthProvider's `defaultHandler`: it owns everything except /mcp.
 * The flow, per the MCP third-party-provider pattern — Abbe issues its own
 * tokens to MCP clients, Google only establishes who is asking:
 *
 *   GET  /authorize  parse the client's request, bounce the browser to Google
 *   GET  /callback   exchange the code, verify the identity, check the allowlist,
 *                    then ask the human to approve this specific client
 *   POST /approve    mint the grant and redirect back to the MCP client
 *
 * The parsed auth request round-trips through the browser inside the Google
 * `state` parameter, HMAC-signed so a third party cannot swap in their own
 * redirect_uri along the way.
 */

import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

/** How long the human has to click Approve after signing in with Google. */
const APPROVAL_TTL_MS = 5 * 60 * 1000;

type Env = Cloudflare.Env & { OAUTH_PROVIDER: OAuthHelpers };

/** The identity we store on the grant; surfaces to tools as ctx.props. */
export type GrantProps = { email: string; name?: string };

/* ------------------------------------------------------------------ signing */

/**
 * HMAC key for the browser round trip. Derived from the Google client secret so
 * there is no extra secret to manage: it is already a high-entropy value only
 * the Worker knows, and it is never used as an HMAC key by Google itself.
 */
async function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GOOGLE_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Serialize `payload` as `<base64url json>.<base64url hmac>`. */
async function sign(env: Env, payload: unknown): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env),
    new TextEncoder().encode(body),
  );
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

/** Verify and parse a value produced by `sign`. Returns null on any tampering. */
async function unsign<T>(env: Env, token: string): Promise<T | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env),
      b64urlDecode(token.slice(dot + 1)),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- pages */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 ui-sans-serif, system-ui, sans-serif; max-width: 30rem;
         margin: 12vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.3rem; margin-bottom: 1rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem .9rem;
       margin: 1.25rem 0; font-size: .9rem; }
  dt { opacity: .6; }
  dd { margin: 0; overflow-wrap: anywhere; }
  button { font: inherit; padding: .6rem 1.4rem; border: 0; border-radius: .5rem;
           background: #2563eb; color: #fff; cursor: pointer; }
  code { font-size: .9em; }
</style>
${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/* ------------------------------------------------------------------- google */

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).toString();
}

type StatePayload = { req: AuthRequest };
type ApprovalPayload = { req: AuthRequest; email: string; name?: string; iat: number };

type IdTokenClaims = {
  iss?: string;
  aud?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
};

/**
 * Read the claims out of an id_token.
 *
 * The signature is deliberately not checked: this token was just received in the
 * body of a TLS connection we opened to Google's token endpoint and authenticated
 * with our client secret, so the channel — not the signature — is what proves
 * provenance. (OpenID Connect Core 3.1.3.7 permits this for the code flow.)
 * Everything a caller could influence is still validated below.
 */
function readIdToken(idToken: string): IdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as IdTokenClaims;
  } catch {
    return null;
  }
}

function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/* ----------------------------------------------------------------- handlers */

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  // parseAuthRequest throws on a malformed request or an unregistered client_id.
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return page(
      "Invalid request",
      "<h1>Invalid request</h1><p>This authorization request is malformed, or the client is not registered.</p>",
      400,
    );
  }

  const state = await sign(env, { req: authRequest } satisfies StatePayload);
  const google = new URL(GOOGLE_AUTHORIZE);
  google.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  google.searchParams.set("redirect_uri", callbackUrl(request));
  google.searchParams.set("response_type", "code");
  google.searchParams.set("scope", "openid email profile");
  google.searchParams.set("state", state);
  // Always show the account chooser: on a shared browser this makes it obvious
  // which identity is about to be handed to the vault.
  google.searchParams.set("prompt", "select_account");
  return Response.redirect(google.toString(), 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return page("Sign-in cancelled", `<h1>Sign-in cancelled</h1><p>Google said: <code>${escapeHtml(error)}</code></p>`, 400);
  }

  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  if (!code || !rawState) {
    return page("Bad request", "<h1>Bad request</h1><p>Missing code or state.</p>", 400);
  }

  const state = await unsign<StatePayload>(env, rawState);
  if (!state?.req) {
    return page("Bad request", "<h1>Bad request</h1><p>The sign-in state was missing or tampered with. Start over.</p>", 400);
  }

  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(request),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return page("Sign-in failed", "<h1>Sign-in failed</h1><p>Google rejected the authorization code.</p>", 502);
  }

  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  const claims = id_token ? readIdToken(id_token) : null;
  const email = claims?.email?.toLowerCase();

  const identityOk =
    claims &&
    email &&
    claims.email_verified === true &&
    claims.aud === env.GOOGLE_CLIENT_ID &&
    GOOGLE_ISSUERS.includes(claims.iss ?? "") &&
    typeof claims.exp === "number" &&
    claims.exp * 1000 > Date.now();

  if (!identityOk) {
    return page("Sign-in failed", "<h1>Sign-in failed</h1><p>Google did not return a usable verified identity.</p>", 401);
  }

  // The one control that makes this a single-user server.
  if (!allowedEmails(env).includes(email)) {
    return page(
      "Not authorized",
      `<h1>Not authorized</h1><p><code>${escapeHtml(email)}</code> is not allowed to access this vault.</p>`,
      403,
    );
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(state.req.clientId);
  const approval = await sign(env, {
    req: state.req,
    email,
    name: claims.name,
    iat: Date.now(),
  } satisfies ApprovalPayload);

  return renderApproval(client, state.req, email, approval);
}

/**
 * Consent screen. Clients self-register, so this is what stops a link someone
 * else crafted from turning your Google session into a token pointed at their
 * redirect_uri: the destination is shown before anything is minted.
 */
function renderApproval(
  client: ClientInfo | null,
  req: AuthRequest,
  email: string,
  approval: string,
): Response {
  const clientName = client?.clientName ?? client?.clientId ?? "an unidentified client";
  return page(
    "Connect to Abbe",
    `<h1>Connect to your vault?</h1>
<p><strong>${escapeHtml(clientName)}</strong> is asking for access to Abbe as
<code>${escapeHtml(email)}</code>.</p>
<dl>
  <dt>Client</dt><dd>${escapeHtml(client?.clientId ?? "unknown")}</dd>
  <dt>Sends tokens to</dt><dd>${escapeHtml(req.redirectUri)}</dd>
  <dt>Scope</dt><dd>${escapeHtml(req.scope.join(" ") || "(none requested)")}</dd>
</dl>
<p>Only approve this if you just started the connection yourself, and you
recognise the address above.</p>
<form method="POST" action="/approve">
  <input type="hidden" name="approval" value="${escapeHtml(approval)}">
  <button type="submit">Approve</button>
</form>`,
  );
}

async function handleApprove(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const raw = form.get("approval");
  const approval = typeof raw === "string" ? await unsign<ApprovalPayload>(env, raw) : null;
  if (!approval) {
    return page("Bad request", "<h1>Bad request</h1><p>That approval was not valid. Start over.</p>", 400);
  }
  if (Date.now() - approval.iat > APPROVAL_TTL_MS) {
    return page("Expired", "<h1>Expired</h1><p>That approval sat too long. Start the connection again.</p>", 400);
  }
  // Re-check the allowlist: it may have been tightened since the page was rendered.
  if (!allowedEmails(env).includes(approval.email)) {
    return page("Not authorized", "<h1>Not authorized</h1><p>That account is not allowed to access this vault.</p>", 403);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: approval.req,
    userId: approval.email,
    scope: approval.req.scope,
    metadata: { loggedInAt: new Date().toISOString() },
    props: { email: approval.email, name: approval.name } satisfies GrantProps,
  });
  return Response.redirect(redirectTo, 302);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "/health") {
      return new Response("abbe: ok", { status: 200 });
    }
    if (pathname === "/authorize" && request.method === "GET") {
      return handleAuthorize(request, env);
    }
    if (pathname === "/callback" && request.method === "GET") {
      return handleCallback(request, env);
    }
    if (pathname === "/approve" && request.method === "POST") {
      return handleApprove(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
