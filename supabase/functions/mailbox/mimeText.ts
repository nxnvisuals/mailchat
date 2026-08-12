// mimeText — pure decoding helpers shared by the mailbox function.
//
// Everything in this file is dependency-free and runtime-agnostic (no Deno
// APIs) so it can be unit-tested with the repo's vitest setup. The pipeline
// for a message body is:
//
//   raw literal bytes ──(transfer encoding: base64 / quoted-printable)──►
//   content bytes ──(charset: utf-8 / iso-8859-1 / …)──► string
//
// Header values use RFC 2047 encoded-words ("=?UTF-8?B?…?=") instead.

/** ASCII view of raw bytes — safe for protocol text (base64/QP are ASCII). */
export function bytesToAscii(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: number[] = (() => {
  const t = new Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/**
 * Base64 → bytes. Tolerates whitespace/newlines and a truncated tail (partial
 * fetches cut mid-quantum) by dropping incomplete trailing units.
 */
export function decodeBase64Bytes(input: string): Uint8Array {
  const chars: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (B64_LOOKUP[c] !== -1) chars.push(B64_LOOKUP[c]);
  }
  const quanta = Math.floor(chars.length / 4);
  const rem = chars.length - quanta * 4; // 0..3 leftover chars (truncation)
  const remBytes = rem >= 2 ? rem - 1 : 0;
  const out = new Uint8Array(quanta * 3 + remBytes);
  let o = 0;
  for (let i = 0; i < quanta * 4; i += 4) {
    const n = (chars[i] << 18) | (chars[i + 1] << 12) | (chars[i + 2] << 6) | chars[i + 3];
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (remBytes >= 1) out[o++] = ((chars[quanta * 4] << 2) | (chars[quanta * 4 + 1] >> 4)) & 0xff;
  if (remBytes === 2) out[o++] = ((chars[quanta * 4 + 1] << 4) | (chars[quanta * 4 + 2] >> 2)) & 0xff;
  return out;
}

/** Bytes → base64 string (no line wrapping). */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : NaN;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : NaN;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (Number.isNaN(b1) ? 0 : b1 >> 4)];
    out += Number.isNaN(b1) ? "=" : B64_ALPHABET[((b1 & 15) << 2) | (Number.isNaN(b2) ? 0 : b2 >> 6)];
    out += Number.isNaN(b2) ? "=" : B64_ALPHABET[b2 & 63];
  }
  return out;
}

/** Quoted-printable (body variant) → bytes. Handles soft line breaks. */
export function decodeQuotedPrintableBytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "=") {
      const next2 = input.slice(i + 1, i + 3);
      if (next2 === "\r\n" || next2.startsWith("\n")) {
        // Soft break: "=\r\n" or "=\n" disappears.
        i += next2 === "\r\n" ? 2 : 1;
      } else if (/^[0-9A-Fa-f]{2}$/.test(next2)) {
        out.push(parseInt(next2, 16));
        i += 2;
      } else {
        out.push(61); // stray '=' kept literally
      }
    } else if (c === "\r") {
      out.push(13);
    } else {
      out.push(c.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Charset label normalization for TextDecoder, with pragmatic aliases. */
function normalizeCharset(cs?: string | null): string {
  const c = (cs ?? "utf-8").trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!c || c === "us-ascii" || c === "ascii" || c === "utf8" || c === "cp-850" || c === "unicode-1-1-utf-8") return "utf-8";
  if (c === "cp1252" || c === "ansi_x3.110-1983") return "windows-1252";
  return c;
}

/** Bytes → string via charset, falling back utf-8 → windows-1252 → latin1. */
export function decodeCharsetBytes(bytes: Uint8Array, charset?: string | null): string {
  const label = normalizeCharset(charset);
  for (const tryLabel of [label, "utf-8", "windows-1252"]) {
    try {
      return new TextDecoder(tryLabel).decode(bytes);
    } catch {
      // unsupported label — try the next fallback
    }
  }
  return bytesToAscii(bytes); // latin1-ish last resort
}

/**
 * Decode a body part: raw bytes + Content-Transfer-Encoding + charset → text.
 */
export function decodeBodyText(raw: Uint8Array, encoding?: string | null, charset?: string | null): string {
  const enc = (encoding ?? "").trim().toLowerCase();
  let contentBytes: Uint8Array;
  if (enc === "base64") {
    contentBytes = decodeBase64Bytes(bytesToAscii(raw));
  } else if (enc === "quoted-printable") {
    contentBytes = decodeQuotedPrintableBytes(bytesToAscii(raw));
  } else {
    contentBytes = raw; // 7bit / 8bit / binary
  }
  // Truncated multibyte tails (from partial fetches) become U+FFFD — trim them.
  return decodeCharsetBytes(contentBytes, charset).replace(/�+$/, "");
}

/** Decode attachment content bytes (transfer encoding only, no charset). */
export function decodeBodyBytes(raw: Uint8Array, encoding?: string | null): Uint8Array {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") return decodeBase64Bytes(bytesToAscii(raw));
  if (enc === "quoted-printable") return decodeQuotedPrintableBytes(bytesToAscii(raw));
  return raw;
}

/**
 * RFC 2047 encoded-words in headers: "=?charset?B|Q?data?=".
 * Adjacent encoded words separated only by whitespace collapse together.
 */
export function decodeRfc2047(value: string): string {
  if (!value.includes("=?")) return value;
  // Collapse whitespace BETWEEN two encoded words (per RFC 2047 §6.2).
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, kind: string, data: string) => {
    try {
      if (kind.toLowerCase() === "b") {
        return decodeCharsetBytes(decodeBase64Bytes(data), cs);
      }
      // Q-encoding: '_' is space; '=XX' hex bytes.
      const bytes: number[] = [];
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ch === "_") bytes.push(32);
        else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) {
          bytes.push(parseInt(data.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(ch.charCodeAt(0) & 0xff);
      }
      return decodeCharsetBytes(new Uint8Array(bytes), cs);
    } catch {
      return _m;
    }
  });
}

/**
 * MIME parameter value decoding: plain, RFC 2047 (Gmail does this for
 * filenames), or RFC 2231 extended syntax ("utf-8''%E2%80%A6").
 * `star` is true when the parameter name ended with '*' (RFC 2231).
 */
export function decodeMimeParamValue(value: string, star = false): string {
  if (star) {
    const m = value.match(/^([^']*)'[^']*'([\s\S]*)$/);
    if (m) {
      const [, cs, data] = m;
      try {
        const bytes: number[] = [];
        for (let i = 0; i < data.length; i++) {
          if (data[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) {
            bytes.push(parseInt(data.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(data.charCodeAt(i) & 0xff);
        }
        return decodeCharsetBytes(new Uint8Array(bytes), cs || "utf-8");
      } catch {
        return data;
      }
    }
  }
  return decodeRfc2047(value);
}
