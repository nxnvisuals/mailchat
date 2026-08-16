// Weaver ↔ mailbox edge function bridge.
//
// Every call goes through supabase.functions.invoke("mailbox"), which
// forwards the signed-in user's JWT automatically. The edge function talks
// to Gmail/Outlook; nothing here ever sees passwords, secrets or tokens.

import { supabase } from "@/lib/supabase";

export type Provider = "gmail" | "outlook";

/**
 * A list the user can ask for. Mirrors MailFolder in the edge function.
 *
 * "unread" is a view of the inbox rather than a folder of its own, and
 * "archive" differs per provider — Gmail has no archive folder, so it means
 * All Mail minus the inbox; Outlook has a real one.
 */
export type MailFolder = "inbox" | "unread" | "starred" | "sent" | "drafts" | "archive";

/** Folders holding mail the user wrote, where the useful column is "to". */
export const OUTGOING_FOLDERS: readonly MailFolder[] = ["sent", "drafts"];

export interface MailAccountSummary {
  id: string;
  provider: Provider;
  email: string;
  displayName: string;
  signature: string;
  aiEnabled: boolean;
  aiModel: string;
}

export interface MailAddress {
  name: string;
  email: string;
}

export interface ThreadSummary {
  threadId: string;
  subject: string;
  from: MailAddress;
  fromIsMe: boolean;
  date: string;
  unread: boolean;
  count: number;
  hasAttachments: boolean;
  snippet: string;
}

export interface MailAttachment {
  messageId: string;
  partId: string;
  filename: string;
  mime: string;
  size: number;
}

export interface MailMessage {
  id: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  date: string;
  isMe: boolean;
  text: string;
  quoted: string;
  attachments: MailAttachment[];
  unread: boolean;
}

export interface ReplyMeta {
  to: MailAddress[];
  subject: string;
  inReplyTo: string | null;
  references: string | null;
  anchorMessageId: string | null;
}

export interface ThreadDetail {
  threadId: string;
  subject: string;
  myEmail: string;
  messages: MailMessage[];
  reply: ReplyMeta;
}

export interface PolishResult {
  subject: string;
  body: string;
  ai: boolean;
  aiError?: string;
}

export interface OutgoingAttachment {
  filename: string;
  mime: string;
  base64: string;
}

export class NotAllowedError extends Error {}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("mailbox", { body });
  if (error) {
    let message = "Something went wrong — please try again.";
    let notAllowed = false;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = String(parsed.error);
        notAllowed = parsed?.notAllowed === true;
      } catch {
        // keep the generic message
      }
    }
    throw notAllowed ? new NotAllowedError(message) : new Error(message);
  }
  const asRecord = data as Record<string, unknown> | null;
  if (asRecord && typeof asRecord === "object" && typeof asRecord.error === "string" && asRecord.error) {
    throw new Error(asRecord.error);
  }
  return data as T;
}

export const mailboxApi = {
  status: () => call<{ accounts: MailAccountSummary[] }>({ action: "status" }),

  connectGmail: (input: { email: string; appPassword: string; displayName: string; signature: string }) =>
    call<{ accounts: MailAccountSummary[] }>({ action: "connectGmail", ...input }),

  connectOutlook: (input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }) => call<{ accounts: MailAccountSummary[]; connectedEmail: string }>({ action: "connectOutlook", ...input }),

  saveSettings: (input: {
    accountId: string;
    displayName?: string;
    signature?: string;
    anthropicApiKey?: string;
    aiModel?: string;
  }) => call<{ accounts: MailAccountSummary[] }>({ action: "saveSettings", ...input }),

  disconnect: (accountId: string) => call<{ accounts: MailAccountSummary[] }>({ action: "disconnect", accountId }),

  listThreads: (accountId: string, q: string, filter: MailFolder) =>
    call<{ threads: ThreadSummary[]; scannedAll: boolean }>({ action: "threads", accountId, q, filter }),

  getThread: (accountId: string, threadId: string, markRead = true) =>
    call<ThreadDetail>({ action: "thread", accountId, threadId, markRead }),

  attachment: (accountId: string, messageId: string, partId: string) =>
    call<{ filename: string; mime: string; base64: string }>({ action: "attachment", accountId, messageId, partId }),

  polish: (input: {
    accountId: string;
    text: string;
    recipientName: string;
    context: Array<{ from: string; text: string }>;
    isNew: boolean;
  }) => call<PolishResult>({ action: "polish", ...input }),

  send: (input: {
    accountId: string;
    to: string[];
    subject: string;
    body: string;
    attachments: OutgoingAttachment[];
    inReplyTo: string | null;
    references: string | null;
    anchorMessageId: string | null;
  }) => call<{ ok: boolean }>({ action: "send", ...input }),
};

/** Turn a base64 payload into a browser download. */
export function downloadBase64(filename: string, mime: string, base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "attachment";
  a.click();
  URL.revokeObjectURL(url);
}

/** Read a picked file as base64 (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatThreadDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

export function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
