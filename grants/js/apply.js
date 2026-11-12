/* =====================================================================
   Toirem Grants – public application form (3 steps).
   ===================================================================== */
import { $, $$, esc, today, frame, notice, field, select, radio, fileField, sigPicker, getJSON, postForm } from './ui.js';

const POSITIONS = ['Trustee', 'Secretary', 'Volunteer', 'Other'];
const ROLES = ['Chair', 'Treasurer', 'Secretary', 'Trustee', 'Other'];
const TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Rabbi', 'Dr'];

const S = {
  step: 1, errors: {}, busy: '', msg: null, done: null,
  registered: null, charityNumber: '', q: '', results: [], cc: null, incorrect: false, incorrectNote: '',
  org: { name: '', line1: '', postcode: '', town: '', country: 'United Kingdom', phone: '', email: '', website: '' },
  trustees: [{ name: '', role: '', other: '' }], route: 'club',
  app: { trustee: '', title: '', first: '', last: '', position: '', positionOther: '', same: false, phone: '', mobile: '', email: '', auto: false },
  bank: { bank: '', acname: '', sort: '', acno: '' },
  grant: { cost: '', annual: '', use: '', declare: false, sign: '', date: today(), font: 'Dancing Script' },
  bankProof: null, invoices: [],
};
const E = () => S.errors;
const fullName = () => [S.app.title, S.app.first, S.app.last].filter(Boolean).join(' ');
const trusteeNames = () => (S.cc ? S.cc.trustees : S.trustees.map((t) => t.name.trim()).filter(Boolean));
const errHtml = (k) => (S.errors[k] ? `<span class="err">${esc(S.errors[k])}</span>` : '');

function step1() {
  let h = `<h2>1) Organisation main or registered address and contact details</h2>
  <div class="f ${E().registered ? 'invalid' : ''}"><span class="lab">Is your organisation a registered charity in England and Wales? <span class="req">*</span></span>
  <div class="radios">${radio('reg', 'yes', S.registered === true, 'Yes')}${radio('reg', 'no', S.registered === false, 'No, club or community account')}</div>${errHtml('registered')}</div>`;
  if (S.registered === true) {
    const e = S.errors.charityNumber;
    h += `<div class="ac-wrap ${e ? 'invalid' : ''}" style="margin-top:22px">
      <label class="f" for="charityQ"><span class="lab">Charity name or registered number <span class="req">*</span></span>
        <input id="charityQ" type="text" value="${esc(S.q)}" placeholder="Start typing the charity name or number…" autocomplete="off"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="acList"></label>
      <span class="ac-spin" id="acSpin" hidden></span>
      <div class="ac-list" id="acList" role="listbox" hidden></div>
      ${e ? `<span class="err">${esc(e)}</span>` : '<span class="note">Type 3 or more letters of the name, or the charity number, then choose your charity.</span>'}
    </div>`;
    if (S.cc) {
      const c = S.cc;
      h += `<div style="margin-top:14px">${notice('ok', 'Found on the Charity Commission register. These details come from the register.')}</div>
      <div class="grid" style="margin-top:20px">
        ${field('x1', "Organisation's legal name", c.name, { ro: true, full: true })}
        ${field('x2', 'Date of registration', c.regDate || '', { ro: true })}
        ${field('x3', 'Website', c.website || '—', { ro: true })}
        ${field('x4', 'Full address', c.address.lines.join(', '), { ro: true, full: true })}
        ${field('x5', 'City / Town', c.address.town, { ro: true })}
        ${field('x6', 'Postcode', c.address.postcode, { ro: true })}
        ${field('x9', 'Country', c.address.country, { ro: true })}
        ${field('x7', 'Phone', c.phone, { ro: true })}
        ${field('x8', 'Email', c.email, { ro: true, full: true })}
        ${c.trustees.map((t, i) => field('tr' + i, 'Trustee ' + (i + 1), t, { ro: true })).join('')}
      </div>
      <label class="tick" style="margin-top:22px"><input type="checkbox" id="incorrect" ${S.incorrect ? 'checked' : ''}> These details are incorrect or out of date</label>
      ${S.incorrect ? `<div class="grid" style="margin-top:12px">${field('incorrectNote', 'Tell us what has changed', S.incorrectNote, { area: true, full: true, errs: E() })}</div>` : ''}`;
    }
  }
  if (S.registered === false) {
    const o = S.org;
    h += `<div class="grid" style="margin-top:22px">
      ${field('org.name', 'Organisation / club name', o.name, { full: true, errs: E() })}
      <div class="row full">${field('org.postcode', 'Postcode', o.postcode, { ph: 'e.g. N16 6EJ', errs: E() })}<button class="ghost" id="pc" type="button" ${S.busy === 'pc' ? 'disabled' : ''}>${S.busy === 'pc' ? 'Checking…' : 'Check postcode'}</button></div>
      ${field('org.line1', 'Full address', o.line1, { full: true, ph: 'House number and street', errs: E() })}
      ${field('org.town', 'City / Town', o.town, { errs: E() })}
      ${field('org.country', 'Country', o.country, { errs: E() })}
      ${field('org.phone', 'Phone', o.phone, { type: 'tel', errs: E() })}
      ${field('org.email', 'Email', o.email, { type: 'email', errs: E() })}
      ${field('org.website', 'Website', o.website, { req: false, opt: true, full: true })}
    </div>
    <h2>Trustees / committee members</h2>
    <div style="display:flex;flex-direction:column;gap:18px">
    ${S.trustees.map((t, i) => `<div class="trustee">
        ${field('t' + i + '.name', 'Trustee ' + (i + 1), t.name, { ph: 'Full name', errs: E() })}
        <div class="f">${select('t' + i + '.role', 'Role', t.role, ROLES, { errs: E() })}${t.role === 'Other' ? `<div style="margin-top:10px">${field('t' + i + '.other', 'Please specify', t.other, { errs: E() })}</div>` : ''}</div>
        ${i > 0 ? `<button class="link" type="button" data-rm="${i}">Remove</button>` : '<span></span>'}
      </div>`).join('')}
    </div>
    <button class="ghost small" id="addT" type="button" style="margin-top:16px">+ Add another trustee</button>
    <h2>How should the grant be paid?</h2>
    <div class="radios">${radio('route', 'supplier', S.route === 'supplier', "Toirem pays the supplier's invoice directly")}${radio('route', 'club', S.route === 'club', 'Pay into our club account')}</div>
    <p class="note">${S.route === 'supplier' ? "You'll only need to upload the invoice. Enter the supplier's bank details in the next step." : "After payment we'll ask for a receipt and bank confirmation that each invoice was paid."}</p>`;
  }
  return h;
}

