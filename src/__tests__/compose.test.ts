import { describe, it, expect } from "vitest";

/**
 * Unit tests for the compose service's pure logic.
 *
 * The Anthropic call and the database lookups can only be exercised against
 * live services, but everything that *decides what someone's email says* —
 * prompt assembly, the greeting rule, the no-AI fallback — and everything
 * that guards access — token minting and hashing — is dependency-free
 * TypeScript shared with the Deno function, so it runs under vitest.
 *
 * These are the two places where a quiet bug does real damage: a bad prompt
 * puts words in the user's mouth, and a bad token check lets someone else in.
 */
import {
  buildSystemPrompt,
  buildUserMessage,
  friendlyAiError,
  isOpusClass,
  normalizeToneSamples,
  polishFallback,
  recipientFirstName,
  DEFAULT_AI_MODEL,
  MAX_TONE_SAMPLES,
  type PolishProfile,
} from "../../supabase/functions/compose/prompt.ts";
import {
  extractBearer,
  generateToken,
  isDeviceToken,
  sha256Hex,
  TOKEN_PREFIX,
} from "../../supabase/functions/compose/tokens.ts";

const baseProfile: PolishProfile = {
  displayName: "Ana Ruiz",
  signature: "Ana Ruiz\nAloha Nails",
  anthropicApiKey: null,
  aiModel: DEFAULT_AI_MODEL,
  toneSamples: [],
};

describe("recipientFirstName", () => {
  it("takes the first word of a real name", () => {
    expect(recipientFirstName("Jane Doe")).toBe("Jane");
    expect(recipientFirstName("  Jane   Doe  ")).toBe("Jane");
  });

  it("refuses to greet an email address", () => {
    // Greeting someone as "janeexamplecom" is worse than not greeting them.
    expect(recipientFirstName("jane@example.com")).toBe("");
    expect(recipientFirstName("Jane <jane@example.com>")).toBe("");
  });

  it("returns empty for empty input", () => {
    expect(recipientFirstName("")).toBe("");
    expect(recipientFirstName("   ")).toBe("");
  });

  it("keeps accents, apostrophes and hyphens but drops punctuation", () => {
    expect(recipientFirstName("José García")).toBe("José");
    expect(recipientFirstName("O'Brien")).toBe("O'Brien");
    expect(recipientFirstName("Anne-Marie Dupont")).toBe("Anne-Marie");
    expect(recipientFirstName("(Bob)")).toBe("Bob");
  });
});

describe("polishFallback", () => {
  it("greets by name when there is one", () => {
    const r = polishFallback(baseProfile, "thursday 2pm works", "Jane");
    expect(r.body).toContain("Hi Jane,");
    expect(r.body).toContain("thursday 2pm works");
    expect(r.ai).toBe(false);
  });

  it("uses a plain greeting when there is no name", () => {
    const r = polishFallback(baseProfile, "sounds good", "");
    expect(r.body.startsWith("Hi,")).toBe(true);
  });

  it("appends the signature block", () => {
    const r = polishFallback(baseProfile, "ok", "Jane");
    expect(r.body.endsWith("Ana Ruiz\nAloha Nails")).toBe(true);
  });

  it("falls back to the display name when there is no signature", () => {
    const r = polishFallback({ ...baseProfile, signature: "" }, "ok", "");
    expect(r.body.endsWith("Ana Ruiz")).toBe(true);
  });

  it("omits the sign-off entirely when there is neither", () => {
    const r = polishFallback({ ...baseProfile, signature: "", displayName: "" }, "ok", "");
    expect(r.body).toBe("Hi,\n\nok");
  });

  it("never returns a subject — the caller decides", () => {
    expect(polishFallback(baseProfile, "ok", "Jane").subject).toBe("");
  });
});

describe("buildSystemPrompt", () => {
  it("asks for a subject on a new email and forbids one on a reply", () => {
    expect(buildSystemPrompt(baseProfile, "Jane", true)).toContain("subject line for a brand-new email");
    expect(buildSystemPrompt(baseProfile, "Jane", false)).toContain('empty string for "subject"');
  });

  it("names the greeting target when known", () => {
    expect(buildSystemPrompt(baseProfile, "Jane", false)).toContain("friendly greeting to Jane");
    expect(buildSystemPrompt(baseProfile, "", false)).toContain("- Start with a friendly greeting.");
  });

  it("pins the exact sign-off block", () => {
    expect(buildSystemPrompt(baseProfile, "Jane", false)).toContain("Ana Ruiz\nAloha Nails");
  });

  it("guards against invented facts", () => {
    const p = buildSystemPrompt(baseProfile, "Jane", false);
    expect(p).toContain("Never invent details");
    expect(p).toContain("Keep every fact");
  });

  it("leaves tone instructions out when there are no samples", () => {
    expect(buildSystemPrompt(baseProfile, "Jane", false)).not.toContain("Match their voice");
  });

  it("includes tone samples when present", () => {
    const p = buildSystemPrompt(
      { ...baseProfile, toneSamples: ["Hey! Sounds great, see you then.", "Thanks so much!!"] },
      "Jane",
      false,
    );
    expect(p).toContain("Match their voice");
    expect(p).toContain("--- sample 1 ---");
    expect(p).toContain("--- sample 2 ---");
    expect(p).toContain("Sounds great, see you then.");
  });

  it("tells the model to copy manner, not content", () => {
    const p = buildSystemPrompt({ ...baseProfile, toneSamples: ["sample"] }, "", false);
    expect(p).toContain("Do not reuse their content, only their manner");
  });
});

