import { describe, it, expect } from "vitest";

/**
 * Unit tests for the mailbox edge function's pure protocol logic.
 *
 * The IMAP/SMTP socket layers can only be exercised against live Gmail, but
 * everything that *interprets* mail — the IMAP response parser, MIME
 * decoding, quote-stripping, and outgoing message assembly — is dependency-
 * free TypeScript shared with the Deno function, so it runs under vitest.
 * These are the parts where a subtle bug silently mangles someone's email.
 */
import {
  parseImapLine,
  fetchAttrs,
  asString,
  interpretEnvelope,
  interpretBodyStructure,
  pickTextPart,
  pickAttachments,
  parseInternalDate,
  parseHeaderBlock,
} from "../../supabase/functions/mailbox/imapParse.ts";
import {
  decodeBase64Bytes,
  encodeBase64,
  decodeQuotedPrintableBytes,
  decodeBodyText,
  decodeRfc2047,
  bytesToAscii,
} from "../../supabase/functions/mailbox/mimeText.ts";
import { splitQuoted, htmlToText, dropHtmlQuotes, makeSnippet, decodeEntities } from "../../supabase/functions/mailbox/quoteStrip.ts";
import {
  buildMime,
  dotStuff,
  isValidEmail,
  sanitizeHeaderValue,
  encodeHeaderText,
  wrapBase64,
  formatRfc822Date,
} from "../../supabase/functions/mailbox/mimeBuild.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

/* ── IMAP response parsing ── */

describe("parseImapLine", () => {
  it("parses atoms, quoted strings, NIL and nested lists", () => {
    const v = parseImapLine('UID 4242 FLAGS (\\Seen $Label) SUBJ "Hi \\"you\\"" NOTHING NIL', []);
    expect(v[0]).toBe("UID");
    expect(v[1]).toBe("4242");
    expect(v[2]).toBe("FLAGS");
    expect(v[3]).toEqual(["\\Seen", "$Label"]);
    expect(v[5]).toBe('Hi "you"');
    expect(v[7]).toBeNull();
  });

  it("keeps X-GM-THRID as a string so 64-bit ids never lose precision", () => {
    const v = parseImapLine("X-GM-THRID 1837652209374652918", []);
    const attrs = fetchAttrs(v);
    expect(asString(attrs.get("X-GM-THRID")!)).toBe("1837652209374652918");
  });

  it("consumes literals in order via {n} markers", () => {
    const body = utf8("Hello literal body");
    const v = parseImapLine("UID 7 BODY[1] {0}", [body]);
    const attrs = fetchAttrs(v);
    expect(attrs.get("BODY[1]")).toBe(body);
  });

  it("treats bracketed section atoms (with inner spaces) as one token", () => {
    const v = parseImapLine("BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO)] {0}", [utf8("Message-ID: <x@y>\r\n")]);
    expect(asString(v[0])).toBe("BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO)]");
  });
});

describe("interpretEnvelope", () => {
  it("decodes subject and addresses (incl. RFC 2047 names)", () => {
    const line =
      'ENVELOPE ("Tue, 11 Aug 2026 09:00:00 -0600" "=?utf-8?q?Caf=C3=A9_visit?=" ' +
      '(("=?utf-8?q?Jos=C3=A9?=" NIL "jose" "Example.COM")) NIL NIL ' +
      '(("Aloha" NIL "aloha" "gmail.com")) NIL NIL "<parent@x>" "<msg@x>"';
    const v = parseImapLine(line, []);
    const env = interpretEnvelope(fetchAttrs(v).get("ENVELOPE")!);
    expect(env.subject).toBe("Café visit");
    expect(env.from).toEqual([{ name: "José", email: "jose@example.com" }]);
    expect(env.to).toEqual([{ name: "Aloha", email: "aloha@gmail.com" }]);
    expect(env.inReplyTo).toBe("<parent@x>");
    expect(env.messageId).toBe("<msg@x>");
  });
});