function step2() {
  const a = S.app, b = S.bank, sup = S.registered === false && S.route === 'supplier';
  const orgPhone = S.cc ? S.cc.phone : S.org.phone, orgEmail = S.cc ? S.cc.email : S.org.email;
  const tl = trusteeNames(), isT = a.trustee !== '' && a.trustee !== 'none';
  const pos = a.position === 'Other' ? a.positionOther : a.position;
  return `<h2>2) Contact details of the person completing this form / main applicant</h2>
  ${tl.length ? `<div class="grid" style="margin-bottom:20px">${select('isTrustee', 'Are you one of the trustees?', a.trustee,
    [...tl.map((n, i) => ({ value: String(i), label: 'Yes, I am ' + n })), { value: 'none', label: "No, I'm not a trustee" }], { errs: { isTrustee: S.errors.trustee }, full: true })}</div>` : ''}
  <div class="grid">
    ${select('app.title', 'Title', a.title, TITLES, { errs: E() })}
    ${field('app.first', 'First name', a.first, { ro: isT, errs: E() })}
    ${field('app.last', 'Last name', a.last, { ro: isT, errs: E() })}
    ${isT ? field('app.posRo', 'Position in organisation', pos, { ro: true }) : `<div class="f">${select('app.position', 'Position in organisation', a.position, POSITIONS, { errs: E() })}
      ${a.position === 'Other' ? `<div style="margin-top:10px">${field('app.positionOther', 'Please specify', a.positionOther, { errs: E() })}</div>` : ''}</div>`}
  </div>
  <label class="tick" style="margin:22px 0 4px"><input type="checkbox" id="same" ${a.same ? 'checked' : ''}> Same contact details as the organisation${orgPhone || orgEmail ? ` (${esc([orgPhone, orgEmail].filter(Boolean).join(', '))})` : ''}</label>
  ${a.same ? '' : `<div class="grid" style="margin-top:16px">
    ${field('app.phone', 'Phone', a.phone, { type: 'tel', errs: E() })}
    ${field('app.mobile', 'Mobile', a.mobile, { type: 'tel', req: false, opt: true })}
    ${field('app.email', 'Email', a.email, { type: 'email', errs: E() })}
  </div>`}
  <h2>3) ${sup ? "Supplier's bank account details" : 'Bank account details'}</h2>
  <div class="grid aligned">
    ${field('bank.bank', 'Bank / Building Society', b.bank, { errs: E() })}
    ${field('bank.acname', 'Name on Account', b.acname, { errs: E() })}
    ${field('bank.sort', 'Sort Code', b.sort, { ph: '00-00-00', errs: E() })}
    ${field('bank.acno', 'Account Number', b.acno, { ph: '8 digits', errs: E() })}
    ${fileField('proof', sup ? 'Supplier invoice showing bank details' : 'Proof of Bank', S.bankProof ? [S.bankProof.name] : [],
      'Recent bank statement or bank letter showing the account name (PDF or photo, up to 10 MB).', { errs: E(), errKey: 'bank.proof' })}
  </div>`;
}

