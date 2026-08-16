// compose — MailChat's composer as a service.
//
// "Type one line, send a real email", available to any surface: the web app,
// a Gmail add-on, a phone share target. Unlike the mailbox function this one
// needs no connected mailbox, speaks no IMAP and reads no mail. It takes text
// and a user's profile and returns a draft.
//
// Auth (see auth.ts): a Supabase session JWT, or a MailChat device token.
// The function is deployed with verify_jwt OFF so that device tokens can
// reach it, which means the checks in this file are the only gate.
//
// Privilege split — deliberate: a device token may ONLY polish. Issuing,
// listing and revoking tokens, and reading or writing the Anthropic key, all
// require a real browser session. A token leaked out of an add-on install
// therefore cannot mint more tokens, exfiltrate the key, or escalate.
//
// Actions (POST JSON { action, ... }):
//   profile / saveProfile          → composer settings   (session only)
//   issueToken / tokens / revoke   → device tokens       (session only)
//   polish                         → note → email        (session or token)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  authenticate,
  enforceRateLimit,
  generateToken,
  sha256Hex,
  AuthError,
  RateLimitError,
  type Caller,
  type Db,
} from "./auth.ts";
import { polish, type PolishProfile } from "./polish.ts";
import { DEFAULT_AI_MODEL, normalizeToneSamples } from "./prompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_NOTE_CHARS = 8_000;
const MAX_TOKENS_PER_USER = 10;

