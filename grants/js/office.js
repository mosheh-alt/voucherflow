/* =====================================================================
   Toirem Grants – the Grants Office (signed-in grants staff only).
   #            all grants
   #grant/<id>  one grant: approve, agreement, payments, club receipts, monitoring
   ===================================================================== */
import { $, $$, esc, money, fmtD, today, notice, field, select, pill, renderApplication, renderAgreement, getJSON, postJSON } from './ui.js';
import { signIn, signOut, signedIn, email, authHeader } from './session.js';
import { suggestProofLines, paymentsInPeriod } from '/grants-server/rules.js';
import { renderIndividual } from './ui.js';

const METHODS = ['Bank transfer', 'Prepaid card', 'Paid direct to supplier'];
const FILE_KIND = { id_document: 'ID', benefits_letter: 'Benefits letter', donation_receipt: 'Donation receipt', bank_proof: 'Proof of bank', invoice: 'Invoice', breakdown_proof: 'Proof of spending', receipt: 'Receipt', bank_confirmation: 'Bank confirmation' };
/** Year picker (1 January – 31 December) plus custom dates, and an amount box when nothing is recorded in the period. */
function periodBlock(p, a, inP) {
  const thisYear = new Date().getFullYear();
  const years = []; for (let y = thisYear; y >= thisYear - 4; y--) years.push(String(y));
  const yr = O[p + 'Year'] || String(thisYear);
  const recorded = inP.reduce((s, x) => s + x.amount, 0);
  const platform = a.source === 'import' && a.imported && Number(a.imported.redeemed) > 0 ? Number(a.imported.redeemed) : null;
  return `<div class="grid" style="margin-top:10px">
      ${select(p + '.year', 'Year (1 January – 31 December)', yr, [...years, 'Custom dates'])}
      ${field(p + '.email', 'Send to email', O[p + 'Email'] ?? (a.applicant_email || ''), { type: 'email' })}
      ${yr === 'Custom dates' ? field(p + '.from', 'From', O[p === 'bd' ? 'from' : 'rcFrom'], { type: 'date' }) + field(p + '.to', 'To', O[p === 'bd' ? 'to' : 'rcTo'], { type: 'date' }) : ''}
      ${inP.length ? '' : field(p + '.amount', 'Amount paid in this period (£)', O[p + 'Amount'] ?? (platform != null ? platform : ''), { type: 'number', ph: 'No payments recorded – enter the amount' })}
    </div>
    <p class="note">${inP.length ? `${inP.length} payment(s) recorded in this period, ${money(recorded)} in total.` : `No payments recorded here for this period${platform != null ? `; ${money(platform)} was paid through the platform (filled in above – change it if needed)` : ''}.`}</p>`;
}
const periodOf = (p) => {
  const yr = O[p + 'Year'] || String(new Date().getFullYear());
  if (yr !== 'Custom dates') return [yr + '-01-01', yr + '-12-31'];
  return p === 'bd' ? [O.from, O.to] : [O.rcFrom, O.rcTo];
};
const yearAgo = () => new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);

let LIST = null, FILTER = 'all', D = null, SIGNATORIES = null, FLASH = null, BUSY = false;
let O = {}; // form state on the grant page
const app = () => $('#app');
const toplinks = () => null;
/** Page header in the Toirem Management style. */
const frame = (title, right, body) => `<div class="mhead"><h1>${esc(title)}</h1>${right ? `<div class="mright">${right}</div>` : ''}</div>${body}`;
function shell(on) {
  $('#login').hidden = on; $('#shell').hidden = !on;
  const w = $('#who'); if (w) w.textContent = email() || '';
}

/* ---------- api with sign-in ---------- */
async function api(path, body) {
  const h = await authHeader();
  const r = body === undefined ? await getJSON('office/' + path, h) : await postJSON('office/' + path, body, h);
  if (r.signIn && /have access/.test(r.message || '')) {
    app().innerHTML = frame('Compliance', null, notice('warn', esc(r.message) + ' Ask the administrator to add you to the grants staff list.'));
    throw new Error('signed out');
  }
  if (r.signIn) { signOut(); showSignIn(r.message); throw new Error('signed out'); }
  return r;
}

/* ---------- sign in ---------- */
function showSignIn(msg) {
  shell(false);
  $('#loginMsg').textContent = msg || '';
  setTimeout(() => $('#lEmail').focus(), 50);
}
$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#loginGo').disabled = true; $('#loginMsg').textContent = '';
  try { await signIn($('#lEmail').value, $('#lPass').value); $('#lPass').value = ''; route(); }
  catch (e) { $('#loginMsg').textContent = e.message; }
  finally { $('#loginGo').disabled = false; }
});
$('#signout').addEventListener('click', () => { signOut(); showSignIn(); });

