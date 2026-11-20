/* =====================================================================
   Toirem Grants – Individual Grant Application Form (online version of the paper form).
   /grants/individual.html               a new application
   /grants/individual.html#complete/<t>  completing a past grant imported from the platform
   ===================================================================== */
import { individualPdf } from './indpdf.js';
import { $, $$, esc, today, frame, notice, field, select, radio, fileField, sigPicker, getJSON, postJSON, postForm } from './ui.js';
import { IND_TITLES, MARITAL, INCOME, PURPOSES, FREQUENCY, IND_METHODS, validateIndividual } from '/grants-server/individual.js';

const S = {
  step: 1, errors: {}, busy: '', msg: null, done: null, complete: null,
  f: {
    person: { title: '', first: '', last: '', address: '', town: '', postcode: '', phone: '', email: '' },
    family: { status: '', children: '', childrenCount: '', income: '', benefits: '', benefitsAmount: '' },
    grant: { purposes: [], other: '', comments: '', amount: '', frequency: '' },
    method: '', bank: { acname: '', sort: '', acno: '' },
    endorser: { name: '', position: '', address: '', town: '', postcode: '', phone: '', email: '' },
    confirm: { declare: false, name: '', sign: '', date: today(), font: 'Dancing Script' },
  },
  files: { proof: null, id: null, benefits: null },
};
const E = () => S.errors;
const app = () => $('#app');
const er = (k) => (E()[k] ? `<span class="perr">${esc(E()[k])}</span>` : '');

/* ---- paper-form pieces: "Label ______" answers, light-blue circles, file pickers ---- */
const inl = (k, label, val, { flex = '1 1 160px', type = 'text', ph = '', cls = '' } = {}) =>
  `<label class="pf ${cls} ${E()[k] ? 'invalid' : ''}" style="flex:${flex}" for="${k}"><span>${label}</span><input id="${k}" data-k="${k}" type="${type}" value="${esc(val)}" placeholder="${esc(ph)}" ${type === 'number' ? 'min="0" step="any" inputmode="decimal"' : ''}>${er(k)}</label>`;
const circle = (name, value, checked, text, type = 'radio', extra = '') =>
  `<label class="pr"><input type="${type}" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''} ${extra}> ${text}</label>`;
const grp = (k, inner) => `<div class="pgrp ${E()[k] ? 'invalid' : ''}">${inner}${er(k)}</div>`;
const doc = (k, label, hint) => {
  const f = S.files[k.split('.')[1]];
  return `<div class="pdoc ${E()[k] ? 'invalid' : ''}"><span>${label} <span class="psmall">${hint}</span></span>
    <label class="pick">${f ? 'Change file' : 'Choose file'}<input type="file" id="${k}" accept=".pdf,.jpg,.jpeg,.png" hidden></label>
    ${f ? `<span class="got">✓ ${esc(f.name)}</span>` : ''}${er(k)}</div>`;
};

