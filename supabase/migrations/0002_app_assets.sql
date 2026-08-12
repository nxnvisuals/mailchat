-- Storage for the built frontend served by the `app` edge function.
-- The payload (gzip + base64 of the compiled files) is loaded in small
-- chunks by supabase/functions/app/load-assets.sql, which build-lite.mjs
-- regenerates on every build.
--
-- Service-role only, like every other table in this project: RLS is on with
-- zero policies, so only the edge functions (service role) can touch it.

create table if not exists public.app_assets_parts (
  seq integer primary key,
  part text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_assets_parts enable row level security;
grant all on public.app_assets_parts to service_role;
revoke all on public.app_assets_parts from anon, authenticated;