/* ---------- routing ---------- */
async function route() {
  if (!signedIn()) return showSignIn();
  shell(true);
  const onInbox = location.hash === '#inbox';
  const onInd = location.hash === '#individuals' || (D && D.grant && D.grant.kind === 'individual' && /^#grant\//.test(location.hash));
  const cur = (id, on) => { const el = document.getElementById(id); if (el) el.setAttribute('aria-current', on ? 'page' : 'false'); };
  cur('navGrants', !onInbox && !onInd); cur('navInd', !onInbox && onInd); cur('navInbox', onInbox);
  if (!onInbox) refreshUnread();
  const m = location.hash.match(/^#grant\/([\w-]+)/);
  try {
    if (location.hash === '#import') { renderImport(); return; }
    if (location.hash === '#bank') { await startBank(); return; }
    if (location.hash === '#inbox') { await startInbox(); return; }
    if (m) { await loadGrant(m[1]); renderGrant(); }
    else { await loadList(); renderList(); }
  } catch (e) { if (e.message !== 'signed out') { console.error('Grants office:', e); app().innerHTML = frame('Grant applications', null, notice('bad', 'Could not load. Check your connection and refresh the page.')); } }
}
window.addEventListener('hashchange', () => { FLASH = null; O = {}; route(); scrollTo(0, 0); });

/* ---------- list ---------- */
async function loadList() {
  app().innerHTML = frame('Grant applications', null, '<p class="loading">Loading grants…</p>'); bindTop();
  const r = await api('list');
  if (!r.ok) throw new Error(r.message);
  LIST = r;
}
const GROUPS = {
  all: () => true,
  new: (g) => g.status === 'New application' || g.status === 'Details to complete',
  agreements: (g) => /signature|Agreement to send/.test(g.status),
  monitoring: (g) => /requested|review|Receipts/.test(g.status),
  attention: (g) => g.status === 'Needs attention',
};
const INV = { email: '', name: '', note: '', msg: null, busy: false, form: 'apply' };
let SEARCH = '';
/** The list shows either charity grants (charities, clubs, community accounts) or individual grants. */
const listKind = () => (location.hash === '#individuals' ? 'individual' : 'charity');
const kindOf = (g) => (g.kind === 'individual' ? 'individual' : 'charity');
function renderList() {
  if (INV.formKindFor !== listKind()) { INV.form = listKind() === 'individual' ? 'individual' : 'apply'; INV.formKindFor = listKind(); }
  const IND = listKind() === 'individual';
  const gs = LIST.grants.filter((g) => kindOf(g) === listKind());
  const q = SEARCH.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = (g) => !q || [g.ref, g.orgName, g.charityNumber, g.beneficiaryId, g.status, g.kind === 'individual' ? 'individual' : g.kind === 'club' ? 'community club' : 'charity'].some((x) => String(x || '').toLowerCase().includes(q));
  const shown = gs.filter(GROUPS[FILTER]).filter(hit);
  const tile = (k, label) => `<button type="button" class="tile" data-filter="${k}" aria-pressed="${FILTER === k}"><b>${gs.filter(GROUPS[k]).length}</b><span>${label}</span></button>`;
  app().innerHTML = frame(IND ? 'Individual grants' : 'Charity grants', (IND
      ? `<a class="btn" href="/grants/individual.html#test" target="_blank" rel="noopener">Test the individual form ↗</a><a class="btn" href="/grants/individual.html" target="_blank" rel="noopener">Open individual form ↗</a>`
      : `<a class="btn" href="/grants/apply.html" target="_blank" rel="noopener">Open application form ↗</a>`) +
      `<a class="btn" href="#bank">Bank payments</a><a class="btn" href="#import">Import past grants</a>`, `
    <p class="note" style="margin-top:0">Grants of ${money(LIST.threshold)} or more need a signed agreement.</p>
    <div class="tiles">${tile('new', 'New applications')}${tile('agreements', 'Agreements outstanding')}${tile('monitoring', 'Monitoring due')}${tile('attention', 'Need attention')}</div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:22px 0 8px">
      <h2 style="margin:0">${FILTER === 'all' ? (IND ? 'All individual grants' : 'All charity and organisation grants') : 'Filtered grants'} ${FILTER !== 'all' ? '<button class="link" type="button" data-filter="all">Show all</button>' : ''}</h2>
      <span style="flex:1"></span>
      <input type="search" id="gSearch" value="${esc(SEARCH)}" placeholder="Search name, reference, charity number or status…" aria-label="Search grants" style="width:340px;max-width:100%">
    </div>
    ${q ? `<p class="note" style="margin-top:0">${shown.length} found for “${esc(SEARCH)}”.</p>` : ''}
    ${!shown.length ? `<p class="note">No grants here yet. New applications from <a href="/grants/apply.html">the application form</a> appear here and are emailed to you.</p>` : `
    <div class="tbl"><table class="list">
      <thead><tr><th>Ref</th><th>Organisation / person</th><th>Status</th><th class="num">Paid</th></tr></thead>
      <tbody>${shown.map((g) => `<tr class="click" data-open="${g.id}" tabindex="0">
        <td>${esc(g.ref)}</td><td><span class="org">${esc(g.orgName)}</span><br><span class="note">${g.kind === 'individual' ? 'Individual' + (g.beneficiaryId ? ' · ID ' + esc(g.beneficiaryId) : '') : g.kind === 'club' && g.imported ? 'Community account' : g.registered ? 'Charity ' + esc(g.charityNumber) : 'Club account'} · ${g.imported ? 'imported ' : ''}${fmtD(g.created)}</span></td>
        <td>${pill(g.status)}</td><td class="num">${g.paid ? money(g.paid) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>`}
    <div class="panel" id="invite"><h3>Send the application form</h3>
      <p class="note" style="margin-top:0">Email someone the link to apply, or copy the link to send it yourself (WhatsApp, text…).</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0 14px">
        <select id="formKind" aria-label="Which form" style="width:auto">${[['apply', 'Charity / organisation form'], ['individual', 'Individual form']].map(([v, l]) => `<option value="${v}" ${INV.form === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="formLink" readonly value="${esc(location.origin)}/grants/${INV.form === 'individual' ? 'individual' : 'apply'}.html" style="flex:1;min-width:220px" aria-label="Application form link">
        <button class="ghost small" type="button" id="copyLink">Copy link</button></div>
      <div class="grid">${field('inv.email', 'Email address', INV.email, { type: 'email' })}${field('inv.name', 'Name (optional)', INV.name, { ph: 'e.g. Rabbi Cohen' })}
        ${field('inv.note', 'Note to include (optional)', INV.note, { area: true, full: true })}</div>
      ${INV.msg ? `<div style="margin-top:10px">${notice(INV.msg.kind, esc(INV.msg.text))}</div>` : ''}
      <div class="actions"><button class="primary small" type="button" id="sendInvite" ${INV.busy ? 'disabled' : ''}>${INV.busy ? 'Sending…' : 'Email the application form'}</button></div></div>
    <div class="panel"><h3>Connections <button class="ghost small" type="button" id="diag">Check connections</button></h3>
      <div id="diagOut"><p class="note" style="margin:0">Tests the Charity Commission key, the Gmail mailer and the Cloudflare settings.</p></div></div>`);
  bindTop();
  $('#diag').addEventListener('click', async () => {
    $('#diag').disabled = true; $('#diagOut').innerHTML = '<p class="note" style="margin:0">Checking…</p>';
    let r; try { r = await api('diagnostics'); } catch (e) { return; }
    $('#diag').disabled = false;
    $('#diagOut').innerHTML = r.ok ? `<div class="checks">${r.checks.map((c) => notice(c.ok ? 'ok' : 'bad', `<b>${c.ok ? '✓' : '✗'} ${esc(c.name)}:</b> ${esc(c.detail)}`)).join('')}</div>` : notice('bad', esc(r.message || 'Could not run the check.'));
  });
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => { FILTER = FILTER === b.dataset.filter ? 'all' : b.dataset.filter; renderList(); }));
  const gsb = $('#gSearch');
  if (gsb) gsb.addEventListener('input', () => {
    SEARCH = gsb.value; const pos = gsb.selectionStart; renderList();
    const again = $('#gSearch'); again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* */ }
  });
  const keepInv = () => { INV.email = $('#inv\\.email').value; INV.name = $('#inv\\.name').value; INV.note = $('#inv\\.note').value; };
  $('#formKind').addEventListener('change', (e) => { keepInv(); INV.form = e.target.value; renderList(); });
  $('#copyLink').addEventListener('click', async () => {
    const box = $('#formLink');
    try { await navigator.clipboard.writeText(box.value); $('#copyLink').textContent = 'Copied ✓'; }
    catch (e) { box.select(); $('#copyLink').textContent = 'Press Ctrl+C'; }
    setTimeout(() => { const b = $('#copyLink'); if (b) b.textContent = 'Copy link'; }, 2500);
  });
  $('#sendInvite').addEventListener('click', async () => {
    keepInv(); INV.busy = true; INV.msg = null; renderList();
    let r; try { r = await api('invite', { email: INV.email, name: INV.name, note: INV.note, form: INV.form }); } catch (e) { INV.busy = false; return; }
    INV.busy = false;
    if (r.ok) { INV.msg = { kind: 'ok', text: 'Application form sent to ' + r.to + '.' }; INV.email = ''; INV.name = ''; INV.note = ''; }
    else INV.msg = { kind: 'bad', text: r.message };
    renderList(); document.getElementById('invite').scrollIntoView({ block: 'nearest' });
  });
  $$('[data-open]').forEach((tr) => {
    const go = () => { location.hash = 'grant/' + tr.dataset.open; };
    tr.addEventListener('click', go); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}
function bindTop() { /* sign-out lives in the side menu */ }

/* ---------- one grant ---------- */
async function loadGrant(id) {
  if (!D || D.grant.id !== id) app().innerHTML = frame('Grant applications', null, '<p class="loading">Loading grant…</p>');
  bindTop();
  const r = await api('grant', { id });
  if (!r.ok) throw new Error(r.message);
  D = r;
  const a = D.grant;
  O.purpose = O.purpose ?? (a.form.grant ? a.form.grant.use : a.purpose || '');
  O.completeTo = O.completeTo ?? (a.complete_sent_to || (a.cc_check && a.cc_check.email) || '');
  O.method = O.method || (!a.registered && a.route === 'supplier' ? 'Paid direct to supplier' : 'Bank transfer');
  O.apDate = O.apDate || today();
  O.payApproved = O.payApproved || today(); O.payDate = O.payDate || today();
  O.from = O.from || yearAgo(); O.to = O.to || today(); O.rcFrom = O.rcFrom || O.from; O.rcTo = O.rcTo || O.to;
  O.picked = O.picked || {};
  if (a.agreement && a.agreement.status === 'draft' && !SIGNATORIES) {
    api('signatories').then((s) => { SIGNATORIES = s.ok ? s.trustees : []; if (location.hash.includes(id)) renderGrant(); }).catch(() => {});
  }
}

function renderGrant() {
  const a = D.grant, t = D.threshold;
  { const ind0 = a.kind === 'individual'; const ng = document.getElementById('navGrants'), nd = document.getElementById('navInd');
    if (ng) ng.setAttribute('aria-current', ind0 ? 'false' : 'page'); if (nd) nd.setAttribute('aria-current', ind0 ? 'page' : 'false'); }
  const approved = a.approved_amount == null ? null : Number(a.approved_amount);
  const paid = a.payments.reduce((s, p) => s + Number(p.amount), 0);
  const needsAg = approved != null && approved >= t;
  const ag = a.agreement;
  const canPay = approved != null && (!needsAg || (ag && ag.status === 'signed'));
  const clubPaid = !a.registered && a.route === 'club' && !a.route_override;
  const open = a.breakdowns.find((b) => b.status !== 'closed');
  const ind = a.kind === 'individual';
  const full = ind ? !!a.form.person : !!a.form.app; // imported grants have no full form until it is completed
  const pos = full && !ind ? (a.form.app.position === 'Other' ? a.form.app.positionOther : a.form.app.position) : '';
  const imp = a.source === 'import' ? a.imported || {} : null;
  const chosen = (SIGNATORIES || []).find((s) => s.name === O.signatory);
  const B = BUSY ? 'disabled' : '';

  let h = `<p style="margin:0 0 14px"><a href="${a.kind === 'individual' ? '#individuals' : '#'}" class="back">← ${a.kind === 'individual' ? 'Individual grants' : 'Charity grants'}</a></p>
  ${FLASH ? `<div style="margin-bottom:12px">${notice(FLASH.kind, esc(FLASH.text))}</div>` : ''}
  ${a.alerts.map((x) => `<div class="status bad alert" style="margin-bottom:10px;justify-content:space-between;flex-wrap:wrap">
    <span><b>Alert</b> ${esc(x.message)} <span class="note">(${fmtD(x.created_at)})</span></span>
    <button class="ghost small" type="button" data-resolve="${x.id}" ${B}>Mark as dealt with</button></div>`).join('')}
  <dl class="kv">
    <div><dt>${imp ? 'Imported' : 'Submitted'}</dt><dd>${fmtD(a.created_at)}</dd></div>
    <div><dt>${ind ? 'Contact' : 'Applicant'}</dt><dd>${full ? `${esc(a.applicant_name)}${pos ? ', ' + esc(pos) : ''}<br><span class="note">${esc(a.applicant_email)}</span>` : 'Not completed yet'}</dd></div>
    <div><dt>${ind ? 'Requested' : 'Activity cost'}</dt><dd>${full ? (ind ? money(a.form.grant.amount) + ' · ' + esc(a.form.grant.frequency) : money(a.form.grant.cost)) : '—'}</dd></div>
    <div><dt>Type</dt><dd>${ind ? 'Individual' + (a.beneficiary_id ? ' · ID ' + esc(a.beneficiary_id) : '') : a.kind === 'club' && a.source === 'import' ? 'Community account' + (a.beneficiary_id ? ' · ID ' + esc(a.beneficiary_id) : '') : a.registered ? 'Registered charity ' + esc(a.charity_number) : 'Club account · ' + (clubPaid ? 'paid to club' : 'supplier paid directly')}</dd></div>
  </dl>
  ${a.form && a.form.test ? `<div style="margin:12px 0">${notice('warn', `<b>Test grant</b> made from the form's test mode. <button class="link" type="button" id="delTest" ${B}>Delete this test grant</button>`)}</div>` : ''}
  ${imp ? importedPanel(a, imp, B) : ''}
  ${full ? `<div class="actions"><button class="ghost small" type="button" id="toggleApp">${O.showApp ? 'Hide' : 'View'} submitted application</button>
    <button class="ghost small" type="button" id="pdf">Download PDF</button></div>
  ${O.showApp ? `<div class="panel">${ind ? renderIndividual(a) : renderApplication(a)}</div>` : ''}` : ''}
  ${D.files.length ? `<div class="panel"><h3>Documents</h3><ul style="margin:0;padding-left:18px">${D.files.map((f) =>
    `<li>${esc(FILE_KIND[f.kind] || f.kind)}: ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noreferrer">${esc(f.name)}</a>` : esc(f.name)}</li>`).join('')}</ul>
    <p class="note">Links work for 5 minutes. Refresh the page for fresh links.</p></div>` : ''}`;

  // approval
  if (approved == null) {
    h += `<div class="panel"><h3>Approve grant</h3>
    <div class="grid">
      ${field('ap.amount', 'Approved amount (£)', O.amount || '', { type: 'number' })}
      ${select('ap.method', 'Payment method', O.method, METHODS)}
      ${field('ap.date', 'Date trustees approved', O.apDate, { type: 'date' })}
      ${field('ap.purpose', 'Purpose of grant', O.purpose, { area: true, full: true })}
    </div>
    ${!a.registered && a.route === 'club' ? `<label class="tick" style="margin-top:14px"><input type="checkbox" id="ap.override" ${O.override ? 'checked' : ''}> Override: pay the suppliers' invoices directly instead of the club account</label>` : ''}
    <p class="note" style="margin-top:12px">From ${money(t)} a grant agreement is created for signing. Below that, the signed application is enough.</p>
    <div class="actions"><button class="primary" type="button" id="approve" ${B}>Approve grant</button></div></div>`;
  } else {
    h += `<div class="panel"><h3>Approval</h3><dl class="kv">
      <div><dt>Approved</dt><dd>${money(approved)}</dd></div><div><dt>Method</dt><dd>${esc(a.payment_method)}</dd></div>
      <div><dt>Trustees approved</dt><dd>${fmtD(a.approved_on)}</dd></div><div><dt>Agreement</dt><dd>${needsAg ? 'Required' : 'Not required (under ' + money(t) + ')'}</dd></div></dl>
      <p class="note" style="margin-top:10px">Purpose: ${esc(a.purpose)}</p>${a.route_override ? '<p class="note">Trustee override: suppliers are paid directly.</p>' : ''}</div>`;
  }

  // agreement
  if (needsAg && ag) {
    const label = ag.status === 'signed' ? `Signed ${fmtD(ag.signed_date)} by ${esc(ag.signed_name)}` : ag.status === 'sent' ? `Sent ${fmtD(ag.sent_on)}${ag.sent_to ? ' to ' + esc(ag.sent_to) : ''}, awaiting signature` : 'Ready to send';
    h += `<div class="panel"><h3>Grant agreement <span class="pill ${ag.status === 'signed' ? 'p-ok' : 'p-wait'}">${label}</span></h3>`;
    if (ag.status === 'draft') {
      h += `<p class="note" style="margin-top:0">Filled in from the application. Choose who signs for Toirem, check it, then send.</p>
      <div class="grid" style="margin-top:12px">
        ${select('ag.signatory', 'Signed for Toirem by', O.signatory || '', (SIGNATORIES || []).map((s) => s.name), { placeholder: SIGNATORIES ? 'Select a trustee' : 'Loading trustees…' })}
        ${field('ag.position', 'Position', chosen ? chosen.position : '', { ro: true })}
      </div><p class="note">Trustees as listed on the Charity Commission register for Toirem (1206622).</p>`;
    }
    if (ag.status !== 'signed' && O.editAg) {
      const E0 = D.agreement, ov = ag.overrides || {};
      const v = (k, def) => (O.ed && O.ed[k] != null ? O.ed[k] : def);
      h += `<div class="panel" style="margin:12px 0;background:#fafbfd"><h3 style="margin-top:0">Edit the agreement</h3>
        <p class="note" style="margin-top:0">Change anything below, then press Save. Leave a box empty to go back to the details from the application.
          The grant amount starts as the total paid so far, rounded up to whole pounds${E0.customAmount ? ' (<b>changed by hand on this agreement</b>; clear the box to go back to it)' : ''}.</p>
        <div class="grid">
          ${field('ed.recipientName', 'Recipient name', v('recipientName', E0.recipientName))}
          ${field('ed.amount', 'Grant amount (£)', v('amount', E0.amount), { type: 'number' })}
          ${field('ed.date', 'Date of agreement', v('date', ov.date || ''), { type: 'date' })}
          ${field('ed.recipientAddress', 'Recipient address', v('recipientAddress', E0.recipientAddress), { full: true })}
          ${field('ed.purpose', 'Purpose of grant', v('purpose', a.purpose || ''), { area: true, full: true })}
          ${select('ed.method', 'Payment method', v('method', E0.method), METHODS)}
          ${field('ed.bank_acname', 'Account name', v('bank_acname', E0.bank.acname || ''))}
          ${field('ed.bank_bank', 'Bank name', v('bank_bank', E0.bank.bank || ''))}
          ${field('ed.bank_sort', 'Sort code', v('bank_sort', E0.bank.sort || ''))}
          ${field('ed.bank_acno', 'Account number', v('bank_acno', E0.bank.acno || ''))}
          ${field('ed.extra', 'Additional conditions (optional – added after the terms)', v('extra', E0.extra || ''), { area: true, full: true, req: false })}
          ${field('ed.terms', 'Letter and terms', v('terms', E0.terms), { area: true, full: true })}
        </div>
        <p class="note" style="margin-top:4px">Layout: <code>## 1. HEADING</code> for a heading, <code>1.1 Text</code> for a clause, <code>- Text</code> for a bullet. <code>{recipient}</code> becomes the recipient's name.
          ${E0.customTerms ? '<b>This agreement has its own wording.</b>' : 'This agreement uses the standard wording.'}
          <button class="link" type="button" id="resetTerms">Put back the standard wording</button></p>
        <label class="tick" style="margin:6px 0 0"><input type="checkbox" id="ed.std" ${O.edStd ? 'checked' : ''}> Also make this the standard wording for new agreements</label>
        <div class="actions"><button class="primary small" type="button" id="saveAg" ${B}>Save changes</button><button class="ghost small" type="button" id="cancelEd">Cancel</button></div></div>`;
    }
    if (ag.status !== 'signed') {
      h += `<div class="grid" style="margin-top:12px">${field('ag.email', 'Send to email', O.agEmail ?? (ag.sent_to || a.applicant_email || ''), { type: 'email', full: true })}</div>
      <p class="note">${ag.status === 'sent' ? 'To send it to someone else, change the address and press Send again. The earlier link stops working.' : 'Filled in with the applicant’s email. Change it to send the agreement to someone else, such as another trustee.'}</p>`;
    }
    h += `<div class="actions"><button class="ghost small" type="button" id="toggleAg">${O.showAg ? 'Hide' : ag.status === 'signed' ? 'View' : 'Preview'} agreement</button>
      ${ag.status !== 'signed' && !O.editAg ? `<button class="ghost small" type="button" id="editAg" ${B}>Edit agreement</button>` : ''}
      ${ag.status !== 'signed' ? `<button class="ghost small" type="button" id="agPdf">Download PDF (draft)</button>` : ''}
      ${ag.status === 'draft' ? `<button class="primary small" type="button" id="sendAg" ${B || (!O.signatory ? 'disabled' : '')}>Send for signing</button>` : ''}
      ${ag.status === 'sent' ? `<button class="ghost small" type="button" id="sendAg" ${B}>Send again</button>` : ''}
      ${ag.status === 'signed' ? `<button class="primary small" type="button" id="agPdf">Download signed agreement</button>` : ''}</div>`;
    if (O.showAg) {
      const data = { ...D.agreement };
      if (ag.status === 'draft') data.toirem = { name: chosen ? chosen.name : null, position: chosen ? chosen.position : null, date: D.agreement.toirem.date || today() };
      h += `<div style="margin-top:14px">${renderAgreement(data)}</div>`;
    }
    h += '</div>';
  }

  // payments
  if (approved != null) {
    h += `<div class="panel"><h3>Payments <span class="note" style="margin:0">${money(paid)} paid of ${money(approved)} · ${money(approved - paid)} remaining</span></h3>
    ${a.payments.length ? `<div class="tbl"><table class="mini"><thead><tr><th>Paid on</th><th>Trustees approved</th><th>From</th><th class="num">Amount</th></tr></thead><tbody>
      ${a.payments.map((p) => `<tr><td>${fmtD(p.paid_on)}</td><td>${fmtD(p.trustees_approved_on)}</td>
        <td>${p.source === 'bank' ? `<span class="note">${esc(p.bank || 'Bank')}: ${esc(p.payee || '')}${p.reference ? ' · ' + esc(p.reference) : ''}</span>` : '<span class="note">Recorded here</span>'}</td>
        <td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="note" style="margin-top:0">No payments yet.</p>'}
    ${canPay && paid < approved - 0.005 ? `<div class="grid" style="margin-top:14px">
      ${field('pay.amount', 'Amount (£)', O.payAmount || '', { type: 'number' })}
      ${field('pay.approved', 'Trustees approved this payment on', O.payApproved, { type: 'date' })}
      ${field('pay.date', 'Paid on', O.payDate, { type: 'date' })}
    </div><div class="actions"><button class="primary small" type="button" id="recordPay" ${B}>Record payment</button></div>` : ''}
    ${!canPay ? '<p class="note">Payments open once the agreement is signed.</p>' : ''}</div>`;
  }

  // club receipts
  if (!a.registered && a.route === 'club' && a.invoice_receipts.length) {
    const st = (r, col) => (r[col] ? '✓ Received' : r.requested_at ? '<span class="pill p-wait">Due</span>' : 'After payment');
    h += `<div class="panel"><h3>Club invoices</h3><div class="tbl"><table class="mini"><thead><tr><th>Invoice</th><th>Receipt</th><th>Bank confirmation</th></tr></thead><tbody>
      ${a.invoice_receipts.map((r) => `<tr><td>${esc((r.invoice || {}).original_name)}</td><td>${st(r, 'receipt_file_id')}</td><td>${st(r, 'bank_confirmation_id')}</td></tr>`).join('')}</tbody></table></div>
      ${!a.route_override ? `<div class="actions"><button class="ghost small" type="button" id="override" ${B}>Pay suppliers directly from now on</button></div>` : ''}
      <p class="note">Reminders go out automatically every 14 days until everything is received.</p></div>`;
  }

  // monitoring (works with or without an agreement, and without payments recorded here)
  if (approved != null || a.payments.length) {
    h += '<div class="panel"><h3>Monitoring</h3>';
    if (!open) {
      const [bf, bt] = periodOf('bd');
      const inP = paymentsInPeriod(a.payments.map((p) => ({ paidOn: p.paid_on, amount: Number(p.amount) })), bf, bt);
      h += `<p class="note" style="margin-top:0">Ask the recipient for a breakdown of how the grant was used in a year (1 January – 31 December). No agreement is needed.</p>
      ${periodBlock('bd', a, inP)}
      <div class="actions"><button class="ghost small" type="button" id="bdPreview" ${BUSY ? 'disabled' : ''}>Preview email</button>
        <button class="primary small" type="button" id="reqBd" ${BUSY ? 'disabled' : ''}>Request breakdown</button></div>
      ${O.bdMail && O.bdMail.kind === 'breakdown' ? mailBox() : ''}`;
    } else {
      const lines = open.breakdown_lines || [];
      h += `<p class="note" style="margin-top:0">Breakdown for ${fmtD(open.period_from)} to ${fmtD(open.period_to)}, ${money(open.total_paid)} paid.</p>`;
      if (open.status === 'requested') {
        h += `<div style="margin-top:10px">${notice('warn', `Requested ${fmtD(open.requested_on)}. Waiting for the recipient; reminders go out every 14 days.`)}</div>`;
      } else {
        h += `<div class="tbl" style="margin-top:10px"><table class="mini"><thead><tr><th>${open.status === 'submitted' ? 'Ask for proof' : ''}</th><th>Spent on</th><th class="num">Amount</th><th>Proof</th></tr></thead><tbody>
          ${lines.map((l, i) => `<tr><td>${open.status === 'submitted' ? `<input type="checkbox" data-pick="${l.id}" ${O.picked[l.id] ? 'checked' : ''} aria-label="Ask for proof of line ${i + 1}" style="accent-color:var(--orange)">` : ''}</td>
            <td>${esc(l.description)}</td><td class="num">${money(l.amount)}</td><td>${l.proof_requested ? (l.proof_file_id ? '✓ Received' : '<span class="pill p-wait">Requested</span>') : '—'}</td></tr>`).join('')}
          <tr><td></td><td><b>Total reported</b></td><td class="num"><b>${money(lines.reduce((s, l) => s + Number(l.amount), 0))}</b></td><td></td></tr></tbody></table></div>`;
        if (open.status === 'submitted') h += `<p class="note">Proof is optional. Tick lines yourself or let the system suggest some.</p>
          <div class="actions"><button class="ghost small" type="button" id="suggest">Suggest random lines</button>
          <button class="primary small" type="button" id="reqProof" ${B}>Request proof for ticked lines</button>
          <button class="ghost small" type="button" id="closeBd" ${B}>Accept without proof</button></div>`;
        if (open.status === 'proof_requested' && lines.filter((l) => l.proof_requested).every((l) => l.proof_file_id))
          h += `<div class="actions"><button class="primary small" type="button" id="closeBd" ${B}>Mark monitoring complete</button></div>`;
      }
    }
    const closed = a.breakdowns.filter((b) => b.status === 'closed');
    if (closed.length) h += `<p class="note" style="margin-top:14px">Completed: ${closed.map((b) => `${fmtD(b.period_from)} to ${fmtD(b.period_to)} (${(b.breakdown_lines || []).filter((l) => l.proof_requested).length} line(s) proved)`).join('; ')}</p>`;
    h += '</div>';

    // donation receipts (charities and community accounts, not individuals)
    if (a.kind !== 'individual') {
    const RR = (a.receipt_requests || []).slice().sort((x, y) => String(y.requested_on).localeCompare(String(x.requested_on)));
    const [rf, rt] = periodOf('rc');
    const inR = paymentsInPeriod(a.payments.map((p) => ({ paidOn: p.paid_on, amount: Number(p.amount) })), rf, rt);
    const rcFiles = (r) => ((r.file_ids && r.file_ids.length) ? r.file_ids : r.file_id ? [r.file_id] : []).map((id) => D.files.find((f) => f.id === id)).filter(Boolean);
    h += `<div class="panel"><h3>Donation receipts</h3>
      <p class="note" style="margin-top:0">Ask the charity for a receipt for the donations Toirem paid in a period. They get a link to upload it, with reminders every 14 days.</p>
      ${RR.length ? `<div class="tbl"><table class="mini"><thead><tr><th>Period</th><th class="num">Amount</th><th>Requested</th><th>Receipt</th></tr></thead><tbody>
        ${RR.map((r) => `<tr><td>${fmtD(r.period_from)} – ${fmtD(r.period_to)}</td><td class="num">${money(r.total)}</td><td>${fmtD(r.requested_on)}${r.sent_to ? `<br><span class="note">${esc(r.sent_to)}</span>` : ''}</td>
          <td>${r.received_at ? `✓ Received ${fmtD(r.received_at.slice(0, 10))}<br>${rcFiles(r).map((f, i) => f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noreferrer">${esc(f.name)}</a>` : esc(f.name)).join('<br>')}` : '<span class="pill p-wait">Waiting</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
      ${periodBlock('rc', a, inR)}
      <div class="actions"><button class="ghost small" type="button" id="rcPreview" ${BUSY ? 'disabled' : ''}>Preview email</button>
        <button class="primary small" type="button" id="reqRc" ${BUSY ? 'disabled' : ''}>Request donation receipt</button></div>
      ${O.bdMail && O.bdMail.kind === 'receipt' ? mailBox() : ''}</div>`;
    }
  }

  app().innerHTML = frame(a.org_name, `<span class="mref">${esc(a.ref)}</span>${pill(D.status)}`, h);
  bindGrant(open);
}

const mailBox = () => `<div style="margin-top:14px;border:1px solid var(--line);border-radius:8px;overflow:hidden">
        <div style="background:#f1f3f8;padding:10px 14px;font-size:13.5px"><b>${O.bdMail.kind === 'receipt' ? 'Donation receipt request' : 'Breakdown request'}</b><br><b>To:</b> ${esc(O.bdMail.to || '—')}<br><b>Subject:</b> ${esc(O.bdMail.subject)}</div>
        <div style="padding:18px;background:#fff">${O.bdMail.html}</div>
        <div class="actions" style="padding:0 14px 14px"><button class="ghost small" type="button" id="bdPdf">Download as PDF</button><button class="ghost small" type="button" id="bdClose">Close preview</button>
          <span class="note">The button in the real email opens the recipient's own upload page.</span></div></div>`;

function keep() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const set = (k, id) => { const x = v(id); if (x !== undefined) O[k] = x; };
  set('amount', 'ap.amount'); set('method', 'ap.method'); set('apDate', 'ap.date'); set('purpose', 'ap.purpose');
  const ov = document.getElementById('ap.override'); if (ov) O.override = ov.checked;
  set('signatory', 'ag.signatory'); set('payAmount', 'pay.amount'); set('payApproved', 'pay.approved'); set('payDate', 'pay.date');
  set('from', 'bd.from'); set('to', 'bd.to'); set('rcFrom', 'rc.from'); set('rcTo', 'rc.to'); set('rcEmail', 'rc.email');
  set('bdYear', 'bd.year'); set('rcYear', 'rc.year'); set('bdEmail', 'bd.email'); set('bdAmount', 'bd.amount'); set('rcAmount', 'rc.amount'); set('completeTo', 'cmp.email'); set('agEmail', 'ag.email');
  const stdBox = document.getElementById('ed.std'); if (stdBox) O.edStd = stdBox.checked;
  if (O.editAg) { O.ed = O.ed || {}; for (const k of ['recipientName', 'amount', 'date', 'recipientAddress', 'purpose', 'method', 'bank_acname', 'bank_bank', 'bank_sort', 'bank_acno', 'extra', 'terms']) { const el = document.getElementById('ed.' + k); if (el) O.ed[k] = el.value; } }
}

async function act(path, body, okText, after) {
  keep(); BUSY = true; FLASH = null; renderGrant();
  let r;
  try { r = await api(path, body); } catch (e) { BUSY = false; return; }
  BUSY = false;
  if (!r.ok) { FLASH = { kind: 'bad', text: r.message || 'Something went wrong.' }; renderGrant(); return; }
  FLASH = { kind: 'ok', text: typeof okText === 'function' ? okText(r) : okText };
  if (after) after();
  await loadGrant(D.grant.id); renderGrant();
}

function bindGrant(open) {
  bindTop();
  const id = D.grant.id;
  const on = (sel, fn, ev = 'click') => { const el = document.getElementById(sel); if (el) el.addEventListener(ev, fn); };
  $$('input,select,textarea', app()).forEach((el) => el.addEventListener('change', keep));
  on('toggleApp', () => { keep(); O.showApp = !O.showApp; renderGrant(); });
  on('delTest', async () => {
    if (!O.confirmDel) { O.confirmDel = true; FLASH = { kind: 'warn', text: 'Press “Delete this test grant” again to delete it.' }; renderGrant(); return; }
    let r; try { r = await api('delete-test', { id }); } catch (e) { return; }
    if (r.ok) { LIST = null; location.hash = ''; } else { FLASH = { kind: 'bad', text: r.message }; renderGrant(); }
  });
  on('sendComplete', () => { keep(); act('send-completion', { id, email: O.completeTo }, `Pre-filled form sent to ${O.completeTo}.`); });
  const download = async (btnId, url, label, fallbackName, body) => {
    const b = document.getElementById(btnId); b.disabled = true; b.textContent = 'Preparing PDF…';
    try {
      const res = await fetch(url, body ? { method: 'POST', headers: { ...(await authHeader()), 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: await authHeader() });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('pdf')) {
        const j = await res.json().catch(() => ({}));
        FLASH = { kind: 'bad', text: j.message || "The PDF couldn't be made. Please try again." }; renderGrant(); return;
      }
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = href; a.download = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallbackName;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 10000);
      b.disabled = false; b.textContent = label;
    } catch (e) { FLASH = { kind: 'bad', text: "The PDF couldn't be made. Check your connection and try again." }; renderGrant(); }
  };
  on('pdf', () => download('pdf', '/api/grants/office/pdf/' + id, 'Download PDF', D.grant.ref + '.pdf'));
  on('agPdf', () => {
    const signed = D.grant.agreement && D.grant.agreement.status === 'signed';
    if (signed) download('agPdf', '/api/grants/office/agreement-pdf/' + id, 'Download signed agreement', D.grant.ref + ' Grant Agreement.pdf');
    else { keep(); download('agPdf', '/api/grants/office/agreement-pdf/' + id, 'Download PDF (draft)', D.grant.ref + ' Grant Agreement DRAFT.pdf', { signatory: O.signatory || '' }); }
  });
  on('bdPreview', async () => {
    keep();
    const b = document.getElementById('bdPreview'); b.disabled = true; b.textContent = 'Loading preview…';
    let r; try { r = await api('email-preview', { ...{ id, from: periodOf('bd')[0], to: periodOf('bd')[1], amount: O.bdAmount, email: O.bdEmail }, kind: 'breakdown' }); } catch (e) { return; }
    if (!r.ok) { FLASH = { kind: 'bad', text: r.message }; renderGrant(); return; }
    O.bdMail = { ...r, kind: 'breakdown' }; renderGrant();
  });
  on('bdClose', () => { O.bdMail = null; renderGrant(); });
  on('bdPdf', () => { keep(); const k = O.bdMail.kind; download('bdPdf', '/api/grants/office/email-pdf', 'Download as PDF', D.grant.ref + (k === 'receipt' ? ' Receipt request.pdf' : ' Breakdown request.pdf'), k === 'receipt' ? { ...{ id, from: periodOf('rc')[0], to: periodOf('rc')[1], amount: O.rcAmount, email: O.rcEmail }, kind: k } : { ...{ id, from: periodOf('bd')[0], to: periodOf('bd')[1], amount: O.bdAmount, email: O.bdEmail }, kind: k }); });
  on('rcPreview', async () => {
    keep();
    const b = document.getElementById('rcPreview'); b.disabled = true; b.textContent = 'Loading preview…';
    let r; try { r = await api('email-preview', { ...{ id, from: periodOf('rc')[0], to: periodOf('rc')[1], amount: O.rcAmount, email: O.rcEmail }, kind: 'receipt' }); } catch (e) { return; }
    if (!r.ok) { FLASH = { kind: 'bad', text: r.message }; renderGrant(); return; }
    O.bdMail = { ...r, kind: 'receipt' }; renderGrant();
  });
  on('reqRc', () => { keep(); act('request-receipt', { id, from: periodOf('rc')[0], to: periodOf('rc')[1], amount: O.rcAmount, email: O.rcEmail }, (r) => `Donation receipt requested from ${r.to}.`, () => { O.bdMail = null; }); });
  on('toggleAg', () => { keep(); O.showAg = !O.showAg; renderGrant(); });
  on('editAg', () => { keep(); O.editAg = true; O.ed = null; renderGrant(); });
  on('cancelEd', () => { O.editAg = false; O.ed = null; renderGrant(); });
  on('saveAg', () => { keep(); const fields = { ...O.ed }; act('agreement-edit', { id, fields, saveStandard: !!O.edStd }, O.edStd ? 'Agreement updated, and its wording is now the standard for new agreements.' : 'Agreement updated.', () => { O.editAg = false; O.ed = null; O.edStd = false; }); });
  on('resetTerms', () => { keep(); O.ed = { ...(O.ed || {}), terms: D.standardTerms }; renderGrant(); });
  const tb = document.getElementById('ed.terms'); if (tb) { tb.rows = 26; tb.style.fontFamily = 'ui-monospace,Consolas,monospace'; tb.style.fontSize = '13px'; }
  on('ag.signatory', () => { keep(); renderGrant(); }, 'change');
  on('bd.from', () => { keep(); O.bdMail = null; renderGrant(); }, 'change');
  on('bd.to', () => { keep(); O.bdMail = null; renderGrant(); }, 'change');
  on('rc.from', () => { keep(); O.bdMail = null; renderGrant(); }, 'change');
  ['bd.year', 'rc.year'].forEach((x) => on(x, () => { keep(); O.bdMail = null; renderGrant(); }, 'change'));
  on('rc.to', () => { keep(); O.bdMail = null; renderGrant(); }, 'change');
  $$('[data-resolve]').forEach((b) => b.addEventListener('click', () => act('resolve-alert', { alertId: b.dataset.resolve }, 'Alert marked as dealt with.')));
  on('approve', () => { keep(); act('approve', { id, amount: Number(O.amount), method: O.method, approvedOn: O.apDate, purpose: O.purpose, override: !!O.override },
    (r) => (r.agreementNeeded ? 'Approved. The grant agreement is ready to check and send.' : 'Approved. No agreement needed; record payments when trustees approve them.')); });
  on('sendAg', () => { keep(); act('send-agreement', { id, signatory: O.signatory, email: O.agEmail ?? (D.grant.agreement.sent_to || D.grant.applicant_email) }, (r) => `Agreement sent to ${r.to}. They've been emailed a link to sign.`); });
  on('recordPay', () => { keep(); act('payment', { id, amount: Number(O.payAmount), paidOn: O.payDate, approvedOn: O.payApproved },
    (r) => `Payment of ${money(O.payAmount)} recorded.${r.receiptsRequested ? ' Receipt and bank confirmation requests sent.' : ''}`, () => { O.payAmount = ''; }); });
  on('override', () => act('override', { id }, 'Switched to paying suppliers directly. No receipts will be chased.'));
  on('reqBd', () => { keep(); act('request-breakdown', { id, from: periodOf('bd')[0], to: periodOf('bd')[1], amount: O.bdAmount, email: O.bdEmail }, (r) => `Breakdown requested from ${r.to}. They've been emailed a link.`, () => { O.bdMail = null; }); });
  $$('[data-pick]').forEach((cb) => cb.addEventListener('change', () => { O.picked[cb.dataset.pick] = cb.checked; }));
  if (open) {
    on('suggest', () => {
      const lines = open.breakdown_lines || [];
      const idx = suggestProofLines(lines.length);
      O.picked = Object.fromEntries(idx.map((i) => [lines[i].id, true]));
      FLASH = { kind: 'ok', text: `Suggested ${idx.length} line(s) at random. Change the ticks if you like.` }; renderGrant();
    });
    on('reqProof', () => act('request-proof', { breakdownId: open.id, lineIds: Object.keys(O.picked).filter((k) => O.picked[k]) }, 'Proof requested. The recipient has been emailed a link.', () => { O.picked = {}; }));
    on('closeBd', () => act('close-breakdown', { breakdownId: open.id }, 'Monitoring for this period is complete.'));
  }
}


/* ---------- imported past grant ---------- */
function importedPanel(a, imp, B) {
  const camps = imp.campaigns || [];
  const done = !!a.completed_at;
  const ind = a.kind === 'individual', club = a.kind === 'club';
  const docs = imp.docs || [], consent = imp.consent || [];
  // Bank check: the platform's paid amount against the bank payments recorded for this grant.
  const platform = Number(imp.redeemed) || 0;
  const banked = a.payments.reduce((s2, p) => s2 + Number(p.amount), 0);
  const diff = Math.round((platform - banked) * 100) / 100;
  const check = !platform ? '' : Math.abs(diff) < 0.01
    ? notice('ok', `<b>Bank payments match the platform:</b> ${money(banked)} paid.`)
    : banked === 0 ? notice('warn', `<b>No bank payments found yet</b> for the ${money(platform)} the platform says was paid. Upload your statements under <a href="#bank">Bank payments</a> to find them.`)
    : notice('warn', `<b>Bank payments ${money(banked)}</b> · platform ${money(platform)} · difference ${money(Math.abs(diff))} ${diff > 0 ? 'not yet found in the bank' : 'more in the bank than on the platform'}. Check under <a href="#bank">Bank payments</a>.`);
  const docLink = (d, i) => `<li><a href="${esc(d.url)}" target="_blank" rel="noreferrer">Document ${i + 1}${d.type ? ' (' + esc(d.type.toUpperCase()) + ')' : ''}</a>${d.campaign ? ` <span class="note">campaign ${esc(d.campaign)}${/other/i.test(d.attached) ? ', other cause' : ''}</span>` : ''}</li>`;
  return `<div class="panel"><h3>Past grant (imported) <span class="pill ${done ? 'p-ok' : 'p-wait'}">${done ? 'Details completed ' + fmtD(a.completed_at) : a.complete_sent_at ? 'Form sent ' + fmtD(a.complete_sent_at) : 'Details to complete'}</span></h3>
    <p class="note" style="margin-top:0">From ${esc(imp.fileName || 'the campaign export')}${imp.fileOrgName && imp.fileOrgName.toUpperCase() !== a.org_name.toUpperCase() ? ` · listed there as “${esc(imp.fileOrgName)}”` : ''}.
      ${camps.length > 1 ? 'Its causes share one pot: the grant is the highest approved amount, paid is everything redeemed.' : ''}</p>
    <div class="tbl"><table class="mini"><thead><tr><th>Campaign</th><th>Name</th><th class="num">Approved</th><th class="num">Redeemed</th></tr></thead><tbody>
      ${camps.map((c) => `<tr><td>${esc(c.number)}</td><td>${esc(c.name)}</td><td class="num">${money(c.approved)}</td><td class="num">${money(c.redeemed)}</td></tr>`).join('')}
      <tr><td></td><td><b>Grant</b></td><td class="num"><b>${money(imp.approved)}</b></td><td class="num"><b>${money(imp.redeemed)}</b></td></tr>
    </tbody></table></div>
    ${check ? `<div style="margin-top:12px">${check}</div>` : ''}
    ${docs.length || consent.length ? `<details style="margin-top:12px" ${docs.length <= 12 ? 'open' : ''}><summary><b>Documents from the platform</b> (${docs.length}${consent.length ? ' + consent form' : ''})</summary>
      <ul style="margin:8px 0 0;padding-left:18px;columns:2;column-gap:28px">${docs.map(docLink).join('')}
      ${consent.map((u, i) => `<li><a href="${esc(u)}" target="_blank" rel="noreferrer">Consent form${consent.length > 1 ? ' ' + (i + 1) : ''}</a></li>`).join('')}</ul></details>` : '<p class="note">No documents in the export.</p>'}
    ${done || club ? (club && !done ? '<p class="note" style="margin-top:14px">For a community account, send the application form from the grants list (Send the application form).</p>' : '') : `<h3 style="margin-top:18px">${ind ? 'Ask them to complete the individual application form' : 'Ask the charity to complete the form'}</h3>
      <p class="note" style="margin-top:0">${ind ? 'They get a link to the online Individual Grant Application Form with their name filled in. They add their details, payment method, ID, proof of bank and an endorser, and sign.'
        : 'They get a link to the application form with their charity details already filled in from the register. They add the applicant, bank details and proof, how the funds are used, and sign.'}</p>
      <div class="row" style="margin-top:8px">${field('cmp.email', 'Send to email', O.completeTo || '', { type: 'email' })}
        <button class="primary small" type="button" id="sendComplete" ${B}>${a.complete_sent_at ? 'Send again' : ind ? 'Send the application form' : 'Send pre-filled form'}</button></div>
      ${a.complete_sent_at ? `<p class="note">Last sent to ${esc(a.complete_sent_to)} on ${fmtD(a.complete_sent_at)}. Sending again replaces the old link.</p>` : ''}`}
  </div>`;
}

/* ---------- import past grants from the campaign export ---------- */
const IMP = { file: null, charities: [], people: [], others: [], checks: {}, results: [], busy: '', msg: null, sel: {}, psel: {}, presults: [] };
const HEAD = {
  campaignNumber: /^campaign ?(number|no|#)$/, campaignName: /^campaign ?name$/, name: /^beneficiary ?name$/, id: /^beneficiary ?id$/,
  cause: /^cause ?name$/, currency: /^currency$/, approved: /^amount ?approved$/, redeemed: /^amount ?redeemed$/, doc: /^doc ?1$/,
  consent: /^consent ?form$/, causeId: /^campaign ?cause ?id$/,
};
const loadScript = (src) => new Promise((ok, no) => { if (window.JSZip) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[£,\s]/g, '')); return isFinite(n) ? n : 0; };

async function readFile(file) {
  const C = await import('/js/core.js');
  let rows, docRows = null;
  if (/\.xlsx$/i.test(file.name)) {
    await loadScript('/vendor/jszip.min.js');
    const book = await C.readXlsx(window.JSZip, await file.arrayBuffer());
    const sheet = book.find((b) => !b.hidden && b.rows.some((r) => r.some((v) => /beneficiary ?id/i.test(String(v))))) || book[0];
    rows = sheet.rows.map((r) => r.map(C.xv));
    // The "Documents" sheet lists every document link (this cause and the campaign's other causes).
    const ds = book.find((b) => b !== sheet && b.rows.some((r) => r.some((v) => /^document$/i.test(String(v).trim()))));
    if (ds) docRows = ds.rows.map((r) => r.map(C.xv));
  } else rows = C.parseCsv(await file.text());
  const hi = rows.findIndex((r) => r.some((v) => /beneficiary ?id/i.test(String(v))));
  if (hi < 0) throw new Error('This file has no “Beneficiary ID” column. Use the campaign export from the platform.');
  const head = rows[hi].map((v) => String(v).replace(/\s+/g, ' ').trim().toLowerCase());
  const col = {}; for (const [k, re] of Object.entries(HEAD)) col[k] = head.findIndex((h) => re.test(h));
  if (col.id < 0 || col.approved < 0) throw new Error('Could not find the Beneficiary ID and Amount Approved columns.');
  const get = (r, k) => (col[k] >= 0 ? r[col[k]] : '');
  const docCols = head.map((h, i) => (/^doc ?\d+$/.test(h) ? i : -1)).filter((i) => i >= 0);
  // documents by cause (CampaignCauseID) from the Documents sheet
  const byCause = new Map();
  if (docRows) {
    const dh = docRows.findIndex((r) => r.some((v) => /^document$/i.test(String(v).trim())));
    const H2 = docRows[dh].map((v) => String(v).trim().toLowerCase());
    const c = (re) => H2.findIndex((h) => re.test(h));
    const cDoc = c(/^document$/), cId = c(/^campaign ?cause ?id$/), cType = c(/^file ?type$/), cAtt = c(/^attached ?to$/), cCamp = c(/^campaign ?number$/);
    for (const r of docRows.slice(dh + 1)) {
      const url = String(r[cDoc] || '').trim(); if (!url) continue;
      const k = String(r[cId] || '').trim();
      if (!byCause.has(k)) byCause.set(k, []);
      byCause.get(k).push({ url, type: String(r[cType] || ''), attached: String(r[cAtt] || ''), campaign: String(r[cCamp] || '') });
    }
  }
  const groups = new Map(), people = new Map(), others = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r.some((v) => String(v).trim())) continue;
    const cause = String(get(r, 'cause'));
    const campaign = { number: String(get(r, 'campaignNumber')).trim(), name: String(get(r, 'campaignName')).trim(), approved: num(get(r, 'approved')), redeemed: num(get(r, 'redeemed')), doc: String(get(r, 'doc')).trim() };
    const docs = [...(byCause.get(String(get(r, 'causeId')).trim()) || []),
      ...docCols.map((i) => String(r[i] || '').trim()).filter(Boolean).map((url) => ({ url, type: (url.match(/\.(\w+)$/) || [])[1] || '', attached: 'This cause', campaign: campaign.number }))];
    const consent = String(get(r, 'consent') || '').trim();
    const rawId = String(get(r, 'id')).trim();
    const row = { campaign, name: String(get(r, 'name')).trim(), id: rawId.replace(/\D/g, ''), cause, currency: String(get(r, 'currency') || 'GBP').trim() };
    if (/organi[sz]ation|עמותה/i.test(cause) && row.id) {
      if (!groups.has(row.id)) groups.set(row.id, { number: row.id, fileOrgName: row.name, currency: row.currency, campaigns: [], docs: [], consent: [] });
      const g = groups.get(row.id); g.campaigns.push(campaign); g.docs.push(...docs); if (consent) g.consent.push(consent);
      continue;
    }
    // Individuals (General Support) and community accounts: one grant per Beneficiary ID.
    const kind = /community/i.test(cause) ? 'club' : /general|support|individual/i.test(cause) ? 'individual' : null;
    if (!kind || !rawId) { others.push(row); continue; }
    const key = rawId.toUpperCase();
    if (!people.has(key)) people.set(key, { id: key, name: row.name, kind, currency: row.currency, campaigns: [], docs: [], consent: [] });
    const p = people.get(key); p.campaigns.push(campaign); p.docs.push(...docs); if (consent) p.consent.push(consent);
  }
  const dedupe = (g) => { const seen = new Set(); g.docs = g.docs.filter((d) => !seen.has(d.url) && seen.add(d.url)); g.consent = [...new Set(g.consent)]; return g; };
  return { charities: [...groups.values()].map(dedupe), people: [...people.values()].map(dedupe), others };
}

