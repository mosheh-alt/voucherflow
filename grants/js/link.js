/* =====================================================================
   Toirem Grants – pages opened from Toirem's emails:
   #sign/<token>  #breakdown/<token>  #proof/<token>  #receipts/<token>
   The token in the address is the permission; it stops working once used.
   ===================================================================== */
import { $, $$, esc, money, fmtD, today, frame, notice, field, fileField, sigPicker, renderAgreement, sigFont, postJSON, postForm } from './ui.js';

const [kind, token] = (location.hash.slice(1) || '').split('/');
const app = () => $('#app');
const expired = () => frame('Your Grant', null, notice('warn', "This link has expired or has already been used. If you need help, email <b>info@toirem.org.uk</b>."));
const thanks = (text) => { app().innerHTML = frame('Your Grant', null, notice('ok', esc(text))); scrollTo(0, 0); };
let L = null;

async function start() {
  if (!['sign', 'breakdown', 'proof', 'receipts'].includes(kind) || !token) { app().innerHTML = expired(); return; }
  L = await postJSON('link', { kind, token });
  if (!L.ok) { app().innerHTML = L.message && !/expired/i.test(L.message) ? frame('Your Grant', null, notice('bad', esc(L.message))) : expired(); return; }
  ({ sign, breakdown, proof, receipts })[kind]();
}

/* ---------- sign the agreement ---------- */
function sign() {
  const s = { name: '', date: today(), font: 'Dancing Script', accepted: false, errs: {}, msg: '' };
  const draw = () => {
    app().innerHTML = frame('Your Grant', esc(L.ref), `<h2>Sign your grant agreement</h2>${renderAgreement(L.agreement)}
      <div class="grid" style="margin-top:20px">${field('name', 'Signature (type your full name)', s.name, { errs: s.errs })}${field('date', 'Date signed', s.date, { type: 'date', errs: s.errs })}</div>
      ${sigPicker('font', s.font, s.name)}
      <label class="tick ${s.errs.accepted ? 'invalid' : ''}" style="margin-top:16px"><input type="checkbox" id="accepted" ${s.accepted ? 'checked' : ''}> I accept the grant on these terms on behalf of ${esc(L.orgName)}</label>
      ${s.errs.accepted ? `<span class="err">${esc(s.errs.accepted)}</span>` : ''}
      ${s.msg ? `<div style="margin-top:12px">${notice('bad', esc(s.msg))}</div>` : ''}
      <div class="actions"><button class="primary" type="button" id="go">Sign agreement</button></div>`);
    preview();
    $('#name').addEventListener('input', (e) => { s.name = e.target.value; $$('.sigopt .sp').forEach((x) => { x.textContent = s.name || 'Your name'; }); preview(); });
    $('#date').addEventListener('change', (e) => { s.date = e.target.value; preview(); });
    $$('input[name=font]').forEach((r) => r.addEventListener('change', () => { s.font = r.value; preview(); }));
    $('#accepted').addEventListener('change', (e) => { s.accepted = e.target.checked; });
    $('#go').addEventListener('click', go);
  };
  const preview = () => {
    $('#agName').textContent = s.name; $('#agSig').textContent = s.name; $('#agSig').style.fontFamily = sigFont(s.font);
    $('#agDate').textContent = s.name ? fmtD(s.date) : '';
  };
  const go = async () => {
    s.errs = {};
    if (!s.name.trim()) s.errs.name = 'Type your full name to sign.';
    if (!s.date) s.errs.date = 'Choose the date.';
    if (!s.accepted) s.errs.accepted = 'Tick to accept the terms.';
    if (Object.keys(s.errs).length) return draw();
    $('#go').disabled = true; $('#go').textContent = 'Signing…';
    const r = await postJSON('sign', { token, name: s.name, date: s.date, font: s.font, accepted: true });
    if (r.ok) thanks("Thank you. The agreement is signed and Toirem has been told. You'll receive payment as agreed.");
    else { s.msg = r.message || "We couldn't save your signature. Please try again."; draw(); }
  };
  draw();
}

