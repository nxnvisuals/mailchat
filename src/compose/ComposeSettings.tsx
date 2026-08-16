// ComposeSettings — who the composer writes as, and which devices may use it.
//
// Also the only place a device token is ever shown. The compose service
// returns a raw token exactly once at issuance and stores only its hash, so if
// it isn't copied here it is unrecoverable and has to be reissued.

import { useCallback, useEffect, useState } from "react";
import { Copy, Key, Loader2, Plus, Smartphone, Trash2, X } from "lucide-react";
import { useToast } from "@/lib/toast";
import { composeApi, copyToClipboard, type ComposeProfile, type DeviceToken } from "./api";

const MAX_TONE_SAMPLES = 5;

export default function ComposeSettings({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [profile, setProfile] = useState<ComposeProfile | null>(null);
  const [tokens, setTokens] = useState<DeviceToken[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [signature, setSignature] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [toneSamples, setToneSamples] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ profile: p }, { tokens: t }] = await Promise.all([
        composeApi.profile(),
        composeApi.tokens(),
      ]);
      setProfile(p);
      setDisplayName(p.displayName);
      setSignature(p.signature);
      setToneSamples(p.toneSamples);
      setTokens(t);
    } catch (e) {
      toast({ title: "Couldn't load settings", description: (e as Error).message, variant: "destructive" });
      setProfile({ displayName: "", signature: "", aiEnabled: false, aiModel: "", toneSamples: [] });
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const { profile: next } = await composeApi.saveProfile({
        displayName,
        signature,
        toneSamples: toneSamples.map((s) => s.trim()).filter(Boolean),
        // Only send the key when the user actually typed one, so an untouched
        // field never blanks out a key that's already stored.
        ...(apiKey.trim() ? { anthropicApiKey: apiKey.trim() } : {}),
      });
      setProfile(next);
      setApiKey("");
      toast({ title: "Saved" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const issueToken = async () => {
    setIssuing(true);
    try {
      const issued = await composeApi.issueToken("Gmail add-on");
      setFreshToken(issued.token);
      setTokens(await composeApi.tokens().then((r) => r.tokens));
    } catch (e) {
      toast({ title: "Couldn't create a token", description: (e as Error).message, variant: "destructive" });
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await composeApi.revokeToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      toast({ title: "Token revoked" });
    } catch (e) {
      toast({ title: "Couldn't revoke", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-foreground/20 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
      <div className="card w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-b-none sm:rounded-2xl">
        <div className="sticky top-0 bg-card border-b border-border px-4 py-3 flex items-center justify-between">
          <h2 className="font-semibold">Composer settings</h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-muted">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {!profile ? (
          <div className="p-10 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {/* ── Voice ── */}
            <section className="space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Your name</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Ana Ruiz"
                  className="input"
                />
              </label>

              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Sign-off</span>
                <textarea
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  rows={3}
                  placeholder={"Ana Ruiz\nAloha Nails"}
                  className="input resize-y"
                />
                <span className="text-[11px] text-muted-foreground mt-1 block">
                  Used exactly as written at the end of every email.
                </span>
              </label>
            </section>

            {/* ── Tone samples ── */}
            <section className="space-y-2 border-t border-border pt-4">
              <div>
                <h3 className="text-sm font-semibold">Sound like you</h3>
                <p className="text-[11px] text-muted-foreground">
                  Paste a few emails you've written. MailChat copies your manner — greetings, sign-offs,
                  sentence length — never your content. Optional.
                </p>
              </div>

              {toneSamples.map((sample, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <textarea
                    value={sample}
                    onChange={(e) =>
                      setToneSamples((prev) => prev.map((s, j) => (j === i ? e.target.value : s)))
                    }
                    rows={2}
                    className="input resize-y flex-1 text-xs"
                    placeholder="Hey Jane — thursday at 2 works great, see you then!"
                  />
                  <button
                    onClick={() => setToneSamples((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Remove sample ${i + 1}`}
                    className="p-2 rounded-lg hover:bg-muted mt-0.5"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
              ))}

              {toneSamples.length < MAX_TONE_SAMPLES && (
                <button
                  onClick={() => setToneSamples((prev) => [...prev, ""])}
                  className="btn-ghost text-xs py-2 px-3"
                >
                  <Plus className="w-3 h-3" /> Add a sample
                </button>
              )}
            </section>

            {/* ── AI key ── */}
            <section className="space-y-2 border-t border-border pt-4">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
                  <Key className="w-3 h-3" /> Anthropic API key
                  {profile.aiEnabled && (
                    <span className="text-[10px] uppercase font-semibold text-primary bg-primary/10 rounded px-1.5 py-0.5">
                      Set
                    </span>
                  )}
                </span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={profile.aiEnabled ? "••••••••  (leave blank to keep)" : "sk-ant-…"}
                  className="input"
                  autoComplete="off"
                />
                <span className="text-[11px] text-muted-foreground mt-1 block">
                  Without a key you still get a clean draft with your greeting and sign-off — just not rewritten.
                </span>
              </label>
            </section>

            <button onClick={save} disabled={saving} className="btn w-full py-2.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? "Saving…" : "Save"}
            </button>

            {/* ── Device tokens ── */}
            <section className="space-y-2 border-t border-border pt-4">
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Smartphone className="w-3.5 h-3.5" /> Connected devices
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  A token lets the Gmail add-on write drafts for you. It can do nothing else — it can't read
                  your mail, change these settings, or see your API key.
                </p>
              </div>

              {freshToken && (
                <div className="rounded-xl border border-primary/40 bg-primary/5 p-3 space-y-2">
                  <p className="text-[11px] font-semibold text-primary uppercase tracking-wide">
                    Copy this now — it won't be shown again
                  </p>
                  <code className="block text-[11px] break-all bg-card border border-border rounded-lg p-2">
                    {freshToken}
                  </code>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        if (await copyToClipboard(freshToken)) toast({ title: "Token copied" });
                      }}
                      className="btn text-xs py-1.5 px-3"
                    >
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                    <button onClick={() => setFreshToken(null)} className="btn-ghost text-xs py-1.5 px-3">
                      Done
                    </button>
                  </div>
                </div>
              )}

              {tokens.map((t) => (
                <div key={t.id} className="flex items-center gap-2 text-sm border border-border rounded-xl px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{t.label}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {t.lastUsedAt
                        ? `Last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                        : "Never used"}
                    </p>
                  </div>
                  <button
                    onClick={() => revoke(t.id)}
                    aria-label={`Revoke ${t.label}`}
                    className="p-2 rounded-lg hover:bg-muted"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </button>
                </div>
              ))}

              <button onClick={issueToken} disabled={issuing} className="btn-ghost text-xs py-2 px-3">
                {issuing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                Create device token
              </button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
