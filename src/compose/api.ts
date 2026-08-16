// Weaver ↔ compose edge function bridge.
//
// The composer half of the product: no mailbox required, no IMAP, no Graph.
// Everything goes through supabase.functions.invoke("compose"), which forwards
// the signed-in user's JWT automatically. Device tokens are minted here for
// other surfaces (the Gmail add-on) but are never used by this browser code —
// the session is credential enough.

import { supabase } from "@/lib/supabase";

export interface ComposeProfile {
  displayName: string;
  signature: string;
  aiEnabled: boolean;
  aiModel: string;
  toneSamples: string[];
}

export interface ComposeDraft {
  subject: string;
  body: string;
  /** False when the draft came from the offline fallback rather than Claude. */
  ai: boolean;
  /** Present only when AI was attempted and failed. */
  aiError?: string;
}

export interface DeviceToken {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface IssuedToken {
  token: string;
  id: string;
  label: string;
  createdAt: string;
  notice: string;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("compose", { body });

  if (error) {
    let message = "Something went wrong — please try again.";
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = String(parsed.error);
      } catch {
        // keep the generic message
      }
    }
    throw new Error(message);
  }

  const asRecord = data as Record<string, unknown> | null;
  if (asRecord && typeof asRecord === "object" && typeof asRecord.error === "string" && asRecord.error) {
    throw new Error(asRecord.error);
  }
  return data as T;
}

export const composeApi = {
  profile: () => call<{ profile: ComposeProfile }>({ action: "profile" }),

  saveProfile: (input: {
    displayName?: string;
    signature?: string;
    anthropicApiKey?: string;
    aiModel?: string;
    toneSamples?: string[];
  }) => call<{ profile: ComposeProfile }>({ action: "saveProfile", ...input }),

  polish: (input: { note: string; recipientName?: string; isNew?: boolean }) =>
    call<ComposeDraft>({ action: "polish", ...input }),

  tokens: () => call<{ tokens: DeviceToken[] }>({ action: "tokens" }),

  issueToken: (label: string) => call<IssuedToken>({ action: "issueToken", label }),

  revokeToken: (tokenId: string) => call<{ ok: boolean }>({ action: "revokeToken", tokenId }),
};

/**
 * Build a mailto: link that hands the finished draft to whatever mail app the
 * user actually uses. This is the whole composer-first thesis in one function:
 * we write the email, they send it from where they already are.
 */
export function mailtoLink(input: { to?: string; subject: string; body: string }): string {
  const params = new URLSearchParams();
  if (input.subject) params.set("subject", input.subject);
  if (input.body) params.set("body", input.body);
  // URLSearchParams encodes spaces as "+", which mail clients render literally
  // in a body. Percent-encoding is what mailto: actually wants.
  const query = params.toString().replace(/\+/g, "%20");
  return `mailto:${encodeURIComponent(input.to ?? "").replace(/%40/g, "@")}${query ? `?${query}` : ""}`;
}

/** Text shared into the app from the Android share sheet, if any. */
export function sharedText(): string {
  const params = new URLSearchParams(window.location.search);
  // Android sends the message under "text"; some apps put a link in "url" and
  // the surrounding message in "title".
  return [params.get("title"), params.get("text"), params.get("url")]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .join("\n")
    .trim();
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
