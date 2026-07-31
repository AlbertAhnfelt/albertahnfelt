import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { isAuthorized } from "./auth";
import googleHandler, { type GrantProps } from "./oauth-google";
import { handleWebSession } from "./web-session";
import {
  FALLBACK_INSTRUCTIONS,
  INDEX_KEY,
  LOG_PREFIX,
  TRASH_PREFIX,
  isSafeLogSlug,
  vaultDate,
  isSafeListPrefix,
  isSafeMarkdownKey,
  isWritableKey,
  listAllKeys,
  listLevel,
  loadInstructions,
} from "./vault";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

/** R2 put precondition for "create only if the key does not exist yet". */
const CREATE_ONLY = { onlyIf: new Headers({ "If-None-Match": "*" }) };

const MD = { httpMetadata: { contentType: "text/markdown; charset=utf-8" } };

const WRITE_SCOPE_MSG = "writes are only allowed under wiki/ or ai/ (and never into the trash)";

/**
 * What the Durable Object sees. `email`/`name` arrive from the OAuth grant (absent
 * on the static-token path); `instructions` is injected per request by the
 * ingress handler, since R2 reads in the DO's startup path hang.
 */
type Props = Partial<GrantProps> & { instructions?: string };

export class AbbeMCP extends McpAgent<Env, unknown, Props> {
  // The server is built in init() (from props), never via I/O in the DO startup
  // path — R2 calls inside the Durable Object's blockConcurrencyWhile hang.
  private resolveServer!: (s: McpServer) => void;
  server: Promise<McpServer> = new Promise((resolve) => {
    this.resolveServer = resolve;
  });
  private built = false;

  async init() {
    if (this.built) return;
    this.built = true;
    const instructions = this.props?.instructions ?? FALLBACK_INSTRUCTIONS;
    const server = new McpServer({ name: "abbe", version: "0.3.0" }, { instructions });
    this.registerTools(server);
    this.resolveServer(server);
  }

  private registerTools(server: McpServer) {
    const vault = () => this.env.VAULT;

    server.registerTool(
      "list",
      {
        description:
          "List the vault like `ls`: folders and files directly under a prefix. " +
          'Use prefix "" (or omit) for the vault root, "wiki/" for the wiki, etc.',
        inputSchema: { prefix: z.string().default("") },
      },
      async ({ prefix }) => {
        if (!isSafeListPrefix(prefix)) return err(`Invalid prefix "${prefix}".`);
        const { dirs, files } = await listLevel(vault(), prefix);
        if (dirs.length === 0 && files.length === 0) {
          return text(`Nothing under "${prefix}".`);
        }
        const lines = [
          ...dirs.map((d) => `${d} (dir)`),
          ...files.map((f) => `${f.key} (${f.size} B)`),
        ];
        return text(lines.join("\n"));
      },
    );

    server.registerTool(
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

        const keys = await listAllKeys(vault());
        const pathHits = keys.filter(
          (k) => k.endsWith(".md") && !k.startsWith(TRASH_PREFIX) && matches(k),
        );

        let indexHits: string[] = [];
        const index = await vault().get(INDEX_KEY);
        if (index) {
          indexHits = (await index.text()).split("\n").filter(matches);
        }

        if (pathHits.length === 0 && indexHits.length === 0) {
          return text(`No matches for "${query}". Try broader terms, or explore with list.`);
        }
        const parts: string[] = [];
        if (pathHits.length) parts.push(`## Matching pages\n${pathHits.join("\n")}`);
        if (indexHits.length) parts.push(`## Matching lines in ${INDEX_KEY}\n${indexHits.join("\n")}`);
        return text(parts.join("\n\n"));
      },
    );

    server.registerTool(
      "read_page",
      {
        description:
          "Read a full vault page (markdown) by its path, e.g. wiki/some-topic.md. " +
          "Returns the page's etag — keep it if you intend to overwrite the page.",
        inputSchema: { path: z.string().min(1) },
      },
      async ({ path }) => {
        if (!isSafeMarkdownKey(path)) {
          return err(`Invalid path "${path}": must be a relative .md path with no traversal.`);
        }
        const obj = await vault().get(path);
        if (!obj) return err(`Page not found: ${path}. Use search or list to locate pages.`);
        return {
          content: [
            { type: "text" as const, text: `${path} | etag: ${obj.etag}` },
            { type: "text" as const, text: await obj.text() },
          ],
        };
      },
    );

