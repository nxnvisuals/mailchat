// AuthGate — email + password sign in / sign up for MailChat itself.
//
// Anyone can create a login, but the mail backend only answers accounts on
// its allowlist (mail_allowed_users), so a stranger who signs up sees a
// polite "this app is private" and nothing else.

import { useState } from "react";
import { Loader2, MessagesSquare } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/lib/toast";

export default function AuthGate() {
  const { toast } = useToast();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw new Error(error.message);
        if (!data.session) {
          toast({
            title: "Almost there",
            description: "Check your email for a confirmation link, then sign in.",
          });
        }
      }
    } catch (err) {
      toast({ title: "Couldn't sign you in", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <MessagesSquare className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-semibold">MailChat</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-5">
          Your email as simple conversations. Sign {mode === "signin" ? "in" : "up"} to continue.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
            placeholder="you@example.com"
            autoComplete="email"
          />
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            placeholder={mode === "signup" ? "Choose a password (8+ characters)" : "Password"}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
          <button type="submit" disabled={busy} className="btn w-full">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="text-xs text-muted-foreground underline mt-4 hover:text-foreground"
        >
          {mode === "signin" ? "First time here? Create your account" : "Already have an account? Sign in"}
        </button>
        <p className="text-[11px] text-muted-foreground mt-4 leading-relaxed">
          This is a private app — mailboxes only load for allowed logins.
        </p>
      </div>
    </div>
  );
}
