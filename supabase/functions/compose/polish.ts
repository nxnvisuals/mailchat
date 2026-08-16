// polish — the Anthropic call around the pure prompt logic in prompt.ts.
//
// This module knows nothing about mailboxes, IMAP or Graph. Give it a profile
// and some text and it returns a draft; whether that draft is then inserted
// into a Gmail compose window, copied to a clipboard or handed to SMTP is
// somebody else's problem. That separation is the whole point of the pivot.

import Anthropic from "npm:@anthropic-ai/sdk@^0.110.0";

import {
  buildSystemPrompt,
  buildUserMessage,
  friendlyAiError,
  isOpusClass,
  polishFallback,
  recipientFirstName,
  DEFAULT_AI_MODEL,
  POLISH_SCHEMA,
  type PolishProfile,
  type PolishRequest,
  type PolishResult,
} from "./prompt.ts";

export {
  DEFAULT_AI_MODEL,
  polishFallback,
  recipientFirstName,
  type PolishProfile,
  type PolishRequest,
  type PolishResult,
};

async function callClaude(
  profile: PolishProfile,
  req: PolishRequest,
  firstName: string,
): Promise<{ subject: string; body: string }> {
  const client = new Anthropic({ apiKey: profile.anthropicApiKey! });
  const model = profile.aiModel || DEFAULT_AI_MODEL;

  // The server-side refusal fallback (those models' safety classifiers can
  // rarely decline, retried on the recommended fallback model within the same
  // call) and the effort knob are both Opus 5-class only.
  const opusClass = isOpusClass(model);

  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...(opusClass ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    output_config: opusClass
      ? { effort: "low", format: { type: "json_schema", schema: POLISH_SCHEMA } }
      : { format: { type: "json_schema", schema: POLISH_SCHEMA } },
    system: buildSystemPrompt(profile, firstName, req.isNew === true),
    messages: [{ role: "user", content: buildUserMessage(profile, req) }],
  } as Parameters<typeof client.beta.messages.create>[0]);

  const resp = response as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
  if (resp.stop_reason === "refusal") {
    throw new Error("refusal");
  }
  const text = resp.content?.find((b) => b.type === "text")?.text ?? "";
  const parsed = JSON.parse(text) as { subject?: string; body?: string };
  if (!parsed.body) throw new Error("The AI assistant returned an empty draft.");
  return { subject: (parsed.subject ?? "").trim(), body: parsed.body.trim() };
}

/**
 * Polish a note into an email. Never rejects on an AI failure: every failure
 * degrades to the plain fallback with an explanatory aiError, because the user
 * must always end up with something they can send.
 */
export async function polish(profile: PolishProfile, req: PolishRequest): Promise<PolishResult> {
  const note = (req.note ?? "").trim();
  if (!note) throw new Error("Type your note first.");

  const firstName = recipientFirstName(req.recipientName ?? "");

  if (!profile.anthropicApiKey) {
    return polishFallback(profile, note, firstName);
  }

  try {
    const draft = await callClaude(profile, { ...req, note }, firstName);
    return { ...draft, ai: true };
  } catch (e) {
    console.error("[compose] polish failed", e);
    return { ...polishFallback(profile, note, firstName), aiError: friendlyAiError(e) };
  }
}
