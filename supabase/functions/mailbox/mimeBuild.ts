// mimeBuild — assembles outgoing RFC 5322 messages for SMTP.
//
// Replies thread correctly for recipients because we set In-Reply-To /
// References from the message being answered; Gmail additionally threads by
// subject. Bodies and attachments are base64-encoded (no raw 8-bit on the
// wire, no dot-stuffing surprises), headers are sanitized against CRLF
// injection and RFC 2047-encoded when they contain non-ASCII.
//
// Pure string logic — unit-testable under vitest.

import { encodeBase64 } from "./mimeText.ts";

export interface OutAddress {
  name?: string;
  email: string;
}

export interface OutAttachment {
  filename: string;
  mime: string;
  /** Raw content, already base64 (as received from the browser). */
  base64: string;
}

export interface OutgoingMail {
  from: OutAddress;
  to: OutAddress[];
  cc?: OutAddress[];
  subject: string;
  textBody: string;
  attachments?: OutAttachment[];
  inReplyTo?: string | null;
  references?: string | null;
  date: Date;
  messageId: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Kill header injection: no CR/LF ever makes it into a header value. */
export function sanitizeHeaderValue(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

// deno-lint-ignore no-control-regex
const NON_ASCII = /[^\x20-\x7e]/;

/** RFC 2047 B-encode a header text when it contains non-ASCII. */
export function encodeHeaderText(v: string): string {
  const clean = sanitizeHeaderValue(v);
  if (!NON_ASCII.test(clean)) return clean;
  // Chunk on UTF-8 bytes so each encoded-word stays under the 75-char limit.
  const bytes = new TextEncoder().encode(clean);
  const words: string[] = [];
  const CHUNK = 42; // 42 bytes → 56 base64 chars → "=?UTF-8?B?…?=" ≤ 75
  for (let i = 0; i < bytes.length; i += CHUNK) {
    let end = Math.min(i + CHUNK, bytes.length);
    // Don't split a multi-byte sequence: back off over continuation bytes.
    while (end > i && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    words.push(`=?UTF-8?B?${encodeBase64(bytes.subarray(i, end))}?=`);
    i = end - CHUNK; // loop adds CHUNK back
  }
  return words.join(" ");
}

export function formatAddress(a: OutAddress): string {
  const email = sanitizeHeaderValue(a.email);
  const name = (a.name ?? "").trim();
  if (!name || name === email) return `<${email}>`;
  const encoded = encodeHeaderText(name);
  // Quote plain names containing specials; encoded-words go bare.
  const safe = encoded.startsWith("=?") ? encoded : /[^A-Za-z0-9 '\-.]/.test(encoded) ? `"${encoded.replace(/(["\\])/g, "\\$1")}"` : encoded;
  return `${safe} <${email}>`;
}

export function formatAddressList(list: OutAddress[]): string {
  return list.map(formatAddress).join(", ");
}

/** Wrap base64 payloads at 76 columns per MIME. */
export function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 date, rendered in UTC. */
export function formatRfc822Date(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

/** Content-Disposition filename, RFC 2231-encoded when non-ASCII. */
function filenameParam(filename: string): string {
  const clean = sanitizeHeaderValue(filename) || "attachment";
  if (!NON_ASCII.test(clean) && !clean.includes('"')) return `filename="${clean}"`;
  const utf8 = new TextEncoder().encode(clean);
  let pct = "";
  for (const b of utf8) {
    pct += /[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `filename*=UTF-8''${pct}`;
}

/** Strip whitespace/newlines from browser-produced base64. */
function cleanBase64(b64: string): string {
  return b64.replace(/[^A-Za-z0-9+/=]/g, "");
}

/** Build the full RFC 5322 message (CRLF line endings) ready for SMTP DATA. */
export function buildMime(mail: OutgoingMail): string {
  const headers: string[] = [];
  headers.push(`From: ${formatAddress(mail.from)}`);
  headers.push(`To: ${formatAddressList(mail.to)}`);
  if (mail.cc && mail.cc.length > 0) headers.push(`Cc: ${formatAddressList(mail.cc)}`);
  headers.push(`Subject: ${encodeHeaderText(mail.subject || "(no subject)")}`);
  headers.push(`Date: ${formatRfc822Date(mail.date)}`);
  headers.push(`Message-ID: ${sanitizeHeaderValue(mail.messageId)}`);
  if (mail.inReplyTo) {
    const irt = sanitizeHeaderValue(mail.inReplyTo);
    headers.push(`In-Reply-To: ${irt}`);
    const refs = sanitizeHeaderValue(mail.references ?? "");
    const chain = refs ? `${refs} ${irt}` : irt;
    // Keep References bounded (very long chains get trimmed from the front).
    const parts = chain.split(/\s+/).filter(Boolean);
    headers.push(`References: ${parts.slice(-20).join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");

  const textPart =
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    wrapBase64(encodeBase64(new TextEncoder().encode(mail.textBody))) +
    `\r\n`;

  let body: string;
  const attachments = mail.attachments ?? [];
  if (attachments.length === 0) {
    headers.push(`Content-Type: text/plain; charset=UTF-8`);
    headers.push(`Content-Transfer-Encoding: base64`);
    body = wrapBase64(encodeBase64(new TextEncoder().encode(mail.textBody))) + "\r\n";
  } else {
    const boundary = `=_aloha_${mail.messageId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}_${attachments.length}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [textPart];
    for (const att of attachments) {
      const mime = sanitizeHeaderValue(att.mime) || "application/octet-stream";
      parts.push(
        `Content-Type: ${mime}\r\n` +
          `Content-Transfer-Encoding: base64\r\n` +
          `Content-Disposition: attachment; ${filenameParam(att.filename)}\r\n\r\n` +
          wrapBase64(cleanBase64(att.base64)) +
          `\r\n`,
      );
    }
    body = parts.map((p) => `--${boundary}\r\n${p}`).join("") + `--${boundary}--\r\n`;
  }

  return headers.join("\r\n") + "\r\n\r\n" + body;
}

/** SMTP DATA transparency: double any line-leading dot (RFC 5321 §4.5.2). */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, "$1..");
}
