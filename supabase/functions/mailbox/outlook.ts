// outlook — MailProvider implementation over Microsoft Graph.
//
// Microsoft turned off app-password/basic sign-in for Outlook mail in 2024,
// so this provider uses OAuth: the owner registers a small (free) app in
// Microsoft Entra, signs in once, and we keep the refresh token. Graph gives
// us conversations natively (conversationId), the non-quoted part of each
// message (uniqueBody), attachments, and reply drafts that thread correctly.

import { htmlToText, splitQuoted, makeSnippet } from "./quoteStrip.ts";
import type { MailAddress } from "./imapParse.ts";
import { encodeBase64 } from "./mimeText.ts";
import {
  MailError,
  type MailAccount,
  type MailProvider,
  type SendArgs,
  type ThreadDetail,
  type ThreadSummary,
  type UiAttachment,
  type UiMessage,
} from "./types.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const OUTLOOK_SCOPES = "offline_access User.Read Mail.ReadWrite Mail.Send";

const LIST_TOP = 100;
const THREAD_LIST_MAX = 60;
// Graph rejects request bodies over ~4 MB, which bounds per-attachment size
// on the simple upload path (base64 inflates by ~1.37x).
const OUTLOOK_ATTACH_B64_CAP = 4_400_000;

export interface OutlookTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export type TokenSaver = (tokens: OutlookTokens) => Promise<void>;

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphBody {
  contentType?: string;
  content?: string;
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  bodyPreview?: string;
  body?: GraphBody;
  uniqueBody?: GraphBody;
  internetMessageId?: string;
}

function firstSentence(s: string): string {
  const cut = s.indexOf(". ");
  return cut === -1 ? s.slice(0, 200) : s.slice(0, cut + 1);
}

async function tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(form) });
  } catch (e) {
    throw new MailError(`Could not reach Microsoft's sign-in service: ${(e as Error).message}`, "network");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(json.error ?? "unknown_error");
    const desc = firstSentence(String(json.error_description ?? ""));
    if (code === "invalid_grant") {
      throw new MailError("Your Outlook connection has expired or was revoked — open Mail settings and reconnect.", "auth");
    }
    throw new MailError(`Microsoft sign-in problem (${code}): ${desc || "no details"}`, "auth");
  }
  return json;
}