    server.registerTool(
      "write_page",
      {
        description:
          "Create a new page, or fully overwrite an existing one. To CREATE: omit expected_etag " +
          "(fails if the page already exists). To OVERWRITE: pass the etag from read_page " +
          "(fails if the page changed since you read it — re-read and retry). " +
          "For small changes to existing pages prefer edit_page. " +
          `Writable areas: wiki/ and ai/ only; overwrites are permanent (no version history). ` +
          `After creating a wiki page, add it to ${INDEX_KEY}.`,
        inputSchema: {
          path: z.string().min(1),
          content: z.string(),
          expected_etag: z.string().optional(),
        },
      },
      async ({ path, content, expected_etag }) => {
        if (!isWritableKey(path)) return err(`Refused: ${WRITE_SCOPE_MSG} (got "${path}").`);
        if (expected_etag) {
          const res = await vault().put(path, content, {
            ...MD,
            onlyIf: { etagMatches: expected_etag },
          });
          if (!res) {
            return err(
              `Conflict: ${path} changed since you read it (or does not exist). ` +
                "Re-read the page and retry with the fresh etag.",
            );
          }
          return text(`Overwrote ${path} (${content.length} chars). New etag: ${res.etag}`);
        }
        const res = await vault().put(path, content, { ...MD, ...CREATE_ONLY });
        if (!res) {
          return err(
            `Refused: ${path} already exists. Read it and pass expected_etag to overwrite.`,
          );
        }
        return text(`Created ${path} (${content.length} chars). Etag: ${res.etag}`);
      },
    );

    server.registerTool(
      "edit_page",
      {
        description:
          "Make a surgical edit to an existing page by exact string replacement — cheaper and " +
          "safer than rewriting the whole page. old_string must match exactly once (set " +
          "replace_all to replace every occurrence). To append, use the page's final line as " +
          "old_string and include it in new_string.",
        inputSchema: {
          path: z.string().min(1),
          old_string: z.string().min(1),
          new_string: z.string(),
          replace_all: z.boolean().default(false),
        },
      },
      async ({ path, old_string, new_string, replace_all }) => {
        if (!isWritableKey(path)) return err(`Refused: ${WRITE_SCOPE_MSG} (got "${path}").`);
        const obj = await vault().get(path);
        if (!obj) return err(`Page not found: ${path}.`);
        const body = await obj.text();
        const count = body.split(old_string).length - 1;
        if (count === 0) {
          return err(`old_string not found in ${path}. Read the page and match its text exactly.`);
        }
        if (count > 1 && !replace_all) {
          return err(
            `old_string occurs ${count} times in ${path}. Add more surrounding context to make ` +
              "it unique, or set replace_all.",
          );
        }
        const updated = replace_all
          ? body.split(old_string).join(new_string)
          : body.replace(old_string, new_string);
        const res = await vault().put(path, updated, {
          ...MD,
          onlyIf: { etagMatches: obj.etag },
        });
        if (!res) {
          return err(`Conflict: ${path} changed while editing. Re-read the page and retry.`);
        }
        return text(
          `Edited ${path}: ${replace_all ? count : 1} replacement(s). New etag: ${res.etag}`,
        );
      },
    );

    server.registerTool(
      "move_page",
      {
        description:
          "Move or rename a page within the writable areas (wiki/ and ai/). Fails if the " +
          `destination already exists. Remember to update ${INDEX_KEY} and any links.`,
        inputSchema: { from: z.string().min(1), to: z.string().min(1) },
      },
      async ({ from, to }) => {
        if (!isWritableKey(from)) return err(`Refused: ${WRITE_SCOPE_MSG} (from "${from}").`);
        if (!isWritableKey(to)) return err(`Refused: ${WRITE_SCOPE_MSG} (to "${to}").`);
        const obj = await vault().get(from);
        if (!obj) return err(`Page not found: ${from}.`);
        const body = await obj.text();
        const res = await vault().put(to, body, { ...MD, ...CREATE_ONLY });
        if (!res) return err(`Refused: destination ${to} already exists.`);
        await vault().delete(from);
        return text(`Moved ${from} -> ${to}.`);
      },
    );

    server.registerTool(
      "log_session",
      {
        description:
          "Save a distilled session log into the vault (ai/log/). Call this ONLY when the " +
          "user explicitly asks to log/summarize the session — never on your own initiative. " +
          "The server adds path, date and frontmatter; you supply the distilled body.",
        inputSchema: {
          title_slug: z
            .string()
            .describe(
              'Short human title for the log, e.g. "second brain changes" or "auth ideas". ' +
                "Letters/digits/spaces/dashes only — the server prefixes the date.",
            ),
          type: z.enum(["changes", "ideas"]),
          body: z.string().min(1).describe("Distilled markdown body, without frontmatter."),
          tags: z.array(z.string()).default([]).describe("Optional extra topic tags."),
        },
      },
      async ({ title_slug, type, body, tags }) => {
        if (!isSafeLogSlug(title_slug)) {
          return err(
            `Invalid title_slug "${title_slug}": letters, digits, spaces and dashes only.`,
          );
        }
        const date = vaultDate();
        const path = `${LOG_PREFIX}${date.slice(0, 7)}/${date} ${title_slug}.md`;
        const allTags = [type, ...tags.filter((t) => t !== type)];
        const frontmatter = [
          "---",
          "provenance: ai",
          `date: ${date}`,
          `type: ${type}`,
          `tags: [${allTags.join(", ")}]`,
          "---",
          "",
        ].join("\n");
        const res = await vault().put(path, frontmatter + body, { ...MD, ...CREATE_ONLY });
        if (!res) {
          return err(
            `Refused: ${path} already exists. Pick a different title_slug for this session.`,
          );
        }
        return text(`Logged session to ${path} (${body.length} chars).`);
      },
    );