function step3() {
  const g = S.grant;
  if (!g.use && S.cc) g.use = S.cc.activities;
  return `<h2>4) Grant information</h2>
  <div class="grid">
    ${field('grant.cost', 'How much does the activity cost in total? (£)', g.cost, { type: 'number', ph: '50000', full: true, errs: E() })}
    ${field('grant.annual', 'Please estimate the value of annual donations you expect to receive from us (£)', g.annual, { type: 'number', ph: '10000', full: true, errs: E() })}
    ${S.cc && S.cc.objects ? `<div class="objects full"><b>Your charitable objects (from the Charity Commission register)</b>${esc(S.cc.objects)}</div>` : ''}
    ${field('grant.use', 'Please specify how you intend to use the funds received from us', g.use, { area: true, full: true, errs: E() })}
    ${S.registered === false ? fileField('inv', 'Invoices for this grant', S.invoices.map((f) => f.name), 'Upload every invoice you are asking us to fund (up to 8 files).', { multiple: true, errs: E(), errKey: 'invoices' }) : ''}
  </div>
  <h2>5) Confirmation</h2>
  <div class="decl">
    <span>We certify that, to the best of our knowledge and belief, the information provided in this application is true, accurate and complete.</span>
    <span>We confirm that the organisation is eligible for charitable grant assistance and undertake to notify Toirem promptly of any material change in its circumstances.</span>
    <span>We acknowledge that any grant awarded must be used solely for the purpose stated in this application.</span>
    <span>We undertake to retain all relevant receipts and records and provide them to Toirem upon request.</span>
    <span>We further acknowledge that Toirem may require repayment of all or part of the grant if it is used for any other purpose or if any information provided is found to be inaccurate or misleading.</span>
  </div>
  <label class="tick ${E()['grant.declare'] ? 'invalid' : ''}" style="margin-top:16px"><input type="checkbox" id="declare" ${g.declare ? 'checked' : ''}> I agree to the declarations above on behalf of the organisation <span class="req">*</span></label>
  ${errHtml('grant.declare')}
  <div class="grid" style="margin-top:20px">
    ${field('n1', 'Name', fullName(), { ro: true })}
    ${field('grant.sign', 'Signature (type your full name)', g.sign, { ph: 'Full name', errs: E() })}
    ${field('grant.date', 'Date signed', g.date, { type: 'date', errs: E() })}
  </div>
  ${sigPicker('sigfont', g.font, g.sign || fullName())}`;
}

function render() {
  const app = $('#app');
  if (S.done) {
    app.innerHTML = frame('Grant Application', 'Submitted', notice('ok', `Thank you. Your application has been sent to Toirem. Your reference is <b>${esc(S.done)}</b>, and we've emailed you a confirmation.`));
    return;
  }
  const body = S.step === 1 ? step1() : S.step === 2 ? step2() : step3();
  app.innerHTML = frame('Grant Application', `0${S.step}/03`,
    (S.msg ? `<div style="margin-bottom:16px">${notice(S.msg.kind, esc(S.msg.text))}</div>` : '') + body +
    `<div class="nav">${S.step > 1 ? '<button class="ghost" id="back" type="button">Back</button>' : '<span></span>'}
     <button class="primary" id="next" type="button" ${S.busy === 'submit' ? 'disabled' : ''}>${S.step < 3 ? 'Continue' : S.busy === 'submit' ? 'Sending…' : 'Submit application'}</button></div>`);
  bind();
}

