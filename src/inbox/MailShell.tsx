// MailShell — the signed-in app: account switcher, thread list and
// conversation panes (which swap full-screen on mobile), add-account and
// settings flows, and completion of a pending Microsoft sign-in.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, LogOut, MailPlus, MessagesSquare, Plus, RefreshCw, Settings, ShieldAlert } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import {
  mailboxApi,
  NotAllowedError,
  type MailAccountSummary,
  type MailFolder,
  type ThreadSummary,
} from "./api";
import { takePendingConnection } from "./outlookAuth";
import AddAccountPanel from "./AddAccountPanel";
import ThreadList from "./ThreadList";
import ConversationView from "./ConversationView";
import MailSettingsDialog from "./MailSettingsDialog";
import NewMessageDialog from "./NewMessageDialog";

export default function MailShell({
  session,
  folder = "inbox",
  onSetFolder,
  onOpenComposer,
  openSettingsNonce = 0,
}: {
  session: Session;
  /** Which list to show. Driven by the sidebar so the rail and the list agree. */
  folder?: MailFolder;
  onSetFolder?: (folder: MailFolder) => void;
  onOpenComposer?: () => void;
  /** Incremented by the sidebar to ask for the settings dialog. */
  openSettingsNonce?: number;
}) {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<MailAccountSummary[] | null>(null);
  const [notAllowed, setNotAllowed] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const finishingOutlook = useRef(false);

  const applyAccounts = useCallback((next: MailAccountSummary[]) => {
    setAccounts(next);
    setActiveId((prev) => (prev && next.some((a) => a.id === prev) ? prev : next[0]?.id ?? null));
  }, []);

  // Initial load + finishing a Microsoft sign-in round trip if one is parked.
  useEffect(() => {
    (async () => {
      try {
        const pending = takePendingConnection();
        if (pending && "error" in pending) {
          toast({ title: "Microsoft sign-in didn't finish", description: pending.error, variant: "destructive" });
        } else if (pending && !finishingOutlook.current) {
          finishingOutlook.current = true;
          try {
            const { accounts: next, connectedEmail } = await mailboxApi.connectOutlook({
              clientId: pending.pending.clientId,
              clientSecret: pending.pending.clientSecret,
              code: pending.callback.code,
              redirectUri: pending.pending.redirectUri,
              codeVerifier: pending.pending.verifier,
            });
            toast({ title: "📬 Outlook connected!", description: `Now reading mail for ${connectedEmail}.` });
            applyAccounts(next);
            setShowAdd(false);
            return;
          } catch (e) {
            toast({ title: "Couldn't connect Outlook", description: (e as Error).message, variant: "destructive" });
          }
        }
        const { accounts: list } = await mailboxApi.status();
        applyAccounts(list);
      } catch (e) {
        if (e instanceof NotAllowedError) setNotAllowed(true);
        else setLoadError((e as Error).message);
        setAccounts([]);
      }
    })();
  }, [applyAccounts, toast]);

  const signOut = () => supabase.auth.signOut();

  if (accounts === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (notAllowed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-sm w-full p-6 text-center">
          <ShieldAlert className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-1">This app is private</h1>
          <p className="text-sm text-muted-foreground mb-4">
            You're signed in as <strong>{session.user.email}</strong>, but that login isn't on Weaver's allowed list.
            The owner can add it in the Supabase table <code>mail_allowed_users</code>.
          </p>
          <button onClick={signOut} className="btn-ghost text-xs py-2 px-4">
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-sm w-full p-6 text-center">
          <p className="text-sm text-muted-foreground mb-4">The mail service isn't reachable: {loadError}</p>
          <button onClick={() => window.location.reload()} className="btn text-xs py-2 px-4">
            <RefreshCw className="w-3.5 h-3.5" /> Try again
          </button>
        </div>
      </div>
    );
  }

  if (accounts.length === 0 || showAdd) {
    return (
      <div className="min-h-screen p-4 sm:p-6">
        <div className="flex items-center justify-between max-w-2xl mx-auto mb-6">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <MessagesSquare className="w-4.5 h-4.5" />
            </div>
            <span className="font-semibold">Weaver</span>
          </div>
          <button onClick={signOut} title="Sign out" aria-label="Sign out" className="p-2 rounded-lg hover:bg-muted">
            <LogOut className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <AddAccountPanel firstRun={accounts.length === 0} onClose={() => setShowAdd(false)} onAccounts={applyAccounts} />
      </div>
    );
  }

  const active = accounts.find((a) => a.id === activeId) ?? accounts[0];
  return (
    <MailApp
      key={active.id}
      account={active}
      accounts={accounts}
      folder={folder}
      onSetFolder={onSetFolder}
      onOpenComposer={onOpenComposer}
      openSettingsNonce={openSettingsNonce}
      onSwitch={setActiveId}
      onAddAccount={() => setShowAdd(true)}
      onAccounts={applyAccounts}
      onSignOut={signOut}
    />
  );
}

