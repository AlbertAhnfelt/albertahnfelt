/**
 * The vault toolset, defined once.
 *
 * Two surfaces call these: the MCP server in `index.ts` (for Claude and other
 * agents) and the website chat in `chat.ts` (for Gemini). Both drive the same
 * handlers, so a guard added here holds on both paths — which is the whole
 * point of the file. Only the schema is stated twice, because MCP wants a Zod
 * shape and Gemini wants an OpenAPI subset; keeping the two adjacent is what
 * makes a drift between them visible.
 */

import { z } from "zod";
import { type LogType, writeLog } from "./log";
import {
  INDEX_KEY,
  LOG_PREFIX,
  TRASH_PREFIX,
  isSafeListPrefix,
  isSafeMarkdownKey,
  isWritableKey,
  listAllKeys,
  listLevel,
} from "./vault";

/**
 * Blocks rather than one string: read_page returns its header and body as two
 * separate pieces, and MCP clients see them as two content blocks.
 */
export type ToolResult = { blocks: string[]; isError?: boolean };

export type ToolSpec = {
  name: string;
  description: string;
  /** Zod raw shape, for `server.registerTool`. */
  input: z.ZodRawShape;
  /** OpenAPI subset, for Gemini's functionDeclarations. */
  parameters: Record<string, unknown>;
  handler: (vault: R2Bucket, args: Record<string, unknown>) => Promise<ToolResult>;
};

function ok(...blocks: string[]): ToolResult {
  return { blocks };
}

function fail(message: string): ToolResult {
  return { blocks: [message], isError: true };
}

/** R2 put precondition for "create only if the key does not exist yet". */
const CREATE_ONLY = { onlyIf: new Headers({ "If-None-Match": "*" }) };

const MD = { httpMetadata: { contentType: "text/markdown; charset=utf-8" } };

const WRITE_SCOPE_MSG =
  "writes are only allowed under human/, wiki/ or ai/ (and never into the trash)";

/** Gemini rejects an OBJECT schema with no properties, so paramless tools omit it. */
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "OBJECT",
  properties,
  required,
});

const str = (description: string) => ({ type: "STRING", description });

