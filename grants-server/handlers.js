/* =====================================================================
   Toirem Grants – everything the server does. Called by functions/api/grants/[[path]].js.
   Public: charity lookup, postcode check, submit an application.
   Recipient links (one-time token): sign agreement, breakdown, proof, club receipts.
   Office (signed-in grants staff only): list, view, approve, agreement, payments, monitoring.
   Scheduled (GitHub Action with CRON_SECRET): reminders and Charity Commission re-checks.

   Cloudflare's free plan allows 50 outside calls per request, so lists are fetched in one
   query and scheduled work is done in small batches.
   ===================================================================== */
import { createDb, newToken, hashToken, checkFile, storeFile } from './supabase.js';
import { checkCharity, CharityNotFound, getTrustees, newProblems, TOIREM_CHARITY_NUMBER, probe, searchCharities } from './charity.js';
import { lookupPostcode } from './postcode.js';
import { sendEmail, templates, officeLink, recipientLink, applicationDetailsHtml, applicationPdfHtml, pdfName, makePdf } from './email.js';
import { validateApplication } from './validate.js';
import { statusOf, checkPayment, needsAgreement, paysClubAccount, paymentsInPeriod, DEFAULT_AGREEMENT_THRESHOLD } from './rules.js';

export class UserError extends Error {}
export class NotAllowed extends Error {}

const today = () => new Date().toISOString().slice(0, 10);
const DAY = 864e5;
const REMIND_AFTER_DAYS = 14;
const RECHECK_AFTER_DAYS = 28;
const MAX_INVOICES = 8;
const one = (v) => (Array.isArray(v) ? v[0] || null : v || null);

/* ---------------- shared loading ---------------- */
const GRANT_SELECT = 'select=*,agreements(*),payments(*),breakdowns(*,breakdown_lines(*)),invoice_receipts(*,invoice:files!invoice_file_id(original_name)),alerts(*)';

async function threshold(db) {
  const row = await db.one('settings?select=value&key=eq.agreement_threshold_gbp').catch(() => null);
  return Number(row?.value ?? DEFAULT_AGREEMENT_THRESHOLD);
}

function stateOf(a) {
  const ag = one(a.agreements);
  return {
    registered: a.registered, route: a.route, routeOverride: a.route_override,
    approvedAmount: a.approved_amount == null ? null : Number(a.approved_amount),
    agreement: ag ? { status: ag.status } : null,
    payments: (a.payments || []).map((p) => ({ amount: Number(p.amount), paidOn: p.paid_on })),
    breakdowns: (a.breakdowns || []).map((b) => ({ status: b.status })),
    receiptsOutstanding: (a.invoice_receipts || []).filter((r) => r.requested_at && (!r.receipt_file_id || !r.bank_confirmation_id)).length,
    openAlerts: (a.alerts || []).filter((x) => !x.resolved_at).length,
  };
}

async function loadGrant(db, id) {
  const a = await db.one('applications?' + GRANT_SELECT + '&id=eq.' + encodeURIComponent(id));
  if (!a) throw new UserError('That grant was not found.');
  a.agreement = one(a.agreements); delete a.agreements;
  a.payments = (a.payments || []).sort((x, y) => x.paid_on.localeCompare(y.paid_on));
  a.breakdowns = (a.breakdowns || []).sort((x, y) => x.requested_on.localeCompare(y.requested_on));
  a.alerts = (a.alerts || []).filter((x) => !x.resolved_at);
  return a;
}

/** Agreement contents for the agreement page (built on the server so the recipient sees only what's needed). */
function agreementData(a, ag) {
  const c = a.cc_check, f = a.form;
  const address = c ? [...c.address.lines, c.address.town, c.address.postcode].filter(Boolean).join(', ')
    : [f.org.line1, f.org.town, f.org.postcode].filter(Boolean).join(', ');
  return {
    recipientName: a.org_name, recipientAddress: address, ref: a.ref, amount: Number(a.approved_amount),
    purpose: a.purpose || '', method: a.payment_method || '', bank: f.bank,
    toirem: { name: ag?.toirem_signatory || null, position: ag?.toirem_position || null, date: ag?.sent_on || null },
    recipient: ag?.signed_name ? { name: ag.signed_name, date: ag.signed_date, font: ag.signed_font } : null,
  };
}