describe("interpretBodyStructure", () => {
  const parse = (s: string) => {
    const v = parseImapLine(`BODYSTRUCTURE ${s}`, []);
    return interpretBodyStructure(fetchAttrs(v).get("BODYSTRUCTURE")!);
  };

  it("gives a single-part message section 1", () => {
    const parts = parse('("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 1152 23 NIL NIL NIL NIL)');
    expect(parts).toHaveLength(1);
    expect(parts[0].section).toBe("1");
    expect(parts[0].subtype).toBe("plain");
    expect(parts[0].params["charset"]).toBe("UTF-8");
  });

  it("prefers text/plain in multipart/alternative", () => {
    const parts = parse(
      '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 403 10 NIL NIL NIL NIL)' +
        '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 1286 22 NIL NIL NIL NIL) ' +
        '"ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL NIL)',
    );
    expect(parts.map((p) => p.section)).toEqual(["1", "2"]);
    expect(pickTextPart(parts)?.section).toBe("1");
  });

  it("numbers nested parts and finds attachments in multipart/mixed", () => {
    const parts = parse(
      '((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 50 2 NIL NIL NIL NIL)' +
        '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 90 3 NIL NIL NIL NIL) ' +
        '"ALTERNATIVE" ("BOUNDARY" "inner") NIL NIL NIL)' +
        '("APPLICATION" "PDF" ("NAME" "menu.pdf") NIL NIL "BASE64" 91444 NIL ("ATTACHMENT" ("FILENAME" "menu.pdf")) NIL NIL) ' +
        '"MIXED" ("BOUNDARY" "outer") NIL NIL NIL)',
    );
    expect(parts.map((p) => p.section)).toEqual(["1.1", "1.2", "2"]);
    const text = pickTextPart(parts);
    expect(text?.section).toBe("1.1");
    const atts = pickAttachments(parts, text?.section ?? null);
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe("menu.pdf");
    expect(atts[0].encoding).toBe("base64");
    expect(atts[0].size).toBe(91444);
  });

  it("decodes RFC 2231 extended filenames", () => {
    const parts = parse(
      '("APPLICATION" "PDF" NIL NIL NIL "BASE64" 1000 NIL ("ATTACHMENT" ("FILENAME*" "utf-8\'\'%E4%B8%AD%E6%96%87.pdf")) NIL NIL)',
    );
    expect(parts[0].filename).toBe("中文.pdf");
  });
});

describe("parseInternalDate / parseHeaderBlock", () => {
  it("converts INTERNALDATE with offset to UTC ISO", () => {
    expect(parseInternalDate("11-Aug-2026 10:30:00 -0600")).toBe("2026-08-11T16:30:00.000Z");
    expect(parseInternalDate("1-Jan-2026 00:00:00 +0130")).toBe("2025-12-31T22:30:00.000Z");
  });

  it("unfolds and lowercases header blocks", () => {
    const h = parseHeaderBlock("Message-ID: <a@b>\r\nReferences: <one@x>\r\n <two@x>\r\n\r\n");
    expect(h["message-id"]).toBe("<a@b>");
    expect(h["references"]).toBe("<one@x> <two@x>");
  });
});

/* ── MIME text decoding ── */

