/**
 * Google as Abbe's identity provider.
 *
 * Two different things need to know who is asking: the MCP OAuth flow
 * (`oauth-google.ts`, which issues bearer tokens to agents) and the website's
 * cookie session (`web-session.ts`). Both establish identity the same way and
 * both answer to the same allowlist — only the credential they mint differs.
 * That shared half lives here.
 */

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

/** Just the bindings this module reads. */
export type GoogleEnv = Pick<
  Cloudflare.Env,
  "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "ALLOWED_EMAILS"
>;

/* ------------------------------------------------------------------ signing */

/**
 * HMAC key for the browser round trip. Derived from the Google client secret so
 * there is no extra secret to manage: it is already a high-entropy value only
 * the Worker knows, and it is never used as an HMAC key by Google itself.
 */
async function signingKey(env: GoogleEnv): Promise<CryptoKey> {
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
export async function sign(env: GoogleEnv, payload: unknown): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env),
    new TextEncoder().encode(body),
  );
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

/** Verify and parse a value produced by `sign`. Returns null on any tampering. */
export async function unsign<T>(env: GoogleEnv, token: string): Promise<T | null> {
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

/* ------------------------------------------------------------- the allowlist */

export function allowedEmails(env: GoogleEnv): string[] {
  return (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(env: GoogleEnv, email: string): boolean {
  return allowedEmails(env).includes(email.toLowerCase());
}

/* ---------------------------------------------------------------- the flow */

/**
 * Where to send the browser to sign in. `redirectUri` must be one of the
 * authorized redirect URIs on the Google OAuth client, and `state` should be a
 * value from `sign` so it comes back unmodified.
 */
export function authorizeUrl(env: GoogleEnv, redirectUri: string, state: string): string {
  const google = new URL(GOOGLE_AUTHORIZE);
  google.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  google.searchParams.set("redirect_uri", redirectUri);
  google.searchParams.set("response_type", "code");
  google.searchParams.set("scope", "openid email profile");
  google.searchParams.set("state", state);
  // Always show the account chooser: on a shared browser this makes it obvious
  // which identity is about to be handed to the vault.
  google.searchParams.set("prompt", "select_account");
  return google.toString();
}

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

export type Identity = { email: string; name?: string };

/**
 * Each failure means something different to the person staring at the browser,
 * so callers get to phrase them: `exchange` is our problem, `identity` is
 * Google's, `forbidden` is a real account that simply is not on the list.
 */
export type IdentityResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: "exchange" }
  | { ok: false; reason: "identity" }
  | { ok: false; reason: "forbidden"; email: string };

/**
 * Trade an authorization code for a verified, allowlisted identity.
 * `redirectUri` must match the one used to obtain the code.
 */
export async function identityFromCode(
  env: GoogleEnv,
  code: string,
  redirectUri: string,
): Promise<IdentityResult> {
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return { ok: false, reason: "exchange" };

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

  if (!identityOk) return { ok: false, reason: "identity" };

  // The one control that makes this a single-user server.
  if (!isAllowedEmail(env, email)) return { ok: false, reason: "forbidden", email };

  return { ok: true, identity: { email, name: claims.name } };
}
