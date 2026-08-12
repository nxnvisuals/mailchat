# MailChat 💬

Your email as simple conversations. MailChat turns messy email threads into
a clean, text-message-style chat. You reply the way you'd text — short and
casual — and MailChat turns it into a proper, professional email before it
sends (you always review and approve first). Attachments, search, unread
filters and multiple mailboxes included.

**Live app:** https://uyjpclffcyxcwidjmwxz.supabase.co/functions/v1/app/

Works with **Gmail** (3-minute setup with an app password) and
**Outlook / Microsoft accounts** (one-time Microsoft app registration).

---

## How it works (the short version)

- The whole product runs on one free Supabase project (`MailChat`,
  ref `uyjpclffcyxcwidjmwxz`, $0/month):
  - **`app` edge function** – serves this repo's built frontend. The compiled
    files travel as a gzip+base64 payload stored in the `app_assets_parts`
    table and are decoded once per cold start.
  - **`mailbox` edge function** – the API. Talks IMAP/SMTP to Gmail and
    Microsoft Graph to Outlook, converts threads into chat conversations,
    turns your quick note into a polished email (Claude, optional), and sends.
  - **Postgres** – account settings and credentials, in tables only the
    server can read (row-level security is on with zero policies; the
    browser never sees a password, key or token).
- **Who can use it:** anyone can create a login, but mailboxes only load for
  emails listed in the `mail_allowed_users` table. Everyone else sees a
  polite "this app is private" screen.
- **Mail is never stored.** Messages are read live from Gmail/Microsoft and
  rendered; nothing is copied into the database.

## Using it

1. Open the live app and **create your account** (the owner's email,
   `nxnvisuals@gmail.com`, is already on the allowed list).
2. **Connect a mailbox.** The app walks you through it:
   - *Gmail*: turn on 2-Step Verification → create an App Password at
     myaccount.google.com/apppasswords → paste it. Your real password is
     never used, and you can revoke the app password any time.
   - *Outlook / Microsoft*: create a free "app registration" at
     portal.azure.com (the app shows every click), paste its client ID +
     secret, then sign in with Microsoft. The redirect URI to register is
     exactly the live app URL above.
3. **(Optional) AI polish.** In Mail settings, paste an Anthropic API key
   (console.anthropic.com → API keys). Your one-line notes then come back as
   complete professional emails — you still approve before anything sends.
   Without a key, replies are framed with a greeting and your signature
   instead.

To allow another person: Supabase dashboard → Table Editor →
`mail_allowed_users` → insert their email.

## Build it on Lovable

The repo is Lovable-ready — the same Vite + React + Tailwind shape as a
Lovable project, with the `lovable-tagger` dev plugin wired in.

1. Go to lovable.dev → **Create** → **Import from GitHub** and pick
   `nxnvisuals/mailchat`.
2. Lovable builds it and gives the project its own live URL (something like
   `mailchat.lovable.app`), plus visual editing and chat-based changes. Use
   **Publish** there the same way as with the salon site.
3. No keys or settings to configure — the app already knows its backend.
   Accounts, connected mailboxes and settings are shared between the Lovable
   copy and the Supabase-hosted copy; both talk to the same MailChat project.

One Outlook note: Microsoft only sends sign-ins back to web addresses that
are registered in the Entra app. The connect screen always shows the exact
"Redirect URI" for wherever the app is running — the first time you connect
Outlook from the Lovable URL, add that shown value in the registration
(Authentication → Web → Add URI) next to the existing one. Gmail needs
nothing extra.

## Development

```sh
npm install
npm run dev        # local dev server (vite)
npx vitest run     # unit tests for the email-parsing internals
```

The frontend is React + Tailwind. The interesting parts live in:

- `src/inbox/` – the chat UI (thread list, conversation view, composer with
  the "your note → real email" preview, settings, Microsoft sign-in flow)
- `supabase/functions/mailbox/` – the API: `gmail.ts` (IMAP/SMTP),
  `outlook.ts` (Microsoft Graph), `imap.ts`, `smtp.ts`, `imapParse.ts`,
  `mimeText.ts`, `mimeBuild.ts`, `quoteStrip.ts` (protocol + MIME plumbing),
  `index.ts` (routing, allowlist, AI polish)
- `supabase/migrations/` – database schema

## Deploying changes

**Frontend** (anything under `src/`):

```sh
node scripts/build-lite.mjs
```

This compiles the app (vendor libraries come from esm.sh via an import map,
so the payload stays ~23 KB) and regenerates
`supabase/functions/app/load-assets.sql`. Run that SQL against the project
(Supabase dashboard → SQL Editor → paste → run). The comment at the bottom
of the file shows the expected md5 so you can verify. No function redeploy
needed.

**API** (anything under `supabase/functions/mailbox/`): redeploy the
`mailbox` function with the Supabase CLI or dashboard. Keep *Verify JWT*
**on** for `mailbox` and **off** for `app` (it's the public web page).

**Database**: files in `supabase/migrations/` were applied via the Supabase
MCP; new ones can be pasted into the SQL Editor.

## Security notes

- Credentials (Gmail app passwords, Microsoft client secrets + refresh
  tokens, Anthropic keys) live only in service-role-only tables and are
  never returned to the browser — status calls report booleans and
  addresses only.
- Outgoing mail headers are sanitized against header injection; recipients,
  thread ids and attachment references are format-validated server side.
- The Microsoft sign-in uses the standard auth-code + PKCE flow; the code
  exchange happens server-side and refresh tokens are rotated and persisted
  on every use.