function renderImport() {
  const ready = IMP.charities.length && Object.keys(IMP.checks).length >= IMP.charities.length;
  // Causes of one beneficiary share one pot: approved = the highest, paid = all redeemed added up.
  const tot = (g, k) => (k === 'approved' ? Math.max(0, ...g.campaigns.map((c) => c[k])) : g.campaigns.reduce((s, c) => s + c[k], 0));
  const picked = IMP.charities.filter((g) => IMP.sel[g.number]);
  let h = `<p style="margin:0 0 14px"><a href="#" class="back">← All grant applications</a></p>
    ${IMP.msg ? `<div style="margin-bottom:12px">${notice(IMP.msg.kind, esc(IMP.msg.text))}</div>` : ''}
    <div class="panel" style="margin-top:0"><h3>1. Choose the campaign export</h3>
      <p class="note" style="margin-top:0">The Excel or CSV export with Beneficiary Name, Beneficiary ID and Cause Name. Rows whose cause is “Organization – עמותה” are charities; the Beneficiary ID is their charity number.</p>
      <input type="file" id="impFile" accept=".xlsx,.csv" ${IMP.busy ? 'disabled' : ''}>${IMP.file ? `<span class="files"> ${esc(IMP.file)}</span>` : ''}</div>`;
  if (IMP.charities.length) {
    h += `<div class="panel"><h3>2. Check the charities ${IMP.busy === 'check' ? '<span class="note" style="margin:0">Checking the register…</span>' : ''}</h3>
      <p class="note" style="margin-top:0">${IMP.charities.length} charit${IMP.charities.length === 1 ? 'y' : 'ies'} found. Untick any you don't want to import. Names come from the Charity Commission register.</p>
      <div class="tbl"><table class="mini"><thead><tr><th></th><th>In the file</th><th>On the register</th><th class="num">Campaigns</th><th class="num">Approved</th><th class="num">Redeemed</th></tr></thead><tbody>
      ${IMP.charities.map((g) => {
        const c = IMP.checks[g.number];
        const reg = !c ? '<span class="note">Checking…</span>'
          : !c.found ? `<span class="pill p-bad">Not found</span> <span class="note">${esc(c.message || '')}</span>`
          : `<b>${esc(c.name)}</b><br><span class="note">Charity ${esc(c.number)}${c.removed ? ' · <b>removed from the register</b>' : ''}${c.already.length ? ' · already imported as ' + c.already.map((x) => esc(x.ref)).join(', ') : ''}</span>`;
        const can = c && c.found;
        return `<tr><td><input type="checkbox" data-sel="${esc(g.number)}" ${IMP.sel[g.number] ? 'checked' : ''} ${can && !IMP.busy ? '' : 'disabled'} aria-label="Import ${esc(g.fileOrgName)}" style="accent-color:var(--navy)"></td>
          <td>${esc(g.fileOrgName)}<br><span class="note">ID ${esc(g.number)}</span></td><td>${reg}</td>
          <td class="num">${g.campaigns.length}</td><td class="num">${money(tot(g, 'approved'))}</td><td class="num">${money(tot(g, 'redeemed'))}</td></tr>`;
      }).join('')}</tbody></table></div>
      ${IMP.others.length ? `<p class="note">${IMP.others.length} row(s) are not charities, individuals or community accounts and won't be imported: ${IMP.others.slice(0, 8).map((o) => esc(o.name || '(no name)') + ' (' + esc(o.cause || 'no cause') + ')').join(', ')}${IMP.others.length > 8 ? '…' : ''}</p>` : ''}
      <div class="actions"><button class="primary" type="button" id="impGo" ${ready && picked.length && !IMP.busy ? '' : 'disabled'}>${IMP.busy === 'import' ? 'Importing…' : `Import ${picked.length} grant${picked.length === 1 ? '' : 's'}`}</button></div></div>`;
  }
  if (IMP.people.length) {
    const pick = IMP.people.filter((p) => IMP.psel[p.id]);
    const ptot = (p, k) => (k === 'approved' ? Math.max(0, ...p.campaigns.map((c) => c[k])) : p.campaigns.reduce((s, c) => s + c[k], 0));
    h += `<div class="panel"><h3>Individuals and community accounts</h3>
      <p class="note" style="margin-top:0">${IMP.people.filter((p) => p.kind === 'individual').length} individuals (General Support) and ${IMP.people.filter((p) => p.kind === 'club').length} community accounts, one grant each.
        Causes of the same person are combined: approved = the highest amount, paid = all redeemed. Every document link from the file is kept on the grant.</p>
      <label class="tick" style="margin:6px 0 10px"><input type="checkbox" id="pAll" ${pick.length === IMP.people.length ? 'checked' : ''}> Select all</label>
      <div class="tbl" style="max-height:480px;overflow:auto"><table class="mini"><thead><tr><th></th><th>Name</th><th>Type</th><th class="num">Causes</th><th class="num">Approved</th><th class="num">Paid</th><th class="num">Documents</th></tr></thead><tbody>
      ${IMP.people.map((p) => `<tr><td><input type="checkbox" data-psel="${esc(p.id)}" ${IMP.psel[p.id] ? 'checked' : ''} ${IMP.busy ? 'disabled' : ''} aria-label="Import ${esc(p.name)}" style="accent-color:var(--navy)"></td>
        <td>${esc(p.name)}<br><span class="note">ID ${esc(p.id)}</span></td><td>${p.kind === 'club' ? 'Community account' : 'Individual'}</td>
        <td class="num">${p.campaigns.length}</td><td class="num">${money(ptot(p, 'approved'))}</td><td class="num">${money(ptot(p, 'redeemed'))}</td>
        <td class="num">${p.docs.length}${p.consent.length ? ' + consent' : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="actions"><button class="primary" type="button" id="pGo" ${pick.length && !IMP.busy ? '' : 'disabled'}>${IMP.busy === 'people' ? 'Importing…' : `Import ${pick.length} individual grant${pick.length === 1 ? '' : 's'}`}</button></div>
      ${IMP.presults.length ? `<p class="note">${IMP.presults.filter((r) => r.ref).length} imported${IMP.presults.some((r) => r.skipped) ? `, ${IMP.presults.filter((r) => r.skipped).length} already imported before` : ''}. Find them in the grants list (search by name).</p>` : ''}</div>`;
  }
  if (IMP.results.length) {
    h += `<div class="panel"><h3>3. Imported</h3><ul style="margin:0;padding-left:18px">${IMP.results.map((r) =>
      r.ref ? `<li><a href="#grant/${esc(r.id)}">${esc(r.ref)} · ${esc(r.name)}</a>${r.warnings && r.warnings.length ? ` <span class="pill p-bad">${esc(r.warnings[0])}</span>` : ''}</li>`
        : `<li>${esc(r.number)}: ${esc(r.message)}</li>`).join('')}</ul>
      <p class="note">Open each grant to send the charity its pre-filled form.</p></div>`;
  }
  app().innerHTML = frame('Import past grants', null, h);
  const f = $('#impFile');
  if (f) f.addEventListener('change', async () => {
    const file = f.files[0]; if (!file) return;
    Object.assign(IMP, { file: file.name, charities: [], people: [], others: [], checks: {}, results: [], presults: [], sel: {}, psel: {}, msg: null, busy: 'check' });
    try { Object.assign(IMP, await readFile(file)); }
    catch (e) { IMP.busy = ''; IMP.msg = { kind: 'bad', text: e.message || 'Could not read that file.' }; return renderImport(); }
    IMP.people.forEach((p) => { IMP.psel[p.id] = true; });
    if (!IMP.charities.length) { IMP.busy = ''; IMP.msg = IMP.people.length ? null : { kind: 'warn', text: 'No charity, individual or community account rows found in that file.' }; return renderImport(); }
    renderImport();
    const nums = IMP.charities.map((g) => g.number);
    for (let i = 0; i < nums.length; i += 40) {
      let r; try { r = await api('import-check', { numbers: nums.slice(i, i + 40) }); } catch (e) { return; }
      if (!r.ok) { IMP.msg = { kind: 'bad', text: r.message }; break; }
      for (const c of r.results) {
        IMP.checks[c.number] = c;
        const g = IMP.charities.find((x) => x.number === c.number);
        const allDone = g && c.already.length && g.campaigns.every((cp) => c.already.some((x) => x.campaigns.includes(cp.number)));
        IMP.sel[c.number] = c.found && !c.removed && !allDone;
      }
      renderImport();
    }
    IMP.busy = ''; renderImport();
  });
  $$('[data-sel]').forEach((cb) => cb.addEventListener('change', () => { IMP.sel[cb.dataset.sel] = cb.checked; renderImport(); }));
  $$('[data-psel]').forEach((cb) => cb.addEventListener('change', () => { IMP.psel[cb.dataset.psel] = cb.checked; renderImport(); }));
  const pAll = $('#pAll'); if (pAll) pAll.addEventListener('change', () => { IMP.people.forEach((p) => { IMP.psel[p.id] = pAll.checked; }); renderImport(); });
  const pGo = $('#pGo');
  if (pGo) pGo.addEventListener('click', async () => {
    const todo = IMP.people.filter((p) => IMP.psel[p.id]);
    IMP.busy = 'people'; IMP.presults = []; IMP.msg = null; renderImport();
    for (let i = 0; i < todo.length; i += 25) {
      let r; try { r = await api('import-people', { fileName: IMP.file, items: todo.slice(i, i + 25) }); } catch (e) { return; }
      if (!r.ok) { IMP.msg = { kind: 'bad', text: r.message }; break; }
      IMP.presults.push(...r.results); r.results.forEach((x) => { IMP.psel[x.id] = false; });
      IMP.msg = { kind: 'ok', text: `Importing… ${Math.min(i + 25, todo.length)} of ${todo.length}` }; renderImport();
    }
    IMP.busy = '';
    const n = IMP.presults.filter((x) => x.ref).length;
    if (!IMP.msg || IMP.msg.kind !== 'bad') IMP.msg = { kind: 'ok', text: `${n} individual grant${n === 1 ? '' : 's'} imported.` };
    renderImport();
  });
  const go = $('#impGo');
  if (go) go.addEventListener('click', async () => {
    const todo = IMP.charities.filter((g) => IMP.sel[g.number]).map((g) => ({ ...g, fileName: IMP.file }));
    IMP.busy = 'import'; IMP.results = []; IMP.msg = null; renderImport();
    for (let i = 0; i < todo.length; i += 4) {
      let r; try { r = await api('import', { items: todo.slice(i, i + 4) }); } catch (e) { return; }
      if (!r.ok) { IMP.msg = { kind: 'bad', text: r.message }; break; }
      IMP.results.push(...r.results);
      r.results.forEach((x) => { if (x.ref || x.skipped) IMP.sel[x.number] = false; });
      IMP.msg = { kind: 'ok', text: `Imported ${IMP.results.filter((x) => x.ref).length} of ${todo.length}…` };
      renderImport();
    }
    const n = IMP.results.filter((x) => x.ref).length;
    IMP.busy = ''; IMP.msg = { kind: n ? 'ok' : 'warn', text: `${n} grant${n === 1 ? '' : 's'} imported.` + (IMP.results.some((x) => x.skipped || x.failed) ? ' Some were skipped; see the list below.' : '') };
    renderImport();
  });
}

/* ---------- upload bank transfers (Lloyds and Metro) and match them to grants ---------- */
const BK = { files: [], rows: [], data: null, busy: '', msg: null, hideNone: false, tab: 'check', list: null, choice: {} };
const STOP = new Set(['LTD', 'LIMITED', 'THE', 'TRUST', 'CHARITABLE', 'CHARITY', 'FOUNDATION', 'FUND', 'OF', 'AND', 'UK', 'CIO', 'CT', 'TST', 'FDN', 'ASSOCIATION', 'SOCIETY', 'INC']);
const words = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
const compact = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const payeeKey = (t) => words(t).join(' ').slice(0, 120);
async function hashKey(k) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(k)));
  return [...new Uint8Array(d)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Lloyds / Metro "Transaction Report" (TransactionReport-….csv): one transaction per row, as "Label:" "value" pairs grouped in sections. */
const TDR_SECTIONS = ['Transaction Information', 'Account Information', 'Additional Information', 'Beneficiary Details',
  'Beneficiary/Remittance Details', 'Originator Details', 'Paying Bank Details'];
function tdrFields(row) {
  const cells = row.map((c) => String(c == null ? '' : c).trim());
  const d = {};
  let section = '';
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c.endsWith(':')) continue;
    const label = c.slice(0, -1);
    if (TDR_SECTIONS.includes(label)) { section = label; continue; }
    const next = i + 1 < cells.length ? cells[i + 1] : '';
    const v = next.endsWith(':') ? '' : next;
    const k = section + '|' + label;
    if (!(k in d)) d[k] = v;
    if (v) i++;
  }
  return d;
}
function readTransactionReport(rows, C) {
  const out = [];
  let bank = 'Lloyds';
  for (const r of rows) {
    if (!r.some((v) => String(v).trim() === 'Transaction Information:')) continue;
    const d = tdrFields(r), g = (k) => d[k] || '';
    const find = (re, not) => { for (const k in d) if (re.test(k) && !(not && not.test(k)) && d[k] && d[k] !== '.') return d[k]; return ''; };
    const sort = g('Account Information|Sort Code').replace(/\D/g, '') || g('Transaction Information|Account Number').replace(/\D/g, '').slice(0, 6);
    if (/^2305/.test(sort)) bank = 'Metro';
    const dc = g('Transaction Information|Debit or Credit');
    const amt = C.amountOf(g('Transaction Information|Amount'));
    if (!(dc === 'DR' || (!dc && amt < 0)) || !(Math.abs(amt) > 0)) continue;
    const type = g('Transaction Information|Type'), desc = g('Transaction Information|Description');
    if (/inter account transfer/i.test(type) || /reject|return|reversal/i.test(type + ' ' + desc) || g('Transaction Information|Reversal Indicator') === 'true') continue;
    const payee = find(/^Beneficiary[^|]*\|.*name$/i) || find(/payee|receiver/i) || g('Transaction Information|Customer Reference') || desc;
    const reference = [find(/Payment Reference|Remittance/i), find(/^Additional Information\|Beneficiary Reference$/), g('Transaction Information|Customer Reference')]
      .filter((x, i, l) => x && x !== payee && l.indexOf(x) === i).join(' · ');
    const acno = find(/^Beneficiary[^|]*\|.*account number$/i).replace(/\D/g, '');
    out.push({ bank, date: C.toIsoDate(g('Transaction Information|Posted Date') || g('Transaction Information|Value Date') || find(/date$/i)),
      bankRef: g('Transaction Information|Bank Reference'), payee, reference,
      // every field goes into the matching text, so a charity number, campaign or account number anywhere is found
      extra: [acno, desc, type, ...Object.values(d)].join(' '), amount: Math.abs(amt) });
  }
  out.forEach((p) => { p.bank = bank; });
  return out;
}