/* =========================== PUBLIC =========================== */

export async function lookupCharity(env, body) {
  try {
    const { check } = await checkCharity(String(body.number || ''), env.CHARITY_COMMISSION_API_KEY);
    if (!check.registered) return { ok: false, message: `Charity ${check.number} is no longer on the register.` };
    return { ok: true, charity: {
      name: check.name, number: check.number, regDate: check.regDate, address: check.address,
      phone: check.phone, email: check.email, website: check.website,
      trustees: check.trustees, objects: check.objects, activities: check.activities,
    } };
  } catch (e) {
    if (e instanceof CharityNotFound) return { ok: false, message: e.message };
    console.error('lookup', e);
    return { ok: false, message: "We can't check the Charity Commission register right now. Please try again in a few minutes, or email info@toirem.org.uk." };
  }
}

/** Find charities by name (or go straight to the number if digits are typed). */
export async function searchCharity(env, body) {
  const q = String(body.q || '').trim();
  if (/^\d{6,8}$/.test(q.replace(/\s/g, ''))) return { ok: true, results: [], number: q.replace(/\s/g, '') };
  if (q.length < 3) return { ok: false, message: 'Type at least 3 letters of the charity name, or its number.' };
  try {
    const results = await searchCharities(q, env.CHARITY_COMMISSION_API_KEY);
    return results.length ? { ok: true, results } : { ok: false, message: `No registered charity found matching "${q}". Try fewer words, or the charity number.` };
  } catch (e) {
    console.error('search', e);
    return { ok: false, message: "We can't search the Charity Commission register right now. Please try again in a few minutes, or use the charity number." };
  }
}

/** Office "Check connections": tests each outside service and says plainly what's wrong. */
export async function officeDiagnostics(env, request) {
  await requireStaff(env, request);
  const out = [];
  const need = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'CHARITY_COMMISSION_API_KEY', 'EMAIL_HELPER_URL', 'EMAIL_HELPER_SECRET', 'EMAIL_FROM_NAME', 'OFFICE_EMAIL', 'PUBLIC_SITE_URL', 'CRON_SECRET'];
  const missing = need.filter((k) => !env[k]);
  out.push({ name: 'Cloudflare settings', ok: !missing.length, detail: missing.length ? 'Missing: ' + missing.join(', ') : 'All 9 settings are present.' });
  out.push({ name: 'Database', ok: true, detail: 'Connected (you are signed in, so this part works).' });
  const cc = await probe(env.CHARITY_COMMISSION_API_KEY);
  out.push({ name: 'Charity Commission', ok: cc.ok, detail: cc.ok ? cc.detail : cc.detail + (cc.status === 401 || cc.status === 403 ? ' Check the key in Cloudflare is the Primary key for the "Register of Charities" product, with no spaces.' : '') });
  try {
    const res = await fetch(env.EMAIL_HELPER_URL, { redirect: 'follow' });
    const text = await res.text();
    const ok = /Toirem grants mailer/.test(text);
    out.push({ name: 'Gmail mailer', ok, detail: ok ? 'The mailer is running.' : 'The mailer address answered, but not as expected. Check EMAIL_HELPER_URL ends in /exec and the script is deployed for "Anyone".' });
  } catch (e) { out.push({ name: 'Gmail mailer', ok: false, detail: 'Could not reach the mailer: ' + e.message }); }
  const site = String(env.PUBLIC_SITE_URL || '');
  const here = new URL(request.url).origin;
  const siteOk = /^https:\/\/[^/]+$/.test(site) && !/supabase\.co/.test(site);
  out.push({ name: 'Website address', ok: siteOk, detail: siteOk ? site + (site !== here ? ` (you are on ${here})` : '') : `PUBLIC_SITE_URL is "${site}". It must be the website address, ${here}, with no slash at the end. Email links use it.` });
  return { ok: true, checks: out };
}

export const checkPostcode = (env, body) => lookupPostcode(String(body.postcode || ''));

