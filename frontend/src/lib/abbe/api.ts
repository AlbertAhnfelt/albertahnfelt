/**
 * Every call the terminal makes, in one place.
 *
 * All of them are same-origin, so the HttpOnly session cookie rides along and
 * the Worker re-checks it on each one. Nothing here holds a credential — the
 * cookie the page's own code can read carries no authority, and this module
 * never reads even that.
 */

import type { ChatSummary, StoredMessage, StreamEvent, ToolEvent, VaultPage } from './types'

export const API = '/api/abbe/web'

/** The shape the Worker mints. Anything else is not a conversation id. */
const ID = /^[0-9a-f]{64}$/

/**
 * Checked before an id is put in a URL or a fetch, never after. An id that
 * fails this never becomes a request — the Worker refuses it too, but a
 * malformed one should not get that far.
 */
export function isConversationId(value: string): boolean {
  return ID.test(value)
}

const JSON_HEADERS = { accept: 'application/json' }

/** Who is asking, and which model answers. The authority on the session. */
export async function fetchMe(): Promise<{ ok: boolean; model?: string }> {
  const res = await fetch(`${API}/me`, { headers: JSON_HEADERS })
  if (!res.ok) return { ok: false }
  const body = (await res.json()) as { model?: unknown }
  return { ok: true, model: typeof body.model === 'string' ? body.model : undefined }
}

export async function fetchChats(): Promise<ChatSummary[]> {
  const res = await fetch(`${API}/chats`, { headers: JSON_HEADERS })
  if (!res.ok) throw new Error(String(res.status))
  return ((await res.json()) as { chats: ChatSummary[] }).chats
}

export async function fetchTranscript(
  id: string,
): Promise<{ messages: StoredMessage[]; tools: ToolEvent[] }> {
  if (!isConversationId(id)) throw new Error('bad id')
  const res = await fetch(`${API}/chats/${id}`, { headers: JSON_HEADERS })
  if (!res.ok) throw new Error(String(res.status))
  const body = (await res.json()) as { messages: StoredMessage[]; tools?: ToolEvent[] }
  return { messages: body.messages, tools: body.tools ?? [] }
}

export async function fetchVaultPages(): Promise<VaultPage[]> {
  const res = await fetch(`${API}/vault/pages`, { headers: JSON_HEADERS })
  if (!res.ok) throw new Error(String(res.status))
  return ((await res.json()) as { pages: VaultPage[] }).pages
}

/**
 * One turn, as a stream of events.
 *
 * NDJSON: one JSON object per line, so a line split across two network chunks
 * has to be held back until its newline arrives. Aborting `signal` stops this
 * side reading; the Worker finishes the turn under waitUntil and stores what it
 * generated, which is what keeps an interrupted turn consistent with a reload.
 */
export async function* streamChat(
  conversationId: string | null,
  text: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, text }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(String(res.status))

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      yield JSON.parse(line) as StreamEvent
    }
  }
}
