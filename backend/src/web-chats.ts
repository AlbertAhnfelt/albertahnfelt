/**
 * GET /web/chats/* — the website's conversation history.
 *
 * Read-only in the strong sense, like `web-vault.ts`: there is no write path in
 * this file, so no request arriving here can change a conversation. Writes
 * happen in `chat.ts`, as a side effect of talking.
 *
 * A conversation id is unguessable, but that is not what protects it — the
 * `email = ?` inside every query in `chats.ts` is, and it comes from the session
 * record in KV. An id belonging to someone else is a 404 here, the same as an id
 * belonging to nobody.
 */

import { getConversation, getMessages, listConversations } from "./chats";
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

/**
 * Routes every /web/chats* path.
 *
 * No `sameOrigin` check, for the reason web-vault.ts gives: browsers omit the
 * Origin header on same-origin GETs, so the guard would reject every real
 * request. These are side-effect-free reads behind HttpOnly and SameSite=Lax.
 */
export async function handleChats(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405);
  }

  const session = await currentSession(request, env);
  if (!session) return json({ error: "not signed in" }, 401);

  const { pathname } = new URL(request.url);

  // The sidebar: titles and timestamps, no transcripts.
  if (pathname === "/web/chats") {
    return json({ chats: await listConversations(env.DB, session.email) });
  }

  const id = pathname.startsWith("/web/chats/") ? pathname.slice("/web/chats/".length) : null;
  if (!id || id.includes("/")) return json({ error: "not found" }, 404);

  // Shape and ownership both, in that order — getConversation does the first
  // and refuses to query on anything that fails it.
  const conversation = await getConversation(env.DB, session.email, id);
  if (!conversation) return json({ error: "not found" }, 404);

  return json({ ...conversation, messages: await getMessages(env.DB, conversation.id) });
}
