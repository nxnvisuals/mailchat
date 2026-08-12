// App — session gate + Outlook OAuth callback capture.
//
// Microsoft's sign-in redirects back here with ?code=…&state=…. That can
// arrive before the user's MailChat session is restored, so the callback is
// stashed immediately on load (and stripped from the URL), then completed by
// MailShell once the user is signed in.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import AuthGate from "./auth/AuthGate";
import MailShell from "./inbox/MailShell";
import { captureOutlookCallback } from "./inbox/outlookAuth";

// Run before first render so the code never survives into the visible URL.
captureOutlookCallback();

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return session ? <MailShell session={session} /> : <AuthGate />;
}
