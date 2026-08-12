// outlookAuth — browser side of the Microsoft sign-in (OAuth 2 auth-code
// flow with PKCE).
//
// Flow: the user pastes their Entra app registration's client ID + secret →
// we stash them (plus a PKCE verifier and a random state) in localStorage →
// send the browser to Microsoft → Microsoft redirects back with ?code= →
// App.tsx captures + strips it → MailShell hands code + stash to the edge
// function, which exchanges it server-side and stores the refresh token.

import { APP_URL } from "@/lib/config";

const PENDING_KEY = "mailchat.outlook.pending";
const CALLBACK_KEY = "mailchat.outlook.callback";

export interface OutlookPending {
  clientId: string;
  clientSecret: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

export interface OutlookCallback {
  code: string;
  state: string;
}

export const OUTLOOK_SCOPES = "offline_access User.Read Mail.ReadWrite Mail.Send";

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

/** The exact redirect URI this deployment uses (register this in Entra). */
export function redirectUri(): string {
  // Production is served by the Supabase `app` function at APP_URL; local
  // dev runs at the origin root.
  if (window.location.origin === new URL(APP_URL).origin) return APP_URL;
  return `${window.location.origin}/`;
}

/** Build the authorize URL and remember everything needed to finish later. */
export async function beginOutlookSignIn(clientId: string, clientSecret: string): Promise<string> {
  const verifier = randomString(48);
  const challengeBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = randomString(16);
  const pending: OutlookPending = {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    verifier,
    state,
    redirectUri: redirectUri(),
  };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const params = new URLSearchParams({
    client_id: pending.clientId,
    response_type: "code",
    redirect_uri: pending.redirectUri,
    response_mode: "query",
    scope: OUTLOOK_SCOPES,
    state,
    code_challenge: base64Url(challengeBytes),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Called once at page load: if Microsoft just redirected back, stash the
 * code and clean the URL so nothing sensitive lingers in the address bar.
 */
export function captureOutlookCallback(): void {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  if (!code && !error) return;
  if (code && state) {
    localStorage.setItem(CALLBACK_KEY, JSON.stringify({ code, state } satisfies OutlookCallback));
  }
  if (error) {
    localStorage.setItem(
      CALLBACK_KEY,
      JSON.stringify({ code: "", state: `error:${params.get("error_description") ?? error}` }),
    );
  }
  window.history.replaceState({}, "", window.location.pathname);
}

/** The stashed pieces, if a sign-in round trip is waiting to be finished. */
export function takePendingConnection(): { pending: OutlookPending; callback: OutlookCallback } | { error: string } | null {
  const callbackRaw = localStorage.getItem(CALLBACK_KEY);
  if (!callbackRaw) return null;
  const callback = JSON.parse(callbackRaw) as OutlookCallback;
  localStorage.removeItem(CALLBACK_KEY);
  if (callback.state.startsWith("error:")) {
    localStorage.removeItem(PENDING_KEY);
    return { error: callback.state.slice("error:".length) };
  }
  const pendingRaw = localStorage.getItem(PENDING_KEY);
  localStorage.removeItem(PENDING_KEY);
  if (!pendingRaw) return { error: "The sign-in came back, but its saved details were missing. Please try connecting again." };
  const pending = JSON.parse(pendingRaw) as OutlookPending;
  if (pending.state !== callback.state) {
    return { error: "The sign-in response didn't match this browser session. Please try connecting again." };
  }
  return { pending, callback };
}
