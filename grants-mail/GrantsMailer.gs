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

    if (!body.to || !body.subject || !body.html) return reply_({ ok: false, error: 'Missing to, subject or html' });

    var options = {
      htmlBody: body.html,
      name: body.name || 'Toirem Grants'
    };
    if (body.replyTo) options.replyTo = body.replyTo;
    // Attachments arrive as HTML pages and are turned into PDFs here.
    var files = (body.attachments || []).filter(function (a) { return a && a.html; }).map(function (a) { return toPdf_(a.html, a.name || 'document.pdf'); });
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
