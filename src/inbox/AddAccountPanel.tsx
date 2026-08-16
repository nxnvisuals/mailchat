// AddAccountPanel — connect a Gmail (app password) or Outlook (Microsoft
// sign-in) mailbox, with plain-language steps for each.

import { useState } from "react";
import { ExternalLink, KeyRound, Loader2, Mail, ShieldCheck, X } from "lucide-react";
import { useToast } from "@/lib/toast";
import { mailboxApi, type MailAccountSummary, type Provider } from "./api";
import { beginOutlookSignIn, redirectUri } from "./outlookAuth";

interface AddAccountPanelProps {
  /** True on first run (no accounts yet) — hides the close button. */
  firstRun: boolean;
  onClose: () => void;
  onAccounts: (accounts: MailAccountSummary[]) => void;
}

function Step({ icon: Icon, title, children }: { icon: typeof Mail; title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 flex gap-3">
      <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-sm leading-relaxed w-full">
        <p className="font-medium mb-1">{title}</p>
        {children}
      </div>
    </div>
  );
}

function ALink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline inline-flex items-center gap-0.5">
      {children} <ExternalLink className="w-3 h-3" />
    </a>
  );
}

export default function AddAccountPanel({ firstRun, onClose, onAccounts }: AddAccountPanelProps) {
  const { toast } = useToast();
  const [provider, setProvider] = useState<Provider>("gmail");

  // Gmail form
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [signature, setSignature] = useState("");
  const [connecting, setConnecting] = useState(false);

  // Outlook form
  const [msClientId, setMsClientId] = useState("");
  const [msClientSecret, setMsClientSecret] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  const connectGmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    try {
      const { accounts } = await mailboxApi.connectGmail({ email, appPassword, displayName, signature });
      toast({ title: "📬 Connected!", description: `Now reading mail for ${email.trim()}.` });
      onAccounts(accounts);
      onClose();
    } catch (err) {
      toast({ title: "Couldn't connect", description: (err as Error).message, variant: "destructive" });
    } finally {
      setConnecting(false);
    }
  };

  const startOutlook = async () => {
    if (!msClientId.trim() || !msClientSecret.trim()) {
      toast({
        title: "Missing details",
        description: "Paste the Application (client) ID and the client secret value first.",
        variant: "destructive",
      });
      return;
    }
    setRedirecting(true);
    try {
      const url = await beginOutlookSignIn(msClientId, msClientSecret);
      window.location.assign(url);
    } catch (err) {
      toast({ title: "Couldn't start Microsoft sign-in", description: (err as Error).message, variant: "destructive" });
      setRedirecting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-semibold">{firstRun ? "Connect your first mailbox" : "Add a mailbox"}</h2>
        {!firstRun && (
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
        Your email becomes simple conversations — like text messages. When you reply, your quick note is turned into a
        proper professional email before it sends. Nothing goes out without your OK.
      </p>

      {/* Provider choice */}
      <div className="flex gap-2 mb-5">
        <button
          onClick={() => setProvider("gmail")}
          aria-pressed={provider === "gmail"}
          className={`flex-1 card p-3 text-sm font-medium text-center transition ${provider === "gmail" ? "ring-2 ring-primary border-primary/50" : "hover:bg-muted/40"}`}
        >
          Gmail
          <span className="block text-[11px] font-normal text-muted-foreground mt-0.5">3 minutes — app password</span>
        </button>
        <button
          onClick={() => setProvider("outlook")}
          aria-pressed={provider === "outlook"}
          className={`flex-1 card p-3 text-sm font-medium text-center transition ${provider === "outlook" ? "ring-2 ring-primary border-primary/50" : "hover:bg-muted/40"}`}
        >
          Outlook / Microsoft
          <span className="block text-[11px] font-normal text-muted-foreground mt-0.5">~10 minutes — Microsoft sign-in</span>
        </button>
      </div>

      {provider === "gmail" ? (
        <div className="space-y-4">
          <Step icon={ShieldCheck} title="Step 1 — Turn on 2-Step Verification (if it isn't already)">
            <p className="text-muted-foreground">
              Go to <ALink href="https://myaccount.google.com/security">myaccount.google.com/security</ALink>, sign in
              with your Gmail, and switch on <strong>2-Step Verification</strong>. If it already says "On", you're done
              with this step.
            </p>
          </Step>
          <Step icon={KeyRound} title="Step 2 — Create an App Password">
            <p className="text-muted-foreground">
              Go to <ALink href="https://myaccount.google.com/apppasswords">myaccount.google.com/apppasswords</ALink>,
              type a name like <strong>Weaver</strong>, and press Create. Google shows a <strong>16-letter code</strong>{" "}
              — copy it. (Your real Google password is never used or stored, and you can cancel the code from that same
              page any time.)
            </p>
          </Step>
          <Step icon={Mail} title="Step 3 — Paste it here">
            <form onSubmit={connectGmail} className="space-y-3">
              <label className="block text-xs text-muted-foreground">
                Your Gmail address
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input mt-1" placeholder="you@gmail.com" autoComplete="off" />
              </label>
              <label className="block text-xs text-muted-foreground">
                The 16-letter app password from Step 2
                <input
                  type="password"
                  required
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  className="input mt-1 font-mono tracking-widest"
                  placeholder="xxxx xxxx xxxx xxxx"
                  autoComplete="off"
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Your name on outgoing email
                <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input mt-1" placeholder="Your name or business" />
              </label>
              <label className="block text-xs text-muted-foreground">
                Sign-off at the bottom of your emails
                <textarea value={signature} onChange={(e) => setSignature(e.target.value)} rows={2} className="input mt-1" placeholder={"Best,\nYour name"} />
              </label>
              <button type="submit" disabled={connecting} className="btn w-full">
                {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                {connecting ? "Checking with Gmail…" : "Connect my Gmail"}
              </button>
            </form>
          </Step>
        </div>
      ) : (
        <div className="space-y-4">
          <Step icon={ShieldCheck} title="Step 1 — Create a free 'app registration' (one time)">
            <div className="text-muted-foreground space-y-1.5">
              <p>
                Microsoft requires this for any app that reads mail. Go to{" "}
                <ALink href="https://portal.azure.com">portal.azure.com</ALink> and sign in with your Outlook account,
                then search for <strong>App registrations</strong> → <strong>New registration</strong>:
              </p>
              <ul className="list-disc pl-4 space-y-1">
                <li>Name: <strong>Weaver</strong></li>
                <li>
                  Supported account types: <strong>"Accounts in any organizational directory and personal Microsoft
                  accounts"</strong>
                </li>
                <li>
                  Redirect URI: choose <strong>Web</strong> and paste exactly:{" "}
                  <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] break-all">{redirectUri()}</code>
                </li>
              </ul>
              <p>
                Press Register. Then, inside the new registration: <strong>API permissions → Add a permission →
                Microsoft Graph → Delegated</strong> and add <strong>Mail.ReadWrite</strong>, <strong>Mail.Send</strong>{" "}
                and <strong>offline_access</strong> (User.Read is already there).
              </p>
            </div>
          </Step>
          <Step icon={KeyRound} title="Step 2 — Copy its ID and make a secret">
            <p className="text-muted-foreground">
              On the registration's <strong>Overview</strong> page copy the <strong>Application (client) ID</strong>.
              Then open <strong>Certificates &amp; secrets → New client secret</strong>, press Add, and copy the
              secret's <strong>Value</strong> (the long one — it's only shown once).
            </p>
          </Step>
          <Step icon={Mail} title="Step 3 — Paste both here and sign in">
            <div className="space-y-3">
              <label className="block text-xs text-muted-foreground">
                Application (client) ID
                <input type="text" value={msClientId} onChange={(e) => setMsClientId(e.target.value)} className="input mt-1 font-mono" placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" />
              </label>
              <label className="block text-xs text-muted-foreground">
                Client secret value
                <input type="password" value={msClientSecret} onChange={(e) => setMsClientSecret(e.target.value)} className="input mt-1 font-mono" placeholder="…" autoComplete="off" />
              </label>
              <button onClick={startOutlook} disabled={redirecting} className="btn w-full">
                {redirecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                {redirecting ? "Taking you to Microsoft…" : "Sign in with Microsoft"}
              </button>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                You'll approve Weaver reading and sending your mail, then land right back here. The connection stays
                good as long as you use the app now and then; you can revoke it any time at{" "}
                <ALink href="https://account.live.com/consent/Manage">account.live.com/consent/Manage</ALink>.
              </p>
            </div>
          </Step>
        </div>
      )}
    </div>
  );
}
