-- MailChat schema.
--
-- Two tables, both service-role only (RLS on, zero policies): the browser
-- talks exclusively to the mailbox edge function, which uses the service
-- role. Credentials never reach a client, and mail content is never stored.

-- Connected mailboxes (one row per account; gmail and outlook columns are
-- nullable and used per provider).
create table if not exists public.mail_accounts (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null check (provider in ('gmail', 'outlook')),
  email               text not null,
  display_name        text not null default '',
  signature           text not null default '',
  -- gmail
  app_password        text,
  -- outlook (Microsoft Entra app registration + OAuth tokens)
  ms_client_id        text,
  ms_client_secret    text,
  ms_refresh_token    text,
  ms_access_token     text,
  ms_token_expires_at timestamptz,
  -- AI polish
  anthropic_api_key   text,
  ai_model            text not null default 'claude-opus-5',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

grant all on public.mail_accounts to service_role;
revoke all on public.mail_accounts from anon, authenticated;
alter table public.mail_accounts enable row level security;
-- Intentionally NO policies: service-role only.

-- Who may use this app at all. Anyone can create a Supabase login, but the
-- mailbox function refuses callers whose email isn't in this table.
create table if not exists public.mail_allowed_users (
  email      text primary key,
  created_at timestamptz not null default now()
);

grant all on public.mail_allowed_users to service_role;
revoke all on public.mail_allowed_users from anon, authenticated;
alter table public.mail_allowed_users enable row level security;
-- Intentionally NO policies: service-role only.

insert into public.mail_allowed_users (email)
values ('nxnvisuals@gmail.com')
on conflict (email) do nothing;
