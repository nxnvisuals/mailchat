// imapParse — pure parser for IMAP response lines (Gmail dialect).
//
// The socket layer (imap.ts) hands us each untagged response as a "logical
// line": the ASCII text with every literal ("{123}\r\n<bytes>") replaced by a
// `{n}` marker, plus the literal byte buffers in order. This module turns
// that into nested values and then interprets the structures we care about:
// ENVELOPE, BODYSTRUCTURE, FLAGS, X-GM-THRID, INTERNALDATE, and body sections.
//
// No Deno APIs — unit-testable under vitest.

import { bytesToAscii, decodeMimeParamValue, decodeRfc2047 } from "./mimeText.ts";

/** Parsed IMAP value: atom/quoted string, literal bytes, NIL, or a list. */
export type ImapValue = string | Uint8Array | null | ImapValue[];

/**
 * Parse one logical response line body (after "* ") into a value list.
 * `literals` are consumed in order wherever a `{n}` marker appears.
 */
export function parseImapLine(text: string, literals: Uint8Array[]): ImapValue[] {
  let pos = 0;
  let literalIndex = 0;

  function skipSpaces() {
    while (pos < text.length && text[pos] === " ") pos++;
  }

  function parseList(): ImapValue[] {
    const items: ImapValue[] = [];
    for (;;) {
      skipSpaces();
      if (pos >= text.length) return items;
      const c = text[pos];
      if (c === ")") {
        pos++;
        return items;
      }
      items.push(parseValue());
    }
  }

  function parseValue(): ImapValue {
    const c = text[pos];
    if (c === "(") {
      pos++;
      return parseList();
    }
    if (c === '"') {
      pos++;
      let out = "";
      while (pos < text.length && text[pos] !== '"') {
        if (text[pos] === "\\" && pos + 1 < text.length) {
          out += text[pos + 1];
          pos += 2;
        } else {
          out += text[pos];
          pos++;
        }
      }
      pos++; // closing quote
      return out;
    }
    if (c === "{") {
      // Literal marker "{n}" — consume the next buffered literal.
      const end = text.indexOf("}", pos);
      pos = end + 1;
      return literals[literalIndex++] ?? new Uint8Array(0);
    }
    // Atom. May embed a bracketed section like BODY[HEADER.FIELDS (A B)] —
    // brackets can contain spaces and parens, so consume to the closing ']'.
    const start = pos;
    let out = "";
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === "[") {
        const close = text.indexOf("]", pos);
        if (close === -1) {
          pos = text.length;
          break;
        }
        pos = close + 1;
        continue;
      }
      if (ch === " " || ch === ")" || ch === "(") break;
      pos++;
    }
    out = text.slice(start, pos);
    if (out.toUpperCase() === "NIL") return null;
    return out;
  }

  return parseList();
}

/** Convert an ImapValue to a display string (literals decoded as ASCII). */
export function asString(v: ImapValue): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return bytesToAscii(v);
  return null;
}

/**
 * FETCH responses are flat lists alternating key / value:
 * (UID 5 FLAGS (\Seen) ENVELOPE (...)). Keys are case-insensitive atoms;
 * section keys like BODY[1] keep their bracket text.
 */
export function fetchAttrs(list: ImapValue[]): Map<string, ImapValue> {
  const map = new Map<string, ImapValue>();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = asString(list[i]);
    if (!key) continue;
    map.set(key.toUpperCase(), list[i + 1]);
  }
  return map;
}

export interface MailAddress {
  name: string;
  email: string;
}

function interpretAddressList(v: ImapValue): MailAddress[] {
  if (!Array.isArray(v)) return [];
  const out: MailAddress[] = [];
  for (const item of v) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const rawName = asString(item[0]);
    const mailbox = asString(item[2]);
    const host = asString(item[3]);
    if (!mailbox || !host) continue; // group syntax markers
    const email = `${mailbox}@${host}`;
    const name = rawName ? decodeRfc2047(rawName).trim() : "";
    out.push({ name: name || email, email: email.toLowerCase() });
  }
  return out;
}

export interface Envelope {
  date: string | null;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  inReplyTo: string | null;
  messageId: string | null;
}

/** ENVELOPE = (date subject from sender reply-to to cc bcc in-reply-to message-id) */
export function interpretEnvelope(v: ImapValue): Envelope {
  const list = Array.isArray(v) ? v : [];
  const subjectRaw = asString(list[1] ?? null);
  return {
    date: asString(list[0] ?? null),
    subject: subjectRaw ? decodeRfc2047(subjectRaw).trim() : "",
    from: interpretAddressList(list[2] ?? null),
    to: interpretAddressList(list[5] ?? null),
    cc: interpretAddressList(list[6] ?? null),
    inReplyTo: asString(list[8] ?? null),
    messageId: asString(list[9] ?? null),
  };
}

