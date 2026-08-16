// imap — minimal IMAP4rev1 client for Gmail (imap.gmail.com:993).
//
// Deliberately small: LOGIN, LIST (to find the localized "All Mail" folder
// via its \All special-use flag), SELECT, UID SEARCH (incl. Gmail's X-GM-RAW
// and X-GM-THRID), FETCH (by sequence or UID), UID STORE, LOGOUT. That is
// everything the Inbox tab needs.
//
// Wire format notes:
// - Responses are CRLF lines, except literals: "{123}\r\n" is followed by
//   exactly 123 raw bytes, then the same logical line continues. readLine()
//   below reassembles a logical line = text (with "{n}" markers kept) plus
//   the literal buffers in order; imapParse.ts consumes that shape.
// - Every op races a deadline; on timeout the connection is torn down so a
//   wedged socket can't hold the edge function open.

import { parseImapLine, asString, type ImapValue } from "./imapParse.ts";
import { bytesToAscii } from "./mimeText.ts";

/** Special-use mailboxes, resolved once per connection. */
export interface SpecialFolders {
  allMail: string;
  sent: string;
  drafts: string;
  starred: string;
}

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
const OP_TIMEOUT_MS = 30_000;

export class ImapError extends Error {
  constructor(message: string, public readonly kind: "auth" | "protocol" | "network" = "protocol") {
    super(message);
  }
}

interface LogicalLine {
  text: string;
  literals: Uint8Array[];
}

interface CommandResult {
  /** Untagged ("* …") logical lines seen before the tagged completion. */
  untagged: LogicalLine[];
  /** Text after OK on the tagged line. */
  doneText: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImapError(`Timed out ${what}`, "network")), ms) as unknown as number;
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Quote a string argument per IMAP grammar. */
export function imapQuote(s: string): string {
  return `"${s.replace(/([\\"])/g, "\\$1")}"`;
}

export class ImapClient {
  private conn!: Deno.TlsConn;
  private buffer = new Uint8Array(0);
  private tagCounter = 0;
  private closed = false;