function page1() {
  const p = S.f.person, fam = S.f.family, g = S.f.grant, b = S.f.bank;
  return `<h2 class="ph">1. Contact Information:</h2>
  <div class="pl">
    <label class="pf" style="flex:0 1 150px" for="person.title"><span>Title</span><select id="person.title" data-k="person.title"><option value=""></option>${IND_TITLES.map((t) => `<option ${p.title === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    ${inl('person.first', 'First name', p.first, { flex: '2 1 190px' })}${inl('person.last', 'Surname', p.last, { flex: '2 1 190px' })}
  </div>
  <div class="addr-slot" id="slot-person"></div>
  <div class="pl">${inl('person.address', 'Address', p.address, { flex: '3 1 260px' })}${inl('person.town', 'City/Town', p.town, { flex: '1.4 1 170px' })}${inl('person.postcode', 'Postcode', p.postcode, { flex: '1 1 150px' })}</div>
  <div class="pl">${inl('person.phone', 'Phone', p.phone, { type: 'tel', flex: '2 1 220px' })}${inl('person.email', 'Email', p.email, { type: 'email', flex: '3 1 260px' })}</div>

  <h2 class="ph">2. Family Information:</h2>
  ${grp('family.status', `<div class="prow" style="gap:10px 54px;margin-left:30px">${MARITAL.map((m) => circle('status', m, fam.status === m, m)).join('')}</div>`)}

  <div class="pl q" style="margin-top:28px"><h2 class="ph sm">3. Do you have any dependent children?</h2>
    ${grp('family.children', `<div class="prow" style="margin:0">${circle('children', 'no', fam.children === 'no', 'No')}${circle('children', 'yes', fam.children === 'yes', 'Yes')}</div>`)}
    ${inl('family.childrenCount', 'How many?', fam.childrenCount, { type: 'number', flex: '0 1 170px' })}</div>

  <h2 class="ph">4. Financial Information:</h2>
  <p class="pnote">Please provide your average monthly salary income per person:</p>
  ${grp('family.income', `<div class="prow" style="margin-left:24px">${INCOME.map((m) => circle('income', m, fam.income === m, m)).join('')}</div>`)}

  <h2 class="ph">5. Do you receive any state benefits?</h2>
  ${grp('family.benefits', `<div class="pl q" style="margin:4px 0">${circle('benefits', 'yes', fam.benefits === 'yes', 'Yes')}${inl('family.benefitsAmount', 'How much?', fam.benefitsAmount, { flex: '0 1 230px', ph: 'e.g. £1,200 a month' })}<span style="width:24px"></span>${circle('benefits', 'no', fam.benefits === 'no', 'No')}</div>`)}

  <h2 class="ph">6. Purpose of grant?</h2>
  ${grp('grant.purposes', `<div class="prow" style="gap:8px 22px">${PURPOSES.filter((x) => x !== 'Other').map((x) => circle('purpose', x, g.purposes.includes(x), x, 'checkbox', `data-purpose="${esc(x)}"`)).join('')}
    ${circle('purpose', 'Other', g.purposes.includes('Other'), 'Other', 'checkbox', 'data-purpose="Other"')}</div>`)}
  <div class="pl">${inl('grant.other', 'Other', g.other, { flex: '1 1 100%', ph: g.purposes.includes('Other') ? 'Please specify' : '' })}</div>
  <p class="pnote" style="margin-top:20px">Please provide any additional comments or information that may help us make a decision <span class="req">*</span></p>
  <div class="pgrp ${E()['grant.comments'] ? 'invalid' : ''}"><textarea class="pruled" id="grant.comments" data-k="grant.comments" rows="3" aria-required="true">${esc(g.comments)}</textarea>${er('grant.comments')}</div>

  <div class="pl q" style="margin-top:26px"><h2 class="ph" style="margin:0">7. Amount of grant requested?:</h2>
    ${inl('grant.amount', '£', g.amount, { type: 'number', flex: '0 1 120px' })}
    ${grp('grant.frequency', `<div class="prow" style="margin:0">${FREQUENCY.map((x) => circle('frequency', x, g.frequency === x, x)).join('')}</div>`)}</div>

  <h2 class="ph">8. Payment method:</h2>
  ${grp('method', `<div class="pl q" style="margin:4px 0"><span style="font-size:15.5px">How would you like to receive your grant?</span>${IND_METHODS.map((x) => circle('method', x, S.f.method === x, x)).join('')}</div>`)}
  <div class="pl" style="${S.f.method === 'Prepaid card' ? 'opacity:.45' : ''}">${inl('bank.acname', 'Account Name', b.acname, { flex: '2 1 220px' })}${inl('bank.sort', 'Sort Code', b.sort, { flex: '1 1 150px', ph: '00-00-00' })}${inl('bank.acno', 'Account Number', b.acno, { flex: '1.3 1 190px' })}</div>`;
}

function page2() {
  const en = S.f.endorser, c = S.f.confirm;
  return `<h2 class="ph" style="margin-top:6px">9. Documents (Please provide recent copies):</h2>
  <div class="pdocs">
    ${doc('doc.proof', 'Proof of bank', '(Bank statement or bank letter with your BACS details)' + (S.f.method === 'Bank transfer' ? '' : ' – only needed for bank transfer'))}
    ${doc('doc.benefits', 'Benefits letter', '(full UC Statement)' + (S.f.family.benefits === 'yes' ? '' : ' – only if you receive benefits'))}
    ${doc('doc.id', 'ID', '(passport, Driving/Provisional license)')}
  </div>
  <p class="pnote" style="margin-top:14px">Please provide an endorser's contact information (e.g., Rabbi, Teacher, Accountant, or Doctor).</p>
  <div class="pl">${inl('endorser.name', 'Name:', en.name, { flex: '3 1 240px' })}${inl('endorser.position', 'Position:', en.position, { flex: '2 1 200px' })}</div>
  <div class="addr-slot" id="slot-endorser"></div>
  <div class="pl">${inl('endorser.address', 'Address:', en.address, { flex: '3 1 240px' })}${inl('endorser.town', 'City/Town:', en.town, { flex: '1.4 1 170px' })}${inl('endorser.postcode', 'Postcode:', en.postcode, { flex: '1 1 140px' })}</div>
  <div class="pl">${inl('endorser.phone', 'Phone:', en.phone, { type: 'tel', flex: '2 1 200px' })}${inl('endorser.email', 'Email:', en.email, { type: 'email', flex: '3 1 240px' })}</div>

  <h2 class="ph">10. Confirmation</h2>
  <div class="pdecl">
    <p>I certify that, to the best of my knowledge and belief, the information provided in this application is true, accurate and complete.</p>
    <p>I confirm that I am eligible for charitable grant assistance and undertake to notify Toirem promptly of any material change in my circumstances.</p>
    <p>I acknowledge that any grant awarded must be used solely for the purpose stated in this application.</p>
    <p>I undertake to retain all relevant receipts and records and provide them to Toirem upon request.</p>
    <p>I further acknowledge that Toirem may require repayment of all or part of the grant if it is used for any other purpose or if any information provided is found to be inaccurate or misleading.</p>
  </div>
  <label class="ptick ${E()['confirm.declare'] ? 'invalid' : ''}"><input type="checkbox" id="declare" ${c.declare ? 'checked' : ''}> I agree to the statements above</label>${er('confirm.declare')}
  <div class="pl" style="margin-top:16px">${inl('confirm.name', 'Please print your name:', c.name, { flex: '0 1 520px' })}</div>
  <div class="pl">${inl('confirm.sign', 'Signature:', c.sign, { flex: '2 1 300px', cls: 'psig', ph: 'Type your name' })}${inl('confirm.date', 'Date:', c.date, { type: 'date', flex: '1 1 200px' })}</div>
  ${sigPicker('sigfont', c.font, c.sign || c.name)}
  <div class="poffice"><p class="pnote">Office use only</p>
    <table><tr><td>Date submitted</td><td>Related documents</td><td>Date authorized</td><td>Amount approved</td></tr><tr><td></td><td></td><td></td><td></td></tr></table></div>`;
}

function render() {
  const head = '<h1 class="ptitle">Individual Grant Application Form</h1>';
  if (S.done) { app().innerHTML = head + notice('ok', `Thank you. Your application has been sent to Toirem. Your reference is <b>${esc(S.done)}</b>. We've emailed you a copy.`); return; }
  if (S.linkProblem) { app().innerHTML = head + notice('warn', 'This link has expired or has already been used. If you need help, email <b>cs@toirem.co.uk</b>.'); return; }
  app().innerHTML = head + `<p class="ppage">Page ${S.step} of 2</p>` +
    (S.test ? `<div style="margin-bottom:16px">${notice('warn', `<b>Test mode.</b> This creates a test grant marked “TEST” that you can delete; the emails go to the Toirem office, not to the applicant.
      <button class="link" type="button" id="fillTest">Fill in sample answers and documents</button>`)}</div>` : '') +
    (S.complete && S.step === 1 ? `<div style="margin-bottom:16px">${notice('ok', `Please complete this form for your grant <b>${esc(S.complete.ref)}</b>. Your name is filled in; please check it and add the rest.`)}</div>` : '') +
    (S.msg ? `<div style="margin-bottom:16px">${notice(S.msg.kind, esc(S.msg.text))}</div>` : '') +
    (S.step === 1 ? page1() : page2()) +
    `<div class="nav">${S.step > 1 ? '<button class="ghost" id="back" type="button">Back</button>' : '<span></span>'}
     <button class="primary" id="next" type="button" ${S.busy ? 'disabled' : ''}>${S.step < 2 ? 'Continue to page 2' : S.busy ? 'Sending…' : 'Submit application'}</button></div>`;
  bind();
}

function setK(k, v) { const [a, b] = k.split('.'); if (b && S.f[a]) S.f[a][b] = v; }
function bind() {
  $$('[data-k]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    setK(el.dataset.k, el.value);
    if (S.errors[el.dataset.k]) { delete S.errors[el.dataset.k]; const l = el.closest('label'); l?.classList.remove('invalid'); l?.querySelector('.err')?.remove(); }
    if (el.dataset.k === 'confirm.sign') $$('.sigopt .sp').forEach((s) => { s.textContent = el.value || 'Your name'; });
  }));
  const radioTo = (name, setter) => $$(`input[name=${name}]`).forEach((r) => r.addEventListener('change', () => { setter(r.value); render(); }));
  radioTo('status', (v) => { S.f.family.status = v; delete S.errors['family.status']; });
  radioTo('children', (v) => { S.f.family.children = v; delete S.errors['family.children']; });
  radioTo('income', (v) => { S.f.family.income = v; delete S.errors['family.income']; });
  radioTo('benefits', (v) => { S.f.family.benefits = v; delete S.errors['family.benefits']; });
  radioTo('frequency', (v) => { S.f.grant.frequency = v; delete S.errors['grant.frequency']; });
  radioTo('method', (v) => { S.f.method = v; delete S.errors.method; });
  $$('input[name=sigfont]').forEach((r) => r.addEventListener('change', () => { S.f.confirm.font = r.value; }));
  $$('[data-purpose]').forEach((cb) => cb.addEventListener('change', () => {
    const x = cb.dataset.purpose, P = S.f.grant.purposes;
    if (cb.checked && !P.includes(x)) P.push(x); if (!cb.checked) P.splice(P.indexOf(x), 1);
    delete S.errors['grant.purposes']; if (x === 'Other') render();
  }));
  [['doc.proof', 'proof'], ['doc.id', 'id'], ['doc.benefits', 'benefits']].forEach(([id, k]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { const f = el.files[0]; if (f) { S.files[k] = f; delete S.errors[id]; render(); } });
  });
  const d = $('#declare'); if (d) d.addEventListener('change', () => { S.f.confirm.declare = d.checked; delete S.errors['confirm.declare']; });
  const back = $('#back'); if (back) back.addEventListener('click', () => { S.step--; S.errors = {}; S.msg = null; render(); scrollTo(0, 0); });
  // Don't move focus on mouse-down: leaving a text box can shift the page and the press would land elsewhere.
  $$('.nav button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
  $('#next').addEventListener('click', next);
  const ft = $('#fillTest'); if (ft) ft.addEventListener('click', fillTest);
  // Google address lookup (only loads when an address section is on screen).
  for (const who of ['person', 'endorser']) {
    const slot = $('#slot-' + who); if (!slot) continue;
    import('./address.js').then((m) => m.mountAddressLookup(slot, who, (a) => {
      const t = S.f[who];
      Object.assign(t, { address: [a.line1, a.line2].filter(Boolean).join(', ') || t.address, town: a.town || t.town, postcode: a.postcode || t.postcode });
      [who + '.address', who + '.town', who + '.postcode'].forEach((k) => delete S.errors[k]); render();
    })).catch(() => {});
  }
}

