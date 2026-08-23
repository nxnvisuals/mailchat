-- Google "Sign in with Google" (OAuth2 / XOAUTH2) for Gmail accounts.
--
-- A Gmail row is now authenticated one of two ways: the original app password
-- (app_password), or Google OAuth tokens below. The single shared Google Cloud
-- OAuth client's id/secret live in edge-function env, not per row; each account
-- keeps only its own refresh token (+ a cached access token).

alter table public.mail_accounts
  add column if not exists google_refresh_token     text,
  add column if not exists google_access_token      text,
  add column if not exists google_token_expires_at  timestamptz;
