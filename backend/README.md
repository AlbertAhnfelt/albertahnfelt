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

Google is the only identity provider and `ALLOWED_EMAILS` the only allowlist —
that shared half lives in `src/google.ts`. What differs downstream is the
credential, because the two things that ask are different:

| Asking | Credential | Path | Can reach |
| --- | --- | --- | --- |
| MCP clients (agents) | opaque OAuth bearer token | `/authorize` → `/callback` → `/approve` | `/mcp`, all vault tools |
| a browser on albertahnfelt.com | HttpOnly session cookie | `/web/login` → `/web/callback` | `/web/me` only |

An agent has no cookie jar, so it needs a token in a header. A browser must not
hold a token — anything JavaScript can read, an XSS bug can steal — so it gets a
cookie its own page code cannot see. The website cookie is deliberately *not*
accepted on `/mcp`: it proves "signed in" and nothing more.

### MCP clients

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

### The website (`src/web-session.ts`)

`/web/login` → Google → `/web/callback` sets `abbe_session`: an opaque random id,
stored in `OAUTH_KV` (prefix `websession:`) as its SHA-256 hash only, so a dump of
the namespace yields nothing usable. `HttpOnly; Secure; SameSite=Lax`, seven days.
`/web/me` answers "signed in?" for the nav; `POST /web/logout` deletes the record.

The allowlist is re-checked on every request, so taking an address out of
`ALLOWED_EMAILS` logs out every session it owns immediately — that is the
revocation lever, alongside deleting the KV record.

Two things keep the flow honest: a login nonce that must come back both in
Google's signed `state` *and* in a short-lived cookie (so a callback can only
complete a login this browser started), and `returnTo` restricted to a plain
same-origin path (so the flow cannot be used as an open redirect).

The cookie is only first-party because the browser never talks to `workers.dev`
directly: `frontend/vercel.json` rewrites
`https://www.albertahnfelt.com/api/abbe/web/*` onto this Worker's `/web/*`.
Hence `SITE_ORIGIN` and `API_BASE_PATH` in `wrangler.jsonc` — Google's
`redirect_uri` and the cookie `Path` are built from config, never from the
request, since behind the proxy the inbound `Host` is the workers.dev name. The
rewrite is scoped to `/web/`, so `/mcp` is not reachable through the site.

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
type "Web application") needs two authorized redirect URIs — one per credential
path:

- `https://abbe.<subdomain>.workers.dev/callback` — MCP clients
- `https://www.albertahnfelt.com/api/abbe/web/callback` — website login

Connect from Claude Code — no token, the browser flow handles it:

```sh
claude mcp add abbe --transport http https://abbe.<subdomain>.workers.dev/mcp
```

## Dev

```sh
npm run dev     # local Worker with simulated R2
npm run check   # typecheck
npm run types   # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

For the website login end to end, run this alongside `astro dev` in `frontend/`:
its Vite proxy mirrors the Vercel rewrite, so `/api/abbe/web/*` on
`localhost:4321` reaches the local Worker. Set `SITE_ORIGIN=http://localhost:4321`
in `.dev.vars` first, and add that callback to the Google client.
