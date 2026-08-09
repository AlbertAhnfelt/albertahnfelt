/**
 * GET /web/connectors — how the connectors are doing.
 *
 * Read-only in the strong sense: there is no write path in this file, so no
 * request arriving here can change anything regardless of what it says. The
 * connectors run on a cron and are configured in wrangler.jsonc; there is
 * nothing for a browser to set.
 *
 * It exists because the characteristic failure of a nightly job is silence. A
 * connector that stopped in March looks exactly like one with nothing new to
 * report, and without somewhere to see "last succeeded" the difference is only
 * noticed months later when someone goes looking for a film that never arrived.
 */

import { connectorStatus } from "./connectors/run";
import { currentSession } from "./web-session";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // An authenticated body in a shared cache is the same leak as no
      // authentication at all.
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleConnectors(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405);
  }

  const session = await currentSession(request, env);
  if (!session) return json({ error: "not signed in" }, 401);

  if (new URL(request.url).pathname !== "/web/connectors") {
    return json({ error: "not found" }, 404);
  }

  return json({ connectors: await connectorStatus(env) });
}