export interface BodyPart {
  /** IMAP section id usable in BODY.PEEK[...], e.g. "1" or "2.1". */
  section: string;
  type: string; // lowercased, e.g. "text"
  subtype: string; // lowercased, e.g. "plain"
  params: Record<string, string>;
  encoding: string; // lowercased transfer encoding
  size: number;
  disposition: string; // "", "attachment", "inline"
  filename: string; // decoded, "" when absent
}

function interpretParams(v: ImapValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(v)) return out;
  // RFC 2231 continuations: name*0*, name*1*, name*, name*0 …
  const pieces: Record<string, { star: boolean; parts: Array<{ idx: number; val: string }> }> = {};
  for (let i = 0; i + 1 < v.length; i += 2) {
    const rawKey = asString(v[i]);
    const rawVal = asString(v[i + 1]);
    if (!rawKey || rawVal === null) continue;
    const m = rawKey.toLowerCase().match(/^([^*]+)(?:\*(\d+))?(\*)?$/);
    if (!m) continue;
    const [, base, idxStr, star] = m;
    const rec = (pieces[base] ??= { star: false, parts: [] });
    if (star) rec.star = true;
    rec.parts.push({ idx: idxStr ? parseInt(idxStr, 10) : -1, val: rawVal });
  }
  for (const [base, rec] of Object.entries(pieces)) {
    rec.parts.sort((a, b) => a.idx - b.idx);
    const joined = rec.parts.map((p) => p.val).join("");
    out[base] = decodeMimeParamValue(joined, rec.star);
  }
  return out;
}

function leafPart(list: ImapValue[], section: string): BodyPart {
  const type = (asString(list[0]) ?? "application").toLowerCase();
  const subtype = (asString(list[1]) ?? "octet-stream").toLowerCase();
  const params = interpretParams(list[2] ?? null);
  const encoding = (asString(list[5] ?? null) ?? "7bit").toLowerCase();
  const sizeStr = asString(list[6] ?? null);
  const size = sizeStr ? parseInt(sizeStr, 10) || 0 : 0;

  // Extension fields start after the type-specific ones.
  let ext = 7;
  if (type === "text") ext = 8;
  else if (type === "message" && subtype === "rfc822") ext = 10;

  let disposition = "";
  let filename = params["name"] ?? "";
  const disp = list[ext + 1];
  if (Array.isArray(disp)) {
    disposition = (asString(disp[0]) ?? "").toLowerCase();
    const dispParams = interpretParams(disp[1] ?? null);
    if (dispParams["filename"]) filename = dispParams["filename"];
  }
  return { section, type, subtype, params, encoding, size, disposition, filename };
}

/**
 * Flatten a BODYSTRUCTURE into leaf parts with their section numbers.
 * message/rfc822 children are not descended into — the attached message is
 * treated as a single attachment part.
 */
export function interpretBodyStructure(v: ImapValue, prefix = ""): BodyPart[] {
  if (!Array.isArray(v) || v.length === 0) return [];
  if (Array.isArray(v[0])) {
    // Multipart: child parts, then subtype string.
    const parts: BodyPart[] = [];
    let i = 0;
    for (; i < v.length && Array.isArray(v[i]); i++) {
      const childSection = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      parts.push(...interpretBodyStructure(v[i], childSection));
    }
    return parts;
  }
  // A message with a single non-multipart body has section "1".
  return [leafPart(v as ImapValue[], prefix || "1")];
}

/** Pick the best body part to show as the message text. */
export function pickTextPart(parts: BodyPart[]): BodyPart | null {
  const isCandidate = (p: BodyPart) => p.type === "text" && p.disposition !== "attachment";
  return (
    parts.find((p) => isCandidate(p) && p.subtype === "plain") ??
    parts.find((p) => isCandidate(p) && p.subtype === "html") ??
    parts.find(isCandidate) ??
    null
  );
}

/** Attachment-ish parts: anything with a filename or attachment disposition, minus the shown text part. */
export function pickAttachments(parts: BodyPart[], textSection: string | null): BodyPart[] {
  return parts.filter((p) => {
    if (p.section === textSection) return false;
    if (p.disposition === "attachment") return true;
    if (p.filename) return true;
    if (p.type === "message" && p.subtype === "rfc822") return true;
    return false;
  });
}

/** Parse INTERNALDATE ("11-Aug-2026 12:34:56 +0000") → ISO string (UTC). */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
export function parseInternalDate(v: string | null): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mi, ss, sign, offH, offM] = m;
  const month = MONTHS[mon.toLowerCase()];
  if (month === undefined) return null;
  const utc = Date.UTC(+yyyy, month, +dd, +hh, +mi, +ss);
  const offsetMin = (+offH * 60 + +offM) * (sign === "-" ? -1 : 1);
  return new Date(utc - offsetMin * 60_000).toISOString();
}

/**
 * Parse the header block returned by BODY[HEADER.FIELDS (...)] into a
 * lowercase-keyed map, unfolding continuation lines.
 */
export function parseHeaderBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = raw.replace(/\r\n[ \t]+/g, " ").replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key && !(key in out)) out[key] = val;
  }
  return out;
}