export const TOOLS: ToolSpec[] = [
  {
    name: "list",
    description:
      "List the vault like `ls`: folders and files directly under a prefix. " +
      'Use prefix "" (or omit) for the vault root, "wiki/" for the wiki, etc.',
    input: { prefix: z.string().default("") },
    parameters: obj({ prefix: str('Vault prefix, e.g. "wiki/". Omit for the root.') }, []),
    handler: async (vault, args) => {
      const prefix = (args.prefix as string | undefined) ?? "";
      if (!isSafeListPrefix(prefix)) return fail(`Invalid prefix "${prefix}".`);
      const { dirs, files } = await listLevel(vault, prefix);
      if (dirs.length === 0 && files.length === 0) return ok(`Nothing under "${prefix}".`);
      return ok(
        [...dirs.map((d) => `${d} (dir)`), ...files.map((f) => `${f.key} (${f.size} B)`)].join("\n"),
      );
    },
  },

  {
    name: "search",
    description:
      "Route to relevant vault pages. Matches the query against page paths and against " +
      `lines of ${INDEX_KEY}. Returns page paths — always follow up with read_page to ` +
      "read a whole page; never act on index snippets alone.",
    input: { query: z.string().min(1) },
    parameters: obj({ query: str("Search terms.") }, ["query"]),
    handler: async (vault, args) => {
      const query = args.query as string;
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = (s: string) => {
        const l = s.toLowerCase();
        return terms.some((t) => l.includes(t));
      };

      const keys = await listAllKeys(vault);
      const pathHits = keys.filter(
        (k) => k.endsWith(".md") && !k.startsWith(TRASH_PREFIX) && matches(k),
      );

      let indexHits: string[] = [];
      const index = await vault.get(INDEX_KEY);
      if (index) indexHits = (await index.text()).split("\n").filter(matches);

      if (pathHits.length === 0 && indexHits.length === 0) {
        return ok(`No matches for "${query}". Try broader terms, or explore with list.`);
      }
      const parts: string[] = [];
      if (pathHits.length) parts.push(`## Matching pages\n${pathHits.join("\n")}`);
      if (indexHits.length) {
        parts.push(`## Matching lines in ${INDEX_KEY}\n${indexHits.join("\n")}`);
      }
      return ok(parts.join("\n\n"));
    },
  },

  {
    name: "read_page",
    description:
      "Read a full vault page (markdown) by its path, e.g. wiki/some-topic.md. " +
      "Returns the page's etag — keep it if you intend to overwrite the page.",
    input: { path: z.string().min(1) },
    parameters: obj({ path: str("Vault path ending in .md.") }, ["path"]),
    handler: async (vault, args) => {
      const path = args.path as string;
      if (!isSafeMarkdownKey(path)) {
        return fail(`Invalid path "${path}": must be a relative .md path with no traversal.`);
      }
      const page = await vault.get(path);
      if (!page) return fail(`Page not found: ${path}. Use search or list to locate pages.`);
      return ok(`${path} | etag: ${page.etag}`, await page.text());
    },
  },

  {
    name: "write_page",
    description:
      "Create a new page, or fully overwrite an existing one. To CREATE: omit expected_etag " +
      "(fails if the page already exists). To OVERWRITE: pass the etag from read_page " +
      "(fails if the page changed since you read it — re-read and retry). " +
      "For small changes to existing pages prefer edit_page. " +
      "Writable areas: human/, wiki/ and ai/ only; overwrites are permanent (no version " +
      "history). " +
      `After creating a wiki page, add it to ${INDEX_KEY}.`,
    input: {
      path: z.string().min(1),
      content: z.string(),
      expected_etag: z.string().optional(),
    },
    parameters: obj(
      {
        path: str("Vault path under human/, wiki/ or ai/, ending in .md."),
        content: str("Full page content."),
        expected_etag: str("Etag from read_page. Omit to create a new page."),
      },
      ["path", "content"],
    ),
    handler: async (vault, args) => {
      const path = args.path as string;
      const content = args.content as string;
      const expectedEtag = args.expected_etag as string | undefined;

      if (!isWritableKey(path)) return fail(`Refused: ${WRITE_SCOPE_MSG} (got "${path}").`);

      if (expectedEtag) {
        const res = await vault.put(path, content, { ...MD, onlyIf: { etagMatches: expectedEtag } });
        if (!res) {
          return fail(
            `Conflict: ${path} changed since you read it (or does not exist). ` +
              "Re-read the page and retry with the fresh etag.",
          );
        }
        return ok(`Overwrote ${path} (${content.length} chars). New etag: ${res.etag}`);
      }

      const res = await vault.put(path, content, { ...MD, ...CREATE_ONLY });
      if (!res) {
        return fail(`Refused: ${path} already exists. Read it and pass expected_etag to overwrite.`);
      }
      return ok(`Created ${path} (${content.length} chars). Etag: ${res.etag}`);
    },
  },

  {
    name: "edit_page",
    description:
      "Make a surgical edit to an existing page by exact string replacement — cheaper and " +
      "safer than rewriting the whole page. old_string must match exactly once (set " +
      "replace_all to replace every occurrence). To append, use the page's final line as " +
      "old_string and include it in new_string.",
    input: {
      path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().default(false),
    },
    parameters: obj(
      {
        path: str("Vault path under human/, wiki/ or ai/."),
        old_string: str("Exact text to replace."),
        new_string: str("Replacement text."),
        replace_all: { type: "BOOLEAN", description: "Replace every occurrence." },
      },
      ["path", "old_string", "new_string"],
    ),
    handler: async (vault, args) => {
      const path = args.path as string;
      const oldString = args.old_string as string;
      const newString = args.new_string as string;
      const replaceAll = (args.replace_all as boolean | undefined) ?? false;

      if (!isWritableKey(path)) return fail(`Refused: ${WRITE_SCOPE_MSG} (got "${path}").`);
      const page = await vault.get(path);
      if (!page) return fail(`Page not found: ${path}.`);

      const body = await page.text();
      const count = body.split(oldString).length - 1;
      if (count === 0) {
        return fail(`old_string not found in ${path}. Read the page and match its text exactly.`);
      }
      if (count > 1 && !replaceAll) {
        return fail(
          `old_string occurs ${count} times in ${path}. Add more surrounding context to make ` +
            "it unique, or set replace_all.",
        );
      }

      const updated = replaceAll
        ? body.split(oldString).join(newString)
        : body.replace(oldString, newString);
      const res = await vault.put(path, updated, { ...MD, onlyIf: { etagMatches: page.etag } });
      if (!res) return fail(`Conflict: ${path} changed while editing. Re-read the page and retry.`);
      return ok(`Edited ${path}: ${replaceAll ? count : 1} replacement(s). New etag: ${res.etag}`);
    },
  },

  {
    name: "move_page",
    description:
      "Move or rename a page within the writable areas (human/, wiki/ and ai/). Fails if the " +
      `destination already exists. Remember to update ${INDEX_KEY} and any links.`,
    input: { from: z.string().min(1), to: z.string().min(1) },
    parameters: obj({ from: str("Current path."), to: str("Destination path.") }, ["from", "to"]),
    handler: async (vault, args) => {
      const from = args.from as string;
      const to = args.to as string;

      if (!isWritableKey(from)) return fail(`Refused: ${WRITE_SCOPE_MSG} (from "${from}").`);
      if (!isWritableKey(to)) return fail(`Refused: ${WRITE_SCOPE_MSG} (to "${to}").`);

      const page = await vault.get(from);
      if (!page) return fail(`Page not found: ${from}.`);
      const res = await vault.put(to, await page.text(), { ...MD, ...CREATE_ONLY });
      if (!res) return fail(`Refused: destination ${to} already exists.`);
      await vault.delete(from);
      return ok(`Moved ${from} -> ${to}.`);
    },
  },

  {
    name: "log_session",
    description:
      "Save a distilled session log into the vault (ai/log/). Call this ONLY when the " +
      "user explicitly asks to log/summarize the session — never on your own initiative. " +
      "The server adds path, date and frontmatter; you supply the distilled body.",
    input: {
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
    parameters: obj(
      {
        title_slug: str("Short human title. Letters, digits, spaces and dashes only."),
        type: { type: "STRING", enum: ["changes", "ideas"], description: "Kind of log." },
        body: str("Distilled markdown body, without frontmatter."),
        tags: { type: "ARRAY", items: { type: "STRING" }, description: "Extra topic tags." },
      },
      ["title_slug", "type", "body"],
    ),
    handler: async (vault, args) => {
      const body = args.body as string;
      // Path, frontmatter and the refusal to overwrite all live in log.ts, so
      // the nightly sweep writes exactly the same kind of page this does.
      const res = await writeLog(vault, {
        titleSlug: args.title_slug as string,
        type: args.type as LogType,
        body,
        tags: (args.tags as string[] | undefined) ?? [],
      });
      if (!res.ok) return fail(res.error);
      return ok(`Logged session to ${res.path} (${body.length} chars).`);
    },
  },

  {
    name: "delete_page",
    description:
      "Soft-delete a page from the writable areas: it is moved into the trash " +
      `(${TRASH_PREFIX}) rather than destroyed. Remember to update ${INDEX_KEY}.`,
    input: { path: z.string().min(1) },
    parameters: obj({ path: str("Vault path under human/, wiki/ or ai/.") }, ["path"]),
    handler: async (vault, args) => {
      const path = args.path as string;
      if (!isWritableKey(path)) return fail(`Refused: ${WRITE_SCOPE_MSG} (got "${path}").`);
      const page = await vault.get(path);
      if (!page) return fail(`Page not found: ${path}.`);
      const trashKey = `${TRASH_PREFIX}${path}.${Date.now()}`;
      await vault.put(trashKey, await page.text(), MD);
      await vault.delete(path);
      return ok(`Deleted ${path} (recoverable at ${trashKey}).`);
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
