import { parseTerms } from '/grants-server/terms.js';
/* =====================================================================
   Toirem Grants – shared page pieces: fields, signature styles, the submitted
   application and the grant agreement, and calls to /api/grants.
   ===================================================================== */

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const today = () => new Date().toISOString().slice(0, 10);
export const fmtD = (d) => (d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDT = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');

export const SIG_FONTS = [['Dancing Script', 'Flowing'], ['Great Vibes', 'Formal'], ['Allura', 'Elegant'], ['Homemade Apple', 'Handwritten'], ['Caveat', 'Casual'], ['Kalam', 'Neat print']];
export const sigFont = (f) => `"${f}","Brush Script MT",cursive`;

/* ---------- talking to the server ---------- */
async function call(path, opts) {
  let res;
  try { res = await fetch('/api/grants/' + path, opts); }
  catch (e) { return { ok: false, message: 'Cannot reach Toirem right now. Check your internet connection and try again.' }; }
  const data = await res.json().catch(() => null);
  if (!data) {
    const type = (res.headers.get('content-type') || '').split(';')[0];
    console.warn('Toirem Grants: unexpected reply from /api/grants/' + path, res.status, type, res.url);
    return { ok: false, message: "Toirem's server didn't answer properly. Please try again in a minute. (Reply " + res.status + (type ? ', ' + type : '') + (res.redirected ? ', redirected' : '') + ')' };
  }
  if (!res.ok && data.ok === undefined) return { ok: false, message: 'Something went wrong. Please try again.' };
  return data;
}
export const postJSON = (path, body, headers = {}) =>
  call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
export const getJSON = (path, headers = {}) => call(path, { headers });
export const postForm = (path, formData) => call(path, { method: 'POST', body: formData });

/* ---------- page frame ---------- */
export function frame(title, count, body) {
  return `<div class="head"><h1>${esc(title)}</h1>${count != null ? `<div class="count">${count}</div>` : ''}</div><div class="rule"></div>${body}`;
}
export const notice = (kind, html) => `<div class="status ${kind}" role="${kind === 'bad' ? 'alert' : 'status'}">${html}</div>`;

/* ---------- fields (errs = object of messages keyed by field id) ---------- */
export function field(id, label, val, { type = 'text', req = true, ro = false, ph = '', full = false, opt = false, area = false, errs = {} } = {}) {
  const e = errs[id];
  const ctl = area
    ? `<textarea id="${id}" data-k="${id}" ${ro ? 'readonly' : ''} placeholder="${esc(ph)}">${esc(val)}</textarea>`
    : `<input id="${id}" data-k="${id}" type="${type}" value="${esc(val)}" ${ro ? 'readonly tabindex="-1"' : ''} placeholder="${esc(ph)}">`;
  return `<label class="f ${full ? 'full' : ''} ${e ? 'invalid' : ''}" for="${id}"><span class="lab">${esc(label)}${req && !ro ? ' <span class="req">*</span>' : ''}${opt ? ' <span class="opt">(optional)</span>' : ''}</span>${ctl}${e ? `<span class="err">${esc(e)}</span>` : ''}</label>`;
}
export function select(id, label, val, options, { req = true, errs = {}, placeholder = 'Select', full = false } = {}) {
  const e = errs[id];
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return `<label class="f ${full ? 'full' : ''} ${e ? 'invalid' : ''}" for="${id}"><span class="lab">${esc(label)}${req ? ' <span class="req">*</span>' : ''}</span>
    <select id="${id}" data-k="${id}"><option value="">${esc(placeholder)}</option>${opts.map((o) => `<option value="${esc(o.value)}" ${val === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${e ? `<span class="err">${esc(e)}</span>` : ''}</label>`;
}
export const radio = (name, value, checked, text) =>
  `<label class="radio"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span></span>${text}</label>`;
export function fileField(id, label, chosen, hint, { multiple = false, errs = {}, errKey = id } = {}) {
  const e = errs[errKey];
  return `<label class="f full ${e ? 'invalid' : ''}" for="${id}"><span class="lab">${esc(label)} <span class="req">*</span></span>
    <input type="file" id="${id}" ${multiple ? 'multiple' : ''} accept=".pdf,.jpg,.jpeg,.png">
    <span class="files">${chosen.length ? chosen.map((n) => '✓ ' + esc(n)).join('<br>') : esc(hint)}</span>${e ? `<span class="err">${esc(e)}</span>` : ''}</label>`;
}
export function sigPicker(name, current, text) {
  return `<div class="f" style="margin-top:20px"><span class="lab">Choose a signature style</span><div class="sigs" role="radiogroup">${SIG_FONTS.map(([f, n]) =>
    `<label class="sigopt"><input type="radio" name="${name}" value="${f}" ${current === f ? 'checked' : ''}><span class="sp" style='font-family:${sigFont(f)}'>${esc(text || 'Your name')}</span><small>${n}</small></label>`).join('')}</div></div>`;
}

const PILL = {
  'New application': 'p-new', 'Breakdown to review': 'p-new', 'Agreement to send': 'p-wait', 'Awaiting signature': 'p-wait',
  'Breakdown requested': 'p-wait', 'Proof requested': 'p-wait', 'Receipts due': 'p-wait', Approved: 'p-ok', Active: 'p-ok',
  'Fully paid': 'p-grey', 'Needs attention': 'p-bad',
};
export const pill = (status) => `<span class="pill ${PILL[status] || 'p-grey'}">${esc(status)}</span>`;

/* ---------- the submitted application (office view) ---------- */
/** The submitted individual application, for the office. */
export function renderIndividual(a) {
  const f = a.form, P = f.person, F = f.family, G = f.grant, B = f.bank || {}, N = f.endorser, C = f.confirm;
  const dl = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v == null || v === '' ? '—' : v)}</dd></div>`).join('')}</dl>`;
  return `<h2 style="margin-top:0">1) Contact information</h2>${dl([['Name', [P.title, P.first, P.last].filter(Boolean).join(' ')], ['Address', [P.address, P.town, P.postcode].filter(Boolean).join(', ')], ['Phone', P.phone], ['Email', P.email]])}
  <h2>2–5) Family and finances</h2>${dl([['Marital status', F.status], ['Dependent children', F.children === 'yes' ? 'Yes – ' + F.childrenCount : 'No'], ['Monthly income per person', F.income], ['State benefits', F.benefits === 'yes' ? 'Yes – ' + F.benefitsAmount : 'No']])}
  <h2>6–7) Grant requested</h2>${dl([['Purpose', G.purposes.map((x) => (x === 'Other' ? 'Other: ' + G.other : x)).join(', ')], ['Amount', money(G.amount) + ' · ' + G.frequency], ['Comments', G.comments]])}
  <h2>8) Payment</h2>${dl([['Method', f.method], ...(f.method === 'Bank transfer' ? [['Account name', B.acname], ['Sort code', B.sort], ['Account number', B.acno]] : [])])}
  <h2>9) Endorser</h2>${dl([['Name', N.name], ['Position', N.position], ['Phone', N.phone], ['Email', N.email], ['Address', [N.address, N.town, N.postcode].filter(Boolean).join(', ')]])}
  <h2>10) Confirmation</h2>${dl([['Name', C.name], ['Date', fmtD(C.date)]])}<div class="sign" style='margin-top:6px;font-family:${sigFont(C.font)}'>${esc(C.sign)}</div>`;
}

export function renderApplication(a) {
  const f = a.form, c = a.cc_check, ap = f.app, b = f.bank, g = f.grant;
  const sup = !a.registered && a.route === 'supplier';
  const dl = (pairs) => `<dl>${pairs.map(([k, v, full]) => `<div ${full ? 'style="grid-column:1/-1"' : ''}><dt>${esc(k)}</dt><dd>${v || v === 0 ? esc(v) : '—'}</dd></div>`).join('')}</dl>`;
  const orgPhone = c ? c.phone : f.org.phone, orgEmail = c ? c.email : f.org.email;
  const pos = ap.position === 'Other' ? ap.positionOther : ap.position;
  const role = (t) => (t.role === 'Other' ? t.other : t.role);
  let h = `<div class="sv"><h2>1) Organisation main or registered address and contact details</h2>${dl(c ? [
    ["Organisation's legal name", c.name], ['Registered charity number', c.number], ['Date of registration', fmtD(c.regDate)],
    ['Full address', c.address.lines.join(', ')], ['City / Town', c.address.town], ['Postcode', c.address.postcode],
    ['Phone', c.phone], ['Email', c.email], ...c.trustees.map((t, i) => ['Trustee ' + (i + 1), t]),
  ] : [
    ['Organisation / club name', f.org.name], ['Registered charity', 'No'], ['Full address', f.org.line1], ['City / Town', f.org.town],
    ['Postcode', f.org.postcode], ['Phone', f.org.phone], ['Email', f.org.email],
    ['Payment route', sup ? 'Toirem pays supplier directly' : 'Paid into club account'],
    ...f.trustees.map((t, i) => ['Trustee ' + (i + 1), `${t.name} (${role(t)})`]),
  ])}
  ${a.details_incorrect != null ? `<div class="status warn" style="margin-top:14px">Applicant reports register details are incorrect: ${esc(a.details_incorrect)}</div>` : ''}
  <h2>2) Contact details of the person completing this form / main applicant</h2>${dl([['Title', ap.title], ['First name', ap.first], ['Last name', ap.last], ['Position in organisation', pos],
    ['Phone', ap.same ? orgPhone : ap.phone], ['Mobile', ap.same ? '' : ap.mobile], ['Email', ap.same ? orgEmail : ap.email]])}
  <h2>3) ${sup ? "Supplier's bank account details" : 'Bank account details'}</h2>${dl([['Bank / Building Society', b.bank], ['Name on Account', b.acname], ['Sort Code', b.sort], ['Account Number', b.acno]])}
  <h2>4) Grant information</h2>${dl([['How much does the activity cost in total?', money(g.cost), true], ['Estimated donations from Toirem for the year (1 January – 31 December)', money(g.annual), true], ['How the funds will be used', g.use, true]])}
  <h2>5) Confirmation</h2>${dl([['Name', [ap.title, ap.first, ap.last].filter(Boolean).join(' ')], ['Date signed', fmtD(g.date)]])}
  <div class="sign" style='margin-top:12px;font-family:${sigFont(g.font)}'>${esc(g.sign)}</div>`;
  if (c) {
    h += `<div class="office"><h3>For office use only · Charity Commission check</h3><div class="stamp">Checked automatically ${esc(fmtDT(a.cc_checked_at))}</div>
    ${c.warnings.length ? `<div class="status bad" style="margin-bottom:12px">${c.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="tbl"><table><tbody>
      <tr><td>Registered with Charity Commission</td><td>${c.registered ? `<span class="yn">Yes</span> since ${fmtD(c.regDate)}` : `No (removed ${fmtD(c.removedOn)})`}</td></tr>
      ${c.finances.map((x) => `<tr><td>Income / spending, year to ${fmtD(x.yearEnd)}</td><td>${money(x.income)} / ${money(x.spending)}</td></tr>`).join('')}
      <tr><td>Accounts filed?</td><td>${c.accounts.overdue ? `Overdue (due ${fmtD(c.accounts.dueDate)})` : `<span class="yn">Yes</span> received ${fmtD(c.accounts.lastReceived)}`}${c.accountsPageUrl ? ` · <a href="${esc(c.accountsPageUrl)}" target="_blank" rel="noreferrer">Open accounts on register</a>` : ''}</td></tr>
      <tr><td>Annual return</td><td>${c.annualReturn.overdue ? 'Overdue' : 'Received ' + fmtD(c.annualReturn.lastReceived)}</td></tr>
      <tr><td>Inquiries / regulatory reports</td><td>${c.regulatoryReports.length ? c.regulatoryReports.map((r) => (r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.title)}</a>` : esc(r.title)) + (r.published ? ` (${fmtD(r.published)})` : '')).join('<br>') : 'None published'}</td></tr>
      <tr><td>Charitable objects</td><td>${esc(c.objects || '—')}</td></tr>
      <tr><td>Activities (how funds are spent)</td><td>${esc(c.activities || '—')}</td></tr>
      <tr><td>Date trustee approved</td><td>${fmtD(a.approved_on)}</td></tr>
    </tbody></table></div></div>`;
  } else {
    h += `<div class="office"><h3>For office use only</h3><div class="stamp">Not a registered charity · no Charity Commission data</div>
    <div class="tbl"><table><tbody>
      <tr><td>Payment route</td><td>${sup || a.route_override ? 'Pay suppliers directly; invoice is sufficient' : 'Paid to club; receipts and bank confirmation requested after payment'}</td></tr>
      <tr><td>Date trustee approved</td><td>${fmtD(a.approved_on)}</td></tr>
    </tbody></table></div></div>`;
  }
  return h + '</div>';
}

/* ---------- the grant agreement ---------- */
/** "Payments made" on the agreement: every payment so far, the total and what is left. */
function paymentsMade(a) {
  const P = a.payments || [];
  const paid = P.reduce((s, p) => s + p.amount, 0);
  return `<h4 style="margin-top:26px">PAYMENTS MADE</h4>
  ${P.length ? `<table class="det"><tbody>
    <tr><td>Date paid</td><td style="font-weight:700;color:#2b3a67;text-align:right">Amount</td></tr>
    ${P.map((p) => `<tr><td style="font-weight:400;color:inherit">${fmtD(p.date)}</td><td style="text-align:right">${money(p.amount)}</td></tr>`).join('')}
    <tr><td>Total paid</td><td style="text-align:right;font-weight:700">${money(paid)}</td></tr>
  </tbody></table>` : '<p>No payments have been made yet.</p>'}`;
}

export function renderAgreement(a) {
  const r = a.recipient;
  const bankUsed = a.method === 'Bank transfer' || a.method === 'Paid direct to supplier';
  const C = (n, html) => `<li><span>${n}</span><div>${html}</div></li>`;
  return `<div class="agree">
  <img src="/grants/img/toirem-letterhead.jpg" alt="Toirem letterhead: Charity Number 1206622, 24 Darenth Rd, London, N16 6EJ">
  <table class="det"><tbody>
    <tr><td>Recipient Name</td><td>${esc(a.recipientName)}</td></tr>
    <tr><td>Recipient Address</td><td>${esc(a.recipientAddress)}</td></tr>
    <tr><td>Grant Reference</td><td>${esc(a.ref)}</td></tr>
    <tr><td>Grant Amount</td><td>${money(a.amount)}</td></tr>
    <tr><td>Purpose of Grant</td><td>${esc(a.purpose)}</td></tr>
    <tr><td>Payment Method</td><td>${esc(a.method)}</td></tr>
    <tr><td>Date of Agreement</td><td>${fmtD(a.toirem.date)}</td></tr>
  </tbody></table>
  ${parseTerms(a.terms, a.recipientName).map((x) => x.h ? `<h4>${esc(x.h)}</h4>`
      : x.bullets ? `<ol>${C(x.n, esc(x.text) + (x.bullets.length ? `<ul>${x.bullets.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''))}</ol>`
      : `<p>${esc(x.p)}</p>`).join('')}
  ${a.extra ? `<h4>ADDITIONAL CONDITIONS</h4><p style="white-space:pre-wrap;margin:0">${esc(a.extra)}</p>` : ''}
  <div class="sigs2">
    <div><b>Signed on behalf of Toirem (CIO Foundation)</b>
      <span>Name: <span class="sigline">${esc(a.toirem.name || '—')}</span></span>
      <span>Position: <span class="sigline">${esc(a.toirem.position || '—')}</span></span>
      <span>Date: <span class="sigline">${fmtD(a.toirem.date)}</span></span></div>
    <div><b>Accepted by the Recipient</b>
      <span>Name: <span class="sigline" id="agName">${r ? esc(r.name) : ''}</span></span>
      <span>Signature:</span><div class="sigline script" id="agSig" ${r ? `style='font-family:${sigFont(r.font)}'` : ''}>${r ? esc(r.name) : ''}</div>
      <span>Date: <span class="sigline" id="agDate">${r ? fmtD(r.date) : ''}</span></span></div>
  </div>
  <h4 style="margin-top:26px">PAYMENT DETAILS${bankUsed ? '' : ' (not used for this payment method)'}</h4>
  <table class="det"><tbody>
    <tr><td>Account Name</td><td>${esc(a.bank.acname)}</td></tr>
    <tr><td>Bank Name</td><td>${esc(a.bank.bank)}</td></tr>
    <tr><td>Sort Code</td><td>${esc(a.bank.sort)}</td></tr>
    <tr><td>Account Number</td><td>${esc(a.bank.acno)}</td></tr>
    <tr><td>Reference</td><td>${esc(a.ref)}</td></tr>
  </tbody></table>
  ${paymentsMade(a)}</div>`;
}