function setK(k, v) {
  if (/^(x\d|tr\d|n1|app\.posRo)/.test(k)) return;
  if (k === 'charityQ') { S.q = v; return; }
  if (k === 'incorrectNote') { S[k] = v; return; }
  const m = k.match(/^t(\d+)\.(name|role|other)$/); if (m) { S.trustees[m[1]][m[2]] = v; return; }
  const [a, b] = k.split('.'); if (b && S[a]) S[a][b] = v;
}

function pickTrustee(v) {
  const a = S.app; a.trustee = v; delete S.errors.trustee;
  if (v === '' || v === 'none') { if (a.auto) Object.assign(a, { first: '', last: '', position: '', positionOther: '', auto: false }); return; }
  const parts = (trusteeNames()[+v] || '').trim().split(/\s+/);
  a.first = parts.shift() || ''; a.last = parts.join(' ');
  const t = S.cc ? null : S.trustees.filter((x) => x.name.trim())[+v];
  const role = t ? (t.role === 'Other' ? t.other : t.role) : 'Trustee';
  if (role === 'Trustee' || role === 'Secretary') { a.position = role; a.positionOther = ''; }
  else if (role === 'Chair' || role === 'Treasurer') { a.position = 'Other'; a.positionOther = 'Trustee (' + role + ')'; }
  else { a.position = 'Other'; a.positionOther = role || 'Trustee'; }
  a.auto = true;
  ['app.first', 'app.last', 'app.position', 'app.positionOther'].forEach((k) => delete S.errors[k]);
}

function on(sel, fn, ev = 'click') { const el = $(sel); if (el) el.addEventListener(ev, fn); }

function bind() {
  $$('[data-k]').forEach((el) => {
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (el.id === 'isTrustee') return;
      if (el.id === 'charityQ') return;
      setK(el.dataset.k, el.value);
      if (S.errors[el.dataset.k]) { delete S.errors[el.dataset.k]; const l = el.closest('label'); l?.classList.remove('invalid'); l?.querySelector('.err')?.remove(); }
      if (el.tagName === 'SELECT' && /position|role/.test(el.dataset.k)) {
        render();
        if (el.value === 'Other') document.getElementById(el.dataset.k === 'app.position' ? 'app.positionOther' : el.dataset.k.replace('role', 'other'))?.focus();
      }
      if (el.dataset.k === 'grant.sign') $$('.sigopt .sp').forEach((s) => { s.textContent = el.value || fullName() || 'Your name'; });
    });
  });
  $$('input[name=reg]').forEach((r) => r.addEventListener('change', () => { S.registered = r.value === 'yes'; S.errors = {}; S.msg = null; render(); }));
  $$('input[name=route]').forEach((r) => r.addEventListener('change', () => { S.route = r.value; render(); }));
  $$('input[name=sigfont]').forEach((r) => r.addEventListener('change', () => { S.grant.font = r.value; }));
  bindTypeahead();
  on('#incorrect', (e) => { S.incorrect = e.target.checked; render(); }, 'change');
  on('#pc', postcode);
  on('#addT', () => { S.trustees.push({ name: '', role: '', other: '' }); render(); });
  $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { S.trustees.splice(+b.dataset.rm, 1); S.errors = {}; render(); }));
  on('#isTrustee', (e) => { pickTrustee(e.target.value); render(); }, 'change');
  on('#same', (e) => { S.app.same = e.target.checked; render(); }, 'change');
  on('#proof', (e) => { const f = e.target.files[0]; if (f) { S.bankProof = f; delete S.errors['bank.proof']; render(); } }, 'change');
  on('#inv', (e) => { S.invoices = [...e.target.files]; delete S.errors.invoices; render(); }, 'change');
  on('#declare', (e) => { S.grant.declare = e.target.checked; delete S.errors['grant.declare']; }, 'change');
  on('#back', () => { S.step--; S.errors = {}; S.msg = null; render(); scrollTo(0, 0); });
  on('#next', next);
}

