-- Conversation history for the website chat.
--
-- Three tables rather than one JSON blob per conversation: the cron sweep wants
-- to ask "which conversations have gone quiet" without reading any transcript,
-- and a transcript wants to be read without its tool noise.
--
-- Times are integer milliseconds since the epoch, not ISO strings: everything
-- that touches them here is arithmetic (ordering, an idle cutoff), and SQLite
-- has no date type to make the string version cheaper.

CREATE TABLE conversations (
  -- 64 hex chars from crypto.getRandomValues, minted server-side. Opaque and
  -- unguessable, because it appears in a URL the browser can be handed.
  id TEXT PRIMARY KEY,
  -- The owner, taken from the session record in KV and never from a request.
  -- Single-user today; the column is what keeps that from being load-bearing.
  email TEXT NOT NULL,
  -- Derived from the first user message. Display only — never a path component.
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Last message, in either direction. The idle clock the sweep reads.
  updated_at INTEGER NOT NULL,
  -- Authoritative count, so the next `seq` needs no MAX() over messages.
  message_count INTEGER NOT NULL DEFAULT 0,
  -- Which model answered last. Recorded because it is config (GEMINI_MODEL) and
  -- will differ across a conversation's life.
  model TEXT,
  -- Set once the sweep has distilled this conversation into the vault.
  logged_at INTEGER,
  log_path TEXT
);

-- Both real access patterns: the sidebar (newest first, one owner) and the
-- sweep (unlogged and idle). The partial index keeps the sweep's scan
-- proportional to what is still outstanding rather than to the whole history.
CREATE INDEX conversations_by_owner ON conversations (email, updated_at DESC);
CREATE INDEX conversations_unlogged ON conversations (updated_at) WHERE logged_at IS NULL;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  -- Position within the conversation. Ordering never depends on created_at,
  -- which two messages in one turn can share.
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  model TEXT,
  -- 1 when the stream died before the model finished. Kept rather than dropped:
  -- the tokens were already paid for and half an answer is still context.
  partial INTEGER NOT NULL DEFAULT 0
);

-- Unique, not merely indexed: a duplicate seq would make the transcript's order
-- undefined, and this turns that into a failed write instead.
CREATE UNIQUE INDEX messages_by_conversation ON messages (conversation_id, seq);

-- What Abbe did to answer. Never shown to the browser as things stand; this is
-- for the sweep, and for being able to see why a reply said what it said.
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  -- The model message this round of calls led to. Null if the turn produced no
  -- message at all, which is why there is no NOT NULL here.
  message_id INTEGER REFERENCES messages (id),
  round INTEGER NOT NULL,
  name TEXT NOT NULL,
  -- JSON, truncated. Vault-derived text in `result`, so it is stored as the
  -- opaque string it is and never interpolated anywhere.
  args TEXT,
  result TEXT,
  ok INTEGER NOT NULL,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX tool_calls_by_message ON tool_calls (message_id);
