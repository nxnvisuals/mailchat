// MailSettingsDialog — per-account name / signature / AI key + disconnect.

import { useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { useToast } from "@/lib/toast";
import { mailboxApi, type MailAccountSummary } from "./api";

interface MailSettingsDialogProps {
  account: MailAccountSummary;
  onClose: () => void;
  onAccounts: (accounts: MailAccountSummary[]) => void;
}

export default function MailSettingsDialog({ account, onClose, onAccounts }: MailSettingsDialogProps) {
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [signature, setSignature] = useState(account.signature);
  const [aiKey, setAiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const payload: Parameters<typeof mailboxApi.saveSettings>[0] = {
        accountId: account.id,
        displayName,
        signature,
      };
      if (aiKey.trim()) payload.anthropicApiKey = aiKey.trim();
      const { accounts } = await mailboxApi.saveSettings(payload);
      onAccounts(accounts);
      toast({ title: "Saved", description: "Mail settings updated." });
      onClose();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const removeAiKey = async () => {
    setSaving(true);
    try {
      const { accounts } = await mailboxApi.saveSettings({ accountId: account.id, anthropicApiKey: "" });
      onAccounts(accounts);
      setAiKey("");
      toast({ title: "AI polish turned off", description: "The key was removed. Replies still work without it." });
    } catch (e) {
      toast({ title: "Couldn't remove the key", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const { accounts } = await mailboxApi.disconnect(account.id);
      toast({ title: "Disconnected", description: `${account.email} was removed. You can reconnect any time.` });
      onAccounts(accounts);
      onClose();
    } catch (e) {
      toast({ title: "Couldn't disconnect", description: (e as Error).message, variant: "destructive" });
      setDisconnecting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mail-settings-title"
      onClick={() => !saving && !disconnecting && onClose()}
    >
      <div className="card p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 id="mail-settings-title" className="text-lg font-semibold">
            Mail settings
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-muted-foreground mb-4">
          <span className="capitalize">{account.provider}</span> — <strong>{account.email}</strong>
        </p>

        <div className="space-y-3">
          <label className="block text-xs text-muted-foreground">
            Your name on outgoing email
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input mt-1" />
          </label>
          <label className="block text-xs text-muted-foreground">
            Sign-off at the bottom of your emails
            <textarea value={signature} onChange={(e) => setSignature(e.target.value)} rows={3} className="input mt-1" />
          </label>

          <div className="border-t border-border pt-3">
            <p className="text-xs font-medium flex items-center gap-1.5 mb-1">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              AI polish{" "}
              {account.aiEnabled ? (
                <span className="text-green-700 bg-green-100 rounded-full px-2 py-0.5">on</span>
              ) : (
                <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5">off</span>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              With an Anthropic API key, your quick notes are rewritten into polished professional emails (you always
              review before sending). Create a key at console.anthropic.com → API keys. Typical cost is well under a
              cent per email.
            </p>
            <input
              type="password"
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              className="input font-mono"
              placeholder={account.aiEnabled ? "•••••••• (saved — paste a new key to replace it)" : "sk-ant-…"}
              autoComplete="off"
            />
            {account.aiEnabled && (
              <button onClick={removeAiKey} disabled={saving} className="text-[11px] text-muted-foreground underline mt-1.5 hover:text-destructive">
                Remove the key / turn AI polish off
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 mt-6">
          {confirmDisconnect ? (
            <div className="flex items-center gap-2">
              <button
                onClick={disconnect}
                disabled={disconnecting}
                className="text-xs py-2 px-3 rounded-full bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-60"
              >
                {disconnecting ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button onClick={() => setConfirmDisconnect(false)} className="text-xs text-muted-foreground underline">
                Keep it
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmDisconnect(true)} className="text-xs text-muted-foreground underline hover:text-destructive">
              Disconnect this mailbox
            </button>
          )}
          <button onClick={save} disabled={saving} className="btn text-xs py-2 px-5">
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
