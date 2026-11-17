import { parseTerms } from './terms.js';
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

/** Any other mailer action (replies, reply). Returns the mailer's answer or throws a readable error. */
export async function mailer(env, body) {
  const res = await fetch(env.EMAIL_HELPER_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
    body: JSON.stringify({ secret: env.EMAIL_HELPER_SECRET, name: env.EMAIL_FROM_NAME || 'Toirem Grants', ...body }),
  });
  let out = {};
  try { out = JSON.parse(await res.text()); } catch (e) { /* not JSON */ }
  if (!out.ok) throw new Error(out.error && !/Missing to/.test(out.error) ? out.error : 'The Gmail mailer needs updating to version 3 (see GRANTS.md › Inbox).');
  return out;
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
      subject: a.completed ? `Grant details completed ${a.ref}: ${a.orgName}` : `New grant application ${a.ref}: ${a.orgName}`,
      html: layout(a.completed ? 'Grant details completed' : 'New grant application', `
        ${a.warnings.length ? `<div style="background:#fdecec;color:#c0262d;padding:10px 12px;border-radius:6px;margin-bottom:14px"><b>Please check:</b><br>${a.warnings.map(esc).join('<br>')}</div>` : ''}
        ${table(row('Reference', a.ref) + row('Organisation', a.orgName) + row('Type', a.type) + row('Applicant', a.applicant) + row('Activity cost', gbp(a.cost)) + row('Use of funds', a.use))}
        ${button(a.officeUrl, 'Open in Grants Office')}
        <hr style="border:0;border-top:1px solid #b9bfcf;margin:24px 0">${a.details}`),
    };
  },
  individualReceived(a) {
    return {
      subject: `${a.completed ? 'Individual grant details completed' : 'New individual grant application'} ${a.ref}: ${a.name}`,
      html: layout(a.completed ? 'Individual grant details completed' : 'New individual grant application', `
        ${table(row('Reference', a.ref) + row('Name', a.name) + row('Amount requested', gbp(a.amount) + ' (' + a.frequency + ')') + row('Purpose', a.purpose) + row('Endorser', a.endorser))}
        ${button(a.officeUrl, 'Open in Grants Office')}<p style="font-size:12px">The full application is attached as a PDF.</p>`),
    };
  },
  individualConfirmation(a) {
    return {
      subject: `We've received your grant application (${a.ref})`,
      html: layout('Application received', `<p>Dear ${esc(a.name)},</p>
        <p>Thank you. We've received your application for a grant from Toirem. Your reference is <b>${esc(a.ref)}</b>. A copy is attached.</p>
        <p>We'll be in touch once the Trustees have considered it.</p>`),
    };
  },
  completeRequestIndividual(a) {
    return {
      subject: `Please complete your Toirem grant application (${a.ref})`,
      html: layout('Grant application', `<p>Dear ${esc(a.name)},</p>
        <p>As part of Toirem's grant records${a.amount ? `, covering your grant of <b>${gbp(a.amount)}</b>,` : ''} please complete our individual grant application form. It takes about 10 minutes.
        Please have ready a photo or PDF of your ID, proof of your bank details${a.benefits ? ' and your benefits letter' : ''}.</p>
        ${button(a.link, 'Complete the form')}<p style="font-size:12px">This link is personal to you. Please don't forward it.</p>`),
    };
  },
  completeRequest(a) {
    return {
      subject: `Please complete your Toirem grant details (${a.ref})`,
      html: layout('Grant details', `<p>Dear ${esc(a.orgName)},</p>
        <p>As part of Toirem's grant records${a.amount ? `, covering the grant of <b>${gbp(a.amount)}</b>,` : ''} please check and complete your organisation's details. Most of the form is already filled in from the Charity Commission register.</p>
        ${button(a.link, 'Check and complete the form')}<p style="font-size:12px">This link is personal to your organisation. Please don't forward it.</p>`),
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
        <p>During ${esc(periodText(a.from, a.to))} Toirem paid you <b>${gbp(a.total)}</b> under grant ${esc(a.ref)}. As set out in your grant terms, please give us a short breakdown of how it was used.</p>
        ${a.payments && a.payments.length ? `<table style="border-collapse:collapse;font-size:14px;margin:4px 0 6px">
          <tr><td style="padding:5px 18px 5px 0;color:#1f2a5c;font-weight:bold">Date paid</td><td style="padding:5px 0;color:#1f2a5c;font-weight:bold;text-align:right">Amount</td></tr>
          ${a.payments.map((p) => `<tr><td style="padding:4px 18px 4px 0;border-top:1px solid #e3e6ee">${esc(longDate(p.date))}</td><td style="padding:4px 0;border-top:1px solid #e3e6ee;text-align:right">${gbp(p.amount)}</td></tr>`).join('')}
          <tr><td style="padding:5px 18px 5px 0;border-top:2px solid #1f2a5c;font-weight:bold">Total</td><td style="padding:5px 0;border-top:2px solid #1f2a5c;text-align:right;font-weight:bold">${gbp(a.total)}</td></tr></table>` : ''}
        <p>Please list what the money was spent on and how much each item cost. We may ask for a receipt or invoice for some of the items.</p>
        ${button(a.link, 'Fill in the breakdown')}`),
    };
  },
  applicationInvite(a) {
    return {
      subject: 'Apply for a grant from Toirem',
      html: layout('Grant application', `<p>Dear ${esc(a.name || 'Sir or Madam')},</p>
        <p>You are invited to apply for a grant from Toirem. Please complete our online application form using the button below. It takes about 10 minutes.
        ${a.individual ? 'Please have ready a photo or PDF of your ID and proof of your bank details (and your benefits letter, if you receive benefits).' : 'If your organisation is a registered charity, its details are filled in from the Charity Commission register.'}</p>
        ${a.note ? `<p style="white-space:pre-wrap">${esc(a.note)}</p>` : ''}
        ${button(a.link, 'Start the application')}
        <p style="font-size:13px">Or copy this address into your browser: <a href="${esc(a.link)}">${esc(a.link)}</a></p>
        <p>Kind regards,<br>${esc(a.from || 'Toirem')}<br>Toirem Compliance</p>`),
    };
  },
  donationReceiptRequest(a) {
    return {
      subject: `${a.reminder ? 'Reminder: ' : ''}Please send a receipt for Toirem's donations (${a.ref})`,
      html: layout('Receipt for our donations', `<p>Dear ${esc(a.orgName)},</p>
        <p>During ${esc(periodText(a.from, a.to))} Toirem donated <b>${gbp(a.total)}</b> to ${esc(a.orgName)} under grant ${esc(a.ref)}.
        For our records, please send us a receipt confirming you received these donations.</p>
        ${a.payments && a.payments.length ? `<table style="border-collapse:collapse;font-size:14px;margin:4px 0 6px">
          <tr><td style="padding:5px 18px 5px 0;color:#1f2a5c;font-weight:bold">Date paid</td><td style="padding:5px 0;color:#1f2a5c;font-weight:bold;text-align:right">Amount</td></tr>
          ${a.payments.map((p) => `<tr><td style="padding:4px 18px 4px 0;border-top:1px solid #e3e6ee">${esc(longDate(p.date))}</td><td style="padding:4px 0;border-top:1px solid #e3e6ee;text-align:right">${gbp(p.amount)}</td></tr>`).join('')}
          <tr><td style="padding:5px 18px 5px 0;border-top:2px solid #1f2a5c;font-weight:bold">Total</td><td style="padding:5px 0;border-top:2px solid #1f2a5c;text-align:right;font-weight:bold">${gbp(a.total)}</td></tr></table>` : ''}
        <p>The receipt should be on your organisation's letterhead and show your charity name and number, the amount and the dates received.</p>
        ${button(a.link, 'Upload your receipt')}`),
    };
  },
  donationReceiptReceived(a) {
    return { subject: `Donation receipt received: ${a.orgName} (${a.ref})`, html: layout('Donation receipt received', `<p>${esc(a.orgName)} has uploaded a receipt for ${gbp(a.total)} (${esc(periodText(a.from, a.to))}).</p>${button(a.link, 'Open the grant')}`) };
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
    h('2) Applicant') + table(row('Name', [a.title, a.first, a.last].filter(Boolean).join(' ')) + row('Position', pos)) +
    h('3) Bank') + table(row('Bank', b.bank) + row('Name on account', b.acname) + row('Sort code', b.sort) + row('Account number', b.acno)) +
    h('4) Grant') + table(row('Activity cost', gbp(g.cost)) + row('Expected donations for the year (1 Jan – 31 Dec)', gbp(g.annual)) + row('Use of funds', g.use)) +
    h('5) Confirmation') + table(row('Signed by', g.sign) + row('Date', g.date)) +
    (cc && includeCheck ? `<div style="background:#fbe3d4;padding:12px 14px;border-radius:10px;margin-top:18px">${h('Charity Commission check')}${table(check)}</div>` : '');
}

