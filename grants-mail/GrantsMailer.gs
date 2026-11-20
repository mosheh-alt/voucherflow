/**
 * Toirem grants mailer
 * Sends the grants system's emails from your Gmail. Kept separate from the donation receipts helper.
 *
 * Setup (once):
 *  1. script.google.com → New project → name it "Toirem grants mailer" → paste this whole file over Code.gs.
 *  2. Project Settings (gear) → Script properties → Add:
 *       SECRET      = a long random password (the same value goes into Cloudflare as EMAIL_HELPER_SECRET)
 *       FROM_ALIAS  = optional, e.g. grants@toirem.org.uk (only if it's set up in Gmail as "Send mail as")
 *  3. Deploy → New deployment → type "Web app"
 *       Execute as: Me      Who has access: Anyone
 *     Click Deploy, approve the Gmail permission, and copy the Web app URL (ends in /exec).
 *     That URL goes into Cloudflare as EMAIL_HELPER_URL.
 *  4. Run testSend() once from the editor to check it works (it emails you).
 *
 * After editing this script later: Deploy → Manage deployments → pencil (edit) → Version: New version → Deploy,
 * so the URL stays the same.
 *
 * Version 2 (12 Nov 2026): PDF copies of applications attached to emails, and PDFs for the Grants Office.
 * Version 3 (17 Nov 2026): reads replies to grant emails for the Compliance inbox, and sends replies from it.
 * Version 4 (18 Nov 2026): attaches ready-made PDFs as they are (individual applications in the paper-form design).
 */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('SECRET');
    if (!secret || body.secret !== secret) return reply_({ ok: false, error: 'Not allowed' });

    // Make a PDF from an HTML page and send it back (used for "Download PDF" in the Grants Office).
    if (body.action === 'pdf') {
      if (!body.html) return reply_({ ok: false, error: 'Missing html' });
      var pdf = toPdf_(body.html, body.name || 'document.pdf');
      return reply_({ ok: true, pdf: Utilities.base64Encode(pdf.getBytes()) });
    }

    // Replies to grant emails, for the Compliance inbox. Returns messages not sent by you, newest first.
    if (body.action === 'replies') return reply_({ ok: true, messages: replies_(body.query, body.since) });

    // Reply in an existing Gmail conversation (from the Compliance inbox).
    if (body.action === 'reply') {
      var thread = GmailApp.getThreadById(String(body.threadId || ''));
      if (!thread) return reply_({ ok: false, error: 'That conversation was not found in Gmail.' });
      var ropts = { htmlBody: body.html, name: body.name || 'Toirem Grants' };
      var ralias = props.getProperty('FROM_ALIAS');
      if (ralias && GmailApp.getAliases().indexOf(ralias) !== -1) ropts.from = ralias;
      thread.reply(plainText_(body.html), ropts);
      return reply_({ ok: true });
    }

    if (!body.to || !body.subject || !body.html) return reply_({ ok: false, error: 'Missing to, subject or html' });

    var options = {
      htmlBody: body.html,
      name: body.name || 'Toirem Grants'
    };
    if (body.replyTo) options.replyTo = body.replyTo;
    // Attachments arrive either as a ready-made PDF (a.pdf, base64), attached as it is,
    // or as an HTML page (a.html), turned into a PDF here.
    var files = (body.attachments || []).filter(function (a) { return a && (a.pdf || a.html); }).map(function (a) {
      if (a.pdf) return Utilities.newBlob(Utilities.base64Decode(a.pdf), 'application/pdf', a.name || 'document.pdf');
      return toPdf_(a.html, a.name || 'document.pdf');
    });
    if (files.length) options.attachments = files;

    var alias = props.getProperty('FROM_ALIAS');
    if (alias && GmailApp.getAliases().indexOf(alias) !== -1) options.from = alias;

    GmailApp.sendEmail(body.to, body.subject, plainText_(body.html), options);
    return reply_({ ok: true });
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Opening the URL in a browser just confirms it's running. */
function doGet() {
  return reply_({ ok: true, service: 'Toirem grants mailer' });
}

/** Run from the editor to check sending works. */
function testSend() {
  var me = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(me, 'Toirem grants mailer test', 'It works.', {
    htmlBody: '<p style="font-family:Arial">The Toirem grants mailer is working.</p>',
    name: 'Toirem Grants'
  });
  Logger.log('Sent a test email to ' + me + '. Remaining daily quota: ' + MailApp.getRemainingDailyQuota());
}

/** Messages in matching conversations that you didn't send, received after `since` (milliseconds). */
function replies_(query, since) {
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  var aliases = GmailApp.getAliases().map(function (a) { return a.toLowerCase(); });
  var after = Number(since) || 0;
  var out = [];
  var threads = GmailApp.search(String(query || 'subject:"TG-" newer_than:30d'), 0, 60);
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var from = m.getFrom(), addr = (from.match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase();
      if (addr === me || aliases.indexOf(addr) !== -1) return;          // our own emails
      if (m.getDate().getTime() <= after) return;
      out.push({
        id: m.getId(), threadId: t.getId(), from: from, subject: m.getSubject(), date: m.getDate().toISOString(),
        body: String(m.getPlainBody() || '').slice(0, 8000),
        attachments: m.getAttachments().map(function (a) { return { name: a.getName(), size: a.getSize() }; })
      });
    });
  });
  out.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return out.slice(0, 100);
}

/** HTML page -> PDF file (Google does the conversion). */
function toPdf_(html, name) {
  return Utilities.newBlob(String(html), 'text/html', 'page.html').getAs('application/pdf').setName(name);
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Plain-text fallback for email apps that don't show HTML. */
function plainText_(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|tr|li)>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
