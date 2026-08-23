// google — OAuth2 "Sign in with Google" for Gmail, the one-click alternative
// to app passwords. One shared Google Cloud OAuth client (its id + secret come
// from edge-function env: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET);
// each connected account keeps its own refresh token. IMAP/SMTP then sign in
// with a short-lived access token via XOAUTH2 (see imap.ts / smtp.ts).

import { MailError } from "./types.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// Full-mailbox scope is the one Gmail's IMAP/SMTP XOAUTH2 accepts; "email"
// lets us read back which address just connected.
export const GOOGLE_SCOPES = "https://mail.google.com/ email profile";

function clientCreds(): { id: string; secret: string } {
  const id = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const secret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!id || !secret) {
    throw new MailError("Google sign-in isn't set up on the server yet.", "auth");
  }
  return { id, secret };
}

async function tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
  } catch (e) {
    throw new MailError(`Could not reach Google's sign-in service: ${(e as Error).message}`, "network");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(json.error ?? "unknown_error");
    const desc = String(json.error_description ?? "");
    if (code === "invalid_grant") {
      throw new MailError("Your Google connection has expired or was revoked — open Mail settings and reconnect.", "auth");
    }
    throw new MailError(`Google sign-in problem (${code})${desc ? `: ${desc}` : ""}`, "auth");
  }
  return json;
}

/** One-time auth-code exchange when connecting a Gmail account with Google. */
export async function exchangeGoogleCode(input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ refreshToken: string; accessToken: string; expiresAt: string; email: string }> {
  const { id, secret } = clientCreds();
  const json = await tokenRequest({
    client_id: id,
    client_secret: secret,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const accessToken = String(json.access_token ?? "");
  const refreshToken = String(json.refresh_token ?? "");
  const expiresAt = new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000).toISOString();
  if (!accessToken || !refreshToken) {
    throw new MailError(
      "Google didn't return the expected sign-in tokens. Try connecting again and be sure to allow offline access.",
      "auth",
    );
  }
  const email = await fetchGoogleEmail(accessToken);
  return { refreshToken, accessToken, expiresAt, email };
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: string }> {
  const { id, secret } = clientCreds();
  const json = await tokenRequest({
    client_id: id,
    client_secret: secret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const accessToken = String(json.access_token ?? "");
  if (!accessToken) throw new MailError("Google didn't return a fresh access token — reconnect the account.", "auth");
  return { accessToken, expiresAt: new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000).toISOString() };
}

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const info = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new MailError("Signed in with Google, but couldn't read the account's email address.", "auth");
  const email = String(info.email ?? "").toLowerCase();
  if (!email) throw new MailError("Google didn't report an email address for this account.", "auth");
  return email;
}