/* ---------- charity type-ahead: searches as you type, no button ---------- */
let acTimer = 0, acSeq = 0, acActive = -1;
function bindTypeahead() {
  const input = $('#charityQ'); if (!input) return;
  const list = $('#acList'), spin = $('#acSpin');
  const show = (html) => { list.innerHTML = html; list.hidden = !html; input.setAttribute('aria-expanded', String(!!html)); acActive = -1; };
  const busy = (on) => { spin.hidden = !on; };
  const draw = () => {
    if (!S.results.length) return show('');
    show(S.results.map((r, i) => `<button type="button" class="ac-item" role="option" id="ac${i}" data-num="${esc(r.number)}">
      <b>${esc(r.name)}</b><span>Charity ${esc(r.number)}${r.registered ? ' · registered ' + esc(r.registered.slice(0, 4)) : ''}</span></button>`).join(''));
    $$('.ac-item', list).forEach((b) => b.addEventListener('mousedown', (ev) => { ev.preventDefault(); choose(b.dataset.num); }));
  };
  const choose = (num) => { show(''); lookup(num); };
  input.addEventListener('input', () => {
    S.q = input.value; S.cc = null; S.results = [];
    if (S.errors.charityNumber) { delete S.errors.charityNumber; const w = input.closest('.ac-wrap'); w.classList.remove('invalid'); const er = w.querySelector('.err'); if (er) er.outerHTML = '<span class="note">Type 3 or more letters of the name, or the charity number, then choose your charity.</span>'; }
    clearTimeout(acTimer); show('');
    const q = S.q.trim(), digits = q.replace(/\s/g, '');
    const isNum = /^\d+$/.test(digits);
    if (isNum ? digits.length < 6 : q.length < 3) { busy(false); return; }
    acTimer = setTimeout(async () => {
      const seq = ++acSeq; busy(true);
      if (isNum) {
        const r = await getJSON('lookup?' + new URLSearchParams({ number: digits }));
        if (seq !== acSeq) return; busy(false);
        if (r.ok) { S.results = [{ number: r.charity.number, name: r.charity.name, registered: r.charity.regDate }]; draw(); }
        else if (digits.length >= 7) show(`<div class="ac-empty">${esc(r.message || 'No charity with that number.')}</div>`);
        return;
      }
      const r = await getJSON('search?' + new URLSearchParams({ q }));
      if (seq !== acSeq) return; busy(false);
      if (r.ok) { S.results = r.results || []; draw(); }
      else show(`<div class="ac-empty">${esc(r.message || 'No matches.')}</div>`);
    }, 350);
  });
  input.addEventListener('keydown', (e) => {
    const items = $$('.ac-item', list);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return; e.preventDefault();
      acActive = (acActive + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('on', i === acActive));
      input.setAttribute('aria-activedescendant', 'ac' + acActive);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) choose(items[Math.max(acActive, 0)].dataset.num);
    } else if (e.key === 'Escape') show('');
  });
  input.addEventListener('blur', () => setTimeout(() => show(''), 150));
  input.addEventListener('focus', () => { if (S.results.length && !S.cc) draw(); });
}

async function lookup(number) {
  S.busy = 'lookup'; S.msg = null; delete S.errors.charityNumber;
  const sp = $('#acSpin'); if (sp) sp.hidden = false;
  const r = await getJSON('lookup?' + new URLSearchParams({ number }));
  S.busy = '';
  if (r.ok) { S.cc = r.charity; S.charityNumber = r.charity.number; S.q = r.charity.name; S.results = []; S.app.trustee = ''; }
  else { S.cc = null; S.errors.charityNumber = r.message; }
  render();
}

async function postcode() {
  S.busy = 'pc'; render();
  const r = await getJSON('postcode?' + new URLSearchParams({ postcode: S.org.postcode }));
  S.busy = '';
  if (r.ok) {
    S.org.postcode = r.postcode; if (r.town) S.org.town = r.town; if (r.country) S.org.country = r.country;
    delete S.errors['org.postcode']; delete S.errors['org.town'];
    S.msg = { kind: 'ok', text: `${r.postcode} found: ${[r.town, r.county].filter(Boolean).join(', ')}. Town filled in.` };
  } else S.msg = { kind: 'bad', text: r.message || "We couldn't check that postcode." };
  render();
}

