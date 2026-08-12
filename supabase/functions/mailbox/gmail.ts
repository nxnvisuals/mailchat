// gmail — MailProvider implementation over IMAP (read) + SMTP (send),
// authenticated with a Google App Password. Threads come from Gmail's own
// X-GM-THRID conversation ids, so grouping matches the real Gmail apps.

import { ImapClient, ImapError, gmailRawQuery } from "./imap.ts";
import { SmtpClient, SmtpError } from "./smtp.ts";
import {
  asString,
  fetchAttrs,
  interpretEnvelope,
  interpretBodyStructure,
  pickTextPart,
  pickAttachments,
  parseInternalDate,
  parseHeaderBlock,
  type BodyPart,
  type Envelope,
  type ImapValue,
} from "./imapParse.ts";
import { decodeBodyText, decodeBodyBytes, encodeBase64 } from "./mimeText.ts";
import { htmlToText, dropHtmlQuotes, splitQuoted, makeSnippet } from "./quoteStrip.ts";
import { buildMime } from "./mimeBuild.ts";
import {
  MailError,
  type MailAccount,
  type MailProvider,
  type SendArgs,
  type ThreadDetail,
  type ThreadSummary,
  type UiMessage,
} from "./types.ts";

const THREAD_LIST_SCAN = 150;
const THREAD_LIST_MAX = 60;
const SNIPPET_BYTES = 700;
const BODY_FETCH_CAP = 400_000;
const ATTACHMENT_CAP = 20_000_000;

interface ParsedFetchRow {
  uid: number;
  threadId: string;
  flags: string[];
  date: string;
  envelope: Envelope;
  parts: BodyPart[];
  textPart: BodyPart | null;
  attachments: BodyPart[];
  headers: Record<string, string>;
}

function interpretFetchRow(list: ImapValue[]): ParsedFetchRow | null {
  const attrs = fetchAttrs(list);
  const uidStr = asString(attrs.get("UID") ?? null);
  if (!uidStr) return null;
  const flagsVal = attrs.get("FLAGS");
  const flags = Array.isArray(flagsVal) ? flagsVal.map((f) => (asString(f) ?? "").toLowerCase()) : [];
  const envelope = interpretEnvelope(attrs.get("ENVELOPE") ?? null);
  const parts = interpretBodyStructure(attrs.get("BODYSTRUCTURE") ?? attrs.get("BODY") ?? null);
  const textPart = pickTextPart(parts);
  const internal = parseInternalDate(asString(attrs.get("INTERNALDATE") ?? null));
  const envDate = envelope.date ? new Date(envelope.date) : null;
  const date = internal ?? (envDate && !isNaN(envDate.getTime()) ? envDate.toISOString() : new Date(0).toISOString());
  let headers: Record<string, string> = {};
  for (const [key, value] of attrs) {
    if (key.startsWith("BODY[HEADER")) {
      const raw = value instanceof Uint8Array ? new TextDecoder().decode(value) : (asString(value) ?? "");
      headers = parseHeaderBlock(raw);
    }
  }
  return {
    uid: parseInt(uidStr, 10),
    threadId: asString(attrs.get("X-GM-THRID") ?? null) ?? "",
    flags,
    date,
    envelope,
    parts,
    textPart,
    attachments: pickAttachments(parts, textPart?.section ?? null),
    headers,
  };
}

/** Fetch (possibly partial) text bodies for uid→part, batched per section. */
async function fetchTextBodies(
  imap: ImapClient,
  rows: Array<{ uid: number; part: BodyPart }>,
  partialBytes: number,
): Promise<Map<number, string>> {
  const bySection = new Map<string, number[]>();
  for (const { uid, part } of rows) {
    const list = bySection.get(part.section) ?? [];
    list.push(uid);
    bySection.set(part.section, list);
  }
  const partByUid = new Map(rows.map((r) => [r.uid, r.part]));
  const out = new Map<number, string>();
  for (const [section, uids] of bySection) {
    const results = await imap.fetch(uids.join(","), `UID BODY.PEEK[${section}]<0.${partialBytes}>`, true);
    for (const list of results) {
      const attrs = fetchAttrs(list);
      const uidStr = asString(attrs.get("UID") ?? null);
      if (!uidStr) continue;
      const uid = parseInt(uidStr, 10);
      const part = partByUid.get(uid);
      if (!part) continue;
      let raw: Uint8Array | null = null;
      for (const [key, value] of attrs) {
        if (key.startsWith("BODY[") && value instanceof Uint8Array) raw = value;
      }
      if (!raw) continue;
      let text = decodeBodyText(raw, part.encoding, part.params["charset"]);
      if (part.subtype === "html") text = htmlToText(dropHtmlQuotes(text));
      out.set(uid, text);
    }
  }
  return out;
}