/* ---------- spending breakdown ---------- */
function breakdown() {
  const b = L.breakdown;
  const lines = [{ description: '', amount: '' }, { description: '', amount: '' }];
  let errs = {}, msg = '';
  const draw = () => {
    const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    app().innerHTML = frame('Your Grant', esc(L.ref), `<h2>Tell us how the grant was spent</h2>
      <p>Between ${fmtD(b.from)} and ${fmtD(b.to)} Toirem paid ${esc(L.orgName)} <b>${money(b.total)}</b>:</p>
      <ul class="note">${b.payments.map((p) => `<li>${fmtD(p.paid_on)}: ${money(p.amount)}</li>`).join('')}</ul>
      <p>List what it was spent on.</p>
      <div style="display:flex;flex-direction:column;gap:14px;margin-top:10px">${lines.map((l, i) => `<div class="trustee">
        ${field('d' + i, 'What was it spent on?', l.description, { ph: 'e.g. Food vouchers for 30 families', errs })}
        ${field('a' + i, 'Amount (£)', l.amount, { type: 'number', errs })}
        ${i > 0 ? `<button class="link" type="button" data-rm="${i}">Remove</button>` : '<span></span>'}</div>`).join('')}</div>
      <button class="ghost small" type="button" id="add" style="margin-top:14px">+ Add a line</button>
      <p class="note" id="tot">Total ${money(total)} of ${money(b.total)} paid.</p>
      ${msg ? notice('bad', esc(msg)) : ''}
      <div class="actions"><button class="primary" type="button" id="go">Submit breakdown</button></div>`);
    lines.forEach((l, i) => {
      $('#d' + i).addEventListener('input', (e) => { l.description = e.target.value; });
      $('#a' + i).addEventListener('input', (e) => { l.amount = e.target.value; $('#tot').textContent = `Total ${money(lines.reduce((s, x) => s + (Number(x.amount) || 0), 0))} of ${money(b.total)} paid.`; });
    });
    $$('[data-rm]').forEach((x) => x.addEventListener('click', () => { lines.splice(+x.dataset.rm, 1); errs = {}; draw(); }));
    $('#add').addEventListener('click', () => { lines.push({ description: '', amount: '' }); draw(); });
    $('#go').addEventListener('click', go);
  };
  const go = async () => {
    errs = {};
    lines.forEach((l, i) => {
      if (!l.description.trim()) errs['d' + i] = 'Describe what was bought or paid for.';
      if (!(Number(l.amount) > 0)) errs['a' + i] = 'Enter the amount.';
    });
    if (Object.keys(errs).length) return draw();
    $('#go').disabled = true; $('#go').textContent = 'Sending…';
    const r = await postJSON('breakdown', { token, lines: lines.map((l) => ({ description: l.description, amount: Number(l.amount) })) });
    if (r.ok) thanks('Thank you. Your breakdown has been sent to Toirem.');
    else { msg = r.message || "We couldn't send your breakdown. Please try again."; draw(); }
  };
  draw();
}