/** Only the errors for the fields on this step. */
const STEP_KEYS = {
  1: /^(person|family|grant|method|bank)/,
  2: /^(doc|endorser|confirm)/,
};
async function next() {
  const { errors } = validateIndividual(S.f, { proof: !!S.files.proof, id: !!S.files.id, benefits: !!S.files.benefits });
  const mine = Object.fromEntries(Object.entries(errors).filter(([k]) => STEP_KEYS[S.step].test(k)));
  for (const [k, f] of Object.entries(S.files)) if (f && f.size > 10 * 1024 * 1024 && S.step === 2) mine['doc.' + k] = 'The file must be under 10 MB.';
  S.errors = mine; S.msg = null;
  if (Object.keys(mine).length) {
    render();
    const first = document.querySelector('.invalid');
    if (first) first.scrollIntoView({ block: 'center' }); else S.msg = { kind: 'bad', text: 'Please check the highlighted fields.' };
    return;
  }
  if (S.step < 2) { S.step++; render(); scrollTo(0, 0); return; }
  S.busy = 'submit'; render();
  const fd = new FormData();
  fd.set('form', JSON.stringify(S.test ? { ...S.f, test: true } : S.f));
  if (S.complete) fd.set('token', S.complete.token);
  for (const [k, f] of Object.entries(S.files)) if (f) fd.set(k, f);
  // A copy in the paper-form design for the confirmation emails. Never holds up the application.
  try {
    const docs = [['proof', 'Proof of bank'], ['id', 'ID'], ['benefits', 'Benefits letter']].filter(([k]) => S.files[k]).map(([, l]) => l);
    const when = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    const pdf = await Promise.race([individualPdf(S.f, { submitted: when, docs }, { office: false }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 15000))]);
    fd.set('formpdf', new Blob([pdf], { type: 'application/pdf' }), 'application.pdf');
  } catch (e) { /* the emails then use the standard copy */ }
  const r = await postForm('individual', fd);
  S.busy = '';
  if (r.ok) { S.done = r.ref; render(); scrollTo(0, 0); return; }
  if (r.errors) {
    S.errors = r.errors;
    const k = Object.keys(r.errors)[0];
    S.step = STEP_KEYS[1].test(k) ? 1 : 2;
  }
  S.msg = { kind: 'bad', text: r.message || 'Please check the highlighted fields.' };
  render(); scrollTo(0, 0);
}

