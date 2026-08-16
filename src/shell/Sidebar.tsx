// Sidebar — the navigation rail from the Weaver design.
//
// Ported from the design screen built in Lovable (mailchat-coming-soon,
// src/routes/design.tsx): the wordmark block, the pill Compose action, the
// active item with its left rule, and the account footer.
//
// Every item here goes somewhere real. Starred, Sent, Drafts and Archive are
// backed by actual folder reads in both providers — IMAP special-use mailboxes
// for Gmail, well-known folders for Microsoft Graph.
//
// Desktop only. Below `md` it is hidden entirely — the composer is meant to be
// usable one-handed on a phone, and a 280px rail is the opposite of that.

import { Archive, FileText, Inbox, PenSquare, Send, Settings, Star, type LucideIcon } from "lucide-react";
import type { MailFolder } from "@/inbox/api";

/** Where the rail can send you: the composer, or one of the mail folders. */
export type Surface = "composer" | MailFolder;

interface NavItem {
  id: Surface;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { id: "composer", label: "Composer", icon: PenSquare },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "archive", label: "Archive", icon: Archive },
];

export default function Sidebar({
  active,
  email,
  displayName,
  onNavigate,
  onOpenSettings,
}: {
  active: Surface;
  email: string;
  displayName?: string;
  onNavigate: (surface: Surface) => void;
  onOpenSettings: () => void;
}) {
  const name = displayName?.trim() || email.split("@")[0] || "You";
  const initial = (name[0] ?? "W").toUpperCase();

  return (
    <nav
      aria-label="Main"
      className="hidden md:flex h-screen w-[280px] shrink-0 flex-col bg-card border-r border-border"
    >
      {/* Wordmark */}
      <div className="p-6 flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-full bg-primary-container text-primary-foreground flex items-center justify-center font-bold">
          W
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-2xl font-bold tracking-tight text-primary leading-7">Weaver</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-[0.18em] font-semibold">
            Deep Focus
          </span>
        </div>
      </div>

      {/* Primary action — the composer is the product, so it leads. */}
      <div className="px-4 mb-6">
        <button
          onClick={() => onNavigate("composer")}
          className="w-full bg-primary text-primary-foreground rounded-[2rem] py-3 flex items-center justify-center gap-2 hover:bg-primary-container transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          <PenSquare className="w-5 h-5" />
          <span className="font-medium">Compose</span>
        </button>
      </div>

      <ul className="flex-1 flex flex-col px-2 gap-1">
        {NAV.map(({ id, label, icon: Icon }) => {
          const isActive = id === active;
          return (
            <li key={id}>
              <button
                onClick={() => onNavigate(id)}
                aria-current={isActive ? "page" : undefined}
                className={
                  isActive
                    ? "w-full text-left flex items-center gap-3 px-3 py-2 rounded-r-full text-primary border-l-4 border-primary bg-primary/10 font-medium"
                    : "w-full text-left flex items-center gap-3 px-4 py-2 rounded-full text-muted-foreground hover:bg-surface-high transition-colors"
                }
              >
                <Icon className="w-5 h-5 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            </li>
          );
        })}

        <li>
          <button
            onClick={onOpenSettings}
            className="w-full text-left flex items-center gap-3 px-4 py-2 rounded-full text-muted-foreground hover:bg-surface-high transition-colors"
          >
            <Settings className="w-5 h-5 shrink-0" />
            <span className="truncate">Settings</span>
          </button>
        </li>
      </ul>

      {/* Account. No photo to show, so the initial stands in rather than
          borrowing a stock portrait the way the mockup did. */}
      <div className="p-5 flex items-center gap-3 border-t border-border mt-auto">
        <div className="w-10 h-10 rounded-full bg-muted text-foreground flex items-center justify-center font-semibold shrink-0">
          {initial}
        </div>
        <div className="flex flex-col min-w-0">
          <span className="font-medium leading-5 truncate">{name}</span>
          <span className="text-xs text-muted-foreground truncate">{email}</span>
        </div>
      </div>
    </nav>
  );
}