interface ProfileRow {
  user_id: string;
  display_name: string;
  signature: string;
  anthropic_api_key: string | null;
  ai_model: string;
  tone_samples: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Never leaks the API key — reports whether one is set, not what it is. */
function profileSummary(row: ProfileRow) {
  return {
    displayName: row.display_name,
    signature: row.signature,
    aiEnabled: !!row.anthropic_api_key,
    aiModel: row.ai_model || DEFAULT_AI_MODEL,
    toneSamples: normalizeToneSamples(row.tone_samples),
  };
}

function toPolishProfile(row: ProfileRow): PolishProfile {
  return {
    displayName: row.display_name,
    signature: row.signature,
    anthropicApiKey: row.anthropic_api_key,
    aiModel: row.ai_model || DEFAULT_AI_MODEL,
    toneSamples: normalizeToneSamples(row.tone_samples),
  };
}

/**
 * Load the caller's profile, creating an empty one on first use so a brand-new
 * user can polish immediately (falling back to the no-AI path) rather than
 * hitting an error before they've configured anything.
 */
async function loadProfile(admin: Db, userId: string): Promise<ProfileRow> {
  const { data } = await admin
    .from("compose_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (data) return data as ProfileRow;

  const { data: created, error } = await admin
    .from("compose_profiles")
    .insert({ user_id: userId })
    .select("*")
    .single();
  if (error || !created) {
    console.error("[compose] profile create failed", error);
    throw new Error("Could not set up your composer profile.");
  }
  return created as ProfileRow;
}

/** Actions that a device token must never be able to perform. */
function requireSession(caller: Caller): void {
  if (caller.via !== "session") {
    throw new AuthError(
      "That action needs you signed in to MailChat in a browser — a device token can only write drafts.",
      403,
    );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseServiceKey || !supabaseAnon) {
    console.error("[compose] missing environment variables");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  const admin: Db = createClient(supabaseUrl, supabaseServiceKey);

  let caller: Caller;
  try {
    caller = await authenticate(req, admin, supabaseUrl, supabaseAnon);
  } catch (e) {
    if (e instanceof AuthError) return jsonResponse({ error: e.message }, e.status);
    console.error("[compose] auth failed", e);
    return jsonResponse({ error: "Could not verify who you are." }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const action = String(payload.action ?? "");

  try {
    switch (action) {
      // ────────────────────────────────────────────────────────────
      case "profile": {
        requireSession(caller);
        const row = await loadProfile(admin, caller.userId);
        return jsonResponse({ profile: profileSummary(row) });
      }

      // ────────────────────────────────────────────────────────────
      case "saveProfile": {
        requireSession(caller);
        await loadProfile(admin, caller.userId);

        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (typeof payload.displayName === "string") {
          update.display_name = payload.displayName.trim().slice(0, 120);
        }
        if (typeof payload.signature === "string") {
          update.signature = payload.signature.trim().slice(0, 1000);
        }
        if (typeof payload.anthropicApiKey === "string") {
          const key = payload.anthropicApiKey.trim();
          update.anthropic_api_key = key === "" ? null : key;
        }
        if (typeof payload.aiModel === "string" && payload.aiModel.trim()) {
          update.ai_model = payload.aiModel.trim().slice(0, 80);
        }
        if (Array.isArray(payload.toneSamples)) {
          // Same normaliser the prompt uses, so what's stored is exactly what
          // gets sent to the model — no silent truncation at read time.
          update.tone_samples = normalizeToneSamples(payload.toneSamples);
        }

        const { error } = await admin
          .from("compose_profiles")
          .update(update)
          .eq("user_id", caller.userId);
        if (error) {
          console.error("[compose] profile update failed", error);
          return jsonResponse({ error: "Saving your settings failed." }, 500);
        }
        const row = await loadProfile(admin, caller.userId);
        return jsonResponse({ profile: profileSummary(row) });
      }

      // ────────────────────────────────────────────────────────────
      case "issueToken": {
        requireSession(caller);
        const { count } = await admin
          .from("compose_tokens")
          .select("id", { count: "exact", head: true })
          .eq("user_id", caller.userId)
          .is("revoked_at", null);
        if ((count ?? 0) >= MAX_TOKENS_PER_USER) {
          return jsonResponse(
            { error: `You already have ${MAX_TOKENS_PER_USER} active tokens. Revoke one first.` },
            400,
          );
        }

        const label = String(payload.label ?? "").trim().slice(0, 80) || "Device";
        const token = generateToken();
        const { data, error } = await admin
          .from("compose_tokens")
          .insert({ user_id: caller.userId, token_hash: await sha256Hex(token), label })
          .select("id, label, created_at")
          .single();
        if (error || !data) {
          console.error("[compose] token insert failed", error);
          return jsonResponse({ error: "Could not create that token." }, 500);
        }

        // The only time the raw token ever leaves this function.
        return jsonResponse({
          token,
          id: data.id,
          label: data.label,
          createdAt: data.created_at,
          notice: "Copy this now — it can't be shown again.",
        });
      }

      // ────────────────────────────────────────────────────────────
      case "tokens": {
        requireSession(caller);
        const { data } = await admin
          .from("compose_tokens")
          .select("id, label, created_at, last_used_at")
          .eq("user_id", caller.userId)
          .is("revoked_at", null)
          .order("created_at", { ascending: true });
        return jsonResponse({
          tokens: (data ?? []).map((t: Record<string, unknown>) => ({
            id: t.id,
            label: t.label,
            createdAt: t.created_at,
            lastUsedAt: t.last_used_at,
          })),
        });
      }

      // ────────────────────────────────────────────────────────────
      case "revokeToken": {
        requireSession(caller);
        const id = String(payload.tokenId ?? "");
        if (!/^[0-9a-f-]{36}$/.test(id)) {
          return jsonResponse({ error: "That token doesn't exist." }, 400);
        }
        // Scoped by user_id as well as id: knowing another user's token id is
        // not enough to revoke it.
        const { error } = await admin
          .from("compose_tokens")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", id)
          .eq("user_id", caller.userId);
        if (error) {
          console.error("[compose] revoke failed", error);
          return jsonResponse({ error: "Could not revoke that token." }, 500);
        }
        return jsonResponse({ ok: true });
      }

      // ────────────────────────────────────────────────────────────
      case "polish": {
        await enforceRateLimit(admin, caller.userId);

        const note = String(payload.note ?? payload.text ?? "").trim();
        if (!note) return jsonResponse({ error: "Type your note first." }, 400);
        if (note.length > MAX_NOTE_CHARS) {
          return jsonResponse({ error: "That note is too long to polish in one go." }, 413);
        }

        const rawContext = Array.isArray(payload.context)
          ? (payload.context as Array<Record<string, unknown>>)
          : [];

        const row = await loadProfile(admin, caller.userId);
        const result = await polish(toPolishProfile(row), {
          note,
          recipientName: String(payload.recipientName ?? ""),
          isNew: payload.isNew === true,
          context: rawContext.map((m) => ({
            from: String(m.from ?? "").slice(0, 120),
            text: String(m.text ?? "").slice(0, 800),
          })),
        });

        return jsonResponse(result);
      }

      default:
        return jsonResponse({ error: `Unknown action: ${action || "(none)"}` }, 400);
    }
  } catch (e) {
    if (e instanceof AuthError) return jsonResponse({ error: e.message }, e.status);
    if (e instanceof RateLimitError) return jsonResponse({ error: e.message }, 429);
    console.error("[compose] unexpected error", e);
    return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
  }
});
