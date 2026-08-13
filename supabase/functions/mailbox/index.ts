// mailbox — MailChat's API: your Gmail and Outlook mailboxes as chat-style
// conversations, with replies typed casually and sent as polished emails.
//
// Providers:
//   gmail   → IMAP/SMTP with a Google App Password (gmail.ts)
//   outlook → Microsoft Graph with OAuth refresh tokens (outlook.ts)
//
// Access control: every action requires a Supabase-auth JWT AND the signed-in
// email must be present in public.mail_allowed_users. Mail credentials live
// in public.mail_accounts (service-role only) and are never returned to the
// browser. Mail content itself is never stored — every view reads live.
//
// Actions (POST JSON { action, ... }):
//   status                                → list connected accounts
//   connectGmail / connectOutlook         → add an account (verified live)
//   saveSettings / disconnect             → per-account settings management
//   threads / thread / attachment / send  → mail (accountId-scoped)
//   polish                                → casual note → professional email

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@^0.110.0";

import { gmailProvider, verifyGmailLogin, ImapError, SmtpError } from "./gmail.ts";
import { outlookProvider, exchangeOutlookCode, type TokenSaver } from "./outlook.ts";
import { MailError, type MailAccount, type MailProvider } from "./types.ts";
import { isValidEmail, type OutAddress, type OutAttachment } from "./mimeBuild.ts";

type Db = SupabaseClient<any, any, any, any, any>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Polishing a short note into an email is well within Haiku's abilities,
// and it's the fastest and cheapest current Claude model — keeps the
// owner's API bill near zero. Accounts can still override ai_model.
const DEFAULT_AI_MODEL = "claude-haiku-4-5";
const SEND_ATTACH_B64_CAP = 20_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function friendlyMailError(e: unknown): Response {
  if (e instanceof MailError || e instanceof ImapError || e instanceof SmtpError) {
    const status = e.kind === "auth" ? 400 : e.kind === "network" ? 502 : 500;
    return jsonResponse({ error: e.message }, status);
  }
  console.error("[mailbox] unexpected error", e);
  return jsonResponse({ error: "Something went wrong talking to your mailbox. Please try again." }, 500);
}

function accountSummary(a: MailAccount) {
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    displayName: a.display_name,
    signature: a.signature,
    aiEnabled: !!a.anthropic_api_key,
    aiModel: a.ai_model || DEFAULT_AI_MODEL,
  };
}

async function listAccounts(admin: Db): Promise<MailAccount[]> {
  const { data } = await admin.from("mail_accounts").select("*").order("created_at", { ascending: true });
  return (data as MailAccount[] | null) ?? [];
}

