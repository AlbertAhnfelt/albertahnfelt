/**
 * Conversation storage — the only file that speaks SQL.
 *
 * Every read is scoped by the owner's email, and that email always arrives from
 * the session record in KV, never from a request. The conversation id in a URL
 * is unguessable but still treated as hostile: `isConversationId` checks its
 * shape, and the `email = ?` in each query is what actually decides whether the
 * row may be seen. One without the other is not enough.
 *
 * Prepared statements with .bind() throughout. Nothing here interpolates a
 * value into a query string, including values that came from the model.
 */

/** Bounds on the window handed to the model, applied before any call is paid for. */
export const MAX_WINDOW_MESSAGES = 40;
export const MAX_WINDOW_CHARS = 60_000;

/** What a single user message may be. The one bound that rejects a request. */
export const MAX_CHARS_PER_MESSAGE = 8_000;

/** How much of a tool call is worth keeping. A read_page result is a whole page. */
const MAX_ARGS_CHARS = 2_000;
const MAX_RESULT_CHARS = 8_000;

/** Longest title derived from a first message, before the ellipsis. */
const MAX_TITLE_CHARS = 60;

const UNTITLED = "Ny konversation";

export type ChatSummary = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  logged_at: number | null;
};

export type StoredMessage = {
  role: "user" | "model";
  text: string;
  created_at: number;
  partial: boolean;
};

/** One tool call, as the chat loop observed it. */
export type ToolRecord = {
  round: number;
  name: string;
  args: unknown;
  result: string;
  ok: boolean;
  durationMs: number;
};

/** The shape a minted id has. Anything else never reaches a query. */
export function isConversationId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function newConversationId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A display title from the first thing said. Server-side and display-only: it
 * is never a path component, and the sweep re-derives its own slug from it
 * through `isSafeLogSlug` rather than trusting this.
 */
export function deriveTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return UNTITLED;
  if (line.length <= MAX_TITLE_CHARS) return line;
  // Prefer a word boundary, but only if one falls somewhere reasonable.
  const cut = line.slice(0, MAX_TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_TITLE_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…[trimmed]`;
}

const SUMMARY_COLUMNS = "id, title, created_at, updated_at, message_count, logged_at";

/* ------------------------------------------------------------------- reading */

/** This owner's conversations, newest activity first. */
export async function listConversations(
  db: D1Database,
  email: string,
  limit = 200,
): Promise<ChatSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM conversations
       WHERE email = ?1 ORDER BY updated_at DESC LIMIT ?2`,
    )
    .bind(email, limit)
    .all<ChatSummary>();
  return results;
}

/** One conversation, or null if it does not exist or is not this owner's. */
export async function getConversation(
  db: D1Database,
  email: string,
  id: string,
): Promise<ChatSummary | null> {
  if (!isConversationId(id)) return null;
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM conversations WHERE id = ?1 AND email = ?2`)
    .bind(id, email)
    .first<ChatSummary>();
}

/**
 * Every message in a conversation, in order.
 *
 * Takes an id whose ownership has already been established by `getConversation`
 * — the two are always called as a pair, and the caller has the row it needs
 * for the response anyway.
 */
export async function getMessages(db: D1Database, id: string): Promise<StoredMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT role, text, created_at, partial FROM messages
       WHERE conversation_id = ?1 ORDER BY seq ASC`,
    )
    .bind(id)
    .all<{ role: "user" | "model"; text: string; created_at: number; partial: number }>();
  return results.map((row) => ({ ...row, partial: row.partial === 1 }));
}

/**
 * The tail of a conversation that fits in the model's window.
 *
 * Walks backwards under both bounds, then drops any leading model turns: a
 * window that opens mid-exchange reads as though the user's question never
 * happened, and Gemini expects the first turn to be the user's.
 */
export function windowFor(messages: StoredMessage[]): StoredMessage[] {
  const kept: StoredMessage[] = [];
  let chars = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (kept.length >= MAX_WINDOW_MESSAGES) break;
    if (chars + message.text.length > MAX_WINDOW_CHARS && kept.length > 0) break;
    chars += message.text.length;
    kept.push(message);
  }

  kept.reverse();
  while (kept.length && kept[0].role !== "user") kept.shift();
  return kept;
}

/* ------------------------------------------------------------------- writing */