describe("mimeText decoding", () => {
  it("round-trips base64 and survives whitespace + truncation", () => {
    expect(bytesToAscii(decodeBase64Bytes("aGVsbG8gd29ybGQ="))).toBe("hello world");
    expect(bytesToAscii(decodeBase64Bytes("aGVs\r\nbG8="))).toBe("hello");
    const round = decodeBase64Bytes(encodeBase64(utf8("Aloha 🌺 nails")));
    expect(new TextDecoder().decode(round)).toBe("Aloha 🌺 nails");
    // Truncated tail (partial fetch): decodes the complete prefix.
    expect(bytesToAscii(decodeBase64Bytes("aGVsbG8gd29ybGQ=".slice(0, 6)))).toBe("hell");
  });

  it("decodes quoted-printable including soft breaks", () => {
    const bytes = decodeQuotedPrintableBytes("Caf=C3=A9 open =\r\nlate");
    expect(new TextDecoder().decode(bytes)).toBe("Café open late");
  });

  it("decodes bodies by transfer encoding + charset", () => {
    expect(decodeBodyText(utf8("Q2Fmw6k="), "base64", "utf-8")).toBe("Café");
    const latin1 = new Uint8Array([67, 97, 102, 233]); // "Café" in ISO-8859-1
    expect(decodeBodyText(latin1, "8bit", "iso-8859-1")).toBe("Café");
  });

  it("decodes RFC 2047 encoded words (B and Q, adjacent-word collapse)", () => {
    expect(decodeRfc2047("=?utf-8?q?Caf=C3=A9_visit?=")).toBe("Café visit");
    expect(decodeRfc2047("=?utf-8?B?Q2Fmw6k=?= =?utf-8?B?IHZpc2l0?=")).toBe("Café visit");
    expect(decodeRfc2047("plain subject")).toBe("plain subject");
  });
});

/* ── Chat-view cleanup ── */

describe("splitQuoted", () => {
  it('hides the "On … wrote:" tail but keeps it retrievable', () => {
    const { visible, quoted } = splitQuoted(
      "Sounds good! See you Tuesday at 2pm.\n\nOn Mon, Aug 10, 2026 at 9:12 AM Jane Doe <jane@example.com> wrote:\n> Can we move my appointment?\n> Thanks",
    );
    expect(visible).toBe("Sounds good! See you Tuesday at 2pm.");
    expect(quoted).toContain("Can we move my appointment?");
  });

  it("handles the marker wrapped across two lines", () => {
    const { visible } = splitQuoted("Yes that works.\n\nOn Mon, Aug 10, 2026 at 9:12 AM Jane Doe\n<jane@example.com> wrote:\n> hi");
    expect(visible).toBe("Yes that works.");
  });

  it("trims signatures and phone sign-offs", () => {
    const { visible, quoted } = splitQuoted("See you soon\n-- \nJane Doe\nSent from my iPhone");
    expect(visible).toBe("See you soon");
    expect(quoted).toContain("Jane Doe");
  });

  it("keeps inline '>' quotes that are answered underneath", () => {
    const { visible } = splitQuoted("> can you do Friday?\nYes, Friday works!");
    expect(visible).toContain("Yes, Friday works!");
  });

  it("never hides an entire forwarded message", () => {
    const text = "---------- Forwarded message ---------\nFrom: a@b.c\n\nbody here";
    const { visible } = splitQuoted(text);
    expect(visible).toContain("body here");
  });
});

describe("htmlToText", () => {
  it("converts breaks, strips tags, decodes entities, drops style", () => {
    const html = "<style>.x{color:red}</style><div>Hi <b>there</b>&nbsp;&amp; welcome<br>Second&#8217;s line</div>";
    expect(htmlToText(html)).toBe("Hi there & welcome\nSecond’s line");
  });

  it("keeps meaningful link targets", () => {
    expect(htmlToText('<a href="https://x.com/book">Book here</a>')).toBe("Book here (https://x.com/book)");
  });

  it("drops gmail_quote history before conversion", () => {
    const html = '<div>New reply</div><div class="gmail_quote">On Mon someone wrote: old stuff</div>';
    expect(htmlToText(dropHtmlQuotes(html))).toBe("New reply");
  });

  it("decodes numeric and named entities", () => {
    expect(decodeEntities("2&nbsp;&amp;&nbsp;3 &#x2764; &#10084;")).toBe("2 & 3 ❤ ❤");
  });
});

describe("makeSnippet", () => {
  it("collapses whitespace and caps length with an ellipsis", () => {
    expect(makeSnippet("Hello\n\n  world")).toBe("Hello world");
    const long = "word ".repeat(60);
    expect(makeSnippet(long).length).toBeLessThanOrEqual(140);
    expect(makeSnippet(long).endsWith("…")).toBe(true);
  });
});

/* ── Outgoing mail assembly ── */

