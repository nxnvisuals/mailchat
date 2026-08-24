-- Multi-tenant mailboxes: each connected account belongs to the Weaver
-- (Supabase auth) user who added it, so people only ever see their own mail.
-- The mailbox edge function scopes every read/write by user_id.

alter table public.mail_accounts
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists mail_accounts_user_id_idx
  on public.mail_accounts(user_id);

-- One connection per (user, provider, email).
create unique index if not exists mail_accounts_user_provider_email_key
  on public.mail_accounts(user_id, provider, email);

-- Existing rows predate ownership and can't be attributed to a user; clear
-- them so they're reconnected under the right account.
delete from public.mail_accounts where user_id is null;
