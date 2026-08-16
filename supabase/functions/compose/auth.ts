// auth — identity for the compose service.
//
// Unlike the mailbox function, compose runs with verify_jwt OFF, because it
// must accept two kinds of caller:
//
//   1. The web app, presenting a normal Supabase session JWT.
//   2. A device surface (Gmail add-on, phone share target) presenting a
//      Weaver device token, which has no Supabase session behind it.
//
// The platform gate being off means every check below is load-bearing. Both
// paths resolve to a Supabase user id, and every downstream query is scoped by
// that id — there is no code path that reads another user's profile.
//
// Token minting and hashing live in tokens.ts, which stays dependency-free so
// it can be tested under vitest.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import { extractBearer, extractDeviceToken, sha256Hex, RATE_LIMIT_PER_MINUTE } from "./tokens.ts";

export {
  generateToken,
  sha256Hex,
  isDeviceToken,
  TOKEN_HEADER,
  RATE_LIMIT_PER_MINUTE,
} from "./tokens.ts";

export type Db = SupabaseClient<any, any, any, any, any>;

export class AuthError extends Error {
  constructor(message: string, public readonly status = 401) {
    super(message);
  }
}

export class RateLimitError extends Error {
  constructor(message = "You're polishing very fast — give it a minute and try again.") {
    super(message);
  }
}

export interface Caller {
  userId: string;
  /** Which door they came through, for logging and token bookkeeping. */
  via: "session" | "token";
  /** Present only for the token path. */
  tokenId?: string;
}

async function authenticateToken(admin: Db, bearer: string): Promise<Caller> {
  // Look the token up by hash. Nothing is compared in application code, so
  // there is no string comparison to time-attack; a wrong token simply finds
  // no row.
  const hash = await sha256Hex(bearer);
  const { data } = await admin
    .from("compose_tokens")
    .select("id, user_id")
    .eq("token_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();

  if (!data) {
    throw new AuthError(
      "That Weaver token isn't valid any more. Issue a new one in Composer settings.",
      403,
    );
  }

  // Fire-and-forget: a failed bookkeeping write must not fail the request.
  admin
    .from("compose_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(undefined, (e: unknown) => console.error("[compose] last_used_at update failed", e));

  return { userId: data.user_id as string, via: "token", tokenId: data.id as string };
}

async function authenticateSession(
  supabaseUrl: string,
  supabaseAnon: string,
  authHeader: string,
): Promise<Caller> {
  const userClient = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user?.id) {
    throw new AuthError("Your session has expired — sign in again.");
  }
  return { userId: user.id, via: "session" };
}

/**
 * Resolve the caller to a user id, by whichever door they used.
 *
 * A device token is checked first: it arrives in its own header, so a surface
 * presenting one is unambiguous. Only if there is no device token do we treat
 * Authorization as a browser session.
 */
export async function authenticate(
  req: Request,
  admin: Db,
  supabaseUrl: string,
  supabaseAnon: string,
): Promise<Caller> {
  const deviceToken = extractDeviceToken(req.headers);
  if (deviceToken) return await authenticateToken(admin, deviceToken);

  const authHeader = req.headers.get("Authorization");
  if (!extractBearer(authHeader)) throw new AuthError("Sign in to use the composer.");
  return await authenticateSession(supabaseUrl, supabaseAnon, authHeader!);
}

/**
 * Count this request against the caller's per-minute budget. Increment and
 * read happen in one statement server-side, so two concurrent requests cannot
 * both read the pre-increment value and slip past the limit.
 */
export async function enforceRateLimit(admin: Db, userId: string): Promise<void> {
  const { data, error } = await admin.rpc("compose_bump_usage", { p_user_id: userId });
  if (error) {
    // Fail open rather than lock someone out of their own composer because a
    // counter misbehaved — the Anthropic key is theirs and self-limiting.
    console.error("[compose] rate limit check failed", error);
    return;
  }
  if (typeof data === "number" && data > RATE_LIMIT_PER_MINUTE) {
    throw new RateLimitError();
  }
}
