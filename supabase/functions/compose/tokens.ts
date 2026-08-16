// tokens — device token minting and hashing.
//
// Dependency-free (Web Crypto only), so it runs under vitest as well as Deno.
// auth.ts wraps this with the database lookups.

export const TOKEN_PREFIX = "mc_";

/** Requests per user per minute, across both auth paths. */
export const RATE_LIMIT_PER_MINUTE = 20;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mint a device token. 32 bytes of CSPRNG output, base64url encoded, with a
 * recognisable prefix so the router can tell it apart from a JWT and so it is
 * greppable if one ever leaks into a log.
 *
 * The raw value is returned to the caller exactly once and never stored — only
 * its SHA-256 hash goes to the database.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${TOKEN_PREFIX}${b64url}`;
}

export function isDeviceToken(bearer: string): boolean {
  return bearer.startsWith(TOKEN_PREFIX);
}

/**
 * Header a device surface uses to present its token.
 *
 * Device tokens deliberately do NOT ride in Authorization. Supabase's gateway
 * inspects that header, and handing it a non-JWT invites the request to be
 * rejected upstream before the function ever runs. A dedicated header keeps
 * the two credential types on separate rails.
 */
export const TOKEN_HEADER = "x-mailchat-token";

/** Bearer extraction for the browser-session path. */
export function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const bearer = authHeader.slice("Bearer ".length).trim();
  return bearer || null;
}

/**
 * Pull a device token from a request's headers.
 *
 * Prefers the dedicated header, but still accepts `Authorization: Bearer mc_…`
 * so a caller that only knows how to set Authorization keeps working.
 */
export function extractDeviceToken(headers: {
  get(name: string): string | null;
}): string | null {
  const direct = headers.get(TOKEN_HEADER)?.trim();
  if (direct) return direct;
  const bearer = extractBearer(headers.get("Authorization"));
  return bearer && isDeviceToken(bearer) ? bearer : null;
}
