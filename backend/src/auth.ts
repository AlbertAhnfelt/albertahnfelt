/**
 * Single-user bearer-token auth. Compares SHA-256 digests with
 * timingSafeEqual so neither content nor length leaks via timing.
 */
export async function isAuthorized(request: Request, expectedToken: string): Promise<boolean> {
  if (!expectedToken) return false;
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match) return false;

  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(match[1])),
    crypto.subtle.digest("SHA-256", enc.encode(expectedToken)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
