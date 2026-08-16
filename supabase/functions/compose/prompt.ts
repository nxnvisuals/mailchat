// prompt — the pure half of the polish engine.
//
// Everything here is dependency-free TypeScript: prompt assembly, the
// greeting rule, the no-AI fallback, and error phrasing. That keeps the part
// most likely to harbour a subtle bug — the instructions that decide what
// someone's email actually says — testable under vitest, the same way the
// mailbox function's MIME and quote-stripping logic is.
//
// polish.ts wraps this with the Anthropic call.

/** Everything the engine needs to know about who it is writing as. */
export interface PolishProfile {
  displayName: string;
  signature: string;
  anthropicApiKey: string | null;
  aiModel: string;
  /** Samples of the user's own writing, used to match their voice. */
  toneSamples: string[];
}

export interface PolishRequest {
  /** The user's casual note — the thing they'd have typed as a text. */
  note: string;
  /** Who it's going to, for the greeting. May be a name or an address. */
  recipientName?: string;
  /** Prior messages for context, oldest first. */
  context?: Array<{ from: string; text: string }>;
  /** True for a brand-new email (needs a subject), false for a reply. */
  isNew?: boolean;
}

export interface PolishResult {
  subject: string;
  body: string;
  /** False when the draft came from the offline fallback rather than Claude. */
  ai: boolean;
  /** Present only when AI was attempted and failed. */
  aiError?: string;
}

// Polishing a short note into an email is well within Haiku's abilities, and
// it's the fastest and cheapest current Claude model — keeps the owner's API
// bill near zero. Profiles can still override ai_model.
export const DEFAULT_AI_MODEL = "claude-haiku-4-5";

export const MAX_CONTEXT_MESSAGES = 6;
export const MAX_CONTEXT_CHARS = 800;
export const MAX_TONE_SAMPLES = 5;
export const MAX_TONE_SAMPLE_CHARS = 900;

export const POLISH_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Email subject line. Empty string for replies." },
    body: { type: "string", description: "The complete plain-text email body, ready to send." },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

/**
 * Two request params are Opus 5-class only: the server-side refusal fallback
 * and the effort knob, which Haiku rejects with a 400.
 */
export function isOpusClass(model: string): boolean {
  return /^claude-(opus-5|fable-5|mythos-5)/.test(model);
}

/**
 * A recipient with no display name arrives as their email address. Greeting
 * someone as "janeexamplecom" is worse than not greeting them by name, so an
 * address yields an empty first name and the prompt falls back to a plain
 * greeting.
 */
export function recipientFirstName(recipientName: string): string {
  const trimmed = (recipientName ?? "").trim();
  if (!trimmed || trimmed.includes("@")) return "";
  return trimmed.split(/\s+/)[0]?.replace(/[^\p{L}\p{N}'’-]/gu, "") ?? "";
}

export function normalizeToneSamples(samples: unknown): string[] {
  if (!Array.isArray(samples)) return [];
  return samples
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_TONE_SAMPLES)
    .map((s) => s.slice(0, MAX_TONE_SAMPLE_CHARS));
}

export function buildSystemPrompt(
  profile: PolishProfile,
  firstName: string,
  isNew: boolean,
): string {
  const owner = profile.displayName || "the sender";
  const signature = profile.signature || profile.displayName || "";

  const lines = [
    `You write emails on behalf of ${owner}.`,
    `${owner} types quick casual notes (like text messages). Rewrite the note as a warm, professional, plain-text email that says exactly what the note says — nothing more.`,
    ``,
    `Rules:`,
    `- Keep every fact, name, number, date, time and price from the note. Never invent details, prices, availability, offers or commitments that are not in the note.`,
    `- Keep it concise and natural. This is a normal email between people, not marketing copy.`,
    `- Write in the same language the note is written in.`,
    `- Plain text only: no markdown, no HTML, no emoji unless the note itself uses them.`,
    firstName ? `- Start with a friendly greeting to ${firstName}.` : `- Start with a friendly greeting.`,
    signature
      ? `- End the body with exactly this sign-off block:\n${signature}`
      : `- End with a friendly sign-off from ${owner}.`,
    isNew
      ? `- Write a short, clear subject line for a brand-new email.`
      : `- This is a reply inside an existing conversation: return an empty string for "subject".`,
  ];

  const samples = normalizeToneSamples(profile.toneSamples);
  if (samples.length > 0) {
    lines.push(
      ``,
      `Here are emails ${owner} has written before. Match their voice — greeting habits, sign-off, sentence length, formality, and whether they use contractions. Do not reuse their content, only their manner.`,
      ...samples.map((s, i) => `--- sample ${i + 1} ---\n${s}`),
    );
  }

  return lines.join("\n");
}

export function buildUserMessage(profile: PolishProfile, req: PolishRequest): string {
  const context = (req.context ?? []).slice(-MAX_CONTEXT_MESSAGES);
  const contextBlock =
    context.length > 0
      ? `Conversation so far (oldest first):\n${context
          .map((m) => `${m.from}: ${String(m.text ?? "").slice(0, MAX_CONTEXT_CHARS)}`)
          .join("\n---\n")}\n\n`
      : "";
  const who = profile.displayName || "The sender";
  return `${contextBlock}${who}'s casual note to turn into the email:\n"""\n${req.note}\n"""`;
}

/**
 * The no-AI path. Never throws, always returns something sendable — the
 * polish button works even with no key, no credit, or a refusal.
 */
export function polishFallback(
  profile: PolishProfile,
  note: string,
  firstName: string,
): PolishResult {
  const signature = profile.signature || profile.displayName || "";
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  return {
    subject: "",
    body: `${greeting}\n\n${note.trim()}${signature ? `\n\n${signature}` : ""}`,
    ai: false,
  };
}

export function friendlyAiError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/credit|billing|401|authentication/i.test(message)) {
    return "The AI key looks invalid or out of credit — sending the plain version instead.";
  }
  if (/refus/i.test(message)) {
    return "The AI assistant declined to write this one — you can still edit and send it yourself.";
  }
  return "The AI polish didn't work this time — here's the plain version instead.";
}