/** Outgoing transfers from a Lloyds or Metro export (CSV or Excel). */
function readOutgoing(rows, C) {
  rows = rows.filter((r) => r && r.some((v) => v !== '' && v != null)).map((r) => r.map(C.xv));
  if (rows.some((r) => r.some((v) => String(v).trim() === 'Transaction Information:'))) return readTransactionReport(rows, C);
  const hi = rows.findIndex((r) => r.some((h) => /posting date|bank reference number|transaction detail|payment reference|paid out|money out/i.test(String(h))));
  if (hi < 0) throw new Error('This is not a Lloyds or Metro Bank export. Download the statement as CSV or Excel from online banking and try again.');
  const head = rows[hi].map((h) => String(h).trim().toLowerCase());
  const col = (...n) => { for (const x of n) { const i = head.indexOf(x.toLowerCase()); if (i >= 0) return i; } return -1; };
  const body = rows.slice(hi + 1), out = [];
  if (col('transaction detail') >= 0 && col('posting date') >= 0) { // Lloyds
    const cD = col('posting date'), cDC = col('debit/credit'), cRef = col('bank reference'), cAcc = col('debit account reference'), cDet = col('transaction detail'), cAmt = col('amount');
    for (const r of body) {
      const amt = C.amountOf(r[cAmt]);
      const isOut = cDC >= 0 ? /debit/i.test(String(r[cDC])) : amt < 0;
      if (!isOut || !(Math.abs(amt) > 0)) continue;
      const det = String(r[cDet] || ''), lines = det.split(/\r?\n/);
      const payee = lines.length > 1 ? lines[0].trim() : det.slice(0, 18).trim();
      const ref = lines.length > 1 ? lines.slice(1).join(' ').trim() : det.slice(18).trim();
      out.push({ bank: 'Lloyds', date: C.toIsoDate(r[cD]), bankRef: C.cellText(r[cRef]), payee, reference: ref, extra: C.cellText(r[cAcc]), amount: Math.abs(amt) });
    }
    return out;
  }
  // Metro (statement or account export)
  const cD = col('post date', 'date', 'transaction date'), cRef = col('bank reference number', 'reference number'), cType = col('payment type', 'transaction type', 'type'),
    cName = col('account name', 'payee', 'beneficiary', 'name', 'description', 'details'), cPRef = col('payment reference', 'reference'),
    cAmt = col('amount'), cOut = col('paid out', 'money out', 'debit', 'withdrawals');
  if (cD < 0 || (cAmt < 0 && cOut < 0)) throw new Error('Could not find the date and amount columns in this file.');
  for (const r of body) {
    const type = cType >= 0 ? C.cellText(r[cType]) : '';
    if (/reject|return|reversal/i.test(type)) continue;
    let amt = cOut >= 0 ? C.amountOf(r[cOut]) : NaN;
    if (!(amt > 0) && cAmt >= 0) { const a = C.amountOf(r[cAmt]); amt = a < 0 ? -a : NaN; }
    if (!(amt > 0)) continue;
    out.push({ bank: 'Metro', date: C.toIsoDate(r[cD]), bankRef: cRef >= 0 ? C.cellText(r[cRef]) : '', payee: cName >= 0 ? C.cellText(r[cName]) : '', reference: cPRef >= 0 ? C.cellText(r[cPRef]) : '', extra: type, amount: amt });
  }
  return out;
}

