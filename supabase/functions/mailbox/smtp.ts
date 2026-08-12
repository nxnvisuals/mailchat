// smtp — minimal SMTP client for Gmail submission (smtp.gmail.com:465).
//
// Implicit TLS, EHLO, AUTH PLAIN with the same app password IMAP uses,
// MAIL FROM / RCPT TO / DATA. Gmail automatically drops a copy of anything
// sent this way into the account's Sent folder, which is what keeps the
// conversation view complete after a reply.

import { encodeBase64, bytesToAscii } from "./mimeText.ts";
import { dotStuff } from "./mimeBuild.ts";

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;
const OP_TIMEOUT_MS = 30_000;

export class SmtpError extends Error {
  constructor(message: string, public readonly kind: "auth" | "protocol" | "network" = "protocol") {
    super(message);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpError(`Timed out ${what}`, "network")), ms) as unknown as number;
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

interface SmtpReply {
  code: number;
  text: string;
}

export class SmtpClient {
  private conn!: Deno.TlsConn;
  private buffer = new Uint8Array(0);
  private closed = false;

  static async connect(): Promise<SmtpClient> {
    const client = new SmtpClient();
    try {
      client.conn = await withTimeout(
        Deno.connectTls({ hostname: SMTP_HOST, port: SMTP_PORT }),
        OP_TIMEOUT_MS,
        "connecting to Gmail (SMTP)",
      );
    } catch (e) {
      if (e instanceof SmtpError) throw e;
      throw new SmtpError(`Could not reach Gmail's sending server: ${(e as Error).message}`, "network");
    }
    const greeting = await client.readReply();
    if (greeting.code !== 220) {
      client.close();
      throw new SmtpError(`Unexpected SMTP greeting: ${greeting.code} ${greeting.text}`);
    }
    await client.expect(`EHLO aloha-mailbox.invalid`, [250]);
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
    const chunk = new Uint8Array(8192);
    const n = await withTimeout(this.conn.read(chunk), OP_TIMEOUT_MS, "reading from Gmail (SMTP)");
    if (n === null) throw new SmtpError("Gmail closed the connection unexpectedly", "network");
    const merged = new Uint8Array(this.buffer.length + n);
    merged.set(this.buffer);
    merged.set(chunk.subarray(0, n), this.buffer.length);
    this.buffer = merged;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = bytesToAscii(this.buffer.subarray(0, i));
          this.buffer = this.buffer.subarray(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }

  /** Read one (possibly multi-line "250-…") reply. */
  private async readReply(): Promise<SmtpReply> {
    const texts: string[] = [];
    for (;;) {
      const line = await this.readLine();
      const m = line.match(/^(\d{3})([ -])(.*)$/);
      if (!m) throw new SmtpError(`Malformed SMTP reply: ${line}`);
      texts.push(m[3]);
      if (m[2] === " ") return { code: parseInt(m[1], 10), text: texts.join(" / ") };
    }
  }

  private async send(line: string): Promise<void> {
    try {
      await withTimeout(writeAll(this.conn, new TextEncoder().encode(`${line}\r\n`)), OP_TIMEOUT_MS, "sending to Gmail (SMTP)");
    } catch (e) {
      if (e instanceof SmtpError) throw e;
      throw new SmtpError(`Lost connection to Gmail: ${(e as Error).message}`, "network");
    }
  }

  private async expect(line: string, okCodes: number[], redactedLabel?: string): Promise<SmtpReply> {
    await this.send(line);
    const reply = await this.readReply();
    if (!okCodes.includes(reply.code)) {
      const label = redactedLabel ?? line.split(" ")[0];
      const isAuth = reply.code === 535 || /Username and Password not accepted/i.test(reply.text);
      throw new SmtpError(
        isAuth
          ? "Gmail rejected the sign-in for sending. Double-check the address and app password."
          : `Gmail refused ${label}: ${reply.code} ${reply.text}`,
        isAuth ? "auth" : "protocol",
      );
    }
    return reply;
  }

  async authPlain(user: string, password: string): Promise<void> {
    const token = encodeBase64(new TextEncoder().encode(`\u0000${user}\u0000${password}`));
    await this.expect(`AUTH PLAIN ${token}`, [235], "AUTH");
  }

  /** Send a fully built RFC 5322 message. */
  async sendMessage(from: string, recipients: string[], message: string): Promise<void> {
    await this.expect(`MAIL FROM:<${from}>`, [250]);
    for (const rcpt of recipients) {
      await this.expect(`RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await this.expect("DATA", [354]);
    const payload = dotStuff(message.endsWith("\r\n") ? message : `${message}\r\n`) + ".";
    await this.expect(payload, [250], "message body");
  }

  async quit(): Promise<void> {
    try {
      await this.send("QUIT");
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