  static async connect(): Promise<ImapClient> {
    const client = new ImapClient();
    try {
      client.conn = await withTimeout(
        Deno.connectTls({ hostname: IMAP_HOST, port: IMAP_PORT }),
        OP_TIMEOUT_MS,
        "connecting to Gmail (IMAP)",
      );
    } catch (e) {
      if (e instanceof ImapError) throw e;
      throw new ImapError(`Could not reach Gmail's mail server: ${(e as Error).message}`, "network");
    }
    // Server greeting: "* OK Gimap ready…"
    const greeting = await client.readLogicalLine();
    if (!greeting.text.toUpperCase().includes("OK")) {
      client.close();
      throw new ImapError(`Unexpected IMAP greeting: ${greeting.text}`);
    }
    return client;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.conn.close();
    } catch {
      // already gone
    }
  }

  private async fill(): Promise<void> {
    const chunk = new Uint8Array(16_384);
    const n = await withTimeout(this.conn.read(chunk), OP_TIMEOUT_MS, "reading from Gmail (IMAP)");
    if (n === null) throw new ImapError("Gmail closed the connection unexpectedly", "network");
    const merged = new Uint8Array(this.buffer.length + n);
    merged.set(this.buffer);
    merged.set(chunk.subarray(0, n), this.buffer.length);
    this.buffer = merged;
  }

  private async readRawLine(): Promise<Uint8Array> {
    for (;;) {
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = this.buffer.subarray(0, i);
          this.buffer = this.buffer.subarray(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }

  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) await this.fill();
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** One logical line: raw line + any literals it announces. */
  private async readLogicalLine(): Promise<LogicalLine> {
    let text = "";
    const literals: Uint8Array[] = [];
    for (;;) {
      const raw = bytesToAscii(await this.readRawLine());
      const m = raw.match(/\{(\d+)\}$/);
      if (!m) {
        text += raw;
        return { text, literals };
      }
      // Literal announced: keep a "{n}" marker in the text, buffer the bytes,
      // and continue the same logical line.
      text += raw.slice(0, raw.length - m[0].length) + `{${literals.length}}`;
      literals.push(new Uint8Array(await this.readBytes(parseInt(m[1], 10))));
    }
  }

  private async command(cmd: string, redactedLabel?: string): Promise<CommandResult> {
    const tag = `A${++this.tagCounter}`;
    const line = `${tag} ${cmd}\r\n`;
    try {
      await withTimeout(writeAll(this.conn, new TextEncoder().encode(line)), OP_TIMEOUT_MS, "sending to Gmail (IMAP)");
    } catch (e) {
      if (e instanceof ImapError) throw e;
      throw new ImapError(`Lost connection to Gmail: ${(e as Error).message}`, "network");
    }
    const untagged: LogicalLine[] = [];
    for (;;) {
      const logical = await this.readLogicalLine();
      if (logical.text.startsWith(`${tag} `)) {
        const status = logical.text.slice(tag.length + 1);
        if (status.toUpperCase().startsWith("OK")) {
          return { untagged, doneText: status.slice(2).trim() };
        }
        const label = redactedLabel ?? cmd.split(" ")[0];
        const isAuth = /AUTHENTICATIONFAILED|Invalid credentials/i.test(status);
        throw new ImapError(
          isAuth
            ? "Gmail rejected the sign-in. Double-check the address and app password (and that 2-Step Verification is on)."
            : `Gmail refused ${label}: ${status}`,
          isAuth ? "auth" : "protocol",
        );
      }
      if (logical.text.startsWith("* ") || logical.text.startsWith("+")) {
        untagged.push(logical);
      }
    }
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(`LOGIN ${imapQuote(user)} ${imapQuote(password)}`, "LOGIN");
  }

  /** Find Gmail's special folders regardless of account language. */
  async findSpecialFolders(): Promise<SpecialFolders> {
    const res = await this.command(`LIST "" "*" RETURN (SPECIAL-USE)`);
    let allMail: string | null = null;
    let sent: string | null = null;
    let drafts: string | null = null;
    let starred: string | null = null;
    for (const line of res.untagged) {
      // * LIST (\HasNoChildren \All) "/" "[Gmail]/All Mail"
      const values = parseImapLine(line.text.replace(/^\* LIST /i, ""), line.literals);
      if (values.length < 3 || !Array.isArray(values[0])) continue;
      const flags = (values[0] as ImapValue[]).map((f) => (asString(f) ?? "").toLowerCase());
      const name = asString(values[2]);
      if (!name) continue;
      if (flags.includes("\\all")) allMail = name;
      if (flags.includes("\\sent")) sent = name;
      if (flags.includes("\\drafts")) drafts = name;
      // Gmail exposes Starred as the \Flagged special-use folder.
      if (flags.includes("\\flagged")) starred = name;
    }
    // English-account fallbacks keep us working if SPECIAL-USE ever changes.
    return {
      allMail: allMail ?? "[Gmail]/All Mail",
      sent: sent ?? "[Gmail]/Sent Mail",
      drafts: drafts ?? "[Gmail]/Drafts",
      starred: starred ?? "[Gmail]/Starred",
    };
  }

  /** SELECT a mailbox read-write. Returns the EXISTS count. */
  async select(mailbox: string): Promise<{ exists: number }> {
    const res = await this.command(`SELECT ${imapQuote(mailbox)}`);
    let exists = 0;
    for (const line of res.untagged) {
      const m = line.text.match(/^\* (\d+) EXISTS/i);
      if (m) exists = parseInt(m[1], 10);
    }
    return { exists };
  }

  /** UID SEARCH; returns UIDs ascending. */
  async uidSearch(criteria: string): Promise<number[]> {
    const res = await this.command(`UID SEARCH ${criteria}`);
    const uids: number[] = [];
    for (const line of res.untagged) {
      const m = line.text.match(/^\* SEARCH((?: \d+)*)\s*$/i);
      if (m && m[1]) {
        for (const part of m[1].trim().split(/\s+/)) uids.push(parseInt(part, 10));
      }
    }
    return uids.sort((a, b) => a - b);
  }

  /**
   * FETCH. `set` is a sequence-set ("1:50" / "5,7,9"); `byUid` switches to
   * UID FETCH. Returns the parsed attribute list of each FETCH response.
   */
  async fetch(set: string, items: string, byUid: boolean): Promise<ImapValue[][]> {
    const res = await this.command(`${byUid ? "UID " : ""}FETCH ${set} (${items})`);
    const out: ImapValue[][] = [];
    for (const line of res.untagged) {
      const m = line.text.match(/^\* (\d+) FETCH \(([\s\S]*)\)\s*$/i);
      if (!m) continue;
      out.push(parseImapLine(m[2], line.literals));
    }
    return out;
  }

  /** Mark messages, e.g. uidStore("5,9", "+FLAGS.SILENT (\\Seen)"). */
  async uidStore(set: string, op: string): Promise<void> {
    await this.command(`UID STORE ${set} ${op}`);
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // best-effort
    } finally {
      this.close();
    }
  }
}

async function writeAll(conn: Deno.TlsConn, data: Uint8Array): Promise<void> {
  let written = 0;
  while (written < data.length) {
    written += await conn.write(data.subarray(written));
  }
}

/** Escape a user query for Gmail's X-GM-RAW quoted-string argument. */
export function gmailRawQuery(q: string): string {
  return `X-GM-RAW ${imapQuote(q.replace(/[\r\n]+/g, " "))}`;
}