describe("buildUserMessage", () => {
  it("wraps the note in delimiters so it can't be read as instructions", () => {
    const m = buildUserMessage(baseProfile, { note: "thursday 2pm" });
    expect(m).toContain('"""\nthursday 2pm\n"""');
  });

  it("omits the context block when there is no history", () => {
    expect(buildUserMessage(baseProfile, { note: "hi" })).not.toContain("Conversation so far");
  });

  it("includes conversation history oldest first", () => {
    const m = buildUserMessage(baseProfile, {
      note: "yes",
      context: [
        { from: "Jane", text: "are you free thursday?" },
        { from: "Ana", text: "checking" },
      ],
    });
    expect(m).toContain("Conversation so far");
    expect(m.indexOf("are you free thursday?")).toBeLessThan(m.indexOf("checking"));
  });

  it("keeps only the most recent messages", () => {
    const context = Array.from({ length: 12 }, (_, i) => ({ from: "X", text: `msg${i}` }));
    const m = buildUserMessage(baseProfile, { note: "ok", context });
    expect(m).not.toContain("msg0");
    expect(m).toContain("msg11");
  });

  it("truncates a very long context message", () => {
    const m = buildUserMessage(baseProfile, {
      note: "ok",
      context: [{ from: "X", text: "z".repeat(2000) }],
    });
    expect(m).not.toContain("z".repeat(900));
  });
});

describe("normalizeToneSamples", () => {
  it("drops empties and non-arrays", () => {
    expect(normalizeToneSamples(["a", "", "  ", "b"])).toEqual(["a", "b"]);
    expect(normalizeToneSamples(null)).toEqual([]);
    expect(normalizeToneSamples("nope")).toEqual([]);
  });

  it("caps the number of samples so the prompt can't grow without bound", () => {
    const many = Array.from({ length: 20 }, (_, i) => `sample ${i}`);
    expect(normalizeToneSamples(many)).toHaveLength(MAX_TONE_SAMPLES);
  });

  it("truncates an over-long sample", () => {
    const [only] = normalizeToneSamples(["x".repeat(5000)]);
    expect(only.length).toBeLessThanOrEqual(900);
  });
});

describe("isOpusClass", () => {
  it("is false for the default model", () => {
    // Haiku rejects the effort knob with a 400, so this gate is load-bearing.
    expect(isOpusClass(DEFAULT_AI_MODEL)).toBe(false);
    expect(isOpusClass("claude-haiku-4-5")).toBe(false);
    expect(isOpusClass("claude-sonnet-5")).toBe(false);
  });

  it("is true for Opus-class models", () => {
    expect(isOpusClass("claude-opus-5")).toBe(true);
    expect(isOpusClass("claude-fable-5")).toBe(true);
  });
});

describe("friendlyAiError", () => {
  it("names a billing problem specifically", () => {
    expect(friendlyAiError(new Error("401 authentication_error"))).toContain("out of credit");
    expect(friendlyAiError(new Error("insufficient credit balance"))).toContain("out of credit");
  });

  it("explains a refusal without alarming the user", () => {
    expect(friendlyAiError(new Error("refusal"))).toContain("declined");
  });

  it("has a generic case that still tells the user what happens next", () => {
    expect(friendlyAiError(new Error("socket hang up"))).toContain("plain version");
  });
});

describe("device tokens", () => {
  it("mints tokens with a recognisable prefix", () => {
    const t = generateToken();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(isDeviceToken(t)).toBe(true);
  });

  it("mints tokens with enough entropy to be unguessable", () => {
    // 32 bytes base64url ≈ 43 chars after the prefix.
    expect(generateToken().length - TOKEN_PREFIX.length).toBeGreaterThanOrEqual(43);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(seen.size).toBe(500);
  });

  it("produces URL-safe output", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateToken()).toMatch(/^mc_[A-Za-z0-9_-]+$/);
    }
  });

  it("does not mistake a JWT for a device token", () => {
    expect(isDeviceToken("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def")).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("matches the known vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic, so a token looks up the same row every time", async () => {
    const t = generateToken();
    expect(await sha256Hex(t)).toBe(await sha256Hex(t));
  });

  it("gives different tokens different hashes", async () => {
    expect(await sha256Hex(generateToken())).not.toBe(await sha256Hex(generateToken()));
  });

  it("returns a full 64-char hex digest", async () => {
    expect(await sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("extractBearer", () => {
  it("pulls the credential out of a well-formed header", () => {
    expect(extractBearer("Bearer mc_abc123")).toBe("mc_abc123");
  });

  it("rejects anything that isn't a bearer header", () => {
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer("Bearer")).toBeNull();
    expect(extractBearer("Bearer    ")).toBeNull();
  });
});
