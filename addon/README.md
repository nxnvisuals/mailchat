# Weaver for Gmail

Type one line, send a real email — inside the Gmail you already use.

You open a Gmail compose window, jot the gist the way you'd write a text
("can do thursday 2pm, bring the deposit"), press **Polish and insert**, and a
complete professional email lands in the draft. You review and send it
yourself; nothing goes out on its own.

## Why this exists rather than a Weaver inbox

Every product that tried to fix email by replacing the client has died,
plateaued, or been absorbed — Mailbox, Google Inbox, and Superhuman between
them. The research behind that call is in [`../docs/MARKET.html`](../docs/MARKET.html).
The thing people actually adopt is a layer on the inbox they already have,
which is exactly what this is.

## What it can and cannot see

The add-on requests three narrow scopes:

| Scope | What it allows |
|---|---|
| `gmail.addons.execute` | Run at all — required of every Gmail add-on |
| `gmail.addons.current.action.compose` | Write into the draft you have open |
| `script.external_request` | Call the Weaver compose service |

Draft access is set to `METADATA`, so the add-on sees **who you're writing to**
and nothing else. It cannot read your inbox, your sent mail, your history, or
the body of anything you've received. Those are different scopes and this
add-on does not ask for them.

Your device token is stored in Apps Script user properties — inside your own
Google account, not on Weaver's servers.

## Install

You need the [`clasp`](https://github.com/google/clasp) CLI, or you can paste
the files in by hand at [script.google.com](https://script.google.com).

### With clasp

```sh
npm install -g @google/clasp
clasp login

cd addon
clasp create --type standalone --title "Weaver"
clasp push
```

### By hand

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Paste [`Code.gs`](Code.gs) over the default `Code.gs`.
3. **Project Settings** → tick *Show `appsscript.json` manifest file*.
4. Open `appsscript.json` in the editor and paste in [this one](appsscript.json).

### Then deploy it to yourself

1. In the Apps Script editor: **Deploy** → **Test deployments**.
2. Pick **Install**, then **Done**.
3. Reload Gmail. Weaver appears in the right-hand add-on rail.

A test deployment is private to your own account and needs no Google review.

## Connect it

1. Open Weaver in a browser → **Composer settings** → **Create device token**.
2. Copy the token — it starts with `wv_` and is shown once.
3. In Gmail, open the Weaver add-on and paste it into **Device token** → **Connect**.

The token is verified immediately, so a bad paste fails there rather than
halfway through writing an email. Revoke it any time from Composer settings;
the add-on stops working within seconds.

## Use it

1. Compose a new email or hit reply.
2. Open Weaver from the add-on rail → **Polish with Weaver**.
3. Type your note.
4. Leave **Write a subject line too** ticked for a new email; untick it on a
   reply so Gmail's `Re:` survives.
5. **Polish and insert**.

The draft is yours to edit before sending. If the AI is unreachable, out of
credit, or declines, you still get a clean plain version with your greeting and
signature rather than an error — the button always produces something sendable.

## Self-hosting

Point `COMPOSE_ENDPOINT` at the top of `Code.gs` at your own project:

```js
var COMPOSE_ENDPOINT = 'https://<your-project>.supabase.co/functions/v1/compose';
```

## If you ever publish this publicly

A private test deployment needs no review, and Google's unverified-app cap
covers roughly 100 users. Beyond that, listing on the Workspace Marketplace
requires OAuth verification.

Worth confirming before you commit to that path: Google treats
`gmail.addons.current.*` as **sensitive** scopes rather than **restricted**
ones — the restricted tier (`gmail.readonly`, `gmail.modify`) is what triggers
the CASA third-party security assessment, which is the expensive, multi-week
part. Staying out of the inbox is what keeps this add-on on the cheaper side of
that line, but check the current policy yourself before planning around it.
