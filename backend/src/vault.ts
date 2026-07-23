/**
 * Vault key helpers. The R2 bucket mirrors the Obsidian vault layout:
 *   human/, external/          — read-only sources
 *   wiki/, ai/                 — AI-writable
 *   wiki/.trash/               — soft-deleted pages (managed by delete_page only)
 */

export const WRITABLE_PREFIXES = ["wiki/", "ai/"] as const;
export const TRASH_PREFIX = "wiki/.trash/";
export const INDEX_KEY = "wiki/index.md";
export const INSTRUCTIONS_KEY = "ai/instructions.md";
export const LOG_PREFIX = "ai/log/";

/** "2026-07-23" in the vault owner's timezone. */
export function vaultDate(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    dateStyle: "short",
  }).format(now);
}

/** Human-readable but path-safe log title: letters, digits, spaces, dashes. */
export function isSafeLogSlug(slug: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N} -]{0,80}$/u.test(slug) && !slug.endsWith(" ");
}

/** True if `key` is a safe relative vault path: no traversal, no absolute paths, .md only. */
export function isSafeMarkdownKey(key: string): boolean {
  if (!key.endsWith(".md")) return false;
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  const segments = key.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

/** True if `key` may be written by tools: safe, under wiki/ or ai/, and not in the trash. */
export function isWritableKey(key: string): boolean {
  return (
    isSafeMarkdownKey(key) &&
    WRITABLE_PREFIXES.some((p) => key.startsWith(p)) &&
    !key.startsWith(TRASH_PREFIX)
  );
}

/** True if `prefix` is safe to use for listing: relative, no traversal. Empty = vault root. */
export function isSafeListPrefix(prefix: string): boolean {
  if (prefix === "") return true;
  if (prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("\0")) return false;
  return prefix.split("/").every((s) => s !== "." && s !== "..");
}

/** List every object key in the bucket (handles pagination). */
export async function listAllKeys(bucket: R2Bucket, prefix?: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** One `ls`-style level: subdirectories and files directly under `prefix`. */
export async function listLevel(
  bucket: R2Bucket,
  prefix: string,
): Promise<{ dirs: string[]; files: { key: string; size: number }[] }> {
  const dirs: string[] = [];
  const files: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor, limit: 1000 });
    dirs.push(...page.delimitedPrefixes);
    files.push(...page.objects.map((o) => ({ key: o.key, size: o.size })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { dirs, files };
}

export const FALLBACK_INSTRUCTIONS = `You are connected to Abbe, a personal second-brain vault of markdown pages.
Layout: human/ and external/ are read-only source material; wiki/ and ai/ are where you may write.
Rules: search only routes to pages — always read whole pages with read_page before acting.
To overwrite a page you must first read it and pass back its etag. After creating, moving, or
deleting a wiki page, update wiki/index.md accordingly.
(This is fallback text — create ${INSTRUCTIONS_KEY} in the vault to replace it.)`;

/** Load agent-facing instructions from the vault, falling back to the baked-in contract. */
export async function loadInstructions(bucket: R2Bucket): Promise<string> {
  try {
    const obj = await bucket.get(INSTRUCTIONS_KEY);
    if (obj) return await obj.text();
  } catch {
    // fall through to fallback
  }
  return FALLBACK_INSTRUCTIONS;
}
