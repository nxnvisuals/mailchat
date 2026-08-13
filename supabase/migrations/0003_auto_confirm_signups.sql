-- MailChat is gated by its own allowlist (mail_allowed_users), so email
-- confirmation adds friction without adding protection: the built-in mailer
-- is rate-limited and its link lands on the default Site URL. New accounts
-- are therefore confirmed at creation.
create or replace function public.auto_confirm_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  return new;
end;
$$;

revoke all on function public.auto_confirm_new_user() from public, anon, authenticated;

drop trigger if exists auto_confirm_users on auth.users;
create trigger auto_confirm_users
  before insert on auth.users
  for each row execute function public.auto_confirm_new_user();
