// ThreadList — the conversation sidebar: search, Inbox/Unread filters, and
// one row per conversation with sender, subject, snippet and unread dot.

import { Loader2, Paperclip, RefreshCw, Search } from "lucide-react";
import { formatThreadDate, type MailFolder, type ThreadSummary } from "./api";

interface ThreadListProps {
  threads: ThreadSummary[];
  loading: boolean;
  selectedId: string | null;
  q: string;
  filter: MailFolder;
  searching: boolean;
  onSelect: (threadId: string) => void;
  onSetQ: (q: string) => void;
  onSearch: () => void;
  onSetFilter: (f: MailFolder) => void;
  onRefresh: () => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "")).toUpperCase();
}

export default function ThreadList(props: ThreadListProps) {
  const { threads, loading, selectedId, q, filter, searching, onSelect, onSetQ, onSearch, onSetFilter, onRefresh } = props;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Search + filters */}
      <div className="p-3 border-b border-border space-y-2 bg-card">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSearch();
          }}
          className="relative"
        >
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={q}
            onChange={(e) => onSetQ(e.target.value)}
            className="input pl-8 text-sm py-2"
            placeholder="Search mail (name, word, topic…)"
          />
        </form>
        <div className="flex items-center gap-2">
          {(["inbox", "unread"] as const).map((f) => (
            <button
              key={f}
              onClick={() => onSetFilter(f)}
              aria-pressed={filter === f}
              className={`text-xs px-3 py-1.5 rounded-full capitalize transition-colors ${
                filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {f}
            </button>
          ))}
          <div className="flex-1" />
          <button onClick={onRefresh} title="Refresh" aria-label="Refresh conversations" className="p-1.5 rounded-lg hover:bg-muted">
            <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {loading && threads.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : threads.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12 px-4">
            {searching ? "No mail matched that search." : filter === "unread" ? "You're all caught up — nothing unread." : "Your inbox is empty."}
          </p>
        ) : (
          threads.map((t) => (
            <button
              key={t.threadId}
              onClick={() => onSelect(t.threadId)}
              className={`w-full text-left px-3 py-3 border-b border-border/60 transition-colors flex gap-2.5 ${
                selectedId === t.threadId ? "bg-primary/5" : "hover:bg-muted/50"
              }`}
            >
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0 ${
                  t.unread ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
                aria-hidden
              >
                {initials(t.fromIsMe ? "Me" : t.from.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <p className={`text-sm truncate ${t.unread ? "font-semibold" : "font-medium"}`}>
                    {t.fromIsMe ? "You" : t.from.name}
                    {t.count > 1 && <span className="text-muted-foreground font-normal"> ({t.count})</span>}
                  </p>
                  <p className="text-[10px] text-muted-foreground flex-shrink-0">{formatThreadDate(t.date)}</p>
                </div>
                <p className={`text-xs truncate ${t.unread ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                  {t.subject}
                </p>
                <div className="flex items-center gap-1">
                  {t.hasAttachments && <Paperclip className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
                  <p className="text-[11px] text-muted-foreground truncate">{t.snippet || " "}</p>
                  {t.unread && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0 ml-auto" aria-label="Unread" />}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