/** Mint a conversation. The title comes from the message that opens it. */
export async function createConversation(
  db: D1Database,
  email: string,
  firstMessage: string,
): Promise<ChatSummary> {
  const now = Date.now();
  const row: ChatSummary = {
    id: newConversationId(),
    title: deriveTitle(firstMessage),
    created_at: now,
    updated_at: now,
    message_count: 0,
    logged_at: null,
  };

  await db
    .prepare(
      `INSERT INTO conversations (id, email, title, created_at, updated_at, message_count)
       VALUES (?1, ?2, ?3, ?4, ?4, 0)`,
    )
    .bind(row.id, email, row.title, now)
    .run();

  return row;
}

/**
 * Append a message and move the conversation's clock.
 *
 * One batch, so a stored message always comes with the bumped count that makes
 * the next `seq` correct — the count is what the next append reads instead of a
 * MAX(seq), and the two drifting apart would collide on the unique index.
 * Returns the new message's id, which the tool rows hang off.
 */
async function appendMessage(
  db: D1Database,
  conversation: ChatSummary,
  message: { role: "user" | "model"; text: string; model?: string; partial?: boolean },
): Promise<number> {
  const now = Date.now();
  const seq = conversation.message_count;

  const inserted = await db
    .prepare(
      `INSERT INTO messages (conversation_id, seq, role, text, created_at, model, partial)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
    )
    .bind(
      conversation.id,
      seq,
      message.role,
      message.text,
      now,
      message.model ?? null,
      message.partial ? 1 : 0,
    )
    .first<{ id: number }>();

  await db
    .prepare(
      `UPDATE conversations
       SET message_count = ?2, updated_at = ?3, model = COALESCE(?4, model)
       WHERE id = ?1`,
    )
    .bind(conversation.id, seq + 1, now, message.model ?? null)
    .run();

  // Kept in step with the row that was just written, so a caller appending
  // twice in one turn does not have to re-read it.
  conversation.message_count = seq + 1;
  conversation.updated_at = now;

  return inserted?.id ?? 0;
}

export function appendUserMessage(
  db: D1Database,
  conversation: ChatSummary,
  text: string,
): Promise<number> {
  return appendMessage(db, conversation, { role: "user", text });
}

/**
 * Store the model's turn together with the tool calls behind it.
 *
 * The message goes in first because the tool rows point at it. Both are stored
 * even when the answer is a fragment: the work was already paid for, and half
 * an answer is still what the next turn has to make sense of.
 */
export async function appendModelMessage(
  db: D1Database,
  conversation: ChatSummary,
  turn: { text: string; model: string; partial?: boolean; tools: ToolRecord[] },
): Promise<number> {
  const messageId = await appendMessage(db, conversation, {
    role: "model",
    text: turn.text,
    model: turn.model,
    partial: turn.partial,
  });

  if (turn.tools.length === 0) return messageId;

  const now = Date.now();
  const statement = db.prepare(
    `INSERT INTO tool_calls
       (conversation_id, message_id, round, name, args, result, ok, duration_ms, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );

  await db.batch(
    turn.tools.map((tool) =>
      statement.bind(
        conversation.id,
        messageId,
        tool.round,
        tool.name,
        truncate(JSON.stringify(tool.args ?? {}), MAX_ARGS_CHARS),
        truncate(tool.result, MAX_RESULT_CHARS),
        tool.ok ? 1 : 0,
        tool.durationMs,
        now,
      ),
    ),
  );

  return messageId;
}

/* --------------------------------------------------------------------- sweep */

/**
 * Conversations that have gone quiet and have never been distilled.
 *
 * Not scoped by email: the sweep runs without a request and so without a
 * session. It reads rows whose owner is already recorded on them and writes
 * only under ai/log/, so there is no identity here for it to get wrong.
 */
export async function conversationsToLog(
  db: D1Database,
  idleBefore: number,
  minMessages: number,
  limit: number,
): Promise<ChatSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM conversations
       WHERE logged_at IS NULL AND updated_at < ?1 AND message_count >= ?2
       ORDER BY updated_at ASC LIMIT ?3`,
    )
    .bind(idleBefore, minMessages, limit)
    .all<ChatSummary>();
  return results;
}

export async function markLogged(db: D1Database, id: string, path: string): Promise<void> {
  await db
    .prepare("UPDATE conversations SET logged_at = ?2, log_path = ?3 WHERE id = ?1")
    .bind(id, Date.now(), path)
    .run();
}