describe("buildMime", () => {
  const base = {
    from: { name: "Aloha Beauty Lounge", email: "aloha@gmail.com" },
    to: [{ name: "Jane Doe", email: "jane@example.com" }],
    subject: "Re: Café visit",
    textBody: "Hi Jane,\r\n\r\nTuesday at 2pm works great.\r\n\r\nWarm aloha,\r\nAloha Beauty Lounge",
    date: new Date(Date.UTC(2026, 7, 11, 15, 3, 22)),
    messageId: "<11111111-2222-3333-4444-555555555555@gmail.com>",
  };

  it("builds threading headers and an RFC 2047 subject", () => {
    const mime = buildMime({ ...base, inReplyTo: "<parent@x>", references: "<root@x> <mid@x>" });
    expect(mime).toContain("From: Aloha Beauty Lounge <aloha@gmail.com>");
    expect(mime).toContain("To: Jane Doe <jane@example.com>");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("In-Reply-To: <parent@x>");
    expect(mime).toContain("References: <root@x> <mid@x> <parent@x>");
    expect(mime).toContain("Date: Tue, 11 Aug 2026 15:03:22 +0000");
    expect(mime).toContain("Message-ID: <11111111-2222-3333-4444-555555555555@gmail.com>");
    // Body is base64 and decodes back to the exact text.
    const b64 = mime.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, "");
    expect(new TextDecoder().decode(decodeBase64Bytes(b64))).toBe(base.textBody);
  });

  it("is immune to header injection", () => {
    const mime = buildMime({ ...base, subject: "Hello\r\nBcc: evil@attacker.com" });
    // The smuggled text may survive INSIDE the subject, but never as its own
    // header line — that's what would make it an actual Bcc.
    expect(mime).not.toMatch(/\r\nBcc:/);
    expect(mime).toContain("Subject: Hello Bcc: evil@attacker.com");
    expect(sanitizeHeaderValue("a\r\nb\rc\nd")).toBe("a b c d");
  });

  it("wraps attachments in multipart/mixed with safe filenames", () => {
    const mime = buildMime({
      ...base,
      attachments: [{ filename: "menu.pdf", mime: "application/pdf", base64: encodeBase64(utf8("PDFDATA")) }],
    });
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="');
    expect(mime).toContain('Content-Disposition: attachment; filename="menu.pdf"');
    expect(mime.trimEnd().endsWith("--")).toBe(true);
    const boundary = mime.match(/boundary="([^"]+)"/)![1];
    expect(mime.split(`--${boundary}`).length).toBe(4); // text + attachment + closing
  });

  it("encodes non-ASCII header text reversibly", () => {
    const name = "Sofía Núñez — Aloha 🌺";
    const encoded = encodeHeaderText(name);
    expect(encoded).toContain("=?UTF-8?B?");
    expect(decodeRfc2047(encoded)).toBe(name);
    for (const word of encoded.split(" ")) expect(word.length).toBeLessThanOrEqual(75);
  });

  it("wraps base64 at 76 columns", () => {
    const wrapped = wrapBase64("A".repeat(200));
    for (const line of wrapped.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("formats RFC 822 dates in UTC", () => {
    expect(formatRfc822Date(new Date(Date.UTC(2026, 0, 5, 8, 9, 7)))).toBe("Mon, 05 Jan 2026 08:09:07 +0000");
  });
});

describe("dotStuff / isValidEmail", () => {
  it("doubles line-leading dots for SMTP DATA", () => {
    expect(dotStuff("a\r\n.hidden\r\nb")).toBe("a\r\n..hidden\r\nb");
    expect(dotStuff(".start\r\nrest")).toBe("..start\r\nrest");
    expect(dotStuff("no dots here")).toBe("no dots here");
  });

  it("validates email addresses sensibly", () => {
    expect(isValidEmail("jane@example.com")).toBe(true);
    expect(isValidEmail("jane.doe+tag@sub.example.co")).toBe(true);
    expect(isValidEmail("not an email")).toBe(false);
    expect(isValidEmail("missing@tld")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
  });
});