function MailApp({
  account,
  accounts,
  folder,
  onSetFolder,
  onOpenComposer,
  openSettingsNonce,
  onSwitch,
  onAddAccount,
  onAccounts,
  onSignOut,
}: {
  account: MailAccountSummary;
  accounts: MailAccountSummary[];
  folder: MailFolder;
  onSetFolder?: (folder: MailFolder) => void;
  onOpenComposer?: () => void;
  openSettingsNonce: number;
  onSwitch: (id: string) => void;
  onAddAccount: () => void;
  onAccounts: (a: MailAccountSummary[]) => void;
  onSignOut: () => void;
}) {
  const { toast } = useToast();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [q, setQ] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const requestSeq = useRef(0);

  const loadThreads = useCallback(
    async (query: string, f: MailFolder) => {
      const seq = ++requestSeq.current;
      setThreadsLoading(true);
      try {
        const result = await mailboxApi.listThreads(account.id, query, f);
        if (seq === requestSeq.current) setThreads(result.threads);
      } catch (e) {
        if (seq === requestSeq.current) {
          toast({ title: "Couldn't load your mail", description: (e as Error).message, variant: "destructive" });
        }
      } finally {
        if (seq === requestSeq.current) setThreadsLoading(false);
      }
    },
    [account.id, toast],
  );

  // The rail lives outside this component, so it asks for settings by bumping
  // a counter. Skipping zero keeps the dialog shut on first render.
  useEffect(() => {
    if (openSettingsNonce > 0) setShowSettings(true);
  }, [openSettingsNonce]);

  useEffect(() => {
    loadThreads(activeQuery, folder);
  }, [loadThreads, activeQuery, folder]);

  const markThreadRead = useCallback((threadId: string) => {
    setThreads((prev) => prev.map((t) => (t.threadId === threadId ? { ...t, unread: false } : t)));
  }, []);

  return (
    <div className="h-screen flex flex-col p-3 sm:p-4 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="relative min-w-0">
          <button
            onClick={() => setSwitcherOpen(!switcherOpen)}
            className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-muted transition min-w-0"
            aria-haspopup="listbox"
            aria-expanded={switcherOpen}
          >
            <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
              <MessagesSquare className="w-4 h-4" />
            </div>
            <div className="text-left min-w-0">
              <p className="text-sm font-semibold leading-tight">Weaver</p>
              <p className="text-[11px] text-muted-foreground truncate leading-tight">
                {account.email} <span className="capitalize">({account.provider})</span>
              </p>
            </div>
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          </button>
          {switcherOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSwitcherOpen(false)} />
              <div className="absolute z-50 top-full mt-1 left-0 card p-1.5 w-72 shadow-lg" role="listbox">
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    role="option"
                    aria-selected={a.id === account.id}
                    onClick={() => {
                      onSwitch(a.id);
                      setSwitcherOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
                      a.id === account.id ? "bg-primary/10 text-primary" : "hover:bg-muted"
                    }`}
                  >
                    <span className="truncate flex-1">{a.email}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">{a.provider}</span>
                  </button>
                ))}
                <button
                  onClick={() => {
                    setSwitcherOpen(false);
                    onAddAccount();
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 hover:bg-muted text-muted-foreground"
                >
                  <Plus className="w-3.5 h-3.5" /> Add a mailbox
                </button>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={() => setShowNewMessage(true)} className="btn text-xs py-2 px-4">
            <MailPlus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">New email</span>
          </button>
          <button onClick={() => setShowSettings(true)} title="Mail settings" aria-label="Mail settings" className="p-2 rounded-lg hover:bg-muted transition-colors">
            <Settings className="w-4 h-4 text-muted-foreground" />
          </button>
          <button onClick={onSignOut} title="Sign out" aria-label="Sign out" className="p-2 rounded-lg hover:bg-muted transition-colors">
            <LogOut className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Two-pane mail surface */}
      <div className="card flex flex-1 min-h-0 overflow-hidden">
        <div className={`${selectedId ? "hidden md:flex" : "flex"} flex-col w-full md:w-80 lg:w-96 md:border-r border-border flex-shrink-0 min-h-0`}>
          <ThreadList
            threads={threads}
            loading={threadsLoading}
            selectedId={selectedId}
            q={q}
            filter={folder}
            searching={activeQuery !== ""}
            onSelect={setSelectedId}
            onSetQ={setQ}
            onSearch={() => setActiveQuery(q.trim())}
            onSetFilter={(f) => onSetFolder?.(f)}
            onRefresh={() => loadThreads(activeQuery, folder)}
          />
        </div>
        <div className={`${selectedId ? "flex" : "hidden md:flex"} flex-col flex-1 min-w-0 min-h-0`}>
          {selectedId ? (
            // Keyed so a half-typed draft never carries over to another
            // conversation's reply box.
            <ConversationView
              key={selectedId}
              accountId={account.id}
              provider={account.provider}
              threadId={selectedId}
              aiEnabled={account.aiEnabled}
              onBack={() => setSelectedId(null)}
              onRead={markThreadRead}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center p-6">
              <MessagesSquare className="w-8 h-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Pick a conversation on the left</p>
              <p className="text-xs text-muted-foreground/70 max-w-xs">
                Your emails show up here as simple back-and-forth conversations. Reply like you'd text — it goes out as
                a proper email.
              </p>
              <button onClick={() => loadThreads(activeQuery, folder)} className="btn-ghost text-xs py-2 px-4 mt-2">
                <RefreshCw className="w-3 h-3" /> Check for new mail
              </button>
            </div>
          )}
        </div>
      </div>

      {showSettings && (
        <MailSettingsDialog account={account} onClose={() => setShowSettings(false)} onAccounts={onAccounts} />
      )}
      {showNewMessage && (
        <NewMessageDialog
          accountId={account.id}
          provider={account.provider}
          aiEnabled={account.aiEnabled}
          onClose={() => setShowNewMessage(false)}
          onSent={() => loadThreads(activeQuery, folder)}
        />
      )}
    </div>
  );
}
