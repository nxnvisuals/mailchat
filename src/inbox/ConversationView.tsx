// ConversationView — one email thread rendered like a text-message chat.
//
// Their messages sit left in muted bubbles, yours sit right in primary
// bubbles. Attachments are tap-to-download chips, quoted history hides behind
// a "show earlier quoted text" expander, and the Composer docks underneath.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Download, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/lib/toast";
import {
  downloadBase64,
  formatBytes,
  formatDayLabel,
  formatMessageTime,
  mailboxApi,
  type MailAttachment,
  type MailMessage,
  type Provider,
  type ThreadDetail,
} from "./api";
import Composer from "./Composer";

interface ConversationViewProps {
  accountId: string;
  provider: Provider;
  threadId: string;
  aiEnabled: boolean;
  onBack: () => void;
  /** Lets the thread list clear its unread dot without a full refresh. */
  onRead: (threadId: string) => void;
}

function AttachmentChip({ accountId, att }: { accountId: string; att: MailAttachment }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const file = await mailboxApi.attachment(accountId, att.messageId, att.partId);
      downloadBase64(file.filename, file.mime, file.base64);
    } catch (e) {
      toast({ title: "Download failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={download}
      disabled={busy}
      className="flex items-center gap-1.5 text-xs bg-card border border-border rounded-full px-2.5 py-1 hover:bg-muted transition-colors max-w-full"
      title={`Download ${att.filename}`}
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" /> : <Download className="w-3 h-3 flex-shrink-0" />}
      <span className="truncate max-w-[160px]">{att.filename}</span>
      {att.size > 0 && <span className="text-muted-foreground flex-shrink-0">{formatBytes(att.size)}</span>}
    </button>
  );
}

function Bubble({ accountId, message }: { accountId: string; message: MailMessage }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const mine = message.isMe;
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] sm:max-w-[75%] ${mine ? "items-end" : "items-start"} flex flex-col gap-1`}>
        {!mine && (
          <p className="text-[11px] text-muted-foreground pl-3" title={message.from.email}>
            {message.from.name}
          </p>
        )}
        <div
          className={`px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words rounded-2xl ${
            mine ? "bg-primary text-primary-foreground rounded-br-md" : "bg-muted text-foreground rounded-bl-md"
          }`}
        >
          {message.text}
          {message.quoted && (
            <div className="mt-2">
              <button
                onClick={() => setShowQuoted(!showQuoted)}
                className={`flex items-center gap-1 text-[11px] ${mine ? "text-primary-foreground/70" : "text-muted-foreground"} hover:underline`}
              >
                {showQuoted ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {showQuoted ? "Hide earlier quoted text" : "Show earlier quoted text"}
              </button>
              {showQuoted && (
                <p
                  className={`mt-1.5 pt-1.5 border-t text-xs whitespace-pre-wrap ${
                    mine ? "border-primary-foreground/20 text-primary-foreground/80" : "border-border text-muted-foreground"
                  }`}
                >
                  {message.quoted}
                </p>
              )}
            </div>
          )}
        </div>
        {message.attachments.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${mine ? "justify-end" : "justify-start"}`}>
            {message.attachments.map((att) => (
              <AttachmentChip key={`${att.messageId}-${att.partId}`} accountId={accountId} att={att} />
            ))}
          </div>
        )}
        <p className={`text-[10px] text-muted-foreground ${mine ? "pr-2 text-right" : "pl-3"}`}>
          {formatMessageTime(message.date)}
        </p>
      </div>
    </div>
  );
}

export default function ConversationView({ accountId, provider, threadId, aiEnabled, onBack, onRead }: ConversationViewProps) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError("");
      try {
        const data = await mailboxApi.getThread(accountId, threadId);
        setDetail(data);
        onRead(threadId);
      } catch (e) {
        if (!quiet) setError((e as Error).message);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [accountId, threadId, onRead],
  );

  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

  useEffect(() => {
    // Pin to the newest message whenever the thread (re)loads.
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail]);

  const handleSent = () => {
    // Mail services take a moment to file the sent copy into the conversation.
    setTimeout(() => load(true), 2500);
    setTimeout(() => load(true), 8000);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-primary" />
      </div>
    );
  }
  if (error || !detail) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{error || "This conversation could not be loaded."}</p>
        <div className="flex gap-2">
          <button onClick={onBack} className="btn-ghost text-xs py-2 px-4 md:hidden">
            Back
          </button>
          <button onClick={() => load()} className="btn text-xs py-2 px-4">
            <RefreshCw className="w-3 h-3" /> Try again
          </button>
        </div>
      </div>
    );
  }

  // Group messages under day separators.
  const groups: Array<{ label: string; messages: MailMessage[] }> = [];
  for (const message of detail.messages) {
    const label = formatDayLabel(message.date);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.messages.push(message);
    else groups.push({ label, messages: [message] });
  }

  const others = [...new Map(detail.messages.filter((m) => !m.isMe).map((m) => [m.from.email, m.from])).values()];

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Header */}
      <div className="border-b border-border px-3 sm:px-4 py-2.5 flex items-center gap-2 bg-card">
        <button onClick={onBack} aria-label="Back to conversations" className="p-1.5 rounded-lg hover:bg-muted md:hidden">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{detail.subject}</p>
          <p className="text-[11px] text-muted-foreground truncate">
            {others.length > 0 ? others.map((a) => `${a.name} (${a.email})`).join(", ") : "Just you so far"}
          </p>
        </div>
        <button onClick={() => load()} title="Refresh conversation" aria-label="Refresh conversation" className="p-1.5 rounded-lg hover:bg-muted">
          <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* Messages */}
      <div ref={scroller} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-3">
        {groups.map((group) => (
          <div key={group.label} className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{group.label}</p>
              <div className="flex-1 h-px bg-border" />
            </div>
            {group.messages.map((message) => (
              <Bubble key={message.id} accountId={accountId} message={message} />
            ))}
          </div>
        ))}
      </div>

      {/* Reply box */}
      <Composer
        accountId={accountId}
        provider={provider}
        aiEnabled={aiEnabled}
        isNew={false}
        reply={detail.reply}
        context={detail.messages.slice(-6).map((m) => ({ from: m.isMe ? "Me" : m.from.name, text: m.text }))}
        onSent={handleSent}
      />
    </div>
  );
}