/* A link from Toirem's email: complete the form for a past grant imported from the platform. */
async function startComplete(token) {
  app().innerHTML = '<p class="loading">Loading your form…</p>';
  const r = await postJSON('link', { kind: 'complete', token });
  if (!r.ok) { S.linkProblem = true; return render(); }
  S.complete = { token, ref: r.ref };
  const parts = String(r.orgName || '').trim().split(/\s+/);
  S.f.person.first = parts.shift() || ''; S.f.person.last = parts.join(' ');
  if (r.approved) S.f.grant.amount = String(r.approved);
  render();
}
/* Test mode (/grants/individual.html#test): fill every answer and attach sample documents, to try the whole form. */
function samplePdf(title) {
  const text = `BT /F1 18 Tf 60 760 Td (${title} - TEST DOCUMENT) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new File([pdf], title.toLowerCase().replace(/\s+/g, '-') + '-test.pdf', { type: 'application/pdf' });
}
function fillTest() {
  Object.assign(S.f.person, { title: 'Mr', first: 'Test', last: 'Applicant', address: '24 Darenth Road', town: 'London', postcode: 'N16 6EJ', phone: '020 8157 2849', email: 'test@example.org' });
  Object.assign(S.f.family, { status: 'Married', children: 'yes', childrenCount: '4', income: '£750 – £1,000', benefits: 'yes', benefitsAmount: '£1,200 a month' });
  Object.assign(S.f.grant, { purposes: ['Living Costs', 'Medical'], other: '', comments: 'Test application made from the Grants Office.', amount: '1500', frequency: 'One-off' });
  S.f.method = 'Bank transfer'; Object.assign(S.f.bank, { acname: 'MR T APPLICANT', sort: '40-16-15', acno: '12345678' });
  Object.assign(S.f.endorser, { name: 'Rabbi Test', position: 'Rabbi', address: '1 Example Road', town: 'London', postcode: 'N16 5AA', phone: '020 8800 0000', email: '' });
  Object.assign(S.f.confirm, { declare: true, name: 'Test Applicant', sign: 'Test Applicant', date: today(), font: 'Dancing Script' });
  S.files = { proof: samplePdf('Proof of bank'), id: samplePdf('ID'), benefits: samplePdf('Benefits letter') };
  S.errors = {}; S.msg = { kind: 'ok', text: 'Sample answers and three sample documents filled in. Check both pages, then press Submit on page 2.' };
  render();
}
S.test = location.hash === '#test';
const cm = location.hash.match(/^#complete\/(.+)$/);
if (cm) startComplete(cm[1]); else render();
