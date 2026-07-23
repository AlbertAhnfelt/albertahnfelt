import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { isAuthorized } from "./auth";
import {
  INDEX_KEY,
  INGEST_PREFIX,
  WRITABLE_PREFIX,
  isSafeMarkdownKey,
  isWritableKey,
  listAllKeys,
} from "./vault";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

export class AbbeMCP extends McpAgent<Env, unknown, {}> {
  server = new McpServer({ name: "abbe", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "search",
      {
        description:
          "Route to relevant vault pages. Matches the query against page paths and against " +
          `lines of ${INDEX_KEY}. Returns page paths — always follow up with read_page to ` +
          "read a whole page; never act on index snippets alone.",
        inputSchema: { query: z.string().min(1) },
      },
      async ({ query }) => {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = (s: string) => {
          const l = s.toLowerCase();
          return terms.some((t) => l.includes(t));
        };

        const keys = await listAllKeys(this.env.VAULT);
        const pathHits = keys.filter((k) => k.endsWith(".md") && matches(k));

        let indexHits: string[] = [];
        const index = await this.env.VAULT.get(INDEX_KEY);
        if (index) {
          indexHits = (await index.text()).split("\n").filter(matches);
        }

        if (pathHits.length === 0 && indexHits.length === 0) {
          return text(`No matches for "${query}". Try broader terms, or list pages via search with a directory name (e.g. "wiki").`);
        }
        const parts: string[] = [];
        if (pathHits.length) parts.push(`## Matching pages\n${pathHits.join("\n")}`);
        if (indexHits.length) parts.push(`## Matching lines in ${INDEX_KEY}\n${indexHits.join("\n")}`);
        return text(parts.join("\n\n"));
      },
    );

    this.server.registerTool(
      "read_page",
      {
        description: "Read a full vault page (markdown) by its path, e.g. wiki/some-topic.md",
        inputSchema: { path: z.string().min(1) },
      },
      async ({ path }) => {
        if (!isSafeMarkdownKey(path)) {
          return err(`Invalid path "${path}": must be a relative .md path with no traversal.`);
        }
        const obj = await this.env.VAULT.get(path);
        if (!obj) return err(`Page not found: ${path}. Use search to locate pages.`);
        return text(await obj.text());
      },
    );

    this.server.registerTool(
      "write_page",
      {
        description:
          `Create or overwrite a page under ${WRITABLE_PREFIX} (the only AI-writable area; ` +
          "human/, external/ and ai/ are read-only sources). Overwrites are PERMANENT — there is " +
          "no version history, so read the existing page first and preserve content you aren't changing.",
        inputSchema: {
          path: z.string().min(1).describe(`Must start with ${WRITABLE_PREFIX} and end with .md`),
          content: z.string(),
        },
      },
      async ({ path, content }) => {
        if (!isWritableKey(path)) {
          return err(`Refused: writes are only allowed to ${WRITABLE_PREFIX}**.md (got "${path}").`);
        }
        const existed = (await this.env.VAULT.head(path)) !== null;
        await this.env.VAULT.put(path, content, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        });
        return text(`${existed ? "Updated" : "Created"} ${path} (${content.length} chars).`);
      },
    );

    this.server.registerTool(
      "ingest",
      {
        description:
          `Add new source material to the vault inbox (${INGEST_PREFIX}). Create-only: ` +
          "existing sources are never modified. Use write_page for wiki pages.",
        inputSchema: {
          filename: z
            .string()
            .min(1)
            .describe("Bare filename like meeting-notes-2026-07-23.md (no directories)"),
          content: z.string().min(1),
        },
      },
      async ({ filename, content }) => {
        if (filename.includes("/") || !isSafeMarkdownKey(filename)) {
          return err(`Invalid filename "${filename}": bare .md filename only.`);
        }
        const key = INGEST_PREFIX + filename;
        if (await this.env.VAULT.head(key)) {
          return err(`Refused: ${key} already exists. Sources are immutable; pick a new filename.`);
        }
        await this.env.VAULT.put(key, content, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        });
        return text(`Ingested ${key} (${content.length} chars).`);
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("abbe: ok", { status: 200 });
    }
    if (url.pathname.startsWith("/mcp")) {
      if (!(await isAuthorized(request, env.MCP_AUTH_TOKEN))) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        });
      }
      return AbbeMCP.serve("/mcp", { binding: "AbbeMCP" }).fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
