/* =====================================================================
   Toirem Grants – emails, sent from your Gmail by the "Toirem grants mailer"
   Google Apps Script (google-apps-script/GrantsMailer.gs).
   ===================================================================== */

export async function sendEmail(env, mail) {
  const res = await fetch(env.EMAIL_HELPER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script reads the body as text
    body: JSON.stringify({
      secret: env.EMAIL_HELPER_SECRET,
      to: Array.isArray(mail.to) ? mail.to.join(',') : mail.to,
      subject: mail.subject,
      html: mail.html,
      replyTo: mail.replyTo || '',
      name: env.EMAIL_FROM_NAME || 'Toirem Grants',
      attachments: mail.attachments || [], // [{ name, html }] – the mailer turns each into a PDF
    }),
    redirect: 'follow', // Apps Script answers through a redirect
  });
  const text = await res.text();
  let out = {};
  try { out = JSON.parse(text); } catch (e) { /* an HTML page means the script isn't deployed for "Anyone" */ }
  if (!res.ok || !out.ok) throw new Error('Email failed: ' + (out.error || res.status + ' ' + text.slice(0, 150)));
}

/** Turn an HTML page into a PDF using the Gmail mailer (Google does the conversion). Returns the PDF bytes. */
export async function makePdf(env, html, name) {
  const res = await fetch(env.EMAIL_HELPER_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
    body: JSON.stringify({ secret: env.EMAIL_HELPER_SECRET, action: 'pdf', html, name }),
  });
  let out = {};
  try { out = JSON.parse(await res.text()); } catch (e) { /* not JSON */ }
  if (!out.ok || !out.pdf) throw new Error(out.error || 'The mailer could not make the PDF. Update the mailer script to the latest version.');
  return Uint8Array.from(atob(out.pdf), (c) => c.charCodeAt(0));
}

/* ---------- links ---------- */
export const siteUrl = (env) => String(env.PUBLIC_SITE_URL || '').replace(/\/+$/, '');
export const officeLink = (env, id) => siteUrl(env) + '/grants/office.html' + (id ? '#grant/' + id : '');
export const recipientLink = (env, kind, token) => siteUrl(env) + '/grants/link.html#' + kind + '/' + token;

