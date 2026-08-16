// Weaver's own Supabase project ("Weaver" in the nxnvisuals org).
// These are publishable values by design — real protection is Supabase auth
// plus the mail_allowed_users allowlist enforced by the edge function.

export const SUPABASE_URL = "https://uyjpclffcyxcwidjmwxz.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_TAPz2OtIN1u1K2QEOFMV5w_UinMz3TA";

/**
 * Where this app is actually being served from.
 *
 * Derived at runtime rather than hardcoded, because Weaver now runs from two
 * places: Lovable's hosting and the `app` edge function. Microsoft requires the
 * OAuth redirect URI to match the address the user is really on, so pinning it
 * to one host silently breaks the Outlook connect flow on the other.
 *
 * Whichever URL this resolves to is the one to register in Azure.
 */
export const APP_URL = (() => {
  if (typeof window === "undefined") return `${SUPABASE_URL}/functions/v1/app/`;
  const { origin, pathname } = window.location;
  // Trim the SPA route off the end so the redirect target is the app root.
  const base = pathname.replace(/\/compose\/?$/, "").replace(/\/index\.html$/, "");
  return `${origin}${base.endsWith("/") ? base : `${base}/`}`;
})();
