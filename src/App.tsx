// App — session gate, route selection, and Outlook OAuth callback capture.
//
// Two surfaces share one bundle:
//
//   Composer — type a note, get an email. No mailbox needed. Also the target
//              of the Android share sheet, which arrives as ?text=…
//   Inbox    — the original chat-style mail client, for connected mailboxes.
//
// Microsoft's sign-in redirects back here with ?code=…&state=…. That can
// arrive before the user's Weaver session is restored, so the callback is
// stashed immediately on load (and stripped from the URL), then completed by
// MailShell once the user is signed in.

import { useEffect, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import AuthGate from "./auth/AuthGate";
import MailShell from "./inbox/MailShell";
import ComposePage from "./compose/ComposePage";
import Sidebar, { type Surface } from "./shell/Sidebar";
import type { MailFolder } from "./inbox/api";
import { captureOutlookCallback } from "./inbox/outlookAuth";

// Run before first render so the code never survives into the visible URL.
captureOutlookCallback();

type Route = "inbox" | "composer";

/**
 * Pick the opening surface.
 *
 * The app is served from a path prefix (…/functions/v1/app/) and the server
 * falls back to index.html for anything it doesn't recognise, so a trailing
 * /compose is enough to route on. Shared text wins outright: if another app
 * handed us a message, the composer is unambiguously what was wanted.
 */
function routeFromUrl(): Route {
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(search);
  if (params.has("text") || params.has("title") || params.has("url")) return "composer";
  if (/\/compose\/?$/.test(pathname) || hash === "#compose") return "composer";
  return "inbox";
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState<Route>(routeFromUrl);
  const [folder, setFolder] = useState<MailFolder>("inbox");
  // Bumped to ask MailShell to open its settings dialog from the rail.
  const [settingsNonce, setSettingsNonce] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Keep the back button meaningful when switching surfaces.
  useEffect(() => {
    const onPop = () => setRoute(routeFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (next: Route) => {
    setRoute(next);
    const base = window.location.pathname.replace(/\/compose\/?$/, "").replace(/\/$/, "");
    window.history.pushState({}, "", next === "composer" ? `${base}/compose` : base || "/");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!session) return <AuthGate />;

  const navigate = (surface: Surface) => {
    if (surface === "composer") {
      go("composer");
      return;
    }
    setFolder(surface);
    if (route !== "inbox") go("inbox");
  };

  if (route === "composer") {
    return <ComposePage session={session} onOpenInbox={() => go("inbox")} />;
  }

  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar
        active={folder}
        email={session.user.email ?? ""}
        onNavigate={navigate}
        onOpenSettings={() => setSettingsNonce((n) => n + 1)}
      />
      <div className="flex-1 min-w-0">
        <MailShell
          session={session}
          folder={folder}
          onSetFolder={setFolder}
          onOpenComposer={() => go("composer")}
          openSettingsNonce={settingsNonce}
        />
      </div>

      {/* Phone: the rail is hidden, so the composer needs its own way in. */}
      <button
        onClick={() => go("composer")}
        title="Write an email from a quick note"
        className="md:hidden fixed bottom-4 right-4 z-30 btn shadow-lg py-3 px-4"
      >
        <Wand2 className="w-4 h-4" /> Composer
      </button>
    </div>
  );
}