/* ---------- templates ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function layout(title, body) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#4a4f5c;max-width:640px;margin:0 auto">
  <h1 style="color:#e8521c;font-size:26px;margin:0 0 6px">${esc(title)}</h1>
  <div style="height:2px;background:#e8521c;margin:0 0 18px"></div>
  ${body}
  <div style="background:#1f2a5c;color:#fff;font-size:12px;padding:14px 16px;margin-top:28px">
    <b>Toirem</b> · Charity Number 1206622 · 24 Darenth Rd, London, N16 6EJ · info@toirem.org.uk · 020 8157 2849
  </div></div>`;
}
const button = (href, label) =>
  `<p style="margin:22px 0"><a href="${esc(href)}" style="background:#e8521c;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${esc(label)}</a></p>`;
const row = (k, v) =>
  `<tr><td style="padding:5px 12px 5px 0;color:#1f2a5c;font-weight:bold;vertical-align:top;width:190px">${esc(k)}</td><td style="padding:5px 0;vertical-align:top">${esc(v || '—')}</td></tr>`;
const table = (rows) => `<table style="border-collapse:collapse;font-size:14px;width:100%">${rows}</table>`;
const h = (s) => `<h3 style="color:#1f2a5c;margin:18px 0 6px">${esc(s)}</h3>`;

export const templates = {
  applicationReceived(a) {
    return {
      subject: `New grant application ${a.ref}: ${a.orgName}`,
      html: layout('New grant application', `
        ${a.warnings.length ? `<div style="background:#fdecec;color:#c0262d;padding:10px 12px;border-radius:6px;margin-bottom:14px"><b>Please check:</b><br>${a.warnings.map(esc).join('<br>')}</div>` : ''}
        ${table(row('Reference', a.ref) + row('Organisation', a.orgName) + row('Type', a.type) + row('Applicant', a.applicant) + row('Activity cost', gbp(a.cost)) + row('Use of funds', a.use))}
        ${button(a.officeUrl, 'Open in Grants Office')}
        <hr style="border:0;border-top:1px solid #b9bfcf;margin:24px 0">${a.details}`),
    };
  },
  applicationConfirmation(a) {
    return {
      subject: `We've received your grant application (${a.ref})`,
      html: layout('Application received', `<p>Dear ${esc(a.applicantName)},</p>
        <p>Thank you. We've received the grant application from ${esc(a.orgName)}. Your reference is <b>${esc(a.ref)}</b>.</p>
        <p>Our trustees will review it and contact you.</p>`),
    };
  },
  agreementToSign(a) {
    return {
      subject: `Your Toirem grant agreement ${a.ref} is ready to sign`,
      html: layout('Grant agreement', `<p>Dear ${esc(a.orgName)},</p>
        <p>Toirem's trustees have approved a grant of <b>${gbp(a.amount)}</b>. Please read and sign the grant agreement online.</p>
        ${button(a.link, 'Read and sign the agreement')}<p style="font-size:12px">This link is personal to your organisation. Please don't forward it.</p>`),
    };
  },
  agreementSigned(a) {
    return {
      subject: `Grant agreement ${a.ref} signed by ${a.orgName}`,
      html: layout('Agreement signed', `<p>${esc(a.signedBy)} signed the grant agreement for ${esc(a.orgName)}. Payments can now be recorded.</p>${button(a.officeUrl, 'Open in Grants Office')}`),
    };
  },
  breakdownRequest(a) {
    return {
      subject: `${a.reminder ? 'Reminder: ' : ''}Please tell us how your Toirem grant was spent (${a.ref})`,
      html: layout('How was the grant spent?', `<p>Dear ${esc(a.orgName)},</p>
        <p>Between ${esc(a.from)} and ${esc(a.to)} Toirem paid you <b>${gbp(a.total)}</b>. As set out in your grant terms, please give us a short breakdown of how it was used.</p>
        ${button(a.link, 'Fill in the breakdown')}`),
    };
  },
  proofRequest(a) {
    return {
      subject: `${a.reminder ? 'Reminder: ' : ''}Receipts needed for your Toirem grant (${a.ref})`,
      html: layout('Proof of spending', `<p>Dear ${esc(a.orgName)},</p><p>Thank you for your breakdown. Please upload a receipt or invoice for:</p>
        <ul>${a.lines.map((l) => `<li>${esc(l.description)}: ${gbp(l.amount)}</li>`).join('')}</ul>${button(a.link, 'Upload proof')}`),
    };
  },
  receiptsRequest(a) {
    return {
      subject: `${a.reminder ? 'Reminder: ' : ''}Receipts and bank confirmation needed (${a.ref})`,
      html: layout('Receipts needed', `<p>Dear ${esc(a.orgName)},</p>
        <p>Toirem has paid your grant. For each invoice below, please upload the supplier's receipt and your bank's confirmation that you paid it.</p>
        <ul>${a.invoices.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>${button(a.link, 'Upload documents')}`),
    };
  },
  recheckAlert(a) {
    return {
      subject: `Charity Commission re-check: ${a.items.length} grant(s) need attention`,
      html: layout('Monthly re-check', a.items.map((i) => `<p><b>${esc(i.ref)} · ${esc(i.orgName)}</b><br>${i.problems.map(esc).join('<br>')}</p>`).join('') + button(a.officeUrl, 'Open Grants Office')),
    };
  },
};

/** Plain copy of a submitted application for the office email. */
export function applicationDetailsHtml(form, cc, { includeCheck = true } = {}) {
  const a = form.app, b = form.bank, g = form.grant;
  const pos = a.position === 'Other' ? a.positionOther : a.position;
  const orgRows = cc
    ? row('Legal name', cc.name) + row('Charity number', cc.number) + row('Registered', cc.regDate) +
      row('Address', [...cc.address.lines, cc.address.town, cc.address.postcode].filter(Boolean).join(', ')) + row('Phone', cc.phone) + row('Email', cc.email) +
      cc.trustees.map((n, i) => row('Trustee ' + (i + 1), n)).join('')
    : row('Name', form.org.name) + row('Address', [form.org.line1, form.org.town, form.org.postcode].join(', ')) + row('Phone', form.org.phone) + row('Email', form.org.email) +
      row('Payment route', form.route === 'club' ? 'Paid into club account' : 'Toirem pays supplier directly') +
      form.trustees.map((t, i) => row('Trustee ' + (i + 1), t.name + ' (' + (t.role === 'Other' ? t.other : t.role) + ')')).join('');
  const check = cc
    ? cc.finances.map((f) => row('Income / spending, year to ' + f.yearEnd, gbp(f.income) + ' / ' + gbp(f.spending))).join('') +
      row('Accounts', cc.accounts.overdue ? 'OVERDUE (due ' + cc.accounts.dueDate + ')' : 'Up to date · last received ' + (cc.accounts.lastReceived || '—')) +
      row('Annual return', cc.annualReturn.overdue ? 'OVERDUE' : 'Received ' + (cc.annualReturn.lastReceived || '—')) +
      row('Inquiries / reports', cc.regulatoryReports.length ? cc.regulatoryReports.map((x) => x.title + (x.published ? ' (' + x.published + ')' : '')).join('; ') : 'None published') +
      row('Objects', cc.objects) + row('Activities', cc.activities) + (cc.accountsPageUrl ? row('Accounts on register', cc.accountsPageUrl) : '')
    : '';
  return h('1) Organisation') + table(orgRows) +
    h('2) Applicant') + table(row('Name', [a.title, a.first, a.last].join(' ')) + row('Position', pos)) +
    h('3) Bank') + table(row('Bank', b.bank) + row('Name on account', b.acname) + row('Sort code', b.sort) + row('Account number', b.acno)) +
    h('4) Grant') + table(row('Activity cost', gbp(g.cost)) + row('Expected annual donations', gbp(g.annual)) + row('Use of funds', g.use)) +
    h('5) Confirmation') + table(row('Signed by', g.sign) + row('Date', g.date)) +
    (cc && includeCheck ? `<div style="background:#fbe3d4;padding:12px 14px;border-radius:10px;margin-top:18px">${h('Charity Commission check')}${table(check)}</div>` : '');
}

