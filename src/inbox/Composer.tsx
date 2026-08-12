// Composer — type a casual note, preview it as a real email, then send.
//
// Two-step flow so nothing ever goes out unseen:
//   1. compose: a text-message style box (+ attachments)
//   2. preview: the transformed email (AI-polished when a Claude key is set,
//      politely framed otherwise) with To / Subject / body all editable
//
// Used at the bottom of a conversation (reply mode) and inside the
// "New email" dialog (isNew).

import { useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2, Paperclip, Send, Sparkles, X } from "lucide-react";
import { useToast } from "@/lib/toast";
import { fileToBase64, formatBytes, mailboxApi, type Provider, type ReplyMeta } from "./api";

// Keep uploads under the edge function's request limit (base64 inflates ~1.37x).
const MAX_TOTAL_ATTACHMENT_BYTES = 14 * 1024 * 1024;
// Microsoft Graph's simple upload path caps individual attachments (~3 MB).
const OUTLOOK_PER_FILE_BYTES = 3 * 1024 * 1024;

interface ComposerProps {
  accountId: string;
  provider: Provider;
  aiEnabled: boolean;
  isNew: boolean;
  reply: ReplyMeta | null; // null for a brand-new email
  context: Array<{ from: string; text: string }>;
  onSent: () => void;
}

interface Preview {
  to: string;
  subject: string;
  body: string;
  ai: boolean;
  aiError?: string;
}

