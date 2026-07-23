/**
 * Vault key helpers. The R2 bucket mirrors the Obsidian vault layout:
 *   human/, external/, ai/  — read-only sources (MCP may only add via ingest)
 *   wiki/                   — AI-writable pages
 */

export const WRITABLE_PREFIX = "wiki/";
export const INGEST_PREFIX = "external/inbox/";
export const INDEX_KEY = "wiki/index.md";

/** True if `key` is a safe relative vault path: no traversal, no absolute paths, .md only. */
export function isSafeMarkdownKey(key: string): boolean {
  if (!key.endsWith(".md")) return false;
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  const segments = key.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

export function isWritableKey(key: string): boolean {
  return isSafeMarkdownKey(key) && key.startsWith(WRITABLE_PREFIX);
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
