/* =====================================================================
   Toirem Grants – the Grants Office (signed-in grants staff only).
   #            all grants
   #grant/<id>  one grant: approve, agreement, payments, club receipts, monitoring
   ===================================================================== */
import { $, $$, esc, money, fmtD, today, notice, field, select, pill, renderApplication, renderAgreement, getJSON, postJSON } from './ui.js';
import { signIn, signOut, signedIn, email, authHeader } from './session.js';
import { suggestProofLines, paymentsInPeriod } from '/grants-server/rules.js';

const METHODS = ['Bank transfer', 'Prepaid card', 'Paid direct to supplier'];
const FILE_KIND = { bank_proof: 'Proof of bank', invoice: 'Invoice', breakdown_proof: 'Proof of spending', receipt: 'Receipt', bank_confirmation: 'Bank confirmation' };
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
  const m = location.hash.match(/^#grant\/([\w-]+)/);
  try {
    if (m) { await loadGrant(m[1]); renderGrant(); }
    else { await loadList(); renderList(); }
  } catch (e) { if (e.message !== 'signed out') app().innerHTML = frame('Grant applications', null, notice('bad', 'Could not load. Check your connection and refresh the page.')); }
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
  new: (g) => g.status === 'New application',
  agreements: (g) => /signature|Agreement to send/.test(g.status),
  monitoring: (g) => /requested|review|Receipts/.test(g.status),
  attention: (g) => g.status === 'Needs attention',
};
function renderList() {
  const gs = LIST.grants, shown = gs.filter(GROUPS[FILTER]);
  const tile = (k, label) => `<button type="button" class="tile" data-filter="${k}" aria-pressed="${FILTER === k}"><b>${gs.filter(GROUPS[k]).length}</b><span>${label}</span></button>`;
  app().innerHTML = frame('Grant applications', `<a class="btn" href="/grants/apply.html" target="_blank" rel="noopener">Open application form ↗</a>`, `
    <p class="note" style="margin-top:0">Grants of ${money(LIST.threshold)} or more need a signed agreement.</p>
    <div class="tiles">${tile('new', 'New applications')}${tile('agreements', 'Agreements outstanding')}${tile('monitoring', 'Monitoring due')}${tile('attention', 'Need attention')}</div>
    <h2>${FILTER === 'all' ? 'All grants' : 'Filtered grants'} ${FILTER !== 'all' ? '<button class="link" type="button" data-filter="all">Show all</button>' : ''}</h2>
    ${!shown.length ? `<p class="note">No grants here yet. New applications from <a href="/grants/apply.html">the application form</a> appear here and are emailed to you.</p>` : `
    <div class="tbl"><table class="list">
      <thead><tr><th>Ref</th><th>Organisation</th><th>Status</th><th class="num">Approved</th><th class="num">Paid</th><th class="num">Remaining</th></tr></thead>
      <tbody>${shown.map((g) => `<tr class="click" data-open="${g.id}" tabindex="0">
        <td>${esc(g.ref)}</td><td><span class="org">${esc(g.orgName)}</span><br><span class="note">${g.registered ? 'Charity ' + esc(g.charityNumber) : 'Club account'} · ${fmtD(g.created)}</span></td>
        <td>${pill(g.status)}</td><td class="num">${g.approved != null ? money(g.approved) : '—'}</td><td class="num">${g.paid ? money(g.paid) : '—'}</td>
        <td class="num">${g.approved != null ? money(g.approved - g.paid) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>`}
    <p class="note">Share this link with applicants: <b>${esc(location.origin)}/grants/apply.html</b></p>
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
  O.purpose = O.purpose ?? a.form.grant.use;
  O.method = O.method || (!a.registered && a.route === 'supplier' ? 'Paid direct to supplier' : 'Bank transfer');
  O.apDate = O.apDate || today();
  O.payApproved = O.payApproved || today(); O.payDate = O.payDate || today();
  O.from = O.from || yearAgo(); O.to = O.to || today();
  O.picked = O.picked || {};
  if (a.agreement && a.agreement.status === 'draft' && !SIGNATORIES) {
    api('signatories').then((s) => { SIGNATORIES = s.ok ? s.trustees : []; if (location.hash.includes(id)) renderGrant(); }).catch(() => {});
  }
}

function renderGrant() {
  const a = D.grant, t = D.threshold;
  const approved = a.approved_amount == null ? null : Number(a.approved_amount);
  const paid = a.payments.reduce((s, p) => s + Number(p.amount), 0);
  const needsAg = approved != null && approved >= t;
  const ag = a.agreement;
  const canPay = approved != null && (!needsAg || (ag && ag.status === 'signed'));
  const clubPaid = !a.registered && a.route === 'club' && !a.route_override;
  const open = a.breakdowns.find((b) => b.status !== 'closed');
  const pos = a.form.app.position === 'Other' ? a.form.app.positionOther : a.form.app.position;
  const chosen = (SIGNATORIES || []).find((s) => s.name === O.signatory);
  const B = BUSY ? 'disabled' : '';

  let h = `<p style="margin:0 0 14px"><a href="#" class="back">← All grant applications</a></p>
  ${FLASH ? `<div style="margin-bottom:12px">${notice(FLASH.kind, esc(FLASH.text))}</div>` : ''}
  ${a.alerts.map((x) => `<div class="status bad alert" style="margin-bottom:10px;justify-content:space-between;flex-wrap:wrap">
    <span><b>Alert</b> ${esc(x.message)} <span class="note">(${fmtD(x.created_at)})</span></span>
    <button class="ghost small" type="button" data-resolve="${x.id}" ${B}>Mark as dealt with</button></div>`).join('')}
  <dl class="kv">
    <div><dt>Submitted</dt><dd>${fmtD(a.created_at)}</dd></div>
    <div><dt>Applicant</dt><dd>${esc(a.applicant_name)}, ${esc(pos)}<br><span class="note">${esc(a.applicant_email)}</span></dd></div>
    <div><dt>Activity cost</dt><dd>${money(a.form.grant.cost)}</dd></div>
    <div><dt>Type</dt><dd>${a.registered ? 'Registered charity ' + esc(a.charity_number) : 'Club account · ' + (clubPaid ? 'paid to club' : 'supplier paid directly')}</dd></div>
  </dl>
  <div class="actions"><button class="ghost small" type="button" id="toggleApp">${O.showApp ? 'Hide' : 'View'} submitted application</button>
    <button class="ghost small" type="button" id="pdf">Download PDF</button></div>
  ${O.showApp ? `<div class="panel">${renderApplication(a)}</div>` : ''}
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
    const label = ag.status === 'signed' ? `Signed ${fmtD(ag.signed_date)} by ${esc(ag.signed_name)}` : ag.status === 'sent' ? `Sent ${fmtD(ag.sent_on)}, awaiting signature` : 'Ready to send';
    h += `<div class="panel"><h3>Grant agreement <span class="pill ${ag.status === 'signed' ? 'p-ok' : 'p-wait'}">${label}</span></h3>`;
    if (ag.status === 'draft') {
      h += `<p class="note" style="margin-top:0">Filled in from the application. Choose who signs for Toirem, check it, then send.</p>
      <div class="grid" style="margin-top:12px">
        ${select('ag.signatory', 'Signed for Toirem by', O.signatory || '', (SIGNATORIES || []).map((s) => s.name), { placeholder: SIGNATORIES ? 'Select a trustee' : 'Loading trustees…' })}
        ${field('ag.position', 'Position', chosen ? chosen.position : '', { ro: true })}
      </div><p class="note">Trustees as listed on the Charity Commission register for Toirem (1206622).</p>`;
    }
    h += `<div class="actions"><button class="ghost small" type="button" id="toggleAg">${O.showAg ? 'Hide' : 'Preview'} agreement</button>
      ${ag.status === 'draft' ? `<button class="primary small" type="button" id="sendAg" ${B || (!O.signatory ? 'disabled' : '')}>Send for signing</button>` : ''}</div>`;
    if (O.showAg) {
      const data = { ...D.agreement };
      if (ag.status === 'draft') data.toirem = { name: chosen ? chosen.name : null, position: chosen ? chosen.position : null, date: today() };
      h += `<div style="margin-top:14px">${renderAgreement(data)}</div>`;
    }
    h += '</div>';
  }

  // payments
  if (approved != null) {
    h += `<div class="panel"><h3>Payments <span class="note" style="margin:0">${money(paid)} paid of ${money(approved)} · ${money(approved - paid)} remaining</span></h3>
    ${a.payments.length ? `<div class="tbl"><table class="mini"><thead><tr><th>Paid on</th><th>Trustees approved</th><th class="num">Amount</th></tr></thead><tbody>
      ${a.payments.map((p) => `<tr><td>${fmtD(p.paid_on)}</td><td>${fmtD(p.trustees_approved_on)}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>`
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

  // monitoring
  if (a.payments.length) {
    h += '<div class="panel"><h3>Monitoring</h3>';
    if (!open) {
      const inP = paymentsInPeriod(a.payments.map((p) => ({ paidOn: p.paid_on, amount: Number(p.amount) })), O.from, O.to);
      h += `<p class="note" style="margin-top:0">Ask the recipient how the payments in a period were spent.</p>
      <div class="grid" style="margin-top:10px">${field('bd.from', 'From', O.from, { type: 'date' })}${field('bd.to', 'To', O.to, { type: 'date' })}</div>
      <p class="note">${inP.length} payment(s) in this period, ${money(inP.reduce((s, p) => s + p.amount, 0))} in total.</p>
      <div class="actions"><button class="primary small" type="button" id="reqBd" ${BUSY || !inP.length ? 'disabled' : ''}>Request breakdown</button></div>`;
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
  }

  app().innerHTML = frame(a.org_name, `<span class="mref">${esc(a.ref)}</span>${pill(D.status)}`, h);
  bindGrant(open);
}

function keep() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const set = (k, id) => { const x = v(id); if (x !== undefined) O[k] = x; };
  set('amount', 'ap.amount'); set('method', 'ap.method'); set('apDate', 'ap.date'); set('purpose', 'ap.purpose');
  const ov = document.getElementById('ap.override'); if (ov) O.override = ov.checked;
  set('signatory', 'ag.signatory'); set('payAmount', 'pay.amount'); set('payApproved', 'pay.approved'); set('payDate', 'pay.date');
  set('from', 'bd.from'); set('to', 'bd.to');
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
  on('pdf', async () => {
    const b = document.getElementById('pdf'); b.disabled = true; b.textContent = 'Preparing PDF…';
    try {
      const res = await fetch('/api/grants/office/pdf/' + id, { headers: await authHeader() });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('pdf')) {
        const j = await res.json().catch(() => ({}));
        FLASH = { kind: 'bad', text: j.message || "The PDF couldn't be made. Please try again." }; renderGrant(); return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || D.grant.ref + '.pdf';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      b.disabled = false; b.textContent = 'Download PDF';
    } catch (e) { FLASH = { kind: 'bad', text: "The PDF couldn't be made. Check your connection and try again." }; renderGrant(); }
  });
  on('toggleAg', () => { keep(); O.showAg = !O.showAg; renderGrant(); });
  on('ag.signatory', () => { keep(); renderGrant(); }, 'change');
  on('bd.from', () => { keep(); renderGrant(); }, 'change');
  on('bd.to', () => { keep(); renderGrant(); }, 'change');
  $$('[data-resolve]').forEach((b) => b.addEventListener('click', () => act('resolve-alert', { alertId: b.dataset.resolve }, 'Alert marked as dealt with.')));
  on('approve', () => { keep(); act('approve', { id, amount: Number(O.amount), method: O.method, approvedOn: O.apDate, purpose: O.purpose, override: !!O.override },
    (r) => (r.agreementNeeded ? 'Approved. The grant agreement is ready to check and send.' : 'Approved. No agreement needed; record payments when trustees approve them.')); });
  on('sendAg', () => { keep(); act('send-agreement', { id, signatory: O.signatory }, `Agreement sent. ${D.grant.org_name} has been emailed a link to sign.`); });
  on('recordPay', () => { keep(); act('payment', { id, amount: Number(O.payAmount), paidOn: O.payDate, approvedOn: O.payApproved },
    (r) => `Payment of ${money(O.payAmount)} recorded.${r.receiptsRequested ? ' Receipt and bank confirmation requests sent.' : ''}`, () => { O.payAmount = ''; }); });
  on('override', () => act('override', { id }, 'Switched to paying suppliers directly. No receipts will be chased.'));
  on('reqBd', () => { keep(); act('request-breakdown', { id, from: O.from, to: O.to }, 'Breakdown requested. The recipient has been emailed a link.'); });
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

route();