/** The Toirem footer banner as a data address, so Google's PDF converter can show it without fetching anything. */
const imageCache = {};
/** A site image as a data address, so Google's PDF converter can show it without fetching anything. */
export async function siteImage(env, file) {
  if (imageCache[file] !== undefined) return imageCache[file];
  try {
    const res = await fetch(siteUrl(env) + '/grants/img/' + file);
    if (!res.ok) throw new Error(String(res.status));
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    imageCache[file] = 'data:image/' + (/\.png$/i.test(file) ? 'png' : 'jpeg') + ';base64,' + btoa(bin);
  } catch (e) { return ''; }
  return imageCache[file];
}
export const footerImage = (env) => siteImage(env, 'toirem-footer.jpg');

/** "the year 2026 (1 January to 31 December 2026)" for a calendar year, otherwise "1 March 2026 to 30 June 2026". */
export function periodText(from, to) {
  const y = String(from).slice(0, 4);
  if (String(from).slice(5) === '01-01' && String(to) === y + '-12-31') return 'the year ' + y + ' (1 January to 31 December ' + y + ')';
  return longDate(from) + ' to ' + longDate(to);
}
const longDate = (d) => (d ? new Date(d + (String(d).length === 10 ? 'T12:00:00Z' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) : '');

/**
 * The grant agreement as a PDF, laid out like the agreement on screen: Toirem letterhead, details table,
 * numbered terms, both signature blocks and the payment details.
 */
export function agreementPdfHtml(a, { letterhead = '', footer = '' } = {}) {
  const NAVY = '#2b3a67', GREY = '#8a90a0', LINE = '#c9cdd8';
  const r = a.recipient;
  const bankUsed = a.method === 'Bank transfer' || a.method === 'Paid direct to supplier';
  const det = (rows) => `<table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12.5px">${rows.map(([k, v], i) =>
    `<tr><td style="border:1px solid ${LINE};padding:7px 10px;font-weight:bold;color:${NAVY};width:34%;vertical-align:top;${i % 2 ? 'background:#f1f3f8' : ''}">${esc(k)}</td>
     <td style="border:1px solid ${LINE};padding:7px 10px;vertical-align:top;${i % 2 ? 'background:#f1f3f8' : ''}">${esc(v)}</td></tr>`).join('')}</table>`;
  const h4 = (t, extra = '') => `<div style="color:${NAVY};font-weight:bold;font-size:13px;letter-spacing:.02em;margin:16px 0 6px;${extra}">${esc(t)}</div>`;
  const cl = (items) => `<table style="width:100%;border-collapse:collapse;font-size:12.5px">${items.map(([n, html]) =>
    `<tr><td style="width:30px;color:${GREY};vertical-align:top;padding:2px 0">${n}</td><td style="vertical-align:top;padding:2px 0 4px">${html}</td></tr>`).join('')}</table>`;
  const sl = (v, style = '') => `<div style="border-bottom:1px solid #9aa0b0;min-height:20px;padding:2px 0 3px;${style}">${v}</div>`;
  const block = (title, rows) => `<td style="width:50%;vertical-align:top;padding:8px 14px 0 0;border-top:2px solid ${NAVY}">
    <div style="color:${NAVY};font-weight:bold;font-size:12.5px;margin-bottom:6px">${esc(title)}</div>${rows}</td>`;
  const lab = (t) => `<div style="font-size:11.5px;color:#555;margin-top:6px">${t}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(a.ref)} Grant Agreement</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;color:#222;font-size:12.5px;line-height:1.45;margin:26px 32px">
  ${a.draft ? `<div style="border:2px solid #e8521c;color:#e8521c;font-weight:bold;text-align:center;padding:6px;margin-bottom:12px;letter-spacing:.06em">DRAFT – NOT YET SIGNED</div>` : ''}
  ${letterhead ? `<img src="${letterhead}" alt="Toirem" style="width:100%;display:block;margin-bottom:16px">`
    : `<div style="color:${NAVY};font-size:22px;font-weight:bold;margin-bottom:14px">Toirem · Grant Agreement</div>`}
  ${det([['Recipient Name', a.recipientName], ['Recipient Address', a.recipientAddress], ['Grant Reference', a.ref], ['Grant Amount', gbp(a.amount)],
    ['Purpose of Grant', a.purpose], ['Payment Method', a.method], ['Date of Agreement', longDate(a.toirem.date)]])}
  ${parseTerms(a.terms, a.recipientName).map((x) => x.h ? h4(x.h)
      : x.bullets ? cl([[x.n, esc(x.text) + (x.bullets.length ? `<ul style="margin:4px 0 0;padding-left:20px">${x.bullets.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '')]])
      : `<p>${esc(x.p)}</p>`).join('')}
  ${a.extra ? h4('ADDITIONAL CONDITIONS') + `<div style="font-size:12.5px;white-space:pre-wrap">${esc(a.extra)}</div>` : ''}
  <table style="width:100%;border-collapse:separate;border-spacing:0;margin-top:18px;page-break-inside:avoid"><tr>
    ${block('Signed on behalf of Toirem (CIO Foundation)', lab('Name:') + sl(esc(a.toirem.name || '—')) + lab('Position:') + sl(esc(a.toirem.position || '—')) + lab('Date:') + sl(esc(longDate(a.toirem.date))))}
    ${block('Accepted by the Recipient', lab('Name:') + sl(r ? esc(r.name) : '') + lab('Signature:') +
      sl(r ? esc(r.name) : '', "font-family:'Brush Script MT','Segoe Script','Lucida Handwriting',cursive;font-style:italic;font-size:24px;color:#1f2a5c") + lab('Date:') + sl(r ? esc(longDate(r.date)) : ''))}
  </tr></table>
  ${r && r.signedAt ? `<div style="font-size:10.5px;color:${GREY};margin-top:8px">Signed electronically by ${esc(r.name)} on ${esc(r.signedAt)} through Toirem's secure signing link.</div>` : ''}
  <div style="page-break-inside:avoid">
  ${h4('PAYMENT DETAILS' + (bankUsed ? '' : ' (not used for this payment method)'), 'margin-top:22px')}
  ${det([['Account Name', a.bank.acname], ['Bank Name', a.bank.bank], ['Sort Code', a.bank.sort], ['Account Number', a.bank.acno], ['Reference', a.ref]])}
  </div>
  <div style="page-break-inside:avoid">
  ${h4('PAYMENTS MADE', 'margin-top:22px')}
  ${(() => {
    const P = a.payments || [], paid = P.reduce((t, p) => t + p.amount, 0);
    if (!P.length) return '<p>No payments have been made yet.</p>';
    const td = (v, st = '') => `<td style="border:1px solid ${LINE};padding:6px 10px;${st}">${v}</td>`;
    return `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr>${td('<b style="color:' + NAVY + '">Date paid</b>')}${td('<b style="color:' + NAVY + '">Amount</b>', 'text-align:right;width:30%')}</tr>
      ${P.map((p, i) => `<tr>${td(esc(longDate(p.date)), i % 2 ? '' : 'background:#f1f3f8')}${td(gbp(p.amount), 'text-align:right;' + (i % 2 ? '' : 'background:#f1f3f8'))}</tr>`).join('')}
      <tr>${td('<b>Total paid</b>')}${td('<b>' + gbp(paid) + '</b>', 'text-align:right')}</tr></table>`;
  })()}
  </div>
  ${footer ? `<img src="${footer}" alt="Toirem" style="width:100%;margin-top:20px">` : ''}
  </body></html>`;
}

/**
 * The application PDF, laid out like Toirem's printed form: orange title and rule, numbered navy sections,
 * labels over underlined answers in two columns, the peach office box and the Toirem banner.
 * Built from tables and inline styles, which Google's HTML-to-PDF converter handles reliably.
 */
export function applicationPdfHtml(form, cc, meta, { includeCheck = true, footer = '' } = {}) {
  const NAVY = '#1f2a5c', ORANGE = '#e8521c', TEXT = '#4a4f5c', LINE = '#b9bfcf';
  const a = form.app || {}, b = form.bank || {}, g = form.grant || {};
  const pos = a.position === 'Other' ? a.positionOther : a.position;
  const sup = !form.registered && form.route === 'supplier';
  const cell = (label, value) => `<td style="width:50%;vertical-align:top;padding:0 14px 12px 0">
    <div style="font-size:11px;font-weight:bold;color:${NAVY};margin-bottom:3px">${esc(label)}</div>
    <div style="font-size:12.5px;color:${TEXT};border-bottom:1px solid ${LINE};padding:2px 0 5px;min-height:15px">${esc(value == null || value === '' ? '—' : value)}</div></td>`;
  /** pairs: [label, value, full?] laid out two to a row; a "full" one takes the whole row. */
  const fields = (pairs) => {
    let rows = '', row = [];
    const flush = () => { if (row.length) { rows += '<tr>' + row.join('') + (row.length === 1 ? '<td style="width:50%"></td>' : '') + '</tr>'; row = []; } };
    for (const [l, v, full] of pairs) {
      if (full) { flush(); rows += `<tr>${cell(l, v).replace('width:50%;', '').replace('<td ', '<td colspan="2" ')}</tr>`; continue; }
      row.push(cell(l, v)); if (row.length === 2) flush();
    }
    flush();
    return `<table style="width:100%;border-collapse:collapse;margin-top:4px">${rows}</table>`;
  };
  const h2 = (t) => `<div style="font-size:15px;font-weight:bold;color:${NAVY};margin:20px 0 10px">${esc(t)}</div>`;
  const role = (t) => (t.role === 'Other' ? t.other : t.role);
  const orgPhone = cc ? cc.phone : form.org && form.org.phone, orgEmail = cc ? cc.email : form.org && form.org.email;

  const org = cc ? [
    ["Organisation's legal name", cc.name, true], ['Registered charity number', cc.number], ['Date of registration', cc.regDate],
    ['Full address', cc.address.lines.join(', '), true], ['City / Town', cc.address.town], ['Postcode', cc.address.postcode],
    ['Phone', cc.phone], ['Email', cc.email], ...cc.trustees.map((t, i) => ['Trustee ' + (i + 1), t]),
  ] : [
    ['Organisation / club name', form.org.name, true], ['Registered charity', 'No'], ['Payment route', sup ? 'Toirem pays the supplier directly' : 'Paid into the club account'],
    ['Full address', form.org.line1, true], ['City / Town', form.org.town], ['Postcode', form.org.postcode], ['Phone', form.org.phone], ['Email', form.org.email],
    ...form.trustees.map((t, i) => ['Trustee ' + (i + 1), t.name + ' (' + role(t) + ')']),
  ];
  const check = cc && includeCheck ? `
    <div style="background:#fbe3d4;padding:14px 18px;margin-top:24px;color:${NAVY}">
      <div style="text-align:center;font-weight:bold;font-size:14px">For office use only · Charity Commission check</div>
      <div style="text-align:center;font-size:10.5px;color:${TEXT};margin:2px 0 10px">Checked automatically ${esc(meta.checked || meta.submitted)}</div>
      ${cc.warnings && cc.warnings.length ? `<div style="color:#c0262d;font-weight:bold;font-size:12px;margin-bottom:8px">${cc.warnings.map(esc).join('<br>')}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        ${[
          ['Registered with Charity Commission', cc.registered ? 'Yes, since ' + (cc.regDate || '—') : 'No (removed ' + (cc.removedOn || '') + ')'],
          ...cc.finances.map((f) => ['Income / spending, year to ' + f.yearEnd, gbp(f.income) + ' / ' + gbp(f.spending)]),
          ['Accounts filed?', cc.accounts.overdue ? 'Overdue (due ' + cc.accounts.dueDate + ')' : 'Yes, received ' + (cc.accounts.lastReceived || '—')],
          ['Annual return', cc.annualReturn.overdue ? 'Overdue' : 'Received ' + (cc.annualReturn.lastReceived || '—')],
          ['Inquiries / regulatory reports', cc.regulatoryReports.length ? cc.regulatoryReports.map((x) => x.title + (x.published ? ' (' + x.published + ')' : '')).join('; ') : 'None published'],
          ['Charitable objects', cc.objects || '—'], ['Activities (how funds are spent)', cc.activities || '—'],
        ].map(([k, v]) => `<tr><td style="width:40%;font-weight:bold;padding:5px 12px 5px 0;vertical-align:top">${esc(k)}</td><td style="padding:5px 0;color:${TEXT};vertical-align:top">${esc(v)}</td></tr>`).join('')}
      </table></div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(meta.ref)}</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;color:${TEXT};margin:28px 32px">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:bottom"><div style="color:${ORANGE};font-size:34px;font-weight:bold;line-height:1.1">Grant Application</div></td>
    <td style="text-align:right;vertical-align:top;color:${NAVY};font-size:11px;font-weight:bold">${esc(meta.ref)}<br><span style="font-weight:normal">Submitted ${esc(meta.submitted)}</span></td>
  </tr></table>
  <div style="height:2px;background:${ORANGE};margin:8px 0 6px;font-size:1px;line-height:2px">&nbsp;</div>

  ${h2('1) Organisation main or registered address and contact details')}${fields(org)}
  ${form.incorrect ? `<div style="background:#fff2de;color:#9a5200;padding:8px 10px;font-size:12px">Applicant reports the register details are incorrect: ${esc(form.incorrectNote)}</div>` : ''}

  ${h2('2) Contact details of the person completing this form / main applicant')}
  ${fields([['Title', a.title], ['First name', a.first], ['Last name', a.last], ['Position in organisation', pos],
    ['Phone', a.same ? orgPhone : a.phone], ['Mobile', a.same ? '' : a.mobile], ['Email', a.same ? (orgEmail || a.email) : a.email, true]])}

  ${h2('3) ' + (sup ? "Supplier's bank account details" : 'Bank account details'))}
  ${fields([['Bank / Building Society', b.bank], ['Name on Account', b.acname], ['Sort Code', b.sort], ['Account Number', b.acno]])}

  ${h2('4) Grant information')}
  ${fields([['How much does the activity cost in total?', gbp(g.cost), true], ['Estimated donations from Toirem for the year (1 January – 31 December)', gbp(g.annual), true],
    ['How the funds will be used', g.use, true]])}

  ${h2('5) Confirmation')}
  <div style="font-size:11.5px;font-style:italic;line-height:1.5;color:${TEXT}">
    We certify that, to the best of our knowledge and belief, the information provided in this application is true, accurate and complete.
    We confirm that the organisation is eligible for charitable grant assistance and undertake to notify Toirem promptly of any material change in its circumstances.
    We acknowledge that any grant awarded must be used solely for the purpose stated in this application.
    We undertake to retain all relevant receipts and records and provide them to Toirem upon request.
    We further acknowledge that Toirem may require repayment of all or part of the grant if it is used for any other purpose or if any information provided is found to be inaccurate or misleading.
  </div>
  <div style="height:10px"></div>
  ${fields([['Name', [a.title, a.first, a.last].filter(Boolean).join(' ')], ['Date signed', g.date]])}
  <div style="font-size:11px;font-weight:bold;color:${NAVY};margin:2px 0 3px">Signature</div>
  <div style="font-family:'Brush Script MT','Segoe Script','Lucida Handwriting',cursive;font-style:italic;font-size:26px;color:${NAVY};border-bottom:1px solid ${LINE};padding:0 0 4px;width:50%">${esc(g.sign)}</div>
  ${check}
  ${footer ? `<img src="${footer}" alt="Toirem" style="width:100%;margin-top:28px">`
    : `<div style="background:${NAVY};color:#fff;font-size:10px;padding:10px 12px;margin-top:28px"><b>Toirem</b> · Charity Number 1206622 · 24 Darenth Rd, London, N16 6EJ · info@toirem.org.uk · 020 8157 2849</div>`}
  </body></html>`;
}
export const pdfName = (ref, orgName) => (ref + ' ' + String(orgName || '')).replace(/[^\w\- ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) + '.pdf';

/**
 * The individual application as a PDF in the design of Toirem's paper form (2026): navy left band, centred title,
 * wide-spaced headings, answers underlined in line, ● for the chosen circle, logo footer band.
 * Built from tables and inline styles, which Google's HTML-to-PDF converter handles reliably.
 */
export function individualPdfHtml(f, meta, { includeOffice = true, footer = '', logo = '' } = {}) {
  const N = '#2E4563', B = '#97DAE7', O = '#E07F56', L = '#8a99ad';
  const P = f.person, F = f.family, G = f.grant, BK = f.bank || {}, E = f.endorser, C = f.confirm;
  const u = (v, w = '') => `<span style="border-bottom:1px solid ${N};padding:0 6px 1px;font-weight:bold;color:${N};${w ? 'display:inline-block;min-width:' + w : ''}">${esc(v == null || v === '' ? ' ' : v)}</span>`;
  const lbl = (t) => `<span style="color:${N}">${t}</span>`;
  const row = (parts) => `<div style="margin:0 0 9px;line-height:1.9">${parts.join('&nbsp;&nbsp;&nbsp;&nbsp;')}</div>`;
  const dot = (on, text) => `<span style="white-space:nowrap;margin-right:22px"><span style="font-size:15px;color:${on ? N : B}">${on ? '●' : '○'}</span> <span style="color:${N};${on ? 'font-weight:bold' : ''}">${esc(text)}</span></span>`;
  const h = (t, sm) => `<div style="font-weight:bold;color:${N};font-size:${sm ? 12.5 : 15}px;letter-spacing:${sm ? 0 : 2}px;margin:${sm ? 14 : 20}px 0 8px">${esc(t)}</div>`;
  const purposes = ['Living Costs', 'Wedding Expenses', 'Medical', 'Special Education', 'Debt Repayment', 'Religious Purposes'];
  const incomes = ['Less than £750', '£750 – £1,000', '£1,000 – £1,500', 'More than £1,500'];
  const docs = meta.docs || [];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(meta.ref)}</title></head>
  <body style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:${N}">
  <table style="width:100%;border-collapse:collapse"><tr>
  <td style="width:26px;background:${N}"></td>
  <td style="padding:22px 30px 18px;vertical-align:top">
    <table style="width:100%;border-collapse:collapse"><tr>
      <td style="text-align:center;font-weight:bold;font-size:24px;color:${N}">Individual Grant Application Form</td></tr>
      <tr><td style="text-align:right;font-size:10px;color:${L}">${esc(meta.ref)} · Submitted ${esc(meta.submitted)}</td></tr></table>
    ${h('1. Contact Information:')}
    ${row([lbl('Title') + ' ' + u(P.title, '40px'), lbl('First name') + ' ' + u(P.first, '120px'), lbl('Surname') + ' ' + u(P.last, '140px')])}
    ${row([lbl('Address') + ' ' + u(P.address, '200px'), lbl('City/Town') + ' ' + u(P.town, '80px'), lbl('Postcode') + ' ' + u(P.postcode, '60px')])}
    ${row([lbl('Phone') + ' ' + u(P.phone, '120px'), lbl('Email') + ' ' + u(P.email, '180px')])}
    ${h('2. Family Information:')}
    <div style="margin-left:24px">${['Married', 'Single', 'Divorced', 'Widowed'].map((m) => dot(F.status === m, m)).join('')}</div>
    ${h('3. Do you have any dependent children?', true)}
    <div>${dot(F.children === 'no', 'No')}${dot(F.children === 'yes', 'Yes')} ${lbl('How many?')} ${u(F.childrenCount, '40px')}</div>
    ${h('4. Financial Information:')}
    <div style="margin-bottom:6px">Please provide your average monthly salary income per person:</div>
    <div style="margin-left:18px">${incomes.map((m) => dot(F.income === m, m)).join('')}</div>
    ${h('5. Do you receive any state benefits?')}
    <div>${dot(F.benefits === 'yes', 'Yes')} ${lbl('How much?')} ${u(F.benefitsAmount, '90px')}&nbsp;&nbsp;&nbsp;&nbsp;${dot(F.benefits === 'no', 'No')}</div>
    ${h('6. Purpose of grant?')}
    <div style="line-height:1.9">${purposes.map((x) => dot(G.purposes.includes(x), x)).join('')}</div>
    ${row([lbl('Other') + ' ' + u(G.purposes.includes('Other') ? G.other : '', '380px')])}
    <div style="margin-top:4px">Please provide any additional comments or information that may help us make a decision</div>
    <div style="border-bottom:1px solid ${N};padding:4px 4px 3px;min-height:16px;font-weight:bold;white-space:pre-wrap">${esc(G.comments || ' ')}</div>
    ${h('7. Amount of grant requested?:')}
    <div>${u(gbp(G.amount), '90px')}&nbsp;&nbsp;&nbsp;&nbsp;${dot(G.frequency === 'One-off', 'One-Off')}${dot(G.frequency === 'Ongoing', 'Ongoing')}</div>
    ${h('8. Payment method:')}
    <div style="margin-bottom:6px">How would you like to receive your grant?&nbsp;&nbsp;&nbsp;${dot(f.method === 'Prepaid card', 'Prepaid card')}${dot(f.method === 'Bank transfer', 'Bank transfer')}</div>
    ${row([lbl('Account Name') + ' ' + u(BK.acname, '120px'), lbl('Sort Code') + ' ' + u(BK.sort, '60px'), lbl('Account Number') + ' ' + u(BK.acno, '70px')])}
    ${h('9. Documents (Please provide recent copies):')}
    <div style="line-height:1.9">${[['Proof of bank', '(Bank statement or bank letter with your BACS details)'], ['Benefits letter', '(full UC Statement)'], ['ID', '(passport, Driving/Provisional license)']].map(([d, hint]) =>
      dot(docs.includes(d), d) + `<span style="font-size:9.5px;color:${L}">${hint}</span>`).join('<br>')}</div>
    <div style="margin:10px 0 6px">Please provide an endorser's contact information (e.g., Rabbi, Teacher, Accountant, or Doctor).</div>
    ${row([lbl('Name:') + ' ' + u(E.name, '150px'), lbl('Position:') + ' ' + u(E.position, '110px')])}
    ${row([lbl('Address:') + ' ' + u(E.address, '150px'), lbl('City/Town:') + ' ' + u(E.town, '70px'), lbl('Postcode:') + ' ' + u(E.postcode, '55px')])}
    ${row([lbl('Phone:') + ' ' + u(E.phone, '110px'), lbl('Email:') + ' ' + u(E.email, '150px')])}
    ${h('10. Confirmation')}
    <div style="line-height:1.55">
      <p style="margin:0 0 5px">I certify that, to the best of my knowledge and belief, the information provided in this application is true, accurate and complete.</p>
      <p style="margin:0 0 5px">I confirm that I am eligible for charitable grant assistance and undertake to notify Toirem promptly of any material change in my circumstances.</p>
      <p style="margin:0 0 5px">I acknowledge that any grant awarded must be used solely for the purpose stated in this application.</p>
      <p style="margin:0 0 5px">I undertake to retain all relevant receipts and records and provide them to Toirem upon request.</p>
      <p style="margin:0 0 5px">I further acknowledge that Toirem may require repayment of all or part of the grant if it is used for any other purpose or if any information provided is found to be inaccurate or misleading.</p></div>
    ${row([lbl('Please print your name:') + ' ' + u(C.name, '200px')])}
    <div style="margin:0 0 9px">${lbl('Signature:')} <span style="border-bottom:1px solid ${N};padding:0 10px;font-family:'Brush Script MT','Segoe Script','Lucida Handwriting',cursive;font-style:italic;font-size:22px;color:${N};display:inline-block;min-width:200px">${esc(C.sign)}</span>&nbsp;&nbsp;&nbsp;&nbsp;${lbl('Date:')} ${u(C.date, '80px')}</div>
    ${includeOffice ? `<div style="margin-top:22px;page-break-inside:avoid"><div style="margin-bottom:6px">Office use only</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <tr>${['Date submitted', 'Related documents', 'Date authorized', 'Amount approved'].map((x) => `<td style="border:1px solid ${N};padding:5px 7px">${x}</td>`).join('')}</tr>
        <tr>${[meta.submitted, String(docs.length) + (docs.length ? ' (' + docs.join(', ') + ')' : ''), meta.authorised || '', meta.approved != null ? gbp(meta.approved) : ''].map((x) => `<td style="border:1px solid ${N};padding:7px;font-weight:bold">${esc(x)}</td>`).join('')}</tr>
      </table></div>` : ''}
  </td></tr>
  <tr><td colspan="2" style="background:${N};padding:14px 22px">
    <table style="border-collapse:collapse"><tr>
      <td style="vertical-align:middle;padding-right:18px">${logo ? `<img src="${logo}" alt="Toirem" style="height:52px">` : '<b style="color:#fff;font-size:18px">Toirem</b>'}</td>
      <td style="vertical-align:middle;color:#c3ccd8;font-size:10px;letter-spacing:1px;line-height:1.7">
        <span style="color:#fff">Charity Name:</span> Toirem <span style="color:${O}">|</span> <span style="color:#fff">Address:</span> 24 Darenth Rd London N16 6EJ <span style="color:${O}">|</span><br>
        <span style="color:#fff">Charity Number:</span> 1206622 <span style="color:${O}">|</span> <span style="color:#fff">Email:</span> cs@toirem.co.uk <span style="color:${O}">|</span> <span style="color:#fff">Tel:</span> 020 8157 2849</td></tr></table>
  </td></tr></table>
  </body></html>`;
}
