// MailChat's own Supabase project ("MailChat" in the nxnvisuals org).
// These are publishable values by design — real protection is Supabase auth
// plus the mail_allowed_users allowlist enforced by the edge function.

export const SUPABASE_URL = "https://uyjpclffcyxcwidjmwxz.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_TAPz2OtIN1u1K2QEOFMV5w_UinMz3TA";

/** Where the production app lives (served by the `app` edge function). */
export const APP_URL = `${SUPABASE_URL}/functions/v1/app/`;
