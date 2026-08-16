-- Compose service: the polish engine as a product of its own.
--
-- MailChat's differentiated asset is "type one line, send a real email".
-- Until now it only worked inside the mail client, and only for a user who
-- had connected an IMAP/Graph mailbox. These tables let it work for someone
-- who is still using Gmail or Outlook and has connected nothing at all.
--
-- Everything here is service-role only (RLS on, zero policies). The compose
-- function runs with verify_jwt OFF because it must also accept device
-- tokens, so it performs both authentication and per-user scoping itself.

-- Composer settings, keyed on the Supabase user rather than on a mailbox.
-- Deliberately separate from mail_accounts: in the composer world there may
-- be no mailbox to hang settings off.
create table if not exists public.compose_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  display_name      text not null default '',
  signature         text not null default '',
  anthropic_api_key text,
  ai_model          text not null default 'claude-haiku-4-5',
  -- Phase D: samples of the user's own writing, fed to the polish prompt so
  -- drafts sound like them. Array of strings.
  tone_samples      jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

grant all on public.compose_profiles to service_role;
revoke all on public.compose_profiles from anon, authenticated;
alter table public.compose_profiles enable row level security;
-- Intentionally NO policies: service-role only.

-- Device tokens, one per surface (Gmail add-on, phone share target, ...).
-- Only the SHA-256 hash is stored; the raw token is shown once at issuance
-- and is unrecoverable afterwards.
create table if not exists public.compose_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  token_hash   text not null unique,
  label        text not null default '',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists compose_tokens_user_idx
  on public.compose_tokens (user_id);

-- Partial index: token lookup on every request only ever considers live rows.
create index if not exists compose_tokens_live_idx
  on public.compose_tokens (token_hash)
  where revoked_at is null;

grant all on public.compose_tokens to service_role;
revoke all on public.compose_tokens from anon, authenticated;
alter table public.compose_tokens enable row level security;
-- Intentionally NO policies: service-role only.

-- Per-minute request counter, keyed on the user so it covers both auth
-- paths (browser session and device token). A user who loses a token to a
-- leaked add-on install cannot run up an unbounded Anthropic bill.
create table if not exists public.compose_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  minute  timestamptz not null,
  count   integer not null default 0,
  primary key (user_id, minute)
);

grant all on public.compose_usage to service_role;
revoke all on public.compose_usage from anon, authenticated;
alter table public.compose_usage enable row level security;
-- Intentionally NO policies: service-role only.

-- Atomic increment + read in one round trip, so two concurrent requests
-- cannot both observe the pre-increment count and slip past the limit.
create or replace function public.compose_bump_usage(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_count  integer;
begin
  insert into public.compose_usage (user_id, minute, count)
  values (p_user_id, v_minute, 1)
  on conflict (user_id, minute)
    do update set count = public.compose_usage.count + 1
  returning count into v_count;

  -- Opportunistic cleanup; keeps the table from growing without a cron job.
  delete from public.compose_usage
   where minute < v_minute - interval '1 hour';

  return v_count;
end;
$$;

revoke all on function public.compose_bump_usage(uuid) from public, anon, authenticated;
grant execute on function public.compose_bump_usage(uuid) to service_role;