export default function Composer({ accountId, provider, aiEnabled, isNew, reply, context, onSent }: ComposerProps) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [toInput, setToInput] = useState(""); // only used when isNew
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [polishing, setPolishing] = useState(false);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  const addFiles = (picked: FileList | null) => {
    if (!picked) return;
    const incoming = Array.from(picked);
    if (provider === "outlook") {
      const tooBig = incoming.find((f) => f.size > OUTLOOK_PER_FILE_BYTES);
      if (tooBig) {
        toast({
          title: "File too large for Outlook",
          description: `"${tooBig.name}" is over 3 MB. Outlook attachments here are limited to about 3 MB each for now.`,
          variant: "destructive",
        });
        return;
      }
    }
    const next = [...files, ...incoming];
    const nextBytes = next.reduce((sum, f) => sum + f.size, 0);
    if (nextBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      toast({
        title: "Attachments too large",
        description: "Please keep the total under about 14 MB. For bigger files, send from your mail app directly.",
        variant: "destructive",
      });
      return;
    }
    setFiles(next);
  };

  const buildPreview = async () => {
    if (!note.trim()) {
      toast({ title: "Nothing to send yet", description: "Type your reply first.", variant: "destructive" });
      return;
    }
    if (isNew && !toInput.trim()) {
      toast({ title: "Who is this for?", description: "Enter the recipient's email address.", variant: "destructive" });
      return;
    }
    setPolishing(true);
    try {
      const result = await mailboxApi.polish({
        accountId,
        text: note,
        recipientName: reply?.to[0]?.name ?? "",
        context,
        isNew,
      });
      setPreview({
        to: isNew ? toInput.trim() : (reply?.to ?? []).map((a) => a.email).join(", "),
        subject: isNew ? result.subject || "Hello" : reply?.subject ?? "",
        body: result.body,
        ai: result.ai,
        aiError: result.aiError,
      });
    } catch (e) {
      toast({ title: "Couldn't prepare the email", description: (e as Error).message, variant: "destructive" });
    } finally {
      setPolishing(false);
    }
  };

  const sendNow = async () => {
    if (!preview) return;
    const to = preview.to
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (to.length === 0) {
      toast({ title: "Missing recipient", description: "Enter at least one email address.", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const attachments = await Promise.all(
        files.map(async (f) => ({
          filename: f.name,
          mime: f.type || "application/octet-stream",
          base64: await fileToBase64(f),
        })),
      );
      await mailboxApi.send({
        accountId,
        to,
        subject: preview.subject,
        body: preview.body,
        attachments,
        inReplyTo: reply?.inReplyTo ?? null,
        references: reply?.references ?? null,
        anchorMessageId: reply?.anchorMessageId ?? null,
      });
      toast({ title: "✉️ Sent!", description: `Your email is on its way to ${to.join(", ")}.` });
      setNote("");
      setFiles([]);
      setPreview(null);
      setToInput("");
      onSent();
    } catch (e) {
      toast({ title: "Send failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  // ── Step 2: preview ──
  if (preview) {
    return (
      <div className="border-t border-border bg-card p-3 sm:p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            {preview.ai ? (
              <>
                <Sparkles className="w-3.5 h-3.5 text-primary" /> Your note, turned into an email — check it, then send
              </>
            ) : (
              <>Ready to send — check it first</>
            )}
          </p>
          <button
            onClick={() => setPreview(null)}
            className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3 h-3" /> Edit note
          </button>
        </div>

        {preview.aiError && (
          <p className="text-xs flex items-start gap-1.5 text-yellow-700 bg-yellow-50 rounded-lg p-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {preview.aiError}
          </p>
        )}

        <div className="grid gap-2">
          <label className="text-xs text-muted-foreground">
            To
            <input
              type="text"
              value={preview.to}
              onChange={(e) => setPreview({ ...preview, to: e.target.value })}
              className="input mt-1"
              placeholder="name@example.com"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Subject
            <input
              type="text"
              value={preview.subject}
              onChange={(e) => setPreview({ ...preview, subject: e.target.value })}
              className="input mt-1"
            />
          </label>
          <textarea
            value={preview.body}
            onChange={(e) => setPreview({ ...preview, body: e.target.value })}
            rows={Math.min(14, Math.max(6, preview.body.split("\n").length + 1))}
            className="input leading-relaxed"
          />
        </div>

        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span key={i} className="text-xs bg-muted rounded-full px-2.5 py-1 flex items-center gap-1">
                <Paperclip className="w-3 h-3" /> {f.name} <span className="text-muted-foreground">({formatBytes(f.size)})</span>
              </span>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={sendNow} disabled={sending} className="btn text-xs py-2 px-5">
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {sending ? "Sending…" : "Send email"}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 1: casual note ──
  return (
    <div className="border-t border-border bg-card p-3 sm:p-4 space-y-2">
      {isNew && (
        <input
          type="text"
          value={toInput}
          onChange={(e) => setToInput(e.target.value)}
          className="input"
          placeholder="To — name@example.com"
        />
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <span key={i} className="text-xs bg-muted rounded-full px-2.5 py-1 flex items-center gap-1">
              <Paperclip className="w-3 h-3" /> {f.name}
              <span className="text-muted-foreground">({formatBytes(f.size)})</span>
              <button
                onClick={() => setFiles(files.filter((_, idx) => idx !== i))}
                aria-label={`Remove ${f.name}`}
                className="hover:text-destructive"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <span className="text-[10px] text-muted-foreground self-center">{formatBytes(totalBytes)} of 14 MB</span>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInput.current?.click()}
          title="Attach files"
          aria-label="Attach files"
          className="p-2.5 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex-shrink-0"
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={Math.min(6, Math.max(1, note.split("\n").length))}
          placeholder="Type it like a text message — it becomes a proper email before it sends…"
          className="input flex-1 resize-none leading-relaxed"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              buildPreview();
            }
          }}
        />
        <button
          onClick={buildPreview}
          disabled={polishing}
          className="btn text-xs py-2.5 px-4 flex-shrink-0"
          title={aiEnabled ? "Turn your note into a polished email" : "Preview the email before sending"}
        >
          {polishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {polishing ? "Writing…" : "Preview email"}
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground pl-11">
        {aiEnabled
          ? "AI polish is on — your note gets rewritten as a professional email, and you approve it before it sends."
          : "Your note is framed with a greeting and your signature — you approve it before it sends."}
      </p>
    </div>
  );
}
