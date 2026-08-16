/**
 * Weaver for Gmail — type one line, send a real email.
 *
 * This is the whole pivot in one file. Instead of asking anyone to leave
 * Gmail for a different email client, the composer shows up inside the Gmail
 * compose window they're already in. You type a casual note the way you'd
 * text, press Polish, and a complete professional email lands in the draft.
 *
 * Nothing here reads your mail. The add-on requests draft METADATA only — the
 * recipients, so it can greet them by name — and never asks for access to
 * your inbox, your history, or the body of anything you've received. The
 * heavy lifting happens in Weaver's `compose` edge function; this file is
 * a text box, a button, and an HTTP call.
 */

// ── Configuration ──────────────────────────────────────────────────────────
// Point this at your own Weaver project if you are self-hosting.
var COMPOSE_ENDPOINT = 'https://uyjpclffcyxcwidjmwxz.supabase.co/functions/v1/compose';

// Device tokens travel in their own header rather than Authorization, which
// the Supabase gateway inspects and would reject as a malformed JWT.
var TOKEN_HEADER = 'X-Weaver-Token';

var TOKEN_PROPERTY = 'weaver_token';
var REQUEST_TIMEOUT_NOTE = 'Weaver took too long to answer. Try again in a moment.';

// ── Token storage ──────────────────────────────────────────────────────────

function getToken() {
  return PropertiesService.getUserProperties().getProperty(TOKEN_PROPERTY) || '';
}

function setToken(token) {
  PropertiesService.getUserProperties().setProperty(TOKEN_PROPERTY, token);
}

function clearToken() {
  PropertiesService.getUserProperties().deleteProperty(TOKEN_PROPERTY);
}

// ── Entry points ───────────────────────────────────────────────────────────

/** Shown when the add-on is opened outside a compose window. */
function onHomepage() {
  return getToken() ? buildStatusCard() : buildSetupCard('');
}

/** Shown when the add-on is opened from inside a Gmail compose window. */
function onComposeAction(e) {
  if (!getToken()) {
    return buildSetupCard('Connect Weaver once, then you can polish from any draft.');
  }
  return buildComposeCard(e, '');
}

// ── Cards ──────────────────────────────────────────────────────────────────

function buildSetupCard(message) {
  var section = CardService.newCardSection();

  if (message) {
    section.addWidget(CardService.newTextParagraph().setText(message));
  }

  section.addWidget(
    CardService.newTextParagraph().setText(
      'Open Weaver in your browser, go to <b>Composer settings</b>, and create a device token. ' +
        'Paste it below — it is stored only in your own Google account.'
    )
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('token')
      .setTitle('Device token')
      .setHint('Starts with wv_')
  );

  section.addWidget(
    CardService.newTextButton()
      .setText('Connect')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('handleSaveToken'))
  );

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Connect Weaver'))
    .addSection(section)
    .build();
}

function buildStatusCard() {
  var section = CardService.newCardSection();

  section.addWidget(
    CardService.newTextParagraph().setText(
      'Weaver is connected. Open a Gmail compose window and choose ' +
        '<b>Polish with Weaver</b> to turn a quick note into a full email.'
    )
  );

  section.addWidget(
    CardService.newTextButton()
      .setText('Disconnect')
      .setOnClickAction(CardService.newAction().setFunctionName('handleClearToken'))
  );

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Weaver'))
    .addSection(section)
    .build();
}

function buildComposeCard(e, prefill) {
  var recipient = firstRecipient(e);

  var section = CardService.newCardSection();

  section.addWidget(
    CardService.newTextParagraph().setText(
      recipient
        ? 'Writing to <b>' + escapeHtml(recipient) + '</b>. Jot the gist — Weaver writes the email.'
        : 'Jot the gist — Weaver writes the email.'
    )
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('note')
      .setTitle('Your note')
      .setMultiline(true)
      .setValue(prefill || '')
      .setHint('can do thursday 2pm, bring the deposit')
  );

  section.addWidget(
    CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('isNew')
      .addItem('Write a subject line too', 'yes', !isReply(e))
  );

  section.addWidget(
    CardService.newTextButton()
      .setText('Polish and insert')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('handlePolish'))
  );

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Polish with Weaver'))
    .addSection(section)
    .build();
}

// ── Handlers ───────────────────────────────────────────────────────────────