/** One-time auth-code exchange when connecting an Outlook account. */
export async function exchangeOutlookCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ tokens: OutlookTokens; email: string; displayName: string }> {
  const json = await tokenRequest({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    scope: OUTLOOK_SCOPES,
  });
  const tokens: OutlookTokens = {
    accessToken: String(json.access_token ?? ""),
    refreshToken: String(json.refresh_token ?? ""),
    expiresAt: new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000).toISOString(),
  };
  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new MailError("Microsoft didn't return the expected sign-in tokens. Check the app registration's permissions (offline_access, Mail.ReadWrite, Mail.Send).", "auth");
  }
  // Who did we just connect?
  const meRes = await fetch(`${GRAPH}/me?$select=displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  const me = (await meRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!meRes.ok) throw new MailError("Signed in, but couldn't read the account's profile from Microsoft.", "auth");
  const email = String(me.mail ?? me.userPrincipalName ?? "").toLowerCase();
  if (!email) throw new MailError("Microsoft didn't report an email address for this account.", "auth");
  return { tokens, email, displayName: String(me.displayName ?? "") };
}

class GraphClient {
  private accessToken: string;
  private expiresAt: number;

  constructor(
    private account: MailAccount,
    private saveTokens: TokenSaver,
  ) {
    this.accessToken = account.ms_access_token ?? "";
    this.expiresAt = account.ms_token_expires_at ? new Date(account.ms_token_expires_at).getTime() : 0;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.expiresAt - Date.now() > 60_000) return this.accessToken;
    const json = await tokenRequest({
      client_id: this.account.ms_client_id ?? "",
      client_secret: this.account.ms_client_secret ?? "",
      grant_type: "refresh_token",
      refresh_token: this.account.ms_refresh_token ?? "",
      scope: OUTLOOK_SCOPES,
    });
    this.accessToken = String(json.access_token ?? "");
    this.expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
    // Microsoft rotates refresh tokens — persist the new one or the account
    // dies quietly in 90 days.
    await this.saveTokens({
      accessToken: this.accessToken,
      refreshToken: String(json.refresh_token ?? this.account.ms_refresh_token ?? ""),
      expiresAt: new Date(this.expiresAt).toISOString(),
    });
    return this.accessToken;
  }

  async request<T>(path: string, init?: RequestInit & { expectEmpty?: boolean }): Promise<T> {
    const token = await this.token();
    let res: Response;
    try {
      res = await fetch(`${GRAPH}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      throw new MailError(`Could not reach Outlook: ${(e as Error).message}`, "network");
    }
    if (res.status === 401) {
      throw new MailError("Outlook rejected the connection — open Mail settings and reconnect this account.", "auth");
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new MailError(
        `Outlook refused the request (${json.error?.code ?? res.status}): ${firstSentence(json.error?.message ?? "")}`,
      );
    }
    if (init?.expectEmpty || res.status === 204 || res.status === 202) return undefined as T;
    return (await res.json()) as T;
  }

  async requestBytes(path: string): Promise<Uint8Array> {
    const token = await this.token();
    const res = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new MailError(`Outlook attachment download failed (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

function toAddress(r: GraphRecipient | undefined): MailAddress | null {
  const address = r?.emailAddress?.address?.trim();
  if (!address) return null;
  return { name: r?.emailAddress?.name?.trim() || address, email: address.toLowerCase() };
}

function toAddressList(list: GraphRecipient[] | undefined): MailAddress[] {
  return (list ?? []).map(toAddress).filter((a): a is MailAddress => a !== null);
}

function bodyToText(body: GraphBody | undefined): string {
  const content = body?.content ?? "";
  if (!content) return "";
  return (body?.contentType ?? "").toLowerCase() === "html" ? htmlToText(content) : content.replace(/\r\n/g, "\n").trim();
}

const CONVERSATION_ID_RE = /^[A-Za-z0-9_=+/-]{10,512}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_=+/-]{5,512}$/;

export function outlookProvider(account: MailAccount, saveTokens: TokenSaver): MailProvider {
  const graph = new GraphClient(account, saveTokens);
  const myEmail = account.email;

  const messageSelect =
    "$select=id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview";

  return {
    async listThreads(q, folder) {
      let messages: GraphMessage[];
      if (q) {
        const query = q.replace(/["\\]/g, " ").trim();
        const res = await graph.request<{ value: GraphMessage[] }>(
          `/me/messages?$search="${encodeURIComponent(query)}"&$top=${LIST_TOP}&${messageSelect}`,
        );
        messages = res.value ?? [];
      } else if (folder === "starred") {
        // Outlook has no Starred folder; flagged messages live across all of
        // them, so this is a filter over the mailbox rather than a folder read.
        const res = await graph.request<{ value: GraphMessage[] }>(
          `/me/messages?$filter=${encodeURIComponent("flag/flagStatus eq 'flagged'")}` +
            `&$top=${LIST_TOP}&$orderby=receivedDateTime desc&${messageSelect}`,
        );
        messages = res.value ?? [];
      } else {
        // Graph well-known folder names. Unlike Gmail, Outlook has a real
        // Archive folder, so this maps straight across.
        const wellKnown =
          folder === "sent"
            ? "sentitems"
            : folder === "drafts"
              ? "drafts"
              : folder === "archive"
                ? "archive"
                : "inbox";
        const res = await graph.request<{ value: GraphMessage[] }>(
          `/me/mailFolders/${wellKnown}/messages?$top=${LIST_TOP}&$orderby=receivedDateTime desc&${messageSelect}`,
        );
        messages = res.value ?? [];
      }

      const byThread = new Map<string, GraphMessage[]>();
      for (const m of messages) {
        if (!m.conversationId) continue;
        const list = byThread.get(m.conversationId) ?? [];
        list.push(m);
        byThread.set(m.conversationId, list);
      }
      let threads: ThreadSummary[] = [...byThread.entries()].map(([threadId, msgs]) => {
        msgs.sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
        const latest = msgs[msgs.length - 1];
        const from = toAddress(latest.from) ?? { name: "(unknown)", email: "" };
        return {
          threadId,
          subject: latest.subject || "(no subject)",
          from,
          fromIsMe: from.email === myEmail,
          date: latest.receivedDateTime ?? new Date(0).toISOString(),
          unread: msgs.some((m) => m.isRead === false),
          count: msgs.length,
          hasAttachments: msgs.some((m) => m.hasAttachments),
          snippet: makeSnippet(latest.bodyPreview ?? ""),
        };
      });
      threads.sort((a, b) => b.date.localeCompare(a.date));
      if (folder === "unread") threads = threads.filter((t) => t.unread);
      return { threads: threads.slice(0, THREAD_LIST_MAX), scannedAll: messages.length < LIST_TOP };
    },

    async getThread(threadId, markRead) {
      if (!CONVERSATION_ID_RE.test(threadId)) throw new MailError("Bad thread id");
      const res = await graph.request<{ value: GraphMessage[] }>(
        `/me/messages?$filter=conversationId eq '${threadId}'&$top=${LIST_TOP}` +
          `&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,body,uniqueBody,internetMessageId`,
      );
      const rows = (res.value ?? []).sort((a, b) =>
        (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""),
      );
      if (rows.length === 0) throw new MailError("This conversation is no longer available.");

      // Attachment metadata for the messages that have any.
      const attachmentsByMessage = new Map<string, UiAttachment[]>();
      await Promise.all(
        rows
          .filter((m) => m.hasAttachments)
          .map(async (m) => {
            const list = await graph.request<{
              value: Array<{ id: string; name?: string; contentType?: string; size?: number; isInline?: boolean }>;
            }>(`/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`);
            attachmentsByMessage.set(
              m.id,
              (list.value ?? []).map((a) => ({
                messageId: m.id,
                partId: a.id,
                filename: a.name || "attachment",
                mime: a.contentType || "application/octet-stream",
                size: a.size ?? 0,
              })),
            );
          }),
      );

      const messages: UiMessage[] = rows.map((m) => {
        const fullText = bodyToText(m.body);
        const uniqueText = bodyToText(m.uniqueBody);
        let visible: string;
        let quoted: string;
        if (uniqueText) {
          // Graph already isolates the fresh part; still trim signatures.
          const split = splitQuoted(uniqueText);
          visible = split.visible;
          quoted =
            fullText && fullText.length > visible.length + 40
              ? fullText
              : split.quoted;
        } else {
          const split = splitQuoted(fullText);
          visible = split.visible;
          quoted = split.quoted;
        }
        const from = toAddress(m.from) ?? { name: "(unknown)", email: "" };
        return {
          id: m.id,
          from,
          to: toAddressList(m.toRecipients),
          cc: toAddressList(m.ccRecipients),
          date: m.receivedDateTime ?? new Date(0).toISOString(),
          isMe: from.email === myEmail,
          text: visible || "(no text — this email may only contain attachments or images)",
          quoted,
          attachments: attachmentsByMessage.get(m.id) ?? [],
          unread: m.isRead === false,
        };
      });

      const lastInbound = [...rows].reverse().find((m) => (toAddress(m.from)?.email ?? "") !== myEmail);
      const anchor = lastInbound ?? rows[rows.length - 1];
      const anchorFrom = toAddress(anchor.from);
      const replyTo =
        lastInbound !== undefined && anchorFrom
          ? [anchorFrom]
          : toAddressList(anchor.toRecipients).filter((a) => a.email !== myEmail);
      const subject = anchor.subject || "(no subject)";

      if (markRead) {
        await Promise.all(
          rows
            .filter((m) => m.isRead === false)
            .map((m) =>
              graph.request(`/me/messages/${encodeURIComponent(m.id)}`, {
                method: "PATCH",
                body: JSON.stringify({ isRead: true }),
                expectEmpty: true,
              }),
            ),
        );
      }

      return {
        threadId,
        subject,
        myEmail,
        messages,
        reply: {
          to: replyTo,
          subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
          inReplyTo: null,
          references: null,
          anchorMessageId: anchor.id,
        },
      } satisfies ThreadDetail;
    },

    async getAttachment(messageId, partId) {
      if (!MESSAGE_ID_RE.test(messageId) || !MESSAGE_ID_RE.test(partId)) {
        throw new MailError("Bad attachment reference");
      }
      const meta = await graph.request<{ name?: string; contentType?: string; "@odata.type"?: string }>(
        `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}?$select=name,contentType`,
      );
      const isItem = (meta["@odata.type"] ?? "").includes("itemAttachment");
      const bytes = await graph.requestBytes(
        `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}/$value`,
      );
      return {
        filename: isItem ? `${meta.name || "attached-message"}.eml` : meta.name || "attachment",
        mime: isItem ? "message/rfc822" : meta.contentType || "application/octet-stream",
        base64: encodeBase64(bytes),
      };
    },

    async send(args: SendArgs) {
      for (const att of args.attachments) {
        if (att.base64.length > OUTLOOK_ATTACH_B64_CAP) {
          throw new MailError(`"${att.filename}" is too big for Outlook here — attachments are limited to about 3 MB each for now.`);
        }
      }
      let draftId: string;
      if (args.anchorMessageId) {
        if (!MESSAGE_ID_RE.test(args.anchorMessageId)) throw new MailError("Bad reply reference");
        const draft = await graph.request<{ id: string }>(
          `/me/messages/${encodeURIComponent(args.anchorMessageId)}/createReply`,
          { method: "POST", body: JSON.stringify({}) },
        );
        draftId = draft.id;
      } else {
        const draft = await graph.request<{ id: string }>(`/me/messages`, {
          method: "POST",
          body: JSON.stringify({ subject: args.subject }),
        });
        draftId = draft.id;
      }
      await graph.request(`/me/messages/${encodeURIComponent(draftId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          subject: args.subject,
          body: { contentType: "Text", content: args.body },
          toRecipients: args.to.map((t) => ({ emailAddress: { address: t.email, name: t.name ?? t.email } })),
        }),
      });
      for (const att of args.attachments) {
        await graph.request(`/me/messages/${encodeURIComponent(draftId)}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: att.filename,
            contentType: att.mime,
            contentBytes: att.base64,
          }),
        });
      }
      await graph.request(`/me/messages/${encodeURIComponent(draftId)}/send`, {
        method: "POST",
        expectEmpty: true,
      });
    },
  };
}
