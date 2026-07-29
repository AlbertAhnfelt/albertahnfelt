# Abbe

Personal second-brain remote MCP server. Cloudflare Worker + R2, no-RAG
(Karpathy LLM-wiki pattern: `search` only routes to pages, the agent reads
whole pages via `read_page`). Design doc: vault `ai/Abbe Architecture.md`.

## Layout in the `abbe-vault` R2 bucket

Mirrors the Obsidian vault: `human/` and `external/` are read-only sources;
`wiki/` and `ai/` are AI-writable. Deleted pages land in `wiki/.trash/`.

## MCP tools

All writes use optimistic concurrency (compare-and-swap on R2 etags): overwrites
require the etag from a prior `read_page`, creates fail if the page exists, and
concurrent modification returns an error instead of losing a write.

- `list(prefix?)` — `ls`-style listing of folders/files under a prefix
- `search(query)` — matches page paths + lines of `wiki/index.md`, returns paths
- `read_page(path)` — full page markdown + its etag
- `write_page(path, content, expected_etag?)` — create (no etag) or full overwrite (with etag)
- `edit_page(path, old_string, new_string, replace_all?)` — surgical string replacement
- `move_page(from, to)` — rename/move within writable areas
- `delete_page(path)` — soft delete into `wiki/.trash/`
- `log_session(title_slug, type, body, tags?)` — save a distilled session log to
  `ai/log/YYYY-MM/YYYY-MM-DD <title>.md` with server-generated frontmatter
  (`provenance: ai`, date, type, tags); create-only. Meant to be driven by the
  user-invoked `log` MCP prompt (`/mcp__abbe__log` in Claude Code), which carries
  the editorial instructions for distilling a session.

Server instructions (the agents' standing orders — directory contract, index
maintenance, conventions) are loaded from `ai/instructions.md` in the vault at
session start, with a baked-in fallback if that page doesn't exist.

## Auth

OAuth 2.1, with Google as the identity provider. Abbe is its own OAuth server
(`@cloudflare/workers-oauth-provider`, grants in the `OAUTH_KV` namespace) and
issues its own opaque tokens to MCP clients; Google only establishes who is
asking. Clients register themselves, so no token is ever copied by hand.

`src/oauth-google.ts` implements the upstream flow: `/authorize` bounces to
Google, `/callback` exchanges the code and checks the verified email against
`ALLOWED_EMAILS`, and `/approve` mints the grant. The parsed auth request
round-trips through the browser inside Google's `state` parameter, HMAC-signed
so nobody can substitute their own `redirect_uri`. The consent screen on
`/callback` is what prevents a link someone else crafted from pointing a token
somewhere else — it names the client and its redirect target before anything is
issued.

`MCP_AUTH_TOKEN` remains as a static-bearer path on `/mcp` for headless agents
that cannot complete a browser login. It bypasses OAuth entirely, so it is as
privileged as the vault itself.

Local dev reads `.dev.vars` (copy from `.dev.vars.example`).

## Deploy

```sh
wrangler r2 bucket create abbe-vault
./scripts/upload-vault.sh                 # seed from ~/Documents/albertahnfelt-vault
wrangler kv namespace create OAUTH_KV     # id goes in wrangler.jsonc
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put ALLOWED_EMAILS        # comma-separated
wrangler secret put MCP_AUTH_TOKEN        # long random token, headless use only
npm run deploy
```

The Google OAuth client (Google Cloud console → Credentials → OAuth client ID,
type "Web application") needs
`https://abbe.<subdomain>.workers.dev/callback` as an authorized redirect URI.

Connect from Claude Code — no token, the browser flow handles it:

```sh
claude mcp add abbe --transport http https://abbe.<subdomain>.workers.dev/mcp
```

## Dev

```sh
npm run dev     # local Worker with simulated R2
npm run check   # typecheck
```