async function openImap(account: MailAccount): Promise<ImapClient> {
  const imap = await ImapClient.connect();
  try {
    await imap.login(account.email, account.app_password ?? "");
    return imap;
  } catch (e) {
    imap.close();
    throw e;
  }
}

export function gmailProvider(account: MailAccount): MailProvider {
  return {
    async listThreads(q, filter) {
      const imap = await openImap(account);
      try {
        let rows: ParsedFetchRow[] = [];
        const items = "UID X-GM-THRID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE";
        if (q) {
          const { allMail } = await imap.findSpecialFolders();
          await imap.select(allMail);
          const uids = await imap.uidSearch(gmailRawQuery(q));
          const recent = uids.slice(-THREAD_LIST_SCAN);
          if (recent.length > 0) {
            rows = (await imap.fetch(recent.join(","), items, true))
              .map(interpretFetchRow)
              .filter((r): r is ParsedFetchRow => r !== null);
          }
        } else {
          const { exists } = await imap.select("INBOX");
          if (exists > 0) {
            const from = Math.max(1, exists - THREAD_LIST_SCAN + 1);
            rows = (await imap.fetch(`${from}:${exists}`, items, false))
              .map(interpretFetchRow)
              .filter((r): r is ParsedFetchRow => r !== null);
          }
        }

        const byThread = new Map<string, ParsedFetchRow[]>();
        for (const row of rows) {
          if (!row.threadId) continue;
          const list = byThread.get(row.threadId) ?? [];
          list.push(row);
          byThread.set(row.threadId, list);
        }
        let threads = [...byThread.entries()].map(([threadId, msgs]) => {
          msgs.sort((a, b) => a.date.localeCompare(b.date));
          const latest = msgs[msgs.length - 1];
          const from = latest.envelope.from[0] ?? { name: "(unknown)", email: "" };
          return {
            latest,
            data: {
              threadId,
              subject: latest.envelope.subject || "(no subject)",
              from,
              fromIsMe: from.email === account.email,
              date: latest.date,
              unread: msgs.some((m) => !m.flags.includes("\\seen")),
              count: msgs.length,
              hasAttachments: msgs.some((m) => m.attachments.length > 0),
              snippet: "",
            } satisfies ThreadSummary,
          };
        });
        threads.sort((a, b) => b.data.date.localeCompare(a.data.date));
        if (filter === "unread") threads = threads.filter((t) => t.data.unread);
        threads = threads.slice(0, THREAD_LIST_MAX);

        const snippetRows = threads
          .filter((t) => t.latest.textPart)
          .map((t) => ({ uid: t.latest.uid, part: t.latest.textPart! }));
        const texts = await fetchTextBodies(imap, snippetRows, SNIPPET_BYTES);
        for (const t of threads) {
          const text = texts.get(t.latest.uid);
          if (text) t.data.snippet = makeSnippet(splitQuoted(text).visible);
        }

        await imap.logout();
        return { threads: threads.map((t) => t.data), scannedAll: rows.length < THREAD_LIST_SCAN };
      } catch (e) {
        imap.close();
        throw e;
      }
    },

    async getThread(threadId, markRead) {
      if (!/^\d{1,25}$/.test(threadId)) throw new MailError("Bad thread id");
      const imap = await openImap(account);
      try {
        const { allMail } = await imap.findSpecialFolders();
        await imap.select(allMail);
        const uids = await imap.uidSearch(`X-GM-THRID ${threadId}`);
        if (uids.length === 0) throw new MailError("This conversation is no longer available.");
        const items =
          "UID X-GM-THRID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)]";
        const rows = (await imap.fetch(uids.join(","), items, true))
          .map(interpretFetchRow)
          .filter((r): r is ParsedFetchRow => r !== null)
          .sort((a, b) => a.date.localeCompare(b.date));

        const bodyRows = rows.filter((r) => r.textPart).map((r) => ({ uid: r.uid, part: r.textPart! }));
        const texts = await fetchTextBodies(imap, bodyRows, BODY_FETCH_CAP);

        const messages: UiMessage[] = rows.map((r) => {
          const raw = texts.get(r.uid) ?? "";
          const { visible, quoted } = splitQuoted(raw);
          const from = r.envelope.from[0] ?? { name: "(unknown)", email: "" };
          return {
            id: String(r.uid),
            from,
            to: r.envelope.to,
            cc: r.envelope.cc,
            date: r.date,
            isMe: from.email === account.email,
            text: visible || "(no text — this email may only contain attachments or images)",
            quoted,
            attachments: r.attachments.map((a) => ({
              messageId: String(r.uid),
              partId: a.section,
              filename: a.filename || `attachment.${a.subtype}`,
              mime: `${a.type}/${a.subtype}`,
              size: a.size,
            })),
            unread: !r.flags.includes("\\seen"),
          };
        });

        const lastInbound = [...rows].reverse().find((r) => (r.envelope.from[0]?.email ?? "") !== account.email);
        const anchor = lastInbound ?? rows[rows.length - 1];
        const replyTo =
          lastInbound !== undefined
            ? lastInbound.envelope.from
            : anchor.envelope.to.filter((a) => a.email !== account.email);
        const subject = anchor.envelope.subject || "(no subject)";

        if (markRead) {
          const unreadUids = rows.filter((r) => !r.flags.includes("\\seen")).map((r) => r.uid);
          if (unreadUids.length > 0) {
            // Gmail flags are per-message (labels are folders), so setting
            // \Seen via All Mail clears the unread state everywhere.
            await imap.uidStore(unreadUids.join(","), "+FLAGS.SILENT (\\Seen)");
          }
        }

        await imap.logout();
        return {
          threadId,
          subject: anchor.envelope.subject || "(no subject)",
          myEmail: account.email,
          messages,
          reply: {
            to: replyTo,
            subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
            inReplyTo: anchor.headers["message-id"] ?? anchor.envelope.messageId ?? null,
            references: anchor.headers["references"] ?? null,
            anchorMessageId: null,
          },
        } satisfies ThreadDetail;
      } catch (e) {
        imap.close();
        throw e;
      }
    },

    async getAttachment(messageId, partId) {
      if (!/^\d{1,12}$/.test(messageId) || !/^\d{1,4}(\.\d{1,4}){0,8}$/.test(partId)) {
        throw new MailError("Bad attachment reference");
      }
      const imap = await openImap(account);
      try {
        const { allMail } = await imap.findSpecialFolders();
        await imap.select(allMail);
        const structRows = await imap.fetch(messageId, "UID BODYSTRUCTURE", true);
        const parsed = structRows.map(interpretFetchRow).find((r) => r !== null) ?? null;
        const part = parsed?.parts.find((p) => p.section === partId) ?? null;
        if (!part) throw new MailError("Attachment not found.");
        if (part.size > ATTACHMENT_CAP) {
          throw new MailError("This attachment is too large to download here — open it in Gmail.");
        }
        const results = await imap.fetch(messageId, `UID BODY.PEEK[${partId}]`, true);
        let raw: Uint8Array | null = null;
        for (const list of results) {
          const attrs = fetchAttrs(list);
          for (const [key, value] of attrs) {
            if (key.startsWith("BODY[") && value instanceof Uint8Array) raw = value;
          }
        }
        await imap.logout();
        if (!raw) throw new MailError("Attachment could not be read.");
        const bytes = decodeBodyBytes(raw, part.encoding);
        return {
          filename: part.filename || `attachment.${part.subtype}`,
          mime: `${part.type}/${part.subtype}`,
          base64: encodeBase64(bytes),
        };
      } catch (e) {
        imap.close();
        throw e;
      }
    },

    async send(args: SendArgs) {
      const domain = account.email.split("@")[1] ?? "gmail.com";
      const mime = buildMime({
        from: { name: account.display_name || undefined, email: account.email },
        to: args.to,
        subject: args.subject,
        textBody: args.body.replace(/\n/g, "\r\n"),
        attachments: args.attachments,
        inReplyTo: args.inReplyTo,
        references: args.references,
        date: new Date(),
        messageId: `<${crypto.randomUUID()}@${domain}>`,
      });
      const smtp = await SmtpClient.connect();
      try {
        await smtp.authPlain(account.email, account.app_password ?? "");
        await smtp.sendMessage(
          account.email,
          args.to.map((t) => t.email),
          mime,
        );
        await smtp.quit();
      } catch (e) {
        smtp.close();
        throw e;
      }
    },
  };
}

/** Verify a Gmail address + app password by actually logging in. */
export async function verifyGmailLogin(email: string, appPassword: string): Promise<void> {
  const imap = await ImapClient.connect();
  try {
    await imap.login(email, appPassword);
    await imap.findSpecialFolders();
    await imap.logout();
  } catch (e) {
    imap.close();
    throw e;
  }
}

export { ImapError, SmtpError };