/** Best grant for one transfer, with a plain reason. */
function suggest(p, data) {
  const text = [p.payee, p.reference, p.extra].join(' ').toUpperCase();
  const nums = (text.match(/\d{5,8}/g) || []);
  const learned = new Map(data.learned.map((l) => [l.payee_key, l.application_id]));
  const pk = payeeKey(p.payee);
  const scored = data.grants.map((g) => {
    let score = 0, why = '';
    const set = (s, w) => { if (s > score) { score = s; why = w; } };
    if (pk && learned.get(pk) === g.id) set(100, 'Matched before');
    if (g.ref && text.includes(g.ref.toUpperCase())) set(95, 'Grant reference ' + g.ref);
    if (g.number && nums.includes(g.number)) set(90, 'Charity number ' + g.number);
    const camp = g.campaigns.find((c) => nums.includes(c)); if (camp) set(85, 'Campaign ' + camp);
    if (g.acno && nums.includes(g.acno)) set(80, 'Account number');
    const sortHit = p.sort && g.sort && p.sort === g.sort;
    for (const nm of [g.name, g.acname, g.fileName].filter(Boolean)) {
      const a = compact(p.payee), b = compact(nm);
      if (a.length >= 8 && b.length >= 8 && (a.startsWith(b.slice(0, Math.min(b.length, a.length))) || b.startsWith(a))) set(75, 'Name');
      const gw = words(nm), pw = new Set(words(p.payee));
      if (gw.length) {
        const hit = gw.filter((w) => pw.has(w) || [...pw].some((x) => x.length >= 4 && (w.startsWith(x) || x.startsWith(w)))).length / gw.length;
        if (hit >= 0.6) set(Math.round(55 + 25 * hit), 'Name');
        if (sortHit && hit >= 0.3) set(92, 'Sort code and name');
      }
    }
    if (sortHit) set(50, 'Same sort code only');
    return { g, score, why };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { grantId: '', score: 0, why: '' };
  // A clear number or reference match is certain, unless two grants share it (e.g. two grants for one charity).
  const tie = scored[1] && scored[1].score >= best.score - (best.score >= 85 ? 0 : 5);
  return { grantId: best.g.id, score: tie ? Math.min(best.score, 80) : best.score, why: best.why + (tie ? ' – more than one grant fits, check' : '') };
}

async function startBank() {
  Object.assign(BK, { files: [], busy: '', msg: null, tab: 'check', list: null });
  app().innerHTML = frame('Bank payments', null, '<p class="loading">Loading…</p>');
  await loadBank();
  renderBank();
}

/** Fetch grants, remembered matches and the saved payments still to check; work out a suggestion for each. */
async function loadBank() {
  const r = await api('bank-data');
  if (!r.ok) throw new Error(r.message);
  BK.data = r;
  BK.rows = r.pending.map((l) => {
    const p = { ...l, ...suggest(l, r) };
    const c = BK.choice[l.hash];
    if (c) { p.grantId = c.grantId; p.tick = c.tick; if (c.manual) { p.score = 0; p.why = ''; } }
    else p.tick = p.score >= 85;
    return p;
  });
}
const keepChoice = (r, manual) => { BK.choice[r.hash] = { grantId: r.grantId, tick: r.tick, manual: manual || (BK.choice[r.hash] || {}).manual }; };

/** Colour of a row: green = certain or confirmed, orange = possible (needs checking), none = no match. */
const bkTone = (r) => (r.grantId && (r.tick || r.score >= 85) ? 'green' : r.grantId ? 'orange' : 'none');
const BK_STYLE = { green: 'background:#e7f5ec;box-shadow:inset 4px 0 0 #23774a', orange: 'background:#fff3e0;box-shadow:inset 4px 0 0 #e8891c', none: '' };

async function bankSave(rows, auto) {
  let added = 0, dups = 0;
  for (let i = 0; i < rows.length; i += 40) {
    const part = rows.slice(i, i + 40);
    if (rows.length > 40) { BK.progress = `Adding payments… ${Math.min(i + 40, rows.length)} of ${rows.length}`; renderBank(); }
    const r = await api('bank-import', { auto: !!auto, items: part.map((p) => ({ grantId: p.grantId, date: p.date, amount: p.amount, bank: p.bank, bankRef: p.bankRef,
      payee: p.payee, reference: p.reference, key: p.key, payeeKey: payeeKey(p.payee) })) });
    if (!r.ok) throw new Error(r.message);
    added += r.added; dups += r.duplicates;
    part.forEach((p) => { delete BK.choice[p.hash]; });
  }
  return { added, dups };
}

/** Read statement files into payment lines (outgoing only, own-account transfers left out). */
async function readStatements(files) {
  const C = await import('/js/core.js');
  const all = [], failed = [];
  for (let n = 0; n < files.length; n++) {
    const file = files[n];
    BK.progress = `Reading file ${n + 1} of ${files.length}: ${file.name}`; renderBank();
    let got;
    try {
    if (/\.pdf$/i.test(file.name)) {
      const [pdfjs, B] = await Promise.all([import('/vendor/pdfjs/pdf.min.mjs'), import('/grants/js/bankpdf.js')]);
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      try { got = B.readBankPdfLines(await B.pdfLines(pdfjs, new Uint8Array(await file.arrayBuffer()))).payments; }
      catch (e) { throw new Error(file.name + ': ' + e.message); }
    } else {
      let rows;
      if (/\.xlsx$/i.test(file.name)) { await loadScript('/vendor/jszip.min.js'); rows = (await C.readXlsx(window.JSZip, await file.arrayBuffer()))[0].rows; }
      else rows = C.parseCsv(await file.text());
      try { got = readOutgoing(rows, C); } catch (e) { throw new Error(file.name + ': ' + e.message); }
    }
    } catch (e) { failed.push(e.message.startsWith(file.name) ? e.message : file.name + ': ' + e.message); continue; }
    got.forEach((p) => { p.file = file.name; });
    all.push(...got);
  }
  const own = all.filter((p) => /^toirem\b/i.test(String(p.payee).trim()));
  const mine = all.filter((p) => !own.includes(p));
  const counts = {};
  for (const p of mine) {
    const base = [p.bank, p.bankRef, p.date, Number(p.amount).toFixed(2), String(p.payee).toUpperCase()].join('|');
    counts[base] = (counts[base] || 0) + 1;
    p.key = base + (counts[base] > 1 ? '#' + counts[base] : ''); // two identical payments on one day stay separate
  }
  return { lines: mine, own: own.length, failed };
}

function renderBank() {
  const d = BK.data, grants = d.grants, c = d.counts || {};
  const gname = (id) => { const g = grants.find((x) => x.id === id); return g ? g.ref + ' · ' + g.name : '—'; };
  const opts = (sel, empty = '— Choose a grant —') => `<option value="">${empty}</option>` + grants.map((g) =>
    `<option value="${esc(g.id)}" ${sel === g.id ? 'selected' : ''}>${esc(g.ref)} · ${esc(g.name)}${g.number ? ' (' + esc(g.number) + ')' : ''}</option>`).join('');
  const tab = (id, label, n) => `<button type="button" class="${BK.tab === id ? 'primary' : 'ghost'} small" data-tab="${id}">${label}${n != null ? ` (${n})` : ''}</button>`;
  let h = `<p style="margin:0 0 14px"><a href="#" class="back">← All grant applications</a></p>
    ${BK.msg ? `<div style="margin-bottom:12px">${notice(BK.msg.kind, esc(BK.msg.text))}</div>` : ''}
    <div class="panel" style="margin-top:0"><h3>Upload bank statements</h3>
      <p class="note" style="margin-top:0">Lloyds or Metro Bank: PDF (Lloyds Transaction Report or Metro statement), CSV or Excel. You can choose several files at once.
        Every payment going out is saved here until you deal with it, so nothing is lost if you leave the page. Uploading the same statement again adds nothing twice.</p>
      <div id="bkDrop" style="border:2px dashed var(--line);border-radius:8px;padding:16px;text-align:center;background:#fafbfd">
        <p style="margin:0 0 10px"><b>Drag statements here</b>, as many as you like, or</p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <label class="btn ghost small" style="cursor:pointer">Choose files<input type="file" id="bkFile" accept=".pdf,.csv,.xlsx" multiple hidden ${BK.busy ? 'disabled' : ''}></label>
          <label class="btn ghost small" style="cursor:pointer">Choose a folder<input type="file" id="bkFolder" webkitdirectory multiple hidden ${BK.busy ? 'disabled' : ''}></label>
        </div>
        ${BK.files.length ? `<p class="note" style="margin:10px 0 0">${BK.files.length} file${BK.files.length === 1 ? '' : 's'}: ${BK.files.slice(0, 8).map(esc).join(', ')}${BK.files.length > 8 ? ' and ' + (BK.files.length - 8) + ' more' : ''}</p>` : ''}
      </div>
      ${BK.busy ? `<p class="loading">${esc(BK.progress || (BK.busy === 'read' ? 'Reading the statements…' : 'Adding payments…'))}</p>` : ''}</div>
    <div class="actions" style="margin:16px 0 0">${tab('check', 'To check', BK.rows.length)}${tab('added', 'Added to grants', c.added)}${tab('ignored', 'Not grant payments', c.ignored)}</div>`;

  if (BK.tab === 'check') {
    const rows = BK.rows, shown = rows.filter((r) => !(BK.hideNone && bkTone(r) === 'none'));
    const ready = rows.filter((r) => r.tick && r.grantId), ticked = rows.filter((r) => r.tick);
    const n = (t) => rows.filter((r) => bkTone(r) === t).length;
    const allOn = shown.length && shown.every((r) => r.tick);
    h += `<div class="panel" style="margin-top:10px">${!rows.length ? '<p class="note" style="margin:0">Nothing to check. Upload a statement above.</p>' : `
      <p class="note" style="margin-top:0">${rows.length} payment${rows.length === 1 ? '' : 's'} to check ·
        <span class="pill p-ok">${n('green')} matched</span> <span class="pill p-wait">${n('orange')} to check</span> ${n('none')} no match</p>
      <p class="note"><b style="color:#23774a">Green</b> = certain match, ticked for you. <b style="color:#b8650a">Orange</b> = possible match: check the grant and tick it, and it turns green.
        Once you've confirmed a recipient, their payments in later statements are added automatically.</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0">
        <label class="tick" style="margin:0"><input type="checkbox" id="bkHide" ${BK.hideNone ? 'checked' : ''}> Hide payments with no match</label>
        <span style="flex:1"></span>
        ${ticked.length ? `<span class="note">${ticked.length} ticked:</span>
          <select id="bkBulk" style="width:250px;max-width:100%">${opts('', 'Give them all one grant…')}</select>
          <button class="ghost small" type="button" id="bkBulkGo">Apply</button>
          <button class="ghost small" type="button" id="bkIgnore">Not grant payments</button>
          <button class="ghost small" type="button" id="bkNone">Untick all</button>` : ''}
      </div>
      <div class="tbl"><table class="mini"><thead><tr>
        <th><input type="checkbox" id="bkAll" ${allOn ? 'checked' : ''} aria-label="Select all payments" title="Select all" style="accent-color:var(--navy)"></th>
        <th>Date</th><th>Paid to</th><th class="num">Amount</th><th>Grant</th><th>Why</th></tr></thead><tbody>
      ${shown.map((r) => { const i = rows.indexOf(r), tone = bkTone(r); return `<tr style="${BK_STYLE[tone]}">
        <td><input type="checkbox" data-bt="${i}" ${r.tick ? 'checked' : ''} aria-label="Select this payment" style="accent-color:var(--navy)"></td>
        <td style="white-space:nowrap">${fmtD(r.date)}</td>
        <td style="min-width:190px"><b>${esc(r.payee || '—')}</b>${r.reference ? `<br><span class="note">${esc(r.reference)}</span>` : ''}<br><span class="note">${esc(r.bank)}${r.file ? ' · ' + esc(r.file) : ''}</span></td>
        <td class="num">${money(r.amount)}</td>
        <td><select data-bg="${i}" style="width:240px;max-width:100%">${opts(r.grantId)}</select></td>
        <td style="max-width:190px;white-space:normal">${tone === 'green' ? `<span class="pill p-ok">${esc(r.score >= 85 ? r.why : 'Confirmed by you')}</span>` : tone === 'orange' ? `<span class="pill p-wait">${esc(r.why || 'Check')}</span>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="actions"><button class="primary" type="button" id="bkGo" ${ready.length && !BK.busy ? '' : 'disabled'}>Add ${ready.length} payment${ready.length === 1 ? '' : 's'} to their grants</button>
        ${ticked.length > ready.length ? `<span class="note">${ticked.length - ready.length} ticked without a grant will be left out.</span>` : ''}</div>`}</div>`;
  } else if (!BK.list) {
    h += '<div class="panel" style="margin-top:10px"><p class="loading">Loading…</p></div>';
  } else if (BK.tab === 'added') {
    const L = BK.list;
    h += `<div class="panel" style="margin-top:10px">${!L.length ? '<p class="note" style="margin:0">No bank payments added yet.</p>' : `
      <p class="note" style="margin-top:0">Payments from your statements that have been added to grants. Undo puts a payment back in “To check” and stops that recipient being added automatically.</p>
      <div class="tbl"><table class="mini"><thead><tr><th>Date</th><th>Paid to</th><th class="num">Amount</th><th>Grant</th><th></th></tr></thead><tbody>
      ${L.map((r, i) => `<tr><td style="white-space:nowrap">${fmtD(r.date)}</td>
        <td><b>${esc(r.payee || '—')}</b>${r.reference ? `<br><span class="note">${esc(r.reference)}</span>` : ''}<br><span class="note">${esc(r.bank)}</span></td>
        <td class="num">${money(r.amount)}</td><td>${r.grantId ? `<a href="#grant/${esc(r.grantId)}">${esc(gname(r.grantId))}</a>` : '—'}</td>
        <td style="white-space:nowrap"><span class="pill ${r.auto ? 'p-new' : 'p-ok'}">${r.auto ? 'Added automatically' : 'Confirmed'}</span>
          <button class="ghost small" type="button" data-undo="${i}">Undo</button></td></tr>`).join('')}
      </tbody></table></div>`}</div>`;
  } else {
    const L = BK.list, t = L.filter((r) => r.tick);
    h += `<div class="panel" style="margin-top:10px">${!L.length ? '<p class="note" style="margin:0">Nothing marked as “not a grant payment”.</p>' : `
      <p class="note" style="margin-top:0">Payments you marked as not grant payments. Tick any to move them back to “To check”.</p>
      <div class="tbl"><table class="mini"><thead><tr><th></th><th>Date</th><th>Paid to</th><th class="num">Amount</th></tr></thead><tbody>
      ${L.map((r, i) => `<tr><td><input type="checkbox" data-it="${i}" ${r.tick ? 'checked' : ''} aria-label="Select" style="accent-color:var(--navy)"></td><td style="white-space:nowrap">${fmtD(r.date)}</td>
        <td><b>${esc(r.payee || '—')}</b>${r.reference ? `<br><span class="note">${esc(r.reference)}</span>` : ''}<br><span class="note">${esc(r.bank)}</span></td>
        <td class="num">${money(r.amount)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="actions"><button class="ghost" type="button" id="bkBack" ${t.length ? '' : 'disabled'}>Move ${t.length} back to “To check”</button></div>`}</div>`;
  }
  app().innerHTML = frame('Bank payments', null, h);

  const refresh = async (msg) => { BK.msg = msg; await loadBank(); if (BK.tab !== 'check') await loadList(); BK.busy = ''; renderBank(); };
  const loadList = async () => { const r = await api('bank-lines?status=' + (BK.tab === 'added' ? 'added' : 'ignored')); BK.list = r.ok ? r.lines : []; };
  $$('[data-tab]').forEach((b) => b.addEventListener('click', async () => {
    BK.tab = b.dataset.tab; BK.list = null; BK.msg = null; renderBank();
    if (BK.tab !== 'check') { await loadList(); renderBank(); }
  }));

  const startUpload = async (picked) => {
    const files = picked.filter((x) => /\.(pdf|csv|xlsx)$/i.test(x.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) { BK.msg = { kind: 'warn', text: 'No PDF, CSV or Excel files there.' }; renderBank(); return; }
    if (BK.busy) return;
    BK.busy = 'read'; BK.msg = null; BK.files = files.map((x) => x.name); BK.tab = 'check'; renderBank();
    try {
      const { lines, own, failed } = await readStatements(files);
      let saved = 0, already = 0;
      let saveErr = '', unsaved = 0;
      for (let i = 0; i < lines.length; i += 100) {
        BK.progress = `Saving payments… ${Math.min(i + 100, lines.length)} of ${lines.length}`; renderBank();
        const part = lines.slice(i, i + 100);
        const r = await api('bank-lines-save', { items: part }).catch((e) => { if (e.message === 'signed out') throw e; return { ok: false, message: e.message }; });
        if (!r.ok) { saveErr = saveErr || r.message; unsaved += part.length; continue; } // keep going with the rest
        saved += r.added; already += r.already || 0;
      }
      await loadBank();
      // Recipients you confirmed before go straight in (Undo is on the "Added to grants" list).
      const auto = BK.rows.filter((p) => p.score === 100 && p.grantId);
      let autoN = 0, autoErr = '';
      if (auto.length) { BK.busy = 'save'; renderBank(); try { autoN = (await bankSave(auto, true)).added; } catch (e) { autoErr = e.message; } await loadBank(); }
      const bits = [`${lines.length} payment${lines.length === 1 ? '' : 's'} going out read: ${saved} new${already ? `, ${already} already saved before` : ''}.`];
      if (autoN) bits.push(`${autoN} added automatically to grants you've confirmed before (see “Added to grants”, where you can undo).`);
      if (own) bits.push(`${own} transfer${own === 1 ? '' : 's'} to Toirem's own accounts left out.`);
      if (autoErr) bits.push('Could not add the confirmed matches automatically: ' + autoErr);
      if (unsaved) bits.push(`${unsaved} payment${unsaved === 1 ? '' : 's'} could not be saved: ${saveErr} Upload the same files again to retry – nothing is added twice.`);
      if (failed.length) bits.push(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be read – ${failed.join(' | ')}`);
      bits.unshift(`${files.length - failed.length} of ${files.length} file${files.length === 1 ? '' : 's'} read.`);
      BK.msg = { kind: unsaved ? 'bad' : autoErr || failed.length ? (lines.length ? 'warn' : 'bad') : lines.length ? 'ok' : 'warn', text: lines.length || failed.length ? bits.join(' ') : 'No outgoing payments found in that file.' };
    } catch (e) { if (e.message !== 'signed out') BK.msg = { kind: 'bad', text: e.message || 'Could not read that file.' }; }
    BK.busy = ''; BK.progress = ''; renderBank();
  };
  const f = $('#bkFile'); if (f) f.addEventListener('change', () => startUpload([...f.files]));
  const fo = $('#bkFolder'); if (fo) fo.addEventListener('change', () => startUpload([...fo.files]));
  const drop = $('#bkDrop');
  if (drop) {
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--navy)'; drop.style.background = '#eef3fa'; }));
    drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; drop.style.background = '#fafbfd'; });
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      // Folders dropped in are opened too.
      const entries = [...(e.dataTransfer.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
      const out = [];
      const walk = async (en) => {
        if (en.isFile) { out.push(await new Promise((res, rej) => en.file(res, rej))); return; }
        const rd = en.createReader();
        for (;;) { const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const x of batch) await walk(x); }
      };
      if (entries.length) { for (const en of entries) await walk(en).catch(() => {}); } else out.push(...e.dataTransfer.files);
      startUpload(out);
    });
  }

  const hide = $('#bkHide'); if (hide) hide.addEventListener('change', () => { BK.hideNone = hide.checked; renderBank(); });
  const all = $('#bkAll'); if (all) all.addEventListener('change', () => { BK.rows.forEach((r) => { if (!(BK.hideNone && bkTone(r) === 'none')) { r.tick = all.checked; keepChoice(r); } }); renderBank(); });
  const none = $('#bkNone'); if (none) none.addEventListener('click', () => { BK.rows.forEach((r) => { r.tick = false; keepChoice(r); }); renderBank(); });
  const bulkGo = $('#bkBulkGo');
  if (bulkGo) bulkGo.addEventListener('click', () => {
    const id = $('#bkBulk').value;
    if (!id) { BK.msg = { kind: 'warn', text: 'Choose the grant to give the ticked payments.' }; renderBank(); return; }
    BK.rows.forEach((r) => { if (r.tick) { r.grantId = id; r.score = 0; r.why = ''; keepChoice(r, true); } });
    BK.msg = null; renderBank();
  });
  const ign = $('#bkIgnore');
  if (ign) ign.addEventListener('click', async () => {
    const ids = BK.rows.filter((r) => r.tick).map((r) => r.id);
    BK.busy = 'save'; renderBank();
    const r = await api('bank-mark', { ids, to: 'ignored' }).catch(() => null);
    ids.forEach((id) => { const row = BK.rows.find((x) => x.id === id); if (row) delete BK.choice[row.hash]; });
    await refresh(r && r.ok ? { kind: 'ok', text: `${r.changed} marked as not grant payments. You'll find them under “Not grant payments”.` } : { kind: 'bad', text: (r && r.message) || 'Could not save.' });
  });
  $$('[data-bt]').forEach((cb) => cb.addEventListener('change', () => { const r = BK.rows[+cb.dataset.bt]; r.tick = cb.checked; keepChoice(r); renderBank(); }));
  $$('[data-bg]').forEach((sel) => sel.addEventListener('change', () => {
    const r = BK.rows[+sel.dataset.bg]; r.grantId = sel.value; r.score = 0; r.why = ''; r.tick = !!sel.value; keepChoice(r, true); renderBank();
  }));
  $$('[data-it]').forEach((cb) => cb.addEventListener('change', () => { BK.list[+cb.dataset.it].tick = cb.checked; renderBank(); }));
  const back = $('#bkBack');
  if (back) back.addEventListener('click', async () => {
    const ids = BK.list.filter((r) => r.tick).map((r) => r.id);
    BK.busy = 'save'; renderBank();
    const r = await api('bank-mark', { ids, to: 'pending' }).catch(() => null);
    await refresh(r && r.ok ? { kind: 'ok', text: `${r.changed} moved back to “To check”.` } : { kind: 'bad', text: (r && r.message) || 'Could not save.' });
  });
  $$('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    const r = BK.list[+b.dataset.undo];
    b.disabled = true; b.textContent = 'Undoing…';
    const res = await api('bank-undo', { items: [{ key: r.key, payeeKey: payeeKey(r.payee) }] }).catch(() => null);
    await refresh(res && res.ok ? { kind: 'ok', text: `Undone: ${r.payee} ${money(r.amount)} is back in “To check”, and ${r.payee} won't be added automatically any more.` } : { kind: 'bad', text: (res && res.message) || 'Could not undo.' });
  }));
  const go = $('#bkGo');
  if (go) go.addEventListener('click', async () => {
    const todo = BK.rows.filter((r) => r.tick && r.grantId);
    BK.busy = 'save'; BK.msg = null; renderBank();
    let msg;
    try {
      const { added, dups } = await bankSave(todo);
      msg = { kind: 'ok', text: `${added} payment${added === 1 ? '' : 's'} added to their grants.` + (dups ? ` ${dups} were already recorded.` : '') + ' Next time, payments to these recipients are added automatically.' };
    } catch (e) { msg = { kind: 'bad', text: e.message }; }
    await refresh(msg);
  });
}

/* ---------- inbox: email replies and form responses ---------- */
const IN = { show: 'unread', data: null, open: null, msg: null, busy: '', reply: {}, lastSync: 0 };
function setUnread(n) { const c = document.getElementById('inboxCount'); if (c) { c.textContent = n; c.hidden = !n; } }
async function refreshUnread() { try { const r = await api('inbox?show=unread'); if (r.ok) setUnread(r.unread); } catch (e) { /* */ } }
async function startInbox(sync) {
  if (!IN.data) app().innerHTML = frame('Inbox', null, '<p class="loading">Loading…</p>');
  // Check Gmail for new replies when the inbox opens (at most every 2 minutes) or on request.
  const doSync = sync || Date.now() - IN.lastSync > 120000;
  if (doSync) { IN.busy = 'sync'; if (IN.data) renderInbox(); }
  const r = await api('inbox?show=' + IN.show + (doSync ? '&sync=1' : ''));
  IN.busy = '';
  if (!r.ok) throw new Error(r.message);
  if (doSync) IN.lastSync = Date.now();
  IN.data = r; setUnread(r.unread);
  if (doSync && r.syncError) IN.msg = { kind: 'warn', text: 'Could not check Gmail for new replies: ' + r.syncError };
  else if (sync) IN.msg = { kind: 'ok', text: r.synced ? `${r.synced} new email${r.synced === 1 ? '' : 's'}.` : 'No new emails.' };
  renderInbox();
}
function renderInbox() {
  const d = IN.data, M = d.messages;
  const tab = (id, label) => `<button type="button" class="${IN.show === id ? 'primary' : 'ghost'} small" data-show="${id}">${label}</button>`;
  const when = (t) => { const x = new Date(t); const today = new Date().toDateString() === x.toDateString(); return today ? x.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: x.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
  let h = `${IN.msg ? `<div style="margin-bottom:12px">${notice(IN.msg.kind, esc(IN.msg.text))}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      ${tab('unread', `Unread (${d.unread})`)}${tab('read', 'Read')}${tab('all', 'All')}
      <span style="flex:1"></span>
      ${IN.show !== 'read' && d.unread ? '<button class="ghost small" type="button" id="allRead">Mark all as read</button>' : ''}
      <button class="ghost small" type="button" id="sync" ${IN.busy ? 'disabled' : ''}>${IN.busy === 'sync' ? 'Checking Gmail…' : 'Check for new emails'}</button>
    </div>
    <p class="note" style="margin-top:0">Replies to Toirem's grant emails (from Gmail), and everything sent back through the forms: signed agreements, breakdowns, proofs, receipts, completed forms and new applications.</p>
    <div class="panel" style="padding:0;overflow:hidden">${!M.length ? `<p class="note" style="padding:16px;margin:0">${IN.show === 'unread' ? 'No unread messages.' : 'No messages yet.'}</p>` :
      M.map((m) => {
        const isOpen = IN.open === m.id;
        return `<div class="msg ${m.read_at ? '' : 'unread'}" data-msg="${m.id}">
          <span>${m.read_at ? '' : '<span class="dot" title="Unread"></span>'}</span>
          <div style="min-width:0"><span class="who">${esc(m.from_name || m.from_email || 'Unknown')}</span>
            <span class="pill ${m.source === 'email' ? 'p-new' : 'p-grey'}" style="margin-left:6px">${m.source === 'email' ? 'Email' : 'Form'}</span>
            <div class="subj">${esc(m.subject)}</div>
            ${isOpen ? '' : `<div class="note" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0">${esc(String(m.body || '').replace(/\s+/g, ' ').slice(0, 160))}</div>`}</div>
          <span class="when">${when(m.received_at)}</span>
          ${isOpen ? `<div class="msgbody" data-stop="1">${esc(m.body || '(no text)')}
            ${m.attachments && m.attachments.length ? `\n\n📎 ${m.attachments.map((a) => esc(a.name)).join(', ')} (open the email in Gmail to see attachments)` : ''}
            <div class="actions" style="margin-top:12px;white-space:normal">
              ${m.application_id ? `<a class="btn" href="#grant/${esc(m.application_id)}">Open ${esc(m.ref || 'the grant')}</a>` : ''}
              ${m.thread_id ? `<a class="btn" href="https://mail.google.com/mail/u/0/#all/${esc(m.thread_id)}" target="_blank" rel="noopener">Open in Gmail ↗</a>` : ''}
              <button class="ghost small" type="button" data-unread="${m.id}">Mark as unread</button>
            </div>
            ${m.source === 'email' && m.thread_id ? `<div style="margin-top:12px;white-space:normal">
              <textarea id="replyText" rows="5" style="width:100%" placeholder="Write a reply… it goes from your Gmail, in the same conversation.">${esc(IN.reply[m.id] || '')}</textarea>
              <div class="actions" style="margin-top:6px"><button class="primary small" type="button" data-reply="${m.id}" ${IN.busy ? 'disabled' : ''}>${IN.busy === 'reply' ? 'Sending…' : 'Send reply'}</button></div></div>` : ''}
          </div>` : ''}
        </div>`;
      }).join('')}</div>`;
  app().innerHTML = frame('Inbox', null, h);
  $$('[data-show]').forEach((b) => b.addEventListener('click', async () => { IN.show = b.dataset.show; IN.open = null; IN.msg = null; await startInbox(false); }));
  const sy = $('#sync'); if (sy) sy.addEventListener('click', () => { IN.msg = null; startInbox(true); });
  const ar = $('#allRead'); if (ar) ar.addEventListener('click', async () => {
    const ids = M.filter((m) => !m.read_at).map((m) => m.id);
    for (let i = 0; i < ids.length; i += 300) await api('inbox-mark', { ids: ids.slice(i, i + 300), read: true });
    IN.msg = { kind: 'ok', text: 'All marked as read.' }; await startInbox(false);
  });
  $$('[data-msg]').forEach((row) => row.addEventListener('click', async (e) => {
    if (e.target.closest('[data-stop]') || e.target.closest('a,button,textarea')) return;
    const id = row.dataset.msg, m = M.find((x) => x.id === id);
    IN.open = IN.open === id ? null : id; IN.msg = null;
    if (IN.open && !m.read_at) { m.read_at = new Date().toISOString(); d.unread = Math.max(0, d.unread - 1); setUnread(d.unread); api('inbox-mark', { id, read: true }).catch(() => {}); }
    renderInbox();
  }));
  $$('[data-unread]').forEach((b) => b.addEventListener('click', async () => {
    const m = M.find((x) => x.id === b.dataset.unread);
    await api('inbox-mark', { id: m.id, read: false }); m.read_at = null; d.unread++; setUnread(d.unread); IN.open = null; renderInbox();
  }));
  const rt = $('#replyText'); if (rt) rt.addEventListener('input', () => { IN.reply[IN.open] = rt.value; });
  $$('[data-reply]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.reply; IN.busy = 'reply'; renderInbox();
    let r; try { r = await api('inbox-reply', { id, text: IN.reply[id] || '' }); } catch (e) { IN.busy = ''; return; }
    IN.busy = '';
    if (r.ok) { IN.reply[id] = ''; IN.msg = { kind: 'ok', text: 'Reply sent from your Gmail.' }; } else IN.msg = { kind: 'bad', text: r.message };
    renderInbox();
  }));
}

// Start last, once everything above is defined.
route();