export async function submitApplication(env, formData, ip) {
  let raw;
  try { raw = JSON.parse(String(formData.get('form') || '')); } catch (e) { throw new UserError('The form could not be read. Please try again.'); }
  const v = validateApplication(raw);
  if (v.errors) return { ok: false, errors: v.errors };
  const form = v.data;

  const bankProof = formData.get('bankProof');
  const invoices = formData.getAll('invoices').filter((x) => x && typeof x !== 'string');
  const errors = {};
  const be = checkFile(bankProof, 'proof of bank'); if (be) errors['bank.proof'] = be;
  if (!form.registered) {
    if (!invoices.length) errors.invoices = 'Upload at least one invoice.';
    if (invoices.length > MAX_INVOICES) errors.invoices = `Upload up to ${MAX_INVOICES} invoices. Combine extra ones into one PDF.`;
    invoices.forEach((f) => { const e = checkFile(f, 'each invoice'); if (e) errors.invoices = e; });
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  let cc = null, ccRaw = null;
  if (form.registered) {
    try { ({ check: cc, raw: ccRaw } = await checkCharity(form.charityNumber, env.CHARITY_COMMISSION_API_KEY)); }
    catch (e) {
      return { ok: false, errors: { charityNumber: e instanceof CharityNotFound ? e.message : "The register isn't responding. Please try again." } };
    }
  }
  const orgName = cc ? cc.name : form.org.name;
  const orgEmail = (cc ? cc.email : form.org.email) || '';
  const orgPhone = cc ? cc.phone : form.org.phone;
  const applicantName = [form.app.title, form.app.first, form.app.last].join(' ');
  const applicantEmail = form.app.same ? orgEmail : form.app.email;
  if (!applicantEmail) return { ok: false, errors: { 'app.email': "The register has no email for this charity. Untick 'same contact details' and enter yours." } };

  const db = createDb(env);
  const [row] = await db.insert('applications', [{
    registered: form.registered,
    charity_number: cc ? cc.number : null,
    org_name: orgName,
    org_email: orgEmail || applicantEmail,
    applicant_name: applicantName,
    applicant_email: applicantEmail,
    route: form.registered ? null : form.route,
    form: { ...form, orgPhone, submittedFromIp: ip || null },
    cc_check: cc ? { ...cc, raw: ccRaw } : null,
    cc_checked_at: cc ? cc.checkedAt : null,
    details_incorrect: cc && form.incorrect ? form.incorrectNote : null,
  }]);

  await storeFile(db, row.id, 'bank_proof', bankProof);
  const invoiceIds = [];
  for (const inv of invoices) invoiceIds.push(await storeFile(db, row.id, 'invoice', inv));
  if (!form.registered && form.route === 'club' && invoiceIds.length) {
    await db.insert('invoice_receipts', invoiceIds.map((id) => ({ application_id: row.id, invoice_file_id: id })), { returning: false });
  }

  const owing = await db.select('orgs_with_outstanding_receipts?select=org_email&org_email=eq.' + encodeURIComponent((orgEmail || applicantEmail).toLowerCase())).catch(() => []);
  const warnings = [...(cc ? cc.warnings : []), ...(owing.length ? ['Outstanding receipts from a previous grant.'] : [])];
  if (cc && form.incorrect) warnings.push('Applicant says the register details are out of date.');

  const pos = form.app.position === 'Other' ? form.app.positionOther : form.app.position;
  const meta = { ref: row.ref, orgName, submitted: new Date(row.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' }) };
  const file = pdfName(row.ref, orgName);
  try {
    await sendEmail(env, { to: env.OFFICE_EMAIL, replyTo: applicantEmail, attachments: [{ name: file, html: applicationPdfHtml(form, cc, meta) }], ...templates.applicationReceived({
      ref: row.ref, orgName, type: cc ? 'Registered charity ' + cc.number : 'Club / community account',
      applicant: `${applicantName}, ${pos} (${applicantEmail})`, cost: form.grant.cost, use: form.grant.use, warnings,
      officeUrl: officeLink(env, row.id), details: applicationDetailsHtml(form, cc),
    }) });
  } catch (e) { console.error('office email', e); } // the application is saved; the office still sees it in the list
  try { await sendEmail(env, { to: applicantEmail, attachments: [{ name: file, html: applicationPdfHtml(form, cc, meta, { includeCheck: false }) }], ...templates.applicationConfirmation({ ref: row.ref, orgName, applicantName }) }); }
  catch (e) { console.error('confirmation email', e); }

  return { ok: true, ref: row.ref };
}

/* =========================== RECIPIENT LINKS =========================== */

export async function openLink(env, body) {
  const db = createDb(env);
  const h = await hashToken(body.token);
  if (body.kind === 'sign') {
    const ag = await db.one('agreements?select=*,applications(*)&status=eq.sent&token_hash=eq.' + h);
    if (!ag) return { ok: false };
    const a = one(ag.applications);
    return { ok: true, ref: a.ref, orgName: a.org_name, agreement: agreementData(a, ag) };
  }
  if (body.kind === 'breakdown' || body.kind === 'proof') {
    const want = body.kind === 'breakdown' ? 'requested' : 'proof_requested';
    const b = await db.one('breakdowns?select=id,period_from,period_to,total_paid,status,breakdown_lines(id,description,amount,proof_requested,proof_file_id),applications(id,ref,org_name)&status=eq.' + want + '&token_hash=eq.' + h);
    if (!b) return { ok: false };
    const a = one(b.applications);
    const payments = body.kind === 'breakdown'
      ? (await db.select('payments?select=paid_on,amount&application_id=eq.' + a.id + '&paid_on=gte.' + b.period_from + '&paid_on=lte.' + b.period_to + '&order=paid_on'))
      : [];
    return { ok: true, ref: a.ref, orgName: a.org_name, breakdown: { from: b.period_from, to: b.period_to, total: Number(b.total_paid), payments, lines: (b.breakdown_lines || []).filter((l) => l.proof_requested && !l.proof_file_id) } };
  }
  if (body.kind === 'receipts') {
    const rows = await db.select('invoice_receipts?select=id,receipt_file_id,bank_confirmation_id,invoice:files!invoice_file_id(original_name),applications(id,ref,org_name,route_override)&token_hash=eq.' + h);
    const open = rows.filter((r) => !one(r.applications).route_override && (!r.receipt_file_id || !r.bank_confirmation_id));
    if (!open.length) return { ok: false };
    const a = one(open[0].applications);
    return { ok: true, ref: a.ref, orgName: a.org_name, invoices: open.map((r) => ({ id: r.id, name: one(r.invoice).original_name, receipt: !!r.receipt_file_id, bank: !!r.bank_confirmation_id })) };
  }
  return { ok: false };
}

export async function signAgreement(env, body, ip) {
  const db = createDb(env);
  const ag = await db.one('agreements?select=*,applications(*)&status=eq.sent&token_hash=eq.' + (await hashToken(body.token)));
  if (!ag) throw new UserError('This link has expired or the agreement is already signed.');
  if (body.accepted !== true) throw new UserError('Tick to accept the terms.');
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw new UserError('Type your full name to sign.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : today();
  const a = one(ag.applications);
  const snapshot = { ...agreementData(a, ag), recipient: { name, date, font: String(body.font || '') } };
  await db.update('agreements', 'id=eq.' + ag.id, {
    status: 'signed', signed_name: name, signed_date: date, signed_font: String(body.font || '').slice(0, 40),
    signed_at: new Date().toISOString(), signer_ip: ip || null, snapshot, token_hash: null,
  });
  try { await sendEmail(env, { to: env.OFFICE_EMAIL, ...templates.agreementSigned({ ref: a.ref, orgName: a.org_name, signedBy: name, officeUrl: officeLink(env, a.id) }) }); }
  catch (e) { console.error('signed email', e); }
  return { ok: true };
}

export async function submitBreakdown(env, body) {
  const db = createDb(env);
  const b = await db.one('breakdowns?select=id&status=eq.requested&token_hash=eq.' + (await hashToken(body.token)));
  if (!b) throw new UserError('This link has expired or the breakdown was already sent.');
  const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 100)
    .map((l) => ({ description: String(l.description || '').trim().slice(0, 300), amount: Number(l.amount) }))
    .filter((l) => l.description && l.amount >= 0);
  if (!lines.length) throw new UserError('Add at least one line.');
  await db.insert('breakdown_lines', lines.map((l) => ({ breakdown_id: b.id, ...l })), { returning: false });
  await db.update('breakdowns', 'id=eq.' + b.id, { status: 'submitted', submitted_at: new Date().toISOString(), token_hash: null });
  return { ok: true };
}

export async function submitProof(env, formData) {
  const db = createDb(env);
  const b = await db.one('breakdowns?select=id,breakdown_lines(id,proof_requested,proof_file_id),applications(id)&status=eq.proof_requested&token_hash=eq.' + (await hashToken(formData.get('token'))));
  if (!b) throw new UserError('This link has expired.');
  const appId = one(b.applications).id;
  const wanted = (b.breakdown_lines || []).filter((l) => l.proof_requested && !l.proof_file_id);
  let done = 0;
  for (const line of wanted.slice(0, 12)) {
    const f = formData.get(line.id);
    if (!f || typeof f === 'string') continue;
    const err = checkFile(f, 'the proof'); if (err) throw new UserError(err);
    const fileId = await storeFile(db, appId, 'breakdown_proof', f);
    await db.update('breakdown_lines', 'id=eq.' + line.id, { proof_file_id: fileId });
    done++;
  }
  return { ok: true, remaining: wanted.length - done };
}

export async function submitReceipts(env, formData) {
  const db = createDb(env);
  const rows = await db.select('invoice_receipts?select=id,receipt_file_id,bank_confirmation_id,applications(id)&token_hash=eq.' + (await hashToken(formData.get('token'))));
  if (!rows.length) throw new UserError('This link has expired.');
  let uploads = 0;
  for (const r of rows) {
    const patch = {};
    for (const [kind, col, label] of [['receipt', 'receipt_file_id', 'the receipt'], ['bank', 'bank_confirmation_id', 'the bank confirmation']]) {
      const f = formData.get(r.id + '.' + kind);
      if (!f || typeof f === 'string' || r[col] || uploads >= 12) continue;
      const err = checkFile(f, label); if (err) throw new UserError(err);
      patch[col] = await storeFile(db, one(r.applications).id, kind === 'receipt' ? 'receipt' : 'bank_confirmation', f);
      uploads++;
    }
    if (Object.keys(patch).length) await db.update('invoice_receipts', 'id=eq.' + r.id, patch);
  }
  return { ok: true };
}

/* =========================== OFFICE =========================== */

export async function requireStaff(env, request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const db = createDb(env);
  const user = await db.userFromToken(token);
  if (!user || !user.id) throw new NotAllowed('Please sign in again.');
  const staff = await db.one('staff?select=name,role&user_id=eq.' + user.id);
  if (!staff) throw new NotAllowed("This account doesn't have access to the Grants Office.");
  return { db, userId: user.id, name: staff.name, email: user.email };
}

export async function officeList(env, request) {
  const { db, name } = await requireStaff(env, request);
  const [rows, t] = await Promise.all([
    db.select('applications?select=id,ref,created_at,org_name,registered,charity_number,route,route_override,approved_amount,agreements(status),payments(amount,paid_on),breakdowns(status),invoice_receipts(requested_at,receipt_file_id,bank_confirmation_id),alerts(resolved_at)&order=created_at.desc'),
    threshold(db),
  ]);
  return { ok: true, me: name, threshold: t, grants: rows.map((a) => {
    const st = stateOf(a);
    return { id: a.id, ref: a.ref, created: a.created_at, orgName: a.org_name, registered: a.registered, charityNumber: a.charity_number,
      status: statusOf(st, t), approved: st.approvedAmount, paid: st.payments.reduce((s, p) => s + p.amount, 0) };
  }) };
}

export async function officeGrant(env, request, body) {
  const { db } = await requireStaff(env, request);
  const [a, t, files] = await Promise.all([
    loadGrant(db, body.id), threshold(db),
    db.select('files?select=id,kind,original_name,storage_path,uploaded_at&application_id=eq.' + encodeURIComponent(body.id) + '&order=uploaded_at'),
  ]);
  const st = stateOf({ ...a, agreements: a.agreement });
  if (a.cc_check) delete a.cc_check.raw;
  const withLinks = await Promise.all(files.slice(0, 40).map(async (f) => ({ id: f.id, kind: f.kind, name: f.original_name, url: await db.signedUrl(f.storage_path) })));
  return { ok: true, threshold: t, status: statusOf(st, t), grant: a, files: withLinks,
    agreement: a.agreement ? agreementData(a, a.agreement) : null };
}

/** The submitted application as a PDF, for the office "Download PDF" button. */
export async function officePdf(env, request, id) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, id);
  const meta = { ref: a.ref, orgName: a.org_name, submitted: new Date(a.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' }) };
  const name = pdfName(a.ref, a.org_name);
  const bytes = await makePdf(env, applicationPdfHtml(a.form, a.cc_check, meta), name).catch((e) => { throw new UserError(e.message); });
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
}

export async function officeSignatories(env, request) {
  await requireStaff(env, request);
  return { ok: true, trustees: await getTrustees(TOIREM_CHARITY_NUMBER, env.CHARITY_COMMISSION_API_KEY) };
}

export async function approve(env, request, body) {
  const { db, userId } = await requireStaff(env, request);
  const a = await loadGrant(db, body.id);
  if (a.approved_amount != null) throw new UserError('This grant is already approved.');
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!(amount > 0)) throw new UserError('Enter the approved amount.');
  const purpose = String(body.purpose || '').trim();
  if (!purpose) throw new UserError('Enter the purpose of the grant.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.approvedOn || '')) throw new UserError('Choose the date the trustees approved it.');
  const methods = ['Bank transfer', 'Prepaid card', 'Paid direct to supplier'];
  const override = body.override === true && !a.registered && a.route === 'club';
  const method = override ? 'Paid direct to supplier' : methods.includes(body.method) ? body.method : 'Bank transfer';
  await db.update('applications', 'id=eq.' + a.id, {
    approved_amount: amount, purpose, approved_on: body.approvedOn, approved_by: userId, payment_method: method, route_override: override,
  });
  const t = await threshold(db);
  if (needsAgreement(amount, t)) await db.insert('agreements', [{ application_id: a.id, status: 'draft' }], { returning: false });
  return { ok: true, agreementNeeded: needsAgreement(amount, t) };
}

export async function sendAgreement(env, request, body) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, body.id);
  if (!a.agreement || a.agreement.status === 'signed') throw new UserError('There is no agreement waiting to be sent.');
  const trustee = (await getTrustees(TOIREM_CHARITY_NUMBER, env.CHARITY_COMMISSION_API_KEY)).find((x) => x.name === body.signatory);
  if (!trustee) throw new UserError('Choose the trustee signing for Toirem.');
  const token = newToken();
  await db.update('agreements', 'id=eq.' + a.agreement.id, {
    status: 'sent', toirem_signatory: trustee.name, toirem_position: trustee.position, sent_on: today(), token_hash: await hashToken(token),
  });
  await sendEmail(env, { to: a.applicant_email, ...templates.agreementToSign({ ref: a.ref, orgName: a.org_name, amount: Number(a.approved_amount), link: recipientLink(env, 'sign', token) }) });
  return { ok: true };
}

export async function recordPayment(env, request, body) {
  const { db, userId } = await requireStaff(env, request);
  const a = await loadGrant(db, body.id);
  const t = await threshold(db);
  const st = stateOf({ ...a, agreements: a.agreement });
  const amount = Math.round(Number(body.amount) * 100) / 100;
  const problem = checkPayment(st, amount, t);
  if (problem) throw new UserError(problem);
  const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(body.paidOn || '') ? body.paidOn : today();
  const approvedOn = /^\d{4}-\d{2}-\d{2}$/.test(body.approvedOn || '') ? body.approvedOn : paidOn;
  await db.insert('payments', [{ application_id: a.id, amount, paid_on: paidOn, trustees_approved_on: approvedOn, recorded_by: userId }], { returning: false });
  let receiptsRequested = false;
  if (paysClubAccount(st)) {
    const pending = (a.invoice_receipts || []).filter((r) => !r.requested_at);
    if (pending.length) {
      const token = newToken();
      await db.update('invoice_receipts', 'id=in.(' + pending.map((r) => r.id).join(',') + ')', { requested_at: new Date().toISOString(), token_hash: await hashToken(token) });
      await sendEmail(env, { to: a.applicant_email, ...templates.receiptsRequest({ ref: a.ref, orgName: a.org_name, invoices: pending.map((r) => one(r.invoice).original_name), link: recipientLink(env, 'receipts', token) }) });
      receiptsRequested = true;
    }
  }
  return { ok: true, receiptsRequested };
}

export async function overrideToSupplier(env, request, body) {
  const { db } = await requireStaff(env, request);
  await db.update('applications', 'id=eq.' + encodeURIComponent(body.id), { route_override: true, payment_method: 'Paid direct to supplier' });
  return { ok: true };
}

export async function requestBreakdown(env, request, body) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, body.id);
  if (a.breakdowns.some((b) => b.status !== 'closed')) throw new UserError('A breakdown is already open for this grant.');
  const from = String(body.from || ''), to = String(body.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new UserError('Choose a valid period.');
  const inPeriod = paymentsInPeriod(a.payments.map((p) => ({ amount: Number(p.amount), paidOn: p.paid_on })), from, to);
  if (!inPeriod.length) throw new UserError('There are no payments in that period.');
  const total = Math.round(inPeriod.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  const token = newToken();
  await db.insert('breakdowns', [{ application_id: a.id, period_from: from, period_to: to, total_paid: total, token_hash: await hashToken(token) }], { returning: false });
  await sendEmail(env, { to: a.applicant_email, ...templates.breakdownRequest({ ref: a.ref, orgName: a.org_name, from, to, total, link: recipientLink(env, 'breakdown', token) }) });
  return { ok: true };
}

export async function requestProof(env, request, body) {
  const { db } = await requireStaff(env, request);
  const ids = (Array.isArray(body.lineIds) ? body.lineIds : []).map(String);
  if (!ids.length) throw new UserError('Tick at least one line, or accept without proof.');
  const b = await db.one('breakdowns?select=*,breakdown_lines(*),applications(ref,org_name,applicant_email)&id=eq.' + encodeURIComponent(body.breakdownId));
  if (!b || b.status !== 'submitted') throw new UserError('Proof can only be requested on a submitted breakdown.');
  const lines = (b.breakdown_lines || []).filter((l) => ids.includes(l.id));
  if (!lines.length) throw new UserError('Tick at least one line.');
  await db.update('breakdown_lines', 'id=in.(' + lines.map((l) => l.id).join(',') + ')', { proof_requested: true });
  const token = newToken();
  await db.update('breakdowns', 'id=eq.' + b.id, { status: 'proof_requested', token_hash: await hashToken(token) });
  const a = one(b.applications);
  await sendEmail(env, { to: a.applicant_email, ...templates.proofRequest({ ref: a.ref, orgName: a.org_name, lines: lines.map((l) => ({ description: l.description, amount: Number(l.amount) })), link: recipientLink(env, 'proof', token) }) });
  return { ok: true };
}

export async function closeBreakdown(env, request, body) {
  const { db } = await requireStaff(env, request);
  await db.update('breakdowns', 'id=eq.' + encodeURIComponent(body.breakdownId), { status: 'closed', closed_at: new Date().toISOString(), token_hash: null });
  return { ok: true };
}

export async function resolveAlert(env, request, body) {
  const { db, userId } = await requireStaff(env, request);
  await db.update('alerts', 'id=eq.' + encodeURIComponent(body.alertId), { resolved_at: new Date().toISOString(), resolved_by: userId });
  return { ok: true };
}

/* =========================== SCHEDULED =========================== */

/** Reminders for breakdowns, proof and club receipts left 14 days. A few per call; the GitHub Action calls again until done. */
export async function cronReminders(env, now = new Date()) {
  const db = createDb(env);
  const cutoff = new Date(now.getTime() - REMIND_AFTER_DAYS * DAY).toISOString();
  const due = (last, since) => String(last || since || now.toISOString()) < cutoff;
  const LIMIT = 6;
  let sent = 0, remaining = 0;

  const bds = await db.select('breakdowns?select=*,breakdown_lines(description,amount,proof_requested,proof_file_id),applications(ref,org_name,applicant_email)&status=in.(requested,proof_requested)');
  for (const b of bds.filter((x) => due(x.last_reminded_at, x.status === 'requested' ? x.requested_on : x.submitted_at))) {
    if (sent >= LIMIT) { remaining++; continue; }
    const token = newToken(), a = one(b.applications);
    await db.update('breakdowns', 'id=eq.' + b.id, { token_hash: await hashToken(token), last_reminded_at: now.toISOString() });
    const mail = b.status === 'requested'
      ? templates.breakdownRequest({ ref: a.ref, orgName: a.org_name, from: b.period_from, to: b.period_to, total: Number(b.total_paid), link: recipientLink(env, 'breakdown', token), reminder: true })
      : templates.proofRequest({ ref: a.ref, orgName: a.org_name, lines: b.breakdown_lines.filter((l) => l.proof_requested && !l.proof_file_id).map((l) => ({ description: l.description, amount: Number(l.amount) })), link: recipientLink(env, 'proof', token), reminder: true });
    await sendEmail(env, { to: a.applicant_email, ...mail }); sent++;
  }

  const recs = await db.select('invoice_receipts?select=id,requested_at,last_reminded_at,receipt_file_id,bank_confirmation_id,invoice:files!invoice_file_id(original_name),applications(id,ref,org_name,applicant_email,route_override)&requested_at=not.is.null');
  const byApp = new Map();
  for (const r of recs) {
    const a = one(r.applications);
    if (a.route_override || (r.receipt_file_id && r.bank_confirmation_id) || !due(r.last_reminded_at, r.requested_at)) continue;
    byApp.set(a.id, [...(byApp.get(a.id) || []), r]);
  }
  for (const rows of byApp.values()) {
    if (sent >= LIMIT) { remaining++; continue; }
    const token = newToken(), a = one(rows[0].applications);
    await db.update('invoice_receipts', 'id=in.(' + rows.map((r) => r.id).join(',') + ')', { token_hash: await hashToken(token), last_reminded_at: now.toISOString() });
    await sendEmail(env, { to: a.applicant_email, ...templates.receiptsRequest({ ref: a.ref, orgName: a.org_name, invoices: rows.map((r) => one(r.invoice).original_name), link: recipientLink(env, 'receipts', token), reminder: true }) });
    sent++;
  }
  return { ok: true, sent, remaining };
}

/** Re-check approved grants against the Charity Commission every 28 days, 4 per call. */
export async function cronRecheck(env, now = new Date()) {
  const db = createDb(env);
  const apps = await db.select('applications?select=id,ref,org_name,charity_number,cc_check,cc_checked_at,cc_rechecks(checked_at,result)&cc_rechecks.order=checked_at.desc&cc_rechecks.limit=1&registered=eq.true&approved_amount=not.is.null');
  const cutoff = new Date(now.getTime() - RECHECK_AFTER_DAYS * DAY).toISOString();
  const due = apps.filter((a) => String((a.cc_rechecks && a.cc_rechecks[0] && a.cc_rechecks[0].checked_at) || a.cc_checked_at || '') < cutoff);
  const batch = due.slice(0, 4), flagged = [];
  for (const a of batch) {
    try {
      const { check } = await checkCharity(a.charity_number, env.CHARITY_COMMISSION_API_KEY);
      const before = (a.cc_rechecks && a.cc_rechecks[0] && a.cc_rechecks[0].result) || a.cc_check;
      const problems = newProblems(before, check);
      await db.insert('cc_rechecks', [{ application_id: a.id, result: check, changed: problems.length > 0, checked_at: now.toISOString() }], { returning: false });
      if (problems.length) {
        await db.insert('alerts', problems.map((p) => ({ application_id: a.id, message: 'Charity Commission re-check: ' + p })), { returning: false });
        flagged.push({ ref: a.ref, orgName: a.org_name, problems });
      }
    } catch (e) { console.error('recheck failed', a.ref, e); }
  }
  if (flagged.length) await sendEmail(env, { to: env.OFFICE_EMAIL, ...templates.recheckAlert({ items: flagged, officeUrl: officeLink(env) }) });
  return { ok: true, checked: batch.length, flagged: flagged.length, remaining: due.length - batch.length };
}
