-- Polishing a short note into an email doesn't need a flagship model:
-- Haiku 4.5 handles it well at a fraction of Opus's cost and latency.
-- Existing rows only ever got their value from the old column default
-- (the app has no model picker), so they move too.
alter table public.mail_accounts alter column ai_model set default 'claude-haiku-4-5';
update public.mail_accounts set ai_model = 'claude-haiku-4-5' where ai_model = 'claude-opus-5';