function handleSaveToken(e) {
  var token = ((e.formInput && e.formInput.token) || '').trim();

  if (!token) {
    return notify('Paste your device token first.');
  }
  if (token.indexOf('wv_') !== 0) {
    return notify("That doesn't look like a Weaver token — they start with wv_.");
  }

  setToken(token);

  // Prove the token works now rather than failing later inside a draft.
  var check = callCompose({ action: 'polish', note: 'test', isNew: false });
  if (check.error) {
    clearToken();
    return notify(check.error);
  }

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Weaver connected.'))
    .setNavigation(CardService.newNavigation().updateCard(buildStatusCard()))
    .build();
}

function handleClearToken() {
  clearToken();
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Weaver disconnected.'))
    .setNavigation(CardService.newNavigation().updateCard(buildSetupCard('')))
    .build();
}

function handlePolish(e) {
  var note = ((e.formInput && e.formInput.note) || '').trim();
  if (!note) {
    return notify('Type your note first.');
  }

  // A checkbox selection arrives as an array of the values that are ticked.
  var isNewRaw = (e.formInput && e.formInput.isNew) || [];
  var wantsSubject = isNewRaw.length > 0;

  var result = callCompose({
    action: 'polish',
    note: note,
    recipientName: firstRecipient(e),
    isNew: wantsSubject
  });

  if (result.error) {
    return notify(result.error);
  }

  var builder = CardService.newUpdateDraftActionResponseBuilder().setUpdateDraftBodyAction(
    CardService.newUpdateDraftBodyAction()
      .addUpdateContent(textToHtml(result.body), CardService.ContentType.MUTABLE_HTML)
      .setUpdateType(CardService.UpdateDraftBodyType.IN_PLACE_INSERT)
  );

  // Only touch the subject when the model actually wrote one — replies come
  // back with an empty subject and must not blank out Gmail's "Re: …".
  if (wantsSubject && result.subject) {
    builder.setUpdateDraftSubjectAction(
      CardService.newUpdateDraftSubjectAction().addUpdateSubject(result.subject)
    );
  }

  return builder.build();
}

// ── Weaver API ───────────────────────────────────────────────────────────

/**
 * Call the compose service. Returns either the draft or a { error } object —
 * never throws, so every failure surfaces as a readable card notification
 * rather than Apps Script's generic red banner.
 */
function callCompose(payload) {
  var token = getToken();
  if (!token) {
    return { error: 'Connect Weaver first.' };
  }

  var headers = {};
  headers[TOKEN_HEADER] = token;

  var response;
  try {
    response = UrlFetchApp.fetch(COMPOSE_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    return { error: REQUEST_TIMEOUT_NOTE };
  }

  var code = response.getResponseCode();
  var body = {};
  try {
    body = JSON.parse(response.getContentText() || '{}');
  } catch (err) {
    return { error: 'Weaver sent back something unreadable. Try again.' };
  }

  if (code === 429) {
    return { error: body.error || 'Slow down a moment and try again.' };
  }
  if (code === 401 || code === 403) {
    return { error: body.error || 'That token is no longer valid. Reconnect Weaver.' };
  }
  if (code >= 400) {
    return { error: body.error || 'Weaver could not write that one.' };
  }
  if (!body.body) {
    return { error: 'Weaver returned an empty draft.' };
  }

  return body;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function notify(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}

/**
 * Best guess at who this draft is going to, for the greeting.
 *
 * Draft metadata gives addresses, sometimes in "Name <addr>" form. The compose
 * service already refuses to greet a bare address, so handing it one is safe —
 * it falls back to a plain "Hi," rather than "Hi janeexamplecom".
 */
function firstRecipient(e) {
  var meta = e && e.draftMetadata;
  if (!meta) return '';

  var to = meta.toRecipients || [];
  if (!to.length) return '';

  var raw = String(to[0] || '').trim();
  var named = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return named ? named[1].trim() : raw;
}

/** A reply already has a subject; Gmail prefills "Re: …". */
function isReply(e) {
  var meta = e && e.draftMetadata;
  var subject = (meta && meta.subject) || '';
  return /^\s*(re|fwd|fw)\s*:/i.test(subject);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The compose service returns plain text; Gmail's draft body is HTML. Escape
 * first, then turn newlines into breaks, so a note containing < or & can never
 * inject markup into the user's own email.
 */
function textToHtml(text) {
  return escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
}
