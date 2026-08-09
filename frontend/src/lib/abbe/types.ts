/**
 * What the Abbe terminal is made of.
 *
 * Everything here crosses the wire from the Worker or is derived from something
 * that did, which is why none of it is trusted as markup anywhere: replies are
 * model-generated, tool details are model-generated, and page titles are vault
 * filenames. Svelte's `{value}` interpolation makes text nodes, and no component
 * in this feature uses `{@html}`.
 */

/** A conversation as the rail knows it. No transcript. */
export type ChatSummary = {
  id: string
  title: string
  updated_at: number
}

/** One stored turn, as /web/chats/:id returns it. */
export type StoredMessage = {
  id: number
  role: 'user' | 'model'
  text: string
  created_at: number
  partial: boolean
}

/**
 * A tool call. The same shape arrives two ways — live on the chat stream and
 * stored on a transcript — which is why `message_id` is optional: live, the
 * reply it belongs to does not have an id yet.
 */
export type ToolEvent = {
  name: string
  detail: string
  ok: boolean
  ms: number | null
  message_id?: number | null
}

/** A vault page, as /web/vault/pages lists it. Used by /vault search. */
export type VaultPage = {
  path: string
  title: string
  folder: string
}

/** One line of a system block: a label, and either text or a link. */
export type SysRow = {
  key: string
  value: string
  href?: string
}

/**
 * A row on screen.
 *
 * The transcript used to be built by appending elements as things happened, so
 * "what is on screen" only existed as DOM. Here it is a list, and the DOM is
 * what Svelte makes of it — which is the whole reason the scoped styles reach
 * these rows at all.
 */
export type Row =
  | {
      kind: 'said'
      id: number
      role: 'me' | 'abbe'
      text: string
      at: number
      partial: boolean
      streaming: boolean
    }
  | { kind: 'tool'; id: number; tool: ToolEvent }
  | { kind: 'sys'; id: number; heading: string; rows: SysRow[] }

/** One line of the chat stream. */
export type StreamEvent = {
  conversation?: { id: string; title: string; created_at: number }
  tool?: ToolEvent
  delta?: string
  done?: boolean
  error?: string
}
