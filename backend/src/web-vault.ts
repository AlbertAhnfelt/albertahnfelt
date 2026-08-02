/**
 * GET /web/vault/* — the website's read-only vault browser.
 *
 * Read-only in the strong sense: there is no write path in this file at all,
 * so no request that arrives here can change the vault regardless of what it
 * says. Writes live on the MCP surface and in the chat's tool loop.
 *
 * Nothing here is reachable without the HttpOnly session cookie, and nothing
 * it returns may be cached — an authenticated body in a shared cache is the
 * same leak as no authentication at all.
 */

import { renderNote } from "./markdown";
import { isSafeMarkdownKey, listAllKeys, TRASH_PREFIX } from "./vault";
import { currentSession } from "./web-session";

/**
 * Which roots the browser will show, as an allowlist rather than a denylist.
 *
 * The bucket also holds `.claude/`, `.github/`, `scripts/`, `_templates/` and
 * loose files like `CLAUDE.md` — tooling that is not notes. A denylist would
 * have to be updated every time the vault grows a new folder; this fails
 * closed instead, at the cost of a line here when a genuinely new note root
 * appears.
 */
const NOTE_ROOTS = ["wiki/", "ai/", "human/", "external/"];

/** Raster only. SVG is a script-carrying document dressed as a picture. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

/** Assets may also live outside the note roots, in the vault-wide image dirs. */
const ASSET_ROOTS = [...NOTE_ROOTS, "images/"];

const CACHE = "private, no-store";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": CACHE,
      "x-content-type-options": "nosniff",
    },
  });
}

/** A note the browser is allowed to open: a safe .md key under a note root. */
function isBrowsableNote(key: string): boolean {
  if (!isSafeMarkdownKey(key)) return false;
  if (key.startsWith(TRASH_PREFIX)) return false;
  // Hidden folders anywhere in the path, not just at the root.
  if (key.split("/").some((segment) => segment.startsWith("."))) return false;
  return NOTE_ROOTS.some((root) => key.startsWith(root));
}

function isBrowsableAsset(key: string): boolean {
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  if (key.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith("."))) return false;
  if (!ASSET_ROOTS.some((root) => key.startsWith(root))) return false;
  return extension(key) in IMAGE_TYPES;
}

function extension(key: string): string {
  return key.slice(key.lastIndexOf(".") + 1).toLowerCase();
}

function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/**
 * Every browsable note, once. Also the lookup wikilinks resolve against, which
 * is why it is built even for a single-note read.
 */
async function noteIndex(vault: R2Bucket): Promise<string[]> {
  return (await listAllKeys(vault)).filter(isBrowsableNote).sort((a, b) => a.localeCompare(b, "sv"));
}

/** Lowercased basename → path, for wikilink resolution. First wins on a tie. */
function byBasename(paths: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of paths) {
    const name = basename(path).toLowerCase();
    if (!index.has(name)) index.set(name, path);
  }
  return index;
}

async function handleList(env: Cloudflare.Env): Promise<Response> {
  const paths = await noteIndex(env.VAULT);
  return json({
    pages: paths.map((path) => ({
      path,
      title: basename(path),
      folder: path.slice(0, path.lastIndexOf("/")),
    })),
  });
}

async function handlePage(request: Request, env: Cloudflare.Env): Promise<Response> {
  const path = new URL(request.url).searchParams.get("path") ?? "";

  // Re-checked here, not merely filtered out of the listing: the listing is a
  // convenience, this is the boundary.
  if (!isBrowsableNote(path)) return json({ error: "not found" }, 404);

  const object = await env.VAULT.get(path);
  if (!object) return json({ error: "not found" }, 404);

  const note = renderNote(path, await object.text(), byBasename(await noteIndex(env.VAULT)));
  return json(note);
}

async function handleAsset(request: Request, env: Cloudflare.Env): Promise<Response> {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!isBrowsableAsset(path)) return json({ error: "not found" }, 404);

  const object = await env.VAULT.get(path);
  if (!object) return json({ error: "not found" }, 404);

  return new Response(object.body, {
    headers: {
      "content-type": IMAGE_TYPES[extension(path)],
      "cache-control": CACHE,
      // The type above is the only one the browser may consider.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/**
 * Routes every /web/vault/* path.
 *
 * No `sameOrigin` check, unlike /web/chat. Browsers omit the Origin header on
 * same-origin GETs, so that guard would reject every real request; these are
 * side-effect-free reads protected by SameSite=Lax and HttpOnly, which is the
 * same footing /web/me already stands on.
 */
export async function handleVault(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405);
  }

  const session = await currentSession(request, env);
  if (!session) return json({ error: "not signed in" }, 401);

  const { pathname } = new URL(request.url);
  if (pathname === "/web/vault/pages") return handleList(env);
  if (pathname === "/web/vault/page") return handlePage(request, env);
  if (pathname === "/web/vault/asset") return handleAsset(request, env);

  return json({ error: "not found" }, 404);
}
