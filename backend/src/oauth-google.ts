/**
 * Google-backed authentication for Abbe's OAuth provider — the credential path
 * for MCP clients (agents), which hold bearer tokens rather than cookies. The
 * website's browser session is a separate path; see `web-session.ts`. Both share
 * one identity provider and one allowlist, in `google.ts`.
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
import { authorizeUrl, identityFromCode, isAllowedEmail, sign, unsign } from "./google";
import { escapeHtml, page } from "./html";

/** How long the human has to click Approve after signing in with Google. */
const APPROVAL_TTL_MS = 5 * 60 * 1000;

type Env = Cloudflare.Env & { OAUTH_PROVIDER: OAuthHelpers };

/** The identity we store on the grant; surfaces to tools as ctx.props. */
export type GrantProps = { email: string; name?: string };

type StatePayload = { req: AuthRequest };
type ApprovalPayload = { req: AuthRequest; email: string; name?: string; iat: number };

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).toString();
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
  return Response.redirect(authorizeUrl(env, callbackUrl(request), state), 302);
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

  const result = await identityFromCode(env, code, callbackUrl(request));
  if (!result.ok) {
    if (result.reason === "exchange") {
      return page("Sign-in failed", "<h1>Sign-in failed</h1><p>Google rejected the authorization code.</p>", 502);
    }
    if (result.reason === "identity") {
      return page("Sign-in failed", "<h1>Sign-in failed</h1><p>Google did not return a usable verified identity.</p>", 401);
    }
    return page(
      "Not authorized",
      `<h1>Not authorized</h1><p><code>${escapeHtml(result.email)}</code> is not allowed to access this vault.</p>`,
      403,
    );
  }
  const { email, name } = result.identity;

  const client = await env.OAUTH_PROVIDER.lookupClient(state.req.clientId);
  const approval = await sign(env, {
    req: state.req,
    email,
    name,
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
  if (!isAllowedEmail(env, approval.email)) {
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
