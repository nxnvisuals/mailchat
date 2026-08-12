// quoteStrip — turns raw email bodies into clean chat-bubble text.
//
// Two jobs:
//   1. htmlToText: readable plain text from an HTML-only email (with Gmail /
//      Outlook quote containers dropped before conversion).
//   2. splitQuoted: separate a plain-text body into the freshly written part
//      and the quoted history ("On … wrote:", "> …", forwarded blocks), so the
//      UI can show a tidy bubble with a "show earlier messages" expander —
//      nothing is thrown away.
//
// Pure string logic — unit-testable under vitest.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _m; }
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _m; }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Remove an element and everything inside it (best-effort, non-nested regex). */
function dropElement(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
}

/**
 * Drop quote containers from HTML *before* text conversion. Gmail wraps
 * history in <div class="gmail_quote">…, Apple Mail / others use
 * <blockquote>. These usually run to the end of the document, so cutting from
 * the first occurrence is safe for a chat view (the text version keeps the
 * quoted tail via splitQuoted instead).
 */
export function dropHtmlQuotes(html: string): string {
  let out = html;
  const gmailQuote = out.search(/<div[^>]*class="[^"]*gmail_quote/i);
  if (gmailQuote > 0) out = out.slice(0, gmailQuote);
  const blockquote = out.search(/<blockquote\b/i);
  if (blockquote > 0) out = out.slice(0, blockquote);
  return out;
}

/** HTML → plain text, minimal but robust for email markup. */
export function htmlToText(html: string): string {
  let s = html;
  s = dropElement(s, "style");
  s = dropElement(s, "script");
  s = dropElement(s, "head");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Line-breaking elements → newlines before stripping tags.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|table|h[1-6]|li|blockquote|section|header|footer)>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  // Keep link targets that differ from their text: "text (url)".
  s = s.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const plain = text.replace(/<[^>]+>/g, "").trim();
    if (!plain) return " ";
    if (href.startsWith("mailto:")) return plain;
    const cleanHref = href.trim();
    return plain === cleanHref || cleanHref.startsWith("#") ? plain : `${plain} (${cleanHref})`;
  });
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // Whitespace cleanup: collapse runs but preserve paragraph breaks.
  s = s.replace(/\r/g, "");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Quote / history markers. Each test gets the full trimmed-lines array plus
// the index AFTER the current line (so lookahead never copies the tail —
// keeps this linear even on giant newsletter bodies).
const MARKER_TESTS: Array<(line: string, all: string[], nextIdx: number) => boolean> = [
  // "On Mon, Aug 11, 2026 at 9:12 AM Jane <jane@x.com> wrote:" — possibly
  // wrapped across two lines by the sender's client.
  (line, all, nextIdx) => {
    if (!/^On .{2,200}$/.test(line)) return false;
    if (/wrote:\s*$/.test(line)) return true;
    const joined = `${line} ${all[nextIdx] ?? ""}`;
    return /^On .{2,300}wrote:\s*$/.test(joined);
  },
  (line) => /^-{2,}\s*Original Message\s*-{2,}$/i.test(line),
  (line) => /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line),
  (line) => /^_{6,}$/.test(line),
  // Outlook-style header block: "From: …" followed shortly by Sent/Date/To.
  (line, all, nextIdx) => {
    if (!/^From:\s.+/i.test(line)) return false;
    return all.slice(nextIdx, nextIdx + 3).some((l) => /^(Sent|Date|To|Subject):\s/i.test(l));
  },
];

const SIGNATURE_TESTS: Array<(line: string) => boolean> = [
  (line) => /^--\s*$/.test(line),
  (line) => /^Sent from my (iPhone|iPad|Galaxy|Android|Samsung|mobile)/i.test(line),
  (line) => /^Get Outlook for (iOS|Android)/i.test(line),
];

export interface SplitBody {
  /** Freshly written text — what the chat bubble shows. */
  visible: string;
  /** Quoted history / signature tail, for the "show more" expander. */
  quoted: string;
}

export function splitQuoted(text: string): SplitBody {
  const lines = text.replace(/\r/g, "").split("\n");
  const trimmed = lines.map((l) => l.trim());

  // Find the first strong quote marker.
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = trimmed[i];
    if (!line) continue;
    if (MARKER_TESTS.some((t) => t(line, trimmed, i + 1))) {
      cut = i;
      break;
    }
  }

  // A trailing ">"-quoted block also counts, but only when it truly runs to
  // the end (inline "> quotes" mid-reply stay visible).
  if (cut === -1) {
    let firstQuoteLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith(">")) {
        if (firstQuoteLine === -1) firstQuoteLine = i;
      } else if (t !== "") {
        firstQuoteLine = -1;
      }
    }
    if (firstQuoteLine !== -1) cut = firstQuoteLine;
  }

  let visible = cut === -1 ? lines.join("\n") : lines.slice(0, cut).join("\n");
  let quoted = cut === -1 ? "" : lines.slice(cut).join("\n");

  // Trim signature tails from the visible part (kept in quoted).
  const vLines = visible.split("\n");
  for (let i = 1; i < vLines.length; i++) {
    if (SIGNATURE_TESTS.some((t) => t(vLines[i].trim()))) {
      quoted = vLines.slice(i).join("\n") + (quoted ? `\n${quoted}` : "");
      visible = vLines.slice(0, i).join("\n");
      break;
    }
  }

  visible = visible.replace(/\n{3,}/g, "\n\n").trim();
  quoted = quoted.trim();

  // Never hide everything: a pure-forward/pure-quote message stays visible.
  if (!visible && quoted) return { visible: quoted, quoted: "" };
  return { visible, quoted };
}

/** One-line preview for thread lists. */
export function makeSnippet(text: string, max = 140): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