/* ---------- proof for picked lines ---------- */
function proof() {
  const files = {}; let msg = '';
  const draw = () => {
    app().innerHTML = frame('Your Grant', esc(L.ref), `<h2>Upload proof for these items</h2>
      <p>Toirem's trustees picked these lines from your breakdown. Upload a receipt or invoice for each (PDF or photo, up to 10 MB).</p>
      <div class="grid" style="margin-top:10px">${L.breakdown.lines.map((l) => fileField('p-' + l.id, `${l.description} · ${money(l.amount)}`, files[l.id] ? [files[l.id].name] : [], 'Choose a file')).join('')}</div>
      ${msg ? `<div style="margin-top:12px">${notice('bad', esc(msg))}</div>` : ''}
      <div class="actions"><button class="primary" type="button" id="go">Submit proof</button></div>`);
    L.breakdown.lines.forEach((l) => $('#p-' + CSS.escape(l.id)).addEventListener('change', (e) => { if (e.target.files[0]) { files[l.id] = e.target.files[0]; draw(); } }));
    $('#go').addEventListener('click', go);
  };
  const go = async () => {
    const missing = L.breakdown.lines.filter((l) => !files[l.id]).length;
    if (missing) { msg = `Upload a file for each item (${missing} still missing).`; return draw(); }
    const fd = new FormData(); fd.set('token', token);
    Object.entries(files).forEach(([id, f]) => fd.set(id, f));
    $('#go').disabled = true; $('#go').textContent = 'Uploading…';
    const r = await postForm('proof', fd);
    if (r.ok) thanks('Thank you. Your documents have been sent to Toirem.');
    else { msg = r.message || "We couldn't upload your files. Please try again."; draw(); }
  };
  draw();
}

/* ---------- club receipts and bank confirmation ---------- */
function receipts() {
  const files = {}; let msg = '';
  const draw = () => {
    app().innerHTML = frame('Your Grant', esc(L.ref), `<h2>Receipts and bank confirmation</h2>
      <p>For each invoice Toirem funded, upload the supplier's receipt and your bank's confirmation that you paid it.</p>
      <div style="display:flex;flex-direction:column;gap:22px;margin-top:10px">${L.invoices.map((r) => `<div><b style="color:var(--ink)">${esc(r.name)}</b>
        <div class="grid" style="margin-top:6px">
          ${r.receipt ? '<p class="files">✓ Receipt received</p>' : fileField(r.id + '-r', 'Receipt', files[r.id + '.receipt'] ? [files[r.id + '.receipt'].name] : [], 'PDF or photo')}
          ${r.bank ? '<p class="files">✓ Bank confirmation received</p>' : fileField(r.id + '-b', 'Bank payment confirmation', files[r.id + '.bank'] ? [files[r.id + '.bank'].name] : [], 'Bank statement line or payment confirmation')}
        </div></div>`).join('')}</div>
      ${msg ? `<div style="margin-top:12px">${notice('bad', esc(msg))}</div>` : ''}
      <div class="actions"><button class="primary" type="button" id="go">Submit documents</button></div>`);
    L.invoices.forEach((r) => {
      [['-r', '.receipt'], ['-b', '.bank']].forEach(([suf, k]) => {
        const el = document.getElementById(r.id + suf);
        if (el) el.addEventListener('change', (e) => { if (e.target.files[0]) { files[r.id + k] = e.target.files[0]; draw(); } });
      });
    });
    $('#go').addEventListener('click', go);
  };
  const go = async () => {
    if (!Object.keys(files).length) { msg = 'Choose at least one file to upload.'; return draw(); }
    const fd = new FormData(); fd.set('token', token);
    Object.entries(files).forEach(([k, f]) => fd.set(k, f));
    $('#go').disabled = true; $('#go').textContent = 'Uploading…';
    const r = await postForm('receipts', fd);
    if (!r.ok) { msg = r.message || "We couldn't upload your files. Please try again."; return draw(); }
    const complete = L.invoices.every((x) => (x.receipt || files[x.id + '.receipt']) && (x.bank || files[x.id + '.bank']));
    if (complete) thanks('Thank you. All your documents have been sent to Toirem.');
    else {
      L.invoices.forEach((x) => { if (files[x.id + '.receipt']) x.receipt = true; if (files[x.id + '.bank']) x.bank = true; });
      Object.keys(files).forEach((k) => delete files[k]);
      msg = ''; draw();
      app().insertAdjacentHTML('afterbegin', `<div style="margin-bottom:12px">${notice('ok', 'Saved. Some documents are still needed. You can add them now or come back to the link in your email.')}</div>`);
    }
  };
  draw();
}

// Opening a second emailed link in the same tab only changes the part after #, so load it fresh.
window.addEventListener('hashchange', () => location.reload());
start();