/** A complete page for the application PDF (simple inline styles, which Google's PDF converter handles well). */
export function applicationPdfHtml(form, cc, meta, { includeCheck = true } = {}) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(meta.ref)}</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;color:#4a4f5c;font-size:12px;margin:24px">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:bottom"><div style="color:#e8521c;font-size:28px;font-weight:bold">Grant Application</div></td>
    <td style="text-align:right;vertical-align:bottom;color:#1f2a5c;font-size:11px"><b>${esc(meta.ref)}</b><br>Submitted ${esc(meta.submitted)}</td>
  </tr></table>
  <div style="height:2px;background:#e8521c;margin:6px 0 10px"></div>
  <div style="font-size:14px;color:#1f2a5c;font-weight:bold;margin-bottom:6px">${esc(meta.orgName)}</div>
  ${applicationDetailsHtml(form, cc, { includeCheck })}
  <div style="background:#1f2a5c;color:#fff;font-size:10px;padding:10px 12px;margin-top:22px">
    <b>Toirem</b> · Charity Number 1206622 · 24 Darenth Rd, London, N16 6EJ · info@toirem.org.uk · 020 8157 2849</div>
  </body></html>`;
}
export const pdfName = (ref, orgName) => (ref + ' ' + String(orgName || '')).replace(/[^\w\- ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) + '.pdf';
