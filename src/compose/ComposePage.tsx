// ComposePage — the composer with no inbox attached.
//
// Type the gist, get a real email back, hand it to whatever mail app you
// actually use. No mailbox connection, no IMAP, no switching cost. This is the
// surface that works on a phone, for Outlook users, and for anyone who shares
// a message into Weaver from another app.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Loader2,
  LogOut,
  Mail,
  Settings,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { composeApi, copyToClipboard, mailtoLink, sharedText, type ComposeDraft } from "./api";
import ComposeSettings from "./ComposeSettings";

export default function ComposePage({
  session,
  onOpenInbox,
}: {
  session: Session;
  onOpenInbox: () => void;
}) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [recipient, setRecipient] = useState("");
  const [wantsSubject, setWantsSubject] = useState(true);
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [polishing, setPolishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Text shared in from another app (Android share sheet) arrives as a query
  // param. Drop it straight into the note so the user only has to press one
  // button.
  useEffect(() => {
    const shared = sharedText();
    if (shared) {
      setNote(shared);
      noteRef.current?.focus();
    }
  }, []);

  const polish = useCallback(async () => {
    const text = note.trim();
    if (!text) {
      toast({ title: "Type your note first", variant: "destructive" });
      noteRef.current?.focus();
      return;
    }

    setPolishing(true);
    try {
      const result = await composeApi.polish({
        note: text,
        recipientName: recipient.trim(),
        isNew: wantsSubject,
      });
      setDraft(result);
      setSubject(result.subject);
      setBody(result.body);
      if (result.aiError) {
        toast({ title: "Wrote it without AI", description: result.aiError });
      }
    } catch (e) {
      toast({ title: "Couldn't write that one", description: (e as Error).message, variant: "destructive" });
    } finally {
      setPolishing(false);
    }
  }, [note, recipient, wantsSubject, toast]);

  const copy = useCallback(async () => {
    const text = subject ? `Subject: ${subject}\n\n${body}` : body;
    if (await copyToClipboard(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast({ title: "Couldn't copy", description: "Select the text and copy it manually.", variant: "destructive" });
    }
  }, [subject, body, toast]);

  const startOver = () => {
    setDraft(null);
    setSubject("");
    setBody("");
    setNote("");
    noteRef.current?.focus();
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between gap-2 p-3 sm:p-4">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
            <Wand2 className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">Composer</p>
            <p className="text-[11px] text-muted-foreground truncate leading-tight">{session.user.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={onOpenInbox} className="btn-ghost text-xs py-2 px-3" title="Open the mail inbox">
            <Mail className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Inbox</span>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            title="Composer settings"
            aria-label="Composer settings"
            className="p-2 rounded-lg hover:bg-muted transition-colors"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={() => supabase.auth.signOut()}
            title="Sign out"
            aria-label="Sign out"
            className="p-2 rounded-lg hover:bg-muted transition-colors"
          >
            <LogOut className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-3 sm:px-4 pb-8">
        {!draft ? (
          <div className="card p-4 sm:p-5 space-y-4">
            <div>
              <h1 className="text-lg font-semibold mb-1">Type the gist</h1>
              <p className="text-sm text-muted-foreground">
                Write it the way you'd text. You'll get a full email back to review before it goes anywhere.
              </p>
            </div>

            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              autoFocus
              placeholder="can do thursday 2pm, bring the deposit"
              className="input resize-y min-h-[7rem]"
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">
                  Who's it to? <span className="font-normal">(optional)</span>
                </span>
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Jane"
                  className="input"
                />
              </label>

              <label className="flex items-end gap-2 pb-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wantsSubject}
                  onChange={(e) => setWantsSubject(e.target.checked)}
                  className="w-4 h-4 rounded accent-primary"
                />
                <span className="text-sm">Write a subject line too</span>
              </label>
            </div>

            <button onClick={polish} disabled={polishing} className="btn w-full py-3">
              {polishing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Writing…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" /> Write my email
                </>
              )}
            </button>
          </div>
        ) : (
          <div className="card p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-lg font-semibold">Your email</h1>
              {draft.ai ? (
                <span className="text-[10px] uppercase tracking-wide font-semibold text-primary bg-primary/10 rounded px-1.5 py-0.5">
                  AI
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                  Plain
                </span>
              )}
            </div>

            {subject !== "" && (
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Subject</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} className="input" />
              </label>
            )}

            <label className="block">
              <span className="text-xs font-medium text-muted-foreground mb-1 block">Body</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                className="input resize-y font-normal leading-relaxed"
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <button onClick={copy} className="btn-ghost py-3">
                {copied ? (
                  <>
                    <Check className="w-4 h-4" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" /> Copy
                  </>
                )}
              </button>
              <a href={mailtoLink({ subject, body })} className="btn py-3">
                <Mail className="w-4 h-4" /> Open in mail app
              </a>
            </div>

            <button onClick={startOver} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 mx-auto">
              <ArrowLeft className="w-3 h-3" /> Write another
            </button>
          </div>
        )}
      </main>

      {showSettings && <ComposeSettings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