    server.registerPrompt(
      "log",
      {
        description:
          "Distill this session into the vault's log (ai/log/) — decisions, changes, reasoning.",
      },
      () => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `The user wants this session logged to their second-brain vault. Distill the conversation so far and save it with the log_session tool.

What to capture — only what future-you (or the user, months from now) would actually need:
- Decisions made, and the WHY behind each — reasoning is the most valuable thing to preserve.
- Concrete changes shipped (code, config, deployments): what and where, as file paths or names — never code dumps.
- Core conclusions or ideas arrived at, stated plainly.
- Open threads: what was deliberately deferred or left unresolved.

What to leave out — be ruthless:
- Play-by-play narrative, false starts, debugging detours that led nowhere.
- Anything derivable from the code or git history itself.
- Pleasantries, process talk, tool mechanics.

Form: aim for well under a page. Short declarative bullets over prose. It is better to drop a detail than to bury a decision.

Then call log_session with:
- title_slug: a few plain words naming what the session was about (the server prefixes the date).
- type: "changes" if the session primarily changed things (code, systems, config), "ideas" if it was primarily thinking/exploration.
- tags: add any extra topic tags that aid future retrieval.
- body: the distilled markdown (no frontmatter — the server adds it).

Afterwards, tell the user the saved path.`,
            },
          },
        ],
      }),
    );

    server.registerTool(
      "delete_page",
      {
        description:
          "Soft-delete a page from the writable areas: it is moved into the trash " +
          `(${TRASH_PREFIX}) rather than destroyed. Remember to update ${INDEX_KEY}.`,
        inputSchema: { path: z.string().min(1) },
      },
      async ({ path }) => {
        if (!isWritableKey(path)) return err(`Refused: ${WRITE_SCOPE_MSG} (got "${path}").`);
        const obj = await vault().get(path);
        if (!obj) return err(`Page not found: ${path}.`);
        const body = await obj.text();
        const trashKey = `${TRASH_PREFIX}${path}.${Date.now()}`;
        await vault().put(trashKey, body, MD);
        await vault().delete(path);
        return text(`Deleted ${path} (recoverable at ${trashKey}).`);
      },
    );
  }
}

// Per-isolate cache so each /mcp request doesn't re-read the instructions page.
let instructionsCache: { value: string; expires: number } | undefined;
const INSTRUCTIONS_TTL_MS = 60_000;

async function getInstructions(env: Env): Promise<string> {
  const now = Date.now();
  if (instructionsCache && instructionsCache.expires > now) return instructionsCache.value;
  const value = await loadInstructions(env.VAULT);
  instructionsCache = { value, expires: now + INSTRUCTIONS_TTL_MS };
  return value;
}

const mcpTransport = AbbeMCP.serve("/mcp", { binding: "AbbeMCP" });

/** Set the props the Durable Object reads, preserving anything already there. */
function withProps(ctx: ExecutionContext, extra: Props): void {
  const slot = ctx as { props?: Props };
  slot.props = { ...slot.props, ...extra };
}

/**
 * The authenticated /mcp endpoint. OAuthProvider only reaches this after it has
 * validated an access token and decrypted the grant's props onto ctx.props, so
 * all that is left is to add the vault instructions.
 */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    withProps(ctx, { instructions: await getInstructions(env) });
    return mcpTransport.fetch(request, env, ctx);
  },
};

const oauth = new OAuthProvider({
  apiHandlers: { "/mcp": mcpApiHandler },
  // Owns /authorize, /callback, /approve, /health and anything unmatched.
  defaultHandler: googleHandler as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["vault"],
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Browser sessions for the website. Handled ahead of the OAuth provider and
    // entirely apart from it: a /web session cookie is never a credential for
    // /mcp, so it cannot be spent on vault tools.
    if (url.pathname.startsWith("/web/")) {
      return handleWebSession(request, env);
    }

    // Static-token path for headless agents that cannot complete a browser
    // login. Interactive clients should use OAuth; this bypasses it entirely,
    // so MCP_AUTH_TOKEN stays as privileged as the vault itself.
    if (url.pathname.startsWith("/mcp") && (await isAuthorized(request, env.MCP_AUTH_TOKEN))) {
      withProps(ctx, { instructions: await getInstructions(env) });
      return mcpTransport.fetch(request, env, ctx);
    }
    return oauth.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