function validate() {
  const X = {}, need = (k, v, m = 'This field is required.') => { if (!String(v == null ? '' : v).trim()) X[k] = m; };
  const email = (v) => /^\S+@\S+\.\S+$/.test(v || '');
  if (S.step === 1) {
    if (S.registered === null) X.registered = 'Choose one to continue.';
    if (S.registered === true && !S.cc) X.charityNumber = 'Start typing your charity name or number, then choose it from the list.';
    if (S.registered === true && S.incorrect) need('incorrectNote', S.incorrectNote);
    if (S.registered === false) {
      ['name', 'line1', 'postcode', 'town', 'country', 'phone'].forEach((k) => need('org.' + k, S.org[k]));
      if (!email(S.org.email)) X['org.email'] = 'Enter a valid email address.';
      S.trustees.forEach((t, i) => { need(`t${i}.name`, t.name); need(`t${i}.role`, t.role, 'Choose a role.'); if (t.role === 'Other') need(`t${i}.other`, t.other, 'Please specify the role.'); });
    }
  }
  if (S.step === 2) {
    if (trusteeNames().length) need('trustee', S.app.trustee, 'Tell us whether you are one of the trustees.');
    need('app.title', S.app.title, 'Choose a title.'); need('app.first', S.app.first); need('app.last', S.app.last);
    need('app.position', S.app.position, 'Choose a position.');
    if (S.app.position === 'Other') need('app.positionOther', S.app.positionOther, 'Please specify the position.');
    if (!S.app.same) { need('app.phone', S.app.phone); if (!email(S.app.email)) X['app.email'] = 'Enter a valid email address.'; }
    if (S.app.same && !(S.cc ? S.cc.email : S.org.email)) X['app.email'] = "There's no organisation email to copy. Untick the box and enter yours.";
    need('bank.bank', S.bank.bank); need('bank.acname', S.bank.acname);
    if (!/^\d{2}-?\d{2}-?\d{2}$/.test(S.bank.sort.trim())) X['bank.sort'] = 'Enter 6 digits, e.g. 40-16-15.';
    if (!/^\d{8}$/.test(S.bank.acno.trim())) X['bank.acno'] = 'Enter the 8 digit account number.';
    if (!S.bankProof) X['bank.proof'] = 'Upload proof of bank to continue.';
    else if (S.bankProof.size > 10 * 1024 * 1024) X['bank.proof'] = 'The file must be under 10 MB.';
  }
  if (S.step === 3) {
    need('grant.cost', S.grant.cost); need('grant.annual', S.grant.annual); need('grant.use', S.grant.use);
    if (S.registered === false && !S.invoices.length) X.invoices = 'Upload at least one invoice.';
    if (S.registered === false && S.invoices.length > 8) X.invoices = 'Upload up to 8 invoices. Combine extra ones into one PDF.';
    if (!S.grant.declare) X['grant.declare'] = 'Tick to agree to the declarations.';
    need('grant.sign', S.grant.sign, 'Type your full name to sign.'); need('grant.date', S.grant.date, 'Choose the date you signed.');
  }
  return X;
}

/** Which step a server-side error belongs to, so we can take the applicant back there. */
const stepOf = (k) => (/^(registered|charityNumber|incorrectNote|org\.|t\d)/.test(k) ? 1 : /^(app\.|bank\.|trustee)/.test(k) ? 2 : 3);

async function next() {
  S.errors = validate(); S.msg = null;
  if (Object.keys(S.errors).length) { render(); $('.err')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (S.step < 3) { S.step++; render(); scrollTo(0, 0); return; }
  const a = { ...S.app }; delete a.auto;
  const payload = S.registered
    ? { registered: true, charityNumber: S.cc.number, incorrect: S.incorrect, incorrectNote: S.incorrectNote, app: a, bank: S.bank, grant: S.grant }
    : { registered: false, org: S.org, trustees: S.trustees, route: S.route, app: a, bank: S.bank, grant: S.grant };
  const fd = new FormData();
  fd.set('form', JSON.stringify(payload));
  fd.set('bankProof', S.bankProof);
  S.invoices.forEach((f) => fd.append('invoices', f));
  S.busy = 'submit'; render();
  const r = await postForm('submit', fd);
  S.busy = '';
  if (r.ok) { S.done = r.ref; render(); scrollTo(0, 0); return; }
  if (r.errors) {
    S.errors = r.errors;
    S.step = Math.min(...Object.keys(r.errors).map(stepOf));
    S.msg = { kind: 'bad', text: 'Please check the highlighted fields.' };
  } else S.msg = { kind: 'bad', text: r.message || "We couldn't send your application. Please try again." };
  render(); scrollTo(0, 0);
}

render();
