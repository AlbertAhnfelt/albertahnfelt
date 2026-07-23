# Abbe

Personal second-brain remote MCP server. Cloudflare Worker + R2, no-RAG
(Karpathy LLM-wiki pattern: `search` only routes to pages, the agent reads
whole pages via `read_page`). Design doc: vault `ai/Abbe Architecture.md`.

## Layout in the `abbe-vault` R2 bucket

Mirrors the Obsidian vault: `human/`, `external/`, `ai/` are read-only sources
(`ingest` may only *add* files under `external/inbox/`, never overwrite);
`wiki/` is the only AI-writable area (`write_page`).

## MCP tools

- `search(query)` — matches page paths + lines of `wiki/index.md`, returns paths
- `read_page(path)` — returns full page markdown
- `write_page(path, content)` — `wiki/**.md` only
- `ingest(filename, content)` — create-only into `external/inbox/`

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
