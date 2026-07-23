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

Server instructions (the agents' standing orders — directory contract, index
maintenance, conventions) are loaded from `ai/instructions.md` in the vault at
session start, with a baked-in fallback if that page doesn't exist.

## Auth

Bearer token on every `/mcp` request, checked with a constant-time digest
comparison. Set it with `wrangler secret put MCP_AUTH_TOKEN`. Local dev reads
`.dev.vars` (copy from `.dev.vars.example`). OAuth upgrade planned later.

## Deploy (once R2 is enabled on the account)

```sh
wrangler r2 bucket create abbe-vault
./scripts/upload-vault.sh            # seed from ~/Documents/albertahnfelt-vault
wrangler secret put MCP_AUTH_TOKEN   # paste a long random token
npm run deploy
```

Connect from Claude Code:

```sh
claude mcp add abbe --transport http https://abbe.<subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

## Dev

```sh
npm run dev     # local Worker with simulated R2
npm run check   # typecheck
```
