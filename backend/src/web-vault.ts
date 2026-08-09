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
 * Scaffolding that is in the bucket but is not notes.
 *
 * This used to be the other way round — an allowlist of note roots, `["wiki/",
 * "ai/", "human/", "external/"]` — and it went stale in both directions at
 * once: `core/` quietly grew four real notes the browser refused to show, while
 * `external/` was still allowlisted for a folder that no longer exists.
 *
 * An allowlist fails closed, which is the right instinct for a boundary. But
 * this is not the boundary: `handlePage` re-checks every path it is handed, and
 * the session cookie is what decides whether any of it may be read at all. All
 * this list does is curate a view of Albert's own vault — and curating it by
 * hand meant new notes went missing without anything saying so. Inverted, the
 * failure is a visible one: a folder of scaffolding shows up until it is named
 * here, rather than a folder of notes silently not existing.
 *
 * Hidden directories (`.claude/`, `.github/`, the trash) are excluded
 * separately, by segment, below.
 */
const TOOLING_PREFIXES = ["_templates/", "scripts/"];

/** Raster only. SVG is a script-carrying document dressed as a picture. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

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

/** A note the browser is allowed to open: any safe .md key that is not tooling. */
function isBrowsableNote(key: string): boolean {
  // Unchanged, and still what stops a path from meaning something other than a
  // note: relative, no traversal, no NUL, .md only.
  if (!isSafeMarkdownKey(key)) return false;
  if (key.startsWith(TRASH_PREFIX)) return false;
  // Hidden folders anywhere in the path, not just at the root.
  if (key.split("/").some((segment) => segment.startsWith("."))) return false;
  return !TOOLING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isBrowsableAsset(key: string): boolean {
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  if (key.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith("."))) return false;
  if (TOOLING_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  // The real control on this path: a fixed set of raster types, and the
  // extension decides the one Content-Type the browser is allowed to consider.
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

  const pages = paths.map((path) => {
    // A note at the vault root has no slash, and `slice(0, -1)` would hand back
    // the filename with its last character bitten off — "purpose.m" — as though
    // that were a folder. Empty is the honest answer; the page labels it.
    const cut = path.lastIndexOf("/");
    return {
      path,
      title: basename(path),
      folder: cut === -1 ? "" : path.slice(0, cut),
    };
  });

  // By folder first, then title — not by path, which is what `noteIndex`
  // returns. For nested notes the two orders agree, because the folder is a
  // prefix of the path. Root-level notes are where they diverge: their folder
  // is empty but their path sorts among the folder names, so path order drops
  // them in the middle of the list and the page, which starts a new group each
  // time the folder changes, renders a second "/" heading further down. This
  // way every folder appears exactly once, and the vault's own loose notes come
  // first rather than wherever their initials happen to land.
  pages.sort(
    (a, b) => a.folder.localeCompare(b.folder, "sv") || a.title.localeCompare(b.title, "sv"),
  );

  return json({ pages });
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
