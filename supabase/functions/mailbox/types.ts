// types — the provider-agnostic contract between index.ts (router), the UI,
// and the two mail providers (gmail.ts over IMAP/SMTP, outlook.ts over
// Microsoft Graph). Message and attachment references are opaque strings the
// provider that produced them knows how to resolve.

import type { MailAddress } from "./imapParse.ts";
import type { OutAddress, OutAttachment } from "./mimeBuild.ts";

export class MailError extends Error {
  constructor(message: string, public readonly kind: "auth" | "protocol" | "network" = "protocol") {
    super(message);
  }
}

export interface MailAccount {
  id: string;
  provider: "gmail" | "outlook";
  email: string;
  display_name: string;
  signature: string;
  app_password: string | null;
  ms_client_id: string | null;
  ms_client_secret: string | null;
  ms_refresh_token: string | null;
  ms_access_token: string | null;
  ms_token_expires_at: string | null;
  anthropic_api_key: string | null;
  ai_model: string;
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

export interface UiAttachment {
  /** Provider message reference (gmail: UID; outlook: Graph message id). */
  messageId: string;
  /** Provider part reference (gmail: MIME section; outlook: attachment id). */
  partId: string;
  filename: string;
  mime: string;
  size: number;
}

export interface UiMessage {
  id: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  date: string;
  isMe: boolean;
  text: string;
  quoted: string;
  attachments: UiAttachment[];
  unread: boolean;
}

export interface ReplyMeta {
  to: MailAddress[];
  subject: string;
  /** RFC 5322 threading (gmail path). */
  inReplyTo: string | null;
  references: string | null;
  /** Graph reply anchor (outlook path). */
  anchorMessageId: string | null;
}

export interface ThreadDetail {
  threadId: string;
  subject: string;
  myEmail: string;
  messages: UiMessage[];
  reply: ReplyMeta;
}

export interface SendArgs {
  to: OutAddress[];
  subject: string;
  body: string;
  attachments: OutAttachment[];
  inReplyTo: string | null;
  references: string | null;
  anchorMessageId: string | null;
}

export interface AttachmentContent {
  filename: string;
  mime: string;
  base64: string;
}

export interface MailProvider {
  listThreads(q: string, filter: "inbox" | "unread"): Promise<{ threads: ThreadSummary[]; scannedAll: boolean }>;
  getThread(threadId: string, markRead: boolean): Promise<ThreadDetail>;
  getAttachment(messageId: string, partId: string): Promise<AttachmentContent>;
  send(args: SendArgs): Promise<void>;
}