async function loadAccount(admin: Db, accountId: unknown): Promise<MailAccount> {
  const id = String(accountId ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new MailError("That mailbox isn't connected any more.", "auth");
  const { data } = await admin.from("mail_accounts").select("*").eq("id", id).maybeSingle();
  if (!data) throw new MailError("That mailbox isn't connected any more.", "auth");
  return data as MailAccount;
}

function providerFor(admin: Db, account: MailAccount): MailProvider {
  if (account.provider === "outlook") {
    const saveTokens: TokenSaver = async (tokens) => {
      await admin
        .from("mail_accounts")
        .update({
          ms_access_token: tokens.accessToken,
          ms_refresh_token: tokens.refreshToken,
          ms_token_expires_at: tokens.expiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", account.id);
    };
    return outlookProvider(account, saveTokens);
  }
  return gmailProvider(account);
}

// ── AI polish ──

const POLISH_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Email subject line. Empty string for replies." },
    body: { type: "string", description: "The complete plain-text email body, ready to send." },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

function polishSystemPrompt(account: MailAccount, recipientFirstName: string, isNew: boolean): string {
  const owner = account.display_name || "the sender";
  const signature = account.signature || account.display_name || "";
  return [
    `You write emails on behalf of ${owner}.`,
    `${owner} types quick casual notes (like text messages). Rewrite the note as a warm, professional, plain-text email that says exactly what the note says — nothing more.`,
    ``,
    `Rules:`,
    `- Keep every fact, name, number, date, time and price from the note. Never invent details, prices, availability, offers or commitments that are not in the note.`,
    `- Keep it concise and natural. This is a normal email between people, not marketing copy.`,
    `- Write in the same language the note is written in.`,
    `- Plain text only: no markdown, no HTML, no emoji unless the note itself uses them.`,
    recipientFirstName ? `- Start with a friendly greeting to ${recipientFirstName}.` : `- Start with a friendly greeting.`,
    signature ? `- End the body with exactly this sign-off block:\n${signature}` : `- End with a friendly sign-off from ${owner}.`,
    isNew
      ? `- Write a short, clear subject line for a brand-new email.`
      : `- This is a reply inside an existing conversation: return an empty string for "subject".`,
  ].join("\n");
}

async function polishWithClaude(
  account: MailAccount,
  note: string,
  context: Array<{ from: string; text: string }>,
  recipientFirstName: string,
  isNew: boolean,
): Promise<{ subject: string; body: string }> {
  const client = new Anthropic({ apiKey: account.anthropic_api_key! });
  const contextBlock =
    context.length > 0
      ? `Conversation so far (oldest first):\n${context.map((m) => `${m.from}: ${m.text.slice(0, 600)}`).join("\n---\n")}\n\n`
      : "";
  const model = account.ai_model || DEFAULT_AI_MODEL;
  // Two params are Opus 5-class only: the server-side refusal fallback
  // (those models' safety classifiers can rarely decline, retried on the
  // recommended fallback model within the same call) and the effort knob,
  // which Haiku rejects with a 400.
  const opusClass = /^claude-(opus-5|fable-5|mythos-5)/.test(model);
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...(opusClass ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    output_config: opusClass
      ? { effort: "low", format: { type: "json_schema", schema: POLISH_SCHEMA } }
      : { format: { type: "json_schema", schema: POLISH_SCHEMA } },
    system: polishSystemPrompt(account, recipientFirstName, isNew),
    messages: [
      {
        role: "user",
        content: `${contextBlock}${account.display_name || "The sender"}'s casual note to turn into the email:\n"""\n${note}\n"""`,
      },
    ],
  } as Parameters<typeof client.beta.messages.create>[0]);

  const resp = response as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
  if (resp.stop_reason === "refusal") {
    throw new Error("The AI assistant declined to write this one — you can still edit and send it yourself.");
  }
  const text = resp.content?.find((b) => b.type === "text")?.text ?? "";
  const parsed = JSON.parse(text) as { subject?: string; body?: string };
  if (!parsed.body) throw new Error("The AI assistant returned an empty draft.");
  return { subject: (parsed.subject ?? "").trim(), body: parsed.body.trim() };
}

function polishFallback(account: MailAccount, note: string, recipientFirstName: string): { subject: string; body: string } {
  const signature = account.signature || account.display_name || "";
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : "Hi,";
  return { subject: "", body: `${greeting}\n\n${note.trim()}${signature ? `\n\n${signature}` : ""}` };
}

// ── HTTP handler ──

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
    console.error("[mailbox] missing environment variables");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  // AuthN: bearer token → user.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const userClient = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user?.email) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // AuthZ: the signed-in email must be allowlisted.
  const admin: Db = createClient(supabaseUrl, supabaseServiceKey);
  const { data: allowed } = await admin
    .from("mail_allowed_users")
    .select("email")
    .eq("email", user.email.toLowerCase())
    .maybeSingle();
  if (!allowed) {
    return jsonResponse(
      { error: "This app is private — your login isn't on its allowed list.", notAllowed: true },
      403,
    );
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
      case "status": {
        const accounts = await listAccounts(admin);
        return jsonResponse({ accounts: accounts.map(accountSummary) });
      }

      // ────────────────────────────────────────────────────────────
      case "connectGmail": {
        const email = String(payload.email ?? "").trim().toLowerCase();
        const appPassword = String(payload.appPassword ?? "").replace(/\s+/g, "");
        const displayName = String(payload.displayName ?? "").trim().slice(0, 120);
        const signature = String(payload.signature ?? "").trim().slice(0, 1000);
        if (!isValidEmail(email)) {
          return jsonResponse({ error: "That doesn't look like a valid email address." }, 400);
        }
        if (appPassword.length < 8) {
          return jsonResponse({ error: "The app password looks too short — it should be 16 letters." }, 400);
        }
        await verifyGmailLogin(email, appPassword);
        await admin.from("mail_accounts").delete().eq("provider", "gmail").eq("email", email);
        const { error: insertError } = await admin.from("mail_accounts").insert({
          provider: "gmail",
          email,
          app_password: appPassword,
          display_name: displayName,
          signature,
        });
        if (insertError) {
          console.error("[mailbox] insert failed", insertError);
          return jsonResponse({ error: "Connected to Gmail, but saving the account failed." }, 500);
        }
        const accounts = await listAccounts(admin);
        return jsonResponse({ accounts: accounts.map(accountSummary) });
      }

      // ────────────────────────────────────────────────────────────
      case "connectOutlook": {
        const clientId = String(payload.clientId ?? "").trim();
        const clientSecret = String(payload.clientSecret ?? "").trim();
        const code = String(payload.code ?? "");
        const redirectUri = String(payload.redirectUri ?? "");
        const codeVerifier = String(payload.codeVerifier ?? "");
        if (!clientId || !clientSecret || !code || !redirectUri || !codeVerifier) {
          return jsonResponse({ error: "The Microsoft sign-in details were incomplete — please try connecting again." }, 400);
        }
        const { tokens, email, displayName } = await exchangeOutlookCode({
          clientId,
          clientSecret,
          code,
          redirectUri,
          codeVerifier,
        });
        await admin.from("mail_accounts").delete().eq("provider", "outlook").eq("email", email);
        const { error: insertError } = await admin.from("mail_accounts").insert({
          provider: "outlook",
          email,
          display_name: String(payload.displayName ?? "").trim().slice(0, 120) || displayName,
          signature: String(payload.signature ?? "").trim().slice(0, 1000),
          ms_client_id: clientId,
          ms_client_secret: clientSecret,
          ms_refresh_token: tokens.refreshToken,
          ms_access_token: tokens.accessToken,
          ms_token_expires_at: tokens.expiresAt,
        });
        if (insertError) {
          console.error("[mailbox] insert failed", insertError);
          return jsonResponse({ error: "Signed in to Microsoft, but saving the account failed." }, 500);
        }
        const accounts = await listAccounts(admin);
        return jsonResponse({ accounts: accounts.map(accountSummary), connectedEmail: email });
      }

      // ────────────────────────────────────────────────────────────
      case "saveSettings": {
        const account = await loadAccount(admin, payload.accountId);
        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (typeof payload.displayName === "string") update.display_name = payload.displayName.trim().slice(0, 120);
        if (typeof payload.signature === "string") update.signature = payload.signature.trim().slice(0, 1000);
        if (typeof payload.anthropicApiKey === "string") {
          const key = payload.anthropicApiKey.trim();
          update.anthropic_api_key = key === "" ? null : key;
        }
        if (typeof payload.aiModel === "string" && payload.aiModel.trim()) {
          update.ai_model = payload.aiModel.trim().slice(0, 80);
        }
        const { error: updateError } = await admin.from("mail_accounts").update(update).eq("id", account.id);
        if (updateError) {
          console.error("[mailbox] settings update failed", updateError);
          return jsonResponse({ error: "Saving settings failed." }, 500);
        }
        const accounts = await listAccounts(admin);
        return jsonResponse({ accounts: accounts.map(accountSummary) });
      }

      // ────────────────────────────────────────────────────────────
      case "disconnect": {
        const account = await loadAccount(admin, payload.accountId);
        await admin.from("mail_accounts").delete().eq("id", account.id);
        const accounts = await listAccounts(admin);
        return jsonResponse({ accounts: accounts.map(accountSummary) });
      }

      // ────────────────────────────────────────────────────────────
      case "threads": {
        const account = await loadAccount(admin, payload.accountId);
        const q = String(payload.q ?? "").trim();
        const filter = String(payload.filter ?? "inbox") === "unread" ? "unread" : "inbox";
        const result = await providerFor(admin, account).listThreads(q, filter);
        return jsonResponse(result);
      }

      // ────────────────────────────────────────────────────────────
      case "thread": {
        const account = await loadAccount(admin, payload.accountId);
        const threadId = String(payload.threadId ?? "");
        const markRead = payload.markRead !== false;
        const result = await providerFor(admin, account).getThread(threadId, markRead);
        return jsonResponse(result);
      }

      // ────────────────────────────────────────────────────────────
      case "attachment": {
        const account = await loadAccount(admin, payload.accountId);
        const result = await providerFor(admin, account).getAttachment(
          String(payload.messageId ?? ""),
          String(payload.partId ?? ""),
        );
        return jsonResponse(result);
      }

      // ────────────────────────────────────────────────────────────
      case "polish": {
        const account = await loadAccount(admin, payload.accountId);
        const note = String(payload.text ?? "").trim();
        if (!note) return jsonResponse({ error: "Type your reply first." }, 400);
        // A recipient with no display name comes through as their email
        // address — don't greet anyone as "janeexamplecom".
        const recipientName = String(payload.recipientName ?? "").trim();
        const firstName = recipientName.includes("@")
          ? ""
          : recipientName.split(/\s+/)[0]?.replace(/[^\p{L}\p{N}'’-]/gu, "") ?? "";
        const isNew = payload.isNew === true;
        const rawContext = Array.isArray(payload.context) ? (payload.context as Array<Record<string, unknown>>) : [];
        const context = rawContext.slice(-6).map((m) => ({
          from: String(m.from ?? "").slice(0, 120),
          text: String(m.text ?? "").slice(0, 800),
        }));

        if (!account.anthropic_api_key) {
          const draft = polishFallback(account, note, firstName);
          return jsonResponse({ ...draft, ai: false });
        }
        try {
          const draft = await polishWithClaude(account, note, context, firstName, isNew);
          return jsonResponse({ ...draft, ai: true });
        } catch (e) {
          console.error("[mailbox] polish failed", e);
          const draft = polishFallback(account, note, firstName);
          return jsonResponse({
            ...draft,
            ai: false,
            aiError:
              e instanceof Error && /credit|billing|401|authentication/i.test(e.message)
                ? "The AI key looks invalid or out of credit — sending the plain version instead."
                : "The AI polish didn't work this time — here's the plain version instead.",
          });
        }
      }

      // ────────────────────────────────────────────────────────────
      case "send": {
        const account = await loadAccount(admin, payload.accountId);
        const toRaw = Array.isArray(payload.to) ? (payload.to as unknown[]) : [];
        const to: OutAddress[] = toRaw
          .map((t) =>
            typeof t === "string"
              ? { email: t.trim().toLowerCase() }
              : {
                  email: String((t as Record<string, unknown>).email ?? "").trim().toLowerCase(),
                  name: String((t as Record<string, unknown>).name ?? ""),
                },
          )
          .filter((t) => t.email);
        if (to.length === 0 || to.some((t) => !isValidEmail(t.email))) {
          return jsonResponse({ error: "Please enter a valid recipient email address." }, 400);
        }
        const subject = String(payload.subject ?? "").trim().slice(0, 300);
        const body = String(payload.body ?? "").replace(/\r\n/g, "\n").trim();
        if (!body) return jsonResponse({ error: "The email body is empty." }, 400);
        const attachRaw = Array.isArray(payload.attachments) ? (payload.attachments as Array<Record<string, unknown>>) : [];
        let totalB64 = 0;
        const attachments: OutAttachment[] = attachRaw.map((a) => {
          const base64 = String(a.base64 ?? "");
          totalB64 += base64.length;
          return {
            filename: String(a.filename ?? "attachment").slice(0, 200),
            mime: String(a.mime ?? "application/octet-stream").slice(0, 120),
            base64,
          };
        });
        if (totalB64 > SEND_ATTACH_B64_CAP) {
          return jsonResponse({ error: "Attachments are too large — keep the total under about 14 MB." }, 413);
        }
        await providerFor(admin, account).send({
          to,
          subject,
          body,
          attachments,
          inReplyTo: typeof payload.inReplyTo === "string" ? payload.inReplyTo.slice(0, 400) : null,
          references: typeof payload.references === "string" ? payload.references.slice(0, 4000) : null,
          anchorMessageId: typeof payload.anchorMessageId === "string" ? payload.anchorMessageId.slice(0, 600) : null,
        });
        return jsonResponse({ ok: true });
      }

      default:
        return jsonResponse({ error: `Unknown action: ${action || "(none)"}` }, 400);
    }
  } catch (e) {
    return friendlyMailError(e);
  }
});
