import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { isAuthorized } from "./auth";
import { handleChat } from "./chat";
import { DISTILL_INSTRUCTIONS } from "./log";
import googleHandler, { type GrantProps } from "./oauth-google";
import { sweep } from "./sweep";
import { handleChats } from "./web-chats";
import { handleVault } from "./web-vault";
import { handleWebSession } from "./web-session";
import { FALLBACK_INSTRUCTIONS, loadInstructions } from "./vault";
import { TOOLS } from "./vault-tools";

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

  /**
   * Every tool comes from the shared spec table, so the MCP surface and the
   * website chat expose exactly the same vault, with the same guards.
   */
  private registerTools(server: McpServer) {
    for (const spec of TOOLS) {
      server.registerTool(
        spec.name,
        { description: spec.description, inputSchema: spec.input },
        async (args: Record<string, unknown>) => {
          const { blocks, isError } = await spec.handler(this.env.VAULT, args);
          return {
            content: blocks.map((text) => ({ type: "text" as const, text })),
            ...(isError ? { isError: true } : {}),
          };
        },
      );
    }

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
              // The wording lives in log.ts, because the nightly sweep hands the
              // same instructions to a model and the two must not drift.
              text: `The user wants this session logged to their second-brain vault. Distill the conversation so far and save it with the log_session tool.

${DISTILL_INSTRUCTIONS}

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
    // Routed here rather than inside handleWebSession so chat.ts can import the
    // session check from web-session.ts without the two importing each other.
    if (url.pathname === "/web/chat") {
      return handleChat(request, env, ctx);
    }

    if (url.pathname.startsWith("/web/vault/")) {
      return handleVault(request, env);
    }

    // Conversation history. Read-only, and matched before the generic /web/
    // branch below so it reaches its own handler rather than a 404.
    if (url.pathname === "/web/chats" || url.pathname.startsWith("/web/chats/")) {
      return handleChats(request, env);
    }

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

  /**
   * The nightly cron (see `triggers` in wrangler.jsonc). Distils website
   * conversations that have gone quiet into the vault's log.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<Env>;
