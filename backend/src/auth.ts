/**
 * Comparing secrets. SHA-256 digests are compared with timingSafeEqual so
 * neither content nor length leaks via timing.
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** Single-user bearer-token auth, for the static-token path on /mcp. */
export async function isAuthorized(request: Request, expectedToken: string): Promise<boolean> {
  if (!expectedToken) return false;
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  return secretsEqual(match[1], expectedToken);
}
