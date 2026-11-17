/* =====================================================================
   Toirem Grants – everything the server does. Called by functions/api/grants/[[path]].js.
   Public: charity lookup, postcode check, submit an application.
   Recipient links (one-time token): sign agreement, breakdown, proof, club receipts.
   Office (signed-in grants staff only): list, view, approve, agreement, payments, monitoring.
   Scheduled (GitHub Action with CRON_SECRET): reminders and Charity Commission re-checks.

   Cloudflare's free plan allows 50 outside calls per request, so lists are fetched in one
   query and scheduled work is done in small batches.
   ===================================================================== */
import { createDb, newToken, stableToken, hashToken, checkFile, storeFile } from './supabase.js';
import { checkCharity, CharityNotFound, getTrustees, newProblems, TOIREM_CHARITY_NUMBER, probe, searchCharities, quickCheck } from './charity.js';
import { lookupPostcode } from './postcode.js';
import { sendEmail, templates, officeLink, recipientLink, siteUrl, applicationDetailsHtml, applicationPdfHtml, pdfName, makePdf, footerImage, siteImage, agreementPdfHtml, individualPdfHtml, mailer } from './email.js';
import { validateApplication } from './validate.js';
import { DEFAULT_TERMS } from './terms.js';
import { validateIndividual, individualName, purposeText } from './individual.js';
import { statusOf, checkPayment, needsAgreement, paysClubAccount, paymentsInPeriod, DEFAULT_AGREEMENT_THRESHOLD } from './rules.js';

export class UserError extends Error {}
export class NotAllowed extends Error {}

const today = () => new Date().toISOString().slice(0, 10);
function londonTime(d) { return new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' }); }
const DAY = 864e5;
const REMIND_AFTER_DAYS = 14;
const RECHECK_AFTER_DAYS = 28;
const MAX_INVOICES = 8;
const one = (v) => (Array.isArray(v) ? v[0] || null : v || null);

/* ---------------- shared loading ---------------- */
const GRANT_SELECT = 'select=*,agreements(*),payments(*),receipt_requests(*),breakdowns(*,breakdown_lines(*)),invoice_receipts(*,invoice:files!invoice_file_id(original_name)),alerts(*)';

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
    imported: a.source === 'import', completed: !!a.completed_at, completeSent: !!a.complete_sent_at,
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
/** The standard agreement wording saved in Settings (empty = the built-in wording). */
async function standardTerms(db) {
  const r = await db.one('settings?select=value&key=eq.agreement_terms').catch(() => null);
  return r && typeof r.value === 'string' ? r.value : '';
}
const paidTotal = (a) => (a.payments || []).reduce((t, p) => t + Number(p.amount), 0);
function agreementData(a, ag, std = '') {
  const c = a.cc_check, f = a.form || {};
  const address = c ? [...c.address.lines, c.address.town, c.address.postcode].filter(Boolean).join(', ')
    : [f.org?.line1, f.org?.town, f.org?.postcode].filter(Boolean).join(', ');
  const o = (ag && ag.overrides) || {};
  const pick = (k, v) => (o[k] != null && String(o[k]).trim() !== '' ? o[k] : v);
  const bank = { ...(f.bank || {}) };
  for (const k of ['acname', 'bank', 'sort', 'acno']) bank[k] = pick('bank_' + k, bank[k]);
  return {
    recipientName: pick('recipientName', a.org_name), recipientAddress: pick('recipientAddress', address), ref: a.ref,
    // The grant amount on the agreement is the total actually paid, rounded up to whole pounds
    // (before any payment it is the approved amount).
    // An amount typed in "Edit the agreement" wins.
    amount: Number(o.amount) > 0 ? Number(o.amount) : paidTotal(a) > 0 ? Math.ceil(paidTotal(a) - 1e-9) : Number(a.approved_amount),
    customAmount: Number(o.amount) > 0,
    approved: Number(a.approved_amount),
    purpose: a.purpose || '', method: pick('method', a.payment_method || ''), bank, extra: o.extra || '',
    // Signed agreements keep the wording they were signed with.
    terms: (ag && ag.status === 'signed' && ag.snapshot && ag.snapshot.terms) || o.terms || std || DEFAULT_TERMS,
    customTerms: !!o.terms,
    toirem: { name: ag?.toirem_signatory || null, position: ag?.toirem_position || null, date: o.date || ag?.sent_on || null },
    recipient: ag?.signed_name ? { name: ag.signed_name, date: ag.signed_date, font: ag.signed_font } : null,
    payments: (a.payments || []).slice().sort((x, y) => String(x.paid_on).localeCompare(String(y.paid_on)))
      .map((p) => ({ date: p.paid_on, amount: Number(p.amount) })),
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
  const applicantName = [form.app.title, form.app.first, form.app.last].filter(Boolean).join(' ');
  const applicantEmail = form.app.same ? (orgEmail || form.app.email) : form.app.email;
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
    await sendEmail(env, { to: env.OFFICE_EMAIL, replyTo: applicantEmail, attachments: [{ name: file, html: applicationPdfHtml(form, cc, { ...meta, checked: cc && cc.checkedAt ? londonTime(cc.checkedAt) : '' }, { footer: await footerImage(env) }) }], ...templates.applicationReceived({
      ref: row.ref, orgName, type: cc ? 'Registered charity ' + cc.number : 'Club / community account',
      applicant: `${applicantName}, ${pos} (${applicantEmail})`, cost: form.grant.cost, use: form.grant.use, warnings,
      officeUrl: officeLink(env, row.id), details: applicationDetailsHtml(form, cc),
    }) });
  } catch (e) { console.error('office email', e); } // the application is saved; the office still sees it in the list
  try { await sendEmail(env, { to: applicantEmail, attachments: [{ name: file, html: applicationPdfHtml(form, cc, meta, { includeCheck: false, footer: await footerImage(env) }) }], ...templates.applicationConfirmation({ ref: row.ref, orgName, applicantName }) }); }
  catch (e) { console.error('confirmation email', e); }

  await note(db, { applicationId: row.id, ref: row.ref, fromName: applicantName, fromEmail: applicantEmail, subject: `New application: ${orgName} (${row.ref})`, body: `${applicantName} applied for a grant for ${orgName}.\nHow the funds will be used: ${form.grant.use}` });
  return { ok: true, ref: row.ref };
}

/* =========================== RECIPIENT LINKS =========================== */

export async function openLink(env, body) {
  if (body.kind === 'complete') return openCompletion(env, body.token);
  const db = createDb(env);
  const h = await hashToken(body.token);
  if (body.kind === 'receipt') {
    const r = await db.one('receipt_requests?select=*,applications(id,ref,org_name,payments(paid_on,amount))&token_hash=eq.' + h);
    if (!r) return { ok: false };
    const a = one(r.applications);
    const sent = (r.file_ids || []).length ? await db.select('files?select=original_name,uploaded_at&id=in.(' + r.file_ids.join(',') + ')') : [];
    return { ok: true, ref: a.ref, orgName: a.org_name, request: { from: r.period_from, to: r.period_to, total: Number(r.total), sent: sent.map((f) => f.original_name),
      payments: (a.payments || []).filter((p) => p.paid_on >= r.period_from && p.paid_on <= r.period_to).sort((x, y) => x.paid_on.localeCompare(y.paid_on)).map((p) => ({ date: p.paid_on, amount: Number(p.amount) })) } };
  }
  if (body.kind === 'sign') {
    const ag = await db.one('agreements?select=*,applications(*,payments(*))&status=eq.sent&token_hash=eq.' + h);
    if (!ag) return { ok: false };
    const a = one(ag.applications);
    return { ok: true, ref: a.ref, orgName: a.org_name, agreement: agreementData(a, ag, await standardTerms(db)) };
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
  const snapshot = { ...agreementData(a, ag, await standardTerms(db)), recipient: { name, date, font: String(body.font || '') } };
  await db.update('agreements', 'id=eq.' + ag.id, {
    status: 'signed', signed_name: name, signed_date: date, signed_font: String(body.font || '').slice(0, 40),
    signed_at: new Date().toISOString(), signer_ip: ip || null, snapshot, token_hash: null,
  });
  try { await sendEmail(env, { to: env.OFFICE_EMAIL, ...templates.agreementSigned({ ref: a.ref, orgName: a.org_name, signedBy: name, officeUrl: officeLink(env, a.id) }) }); }
  catch (e) { console.error('signed email', e); }
  await note(db, { applicationId: a.id, ref: a.ref, fromName: name, fromEmail: a.applicant_email, subject: `Agreement signed: ${a.org_name} (${a.ref})`, body: `${name} signed the grant agreement on ${date}.` });
  return { ok: true };
}

export async function submitBreakdown(env, body) {
  const db = createDb(env);
  const b = await db.one('breakdowns?select=id,period_from,period_to,applications(id,ref,org_name,applicant_email)&status=eq.requested&token_hash=eq.' + (await hashToken(body.token)));
  if (!b) throw new UserError('This link has expired or the breakdown was already sent.');
  const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 100)
    .map((l) => ({ description: String(l.description || '').trim().slice(0, 300), amount: Number(l.amount) }))
    .filter((l) => l.description && l.amount >= 0);
  if (!lines.length) throw new UserError('Add at least one line.');
  await db.insert('breakdown_lines', lines.map((l) => ({ breakdown_id: b.id, ...l })), { returning: false });
  await db.update('breakdowns', 'id=eq.' + b.id, { status: 'submitted', submitted_at: new Date().toISOString(), token_hash: null });
  { const a = one(b.applications); await note(db, { applicationId: a.id, ref: a.ref, fromName: a.org_name, fromEmail: a.applicant_email, subject: `Breakdown received: ${a.org_name} (${a.ref})`, body: `How the grant was used, ${b.period_from} to ${b.period_to}:\n` + lines.map((l) => `• ${l.description}: £${Number(l.amount).toFixed(2)}`).join('\n') }); }
  return { ok: true };
}

export async function submitProof(env, formData) {
  const db = createDb(env);
  const b = await db.one('breakdowns?select=id,breakdown_lines(id,proof_requested,proof_file_id),applications(id,ref,org_name,applicant_email)&status=eq.proof_requested&token_hash=eq.' + (await hashToken(formData.get('token'))));
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
  { const a = one(b.applications); await note(db, { applicationId: a.id, ref: a.ref, fromName: a.org_name, fromEmail: a.applicant_email, subject: `Proof uploaded: ${a.org_name} (${a.ref})`, body: `${done} proof file(s) uploaded${wanted.length - done > 0 ? `; ${wanted.length - done} still to come` : ''}.` }); }
  return { ok: true, remaining: wanted.length - done };
}

export async function submitReceipts(env, formData) {
  const db = createDb(env);
  const rows = await db.select('invoice_receipts?select=id,receipt_file_id,bank_confirmation_id,applications(id,ref,org_name,applicant_email)&token_hash=eq.' + (await hashToken(formData.get('token'))));
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
  if (uploads) { const a = one(rows[0].applications); await note(db, { applicationId: a.id, ref: a.ref, fromName: a.org_name, fromEmail: a.applicant_email, subject: `Receipts uploaded: ${a.org_name} (${a.ref})`, body: `${uploads} document(s) uploaded (receipts / bank confirmations).` }); }
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
    db.select('applications?select=id,ref,created_at,org_name,registered,charity_number,kind,beneficiary_id,route,route_override,approved_amount,source,imported,completed_at,complete_sent_at,agreements(status),payments(amount,paid_on),breakdowns(status),invoice_receipts(requested_at,receipt_file_id,bank_confirmation_id),alerts(resolved_at)&order=created_at.desc'),
    threshold(db),
  ]);
  return { ok: true, me: name, threshold: t, grants: rows.map((a) => {
    const st = stateOf(a);
    return { id: a.id, ref: a.ref, created: a.created_at, orgName: a.org_name, registered: a.registered, charityNumber: a.charity_number, kind: a.kind || 'charity', beneficiaryId: a.beneficiary_id, imported: a.source === 'import',
      status: statusOf(st, t), approved: st.approvedAmount,
      // Paid: payments recorded here; for an imported grant with none yet, what the platform paid.
      paid: st.payments.reduce((s, p) => s + p.amount, 0) || (a.source === 'import' && a.imported ? Number(a.imported.redeemed) || 0 : 0) };
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
    agreement: a.agreement ? agreementData(a, a.agreement, await standardTerms(db)) : null, standardTerms: (await standardTerms(db)) || DEFAULT_TERMS };
}

/** The submitted application as a PDF, for the office "Download PDF" button. */
export async function officePdf(env, request, id) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, id);
  const meta = { ref: a.ref, orgName: a.org_name, submitted: new Date(a.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' }) };
  const name = pdfName(a.ref, a.org_name);
  if (a.kind === 'individual') {
    if (!a.form || !a.form.person) throw new UserError('This person has not completed the application form yet.');
    const docs = (await db.select('files?select=kind&application_id=eq.' + a.id)).map((f) => FILE_LABEL[f.kind] || f.kind);
    const html = individualPdfHtml(a.form, { ...meta, docs, approved: a.approved_amount == null ? null : Number(a.approved_amount), authorised: a.approved_on || '' }, { logo: await siteImage(env, 'toirem-logo-light.png') });
    const out = await makePdf(env, html, name).catch((e) => { throw new UserError(e.message); });
    return new Response(out, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
  }
  const bytes = await makePdf(env, applicationPdfHtml(a.form, a.cc_check, { ...meta, checked: a.cc_checked_at ? londonTime(a.cc_checked_at) : '' }, { footer: await footerImage(env) }), name).catch((e) => { throw new UserError(e.message); });
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
}

/** The signed grant agreement as a PDF, in the same layout as on screen. */
export async function officeAgreementPdf(env, request, id, body = {}) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, id);
  if (!a.agreement) throw new UserError('This grant has no agreement.');
  const data = agreementData(a, a.agreement, await standardTerms(db));
  const signed = a.agreement.status === 'signed';
  if (signed && a.agreement.signed_at) data.recipient.signedAt = londonTime(a.agreement.signed_at);
  if (!signed) {
    data.draft = true;
    if (!data.toirem.date) data.toirem.date = today();
    if (!data.toirem.name && body && body.signatory) {
      const t = (await getTrustees(TOIREM_CHARITY_NUMBER, env.CHARITY_COMMISSION_API_KEY).catch(() => [])).find((x) => x.name === body.signatory);
      if (t) data.toirem = { ...data.toirem, name: t.name, position: t.position };
    }
  }
  const name = pdfName(a.ref + ' Grant Agreement' + (signed ? '' : ' DRAFT'), a.org_name);
  const letterhead = await siteImage(env, 'toirem-letterhead.jpg');
  const bytes = await makePdf(env, agreementPdfHtml(data, { letterhead }), name).catch((e) => { throw new UserError(e.message); });
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
  const to = String(body.email || a.applicant_email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new UserError('Enter a valid email address to send the agreement to.');
  // First send: a trustee must be chosen. Sending again keeps the trustee unless a new one is chosen.
  let signatory = a.agreement.toirem_signatory, position = a.agreement.toirem_position;
  if (body.signatory || a.agreement.status === 'draft') {
    const trustee = (await getTrustees(TOIREM_CHARITY_NUMBER, env.CHARITY_COMMISSION_API_KEY)).find((x) => x.name === body.signatory);
    if (!trustee) throw new UserError('Choose the trustee signing for Toirem.');
    signatory = trustee.name; position = trustee.position;
  }
  const token = newToken(); // a new link; any earlier link stops working
  await db.update('agreements', 'id=eq.' + a.agreement.id, {
    status: 'sent', toirem_signatory: signatory, toirem_position: position, sent_on: today(), sent_to: to, token_hash: await hashToken(token),
  });
  await sendEmail(env, { to, ...templates.agreementToSign({ ref: a.ref, orgName: a.org_name, amount: Number(a.approved_amount), link: recipientLink(env, 'sign', token) }) });
  return { ok: true, to };
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
      const token = await stableToken(env, 'receipts', a.id); // one link per grant, still valid after later payments and reminders
      await db.update('invoice_receipts', 'id=in.(' + pending.map((r) => r.id).join(',') + ')', { requested_at: new Date().toISOString(), token_hash: await hashToken(token) });
      const others = (a.invoice_receipts || []).filter((r) => r.requested_at && !(r.receipt_file_id && r.bank_confirmation_id));
      if (others.length) await db.update('invoice_receipts', 'id=in.(' + others.map((r) => r.id).join(',') + ')', { token_hash: await hashToken(token) });
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
  const id = crypto.randomUUID();
  const token = await stableToken(env, 'breakdown', id);
  const m = await requestEmail(env, db, { ...body, kind: 'breakdown', link: recipientLink(env, 'breakdown', token) });
  if (m.a.breakdowns.some((x) => x.status !== 'closed')) throw new UserError('A breakdown is already open for this grant.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.to_ || '')) throw new UserError('Enter a valid email address.');
  await db.insert('breakdowns', [{ id, application_id: m.a.id, period_from: m.from, period_to: m.to, total_paid: m.total, token_hash: await hashToken(token) }], { returning: false });
  await sendEmail(env, { to: m.to_, subject: m.subject, html: m.html });
  return { ok: true, to: m.to_ };
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
  const token = await stableToken(env, 'proof', b.id);
  await db.update('breakdowns', 'id=eq.' + b.id, { status: 'proof_requested', token_hash: await hashToken(token), last_reminded_at: new Date().toISOString() }); // first reminder 14 days from now
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
    const a = one(b.applications);
    const token = await stableToken(env, b.status === 'requested' ? 'breakdown' : 'proof', b.id); // same link as the first email
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
    const a = one(rows[0].applications);
    const token = await stableToken(env, 'receipts', a.id);
    await db.update('invoice_receipts', 'id=in.(' + rows.map((r) => r.id).join(',') + ')', { token_hash: await hashToken(token), last_reminded_at: now.toISOString() });
    await sendEmail(env, { to: a.applicant_email, ...templates.receiptsRequest({ ref: a.ref, orgName: a.org_name, invoices: rows.map((r) => one(r.invoice).original_name), link: recipientLink(env, 'receipts', token), reminder: true }) });
    sent++;
  }
  const rrs = await db.select('receipt_requests?select=*,applications(id,ref,org_name,applicant_email,payments(paid_on,amount))&received_at=is.null');
  const inbox = await cronInbox(env);
  for (const r of rrs.filter((x) => due(x.last_reminded_at, x.requested_on))) {
    if (sent >= LIMIT) { remaining++; continue; }
    const a = one(r.applications);
    const token = await stableToken(env, 'receipt', r.id);
    await db.update('receipt_requests', 'id=eq.' + r.id, { token_hash: await hashToken(token), last_reminded_at: now.toISOString() });
    const payments = (a.payments || []).filter((p) => p.paid_on >= r.period_from && p.paid_on <= r.period_to).map((p) => ({ date: p.paid_on, amount: Number(p.amount) }));
    await sendEmail(env, { to: r.sent_to || a.applicant_email, ...templates.donationReceiptRequest({ ref: a.ref, orgName: a.org_name, from: r.period_from, to: r.period_to, total: Number(r.total), payments, link: recipientLink(env, 'receipt', token), reminder: true }) });
    sent++;
  }
  return { ok: true, sent, remaining, inbox };
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

/* =========================== PAST GRANTS IMPORT =========================== */

const isoNow = () => new Date().toISOString();
const charityForForm = (c) => ({ name: c.name, number: c.number, regDate: c.regDate, address: c.address, phone: c.phone, email: c.email, website: c.website, trustees: c.trustees, objects: c.objects, activities: c.activities });

/** Step 1 of an import: check the charity numbers against the register (one quick call each) and spot ones already imported. */
export async function importCheck(env, request, body) {
  const { db } = await requireStaff(env, request);
  const numbers = [...new Set((Array.isArray(body.numbers) ? body.numbers : []).map((n) => String(n).replace(/\D/g, '')).filter(Boolean))].slice(0, 40);
  if (!numbers.length) return { ok: true, results: [] };
  const [checks, existing] = await Promise.all([
    quickCheck(numbers, env.CHARITY_COMMISSION_API_KEY),
    db.select('applications?select=id,ref,charity_number,imported&source=eq.import&charity_number=in.(' + numbers.join(',') + ')'),
  ]);
  return { ok: true, results: checks.map((c) => ({
    ...c,
    already: existing.filter((e) => e.charity_number === c.number).map((e) => ({ id: e.id, ref: e.ref, campaigns: ((e.imported && e.imported.campaigns) || []).map((x) => String(x.number)) })),
  })) };
}

/** Step 2: create the grants (4 per call, as each pulls the full Charity Commission record). */
export async function importGrants(env, request, body) {
  const { db, userId } = await requireStaff(env, request);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 4);
  const done = [];
  for (const it of items) {
    const number = String(it.number || '').replace(/\D/g, '');
    const campaigns = (Array.isArray(it.campaigns) ? it.campaigns : []).slice(0, 50).map((c) => ({
      number: String(c.number || '').slice(0, 30), name: String(c.name || '').slice(0, 200),
      approved: Number(c.approved) || 0, redeemed: Number(c.redeemed) || 0, doc: /^https?:\/\//.test(c.doc || '') ? String(c.doc).slice(0, 1000) : '',
    }));
    try {
      const prior = await db.select('applications?select=ref,imported&source=eq.import&charity_number=eq.' + number);
      const priorCampaigns = new Set(prior.flatMap((p) => ((p.imported && p.imported.campaigns) || []).map((x) => String(x.number))));
      if (campaigns.length && campaigns.every((c) => priorCampaigns.has(c.number))) { done.push({ number, skipped: true, message: 'Already imported as ' + prior.map((p) => p.ref).join(', ') }); continue; }
      const { check: cc, raw } = await checkCharity(number, env.CHARITY_COMMISSION_API_KEY);
      // Causes of one beneficiary share one pot: the grant is the highest approved amount, paid is everything redeemed.
      const approved = Math.round(Math.max(0, ...campaigns.map((c) => c.approved)) * 100) / 100;
      const redeemed = Math.round(campaigns.reduce((s, c) => s + c.redeemed, 0) * 100) / 100;
      const [row] = await db.insert('applications', [{
        source: 'import', registered: true, charity_number: cc.number, org_name: cc.name, org_email: cc.email || null,
        applicant_name: null, applicant_email: null,
        form: { registered: true, charityNumber: cc.number, imported: true },
        cc_check: { ...cc, raw }, cc_checked_at: cc.checkedAt,
        approved_amount: approved > 0 ? approved : null, approved_by: userId, payment_method: 'Bank transfer',
        purpose: null, // filled from the charity's own answer when they complete the form (campaign names are not a purpose)
        imported: { fileName: String(it.fileName || '').slice(0, 200), fileOrgName: String(it.fileOrgName || '').slice(0, 200), currency: String(it.currency || 'GBP').slice(0, 5), approved, redeemed, campaigns, docs: cleanDocs(it.docs), consent: cleanUrls(it.consent), importedAt: isoNow() },
        kind: 'charity',
      }]);
      done.push({ number, id: row.id, ref: row.ref, name: cc.name, warnings: cc.warnings });
    } catch (e) {
      done.push({ number, failed: true, message: e instanceof CharityNotFound ? e.message : 'Could not import: ' + e.message });
    }
  }
  return { ok: true, results: done };
}

/** Send the recipient a link to the pre-filled application form. */
export async function sendCompletion(env, request, body) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, body.id);
  if (a.source !== 'import') throw new UserError('Only imported grants need completing.');
  if (a.completed_at) throw new UserError('This grant has already been completed.');
  const to = String(body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new UserError('Enter a valid email address for the charity.');
  if (a.kind === 'club') throw new UserError('For a community account, send the application form instead (grants list › Send the application form).');
  const token = newToken();
  await db.update('applications', 'id=eq.' + a.id, { complete_token_hash: await hashToken(token), complete_sent_at: isoNow(), complete_sent_to: to });
  const amount = a.approved_amount ? Number(a.approved_amount) : 0;
  await sendEmail(env, { to, ...(a.kind === 'individual'
    ? templates.completeRequestIndividual({ ref: a.ref, name: a.org_name, amount, link: siteUrl(env) + '/grants/individual.html#complete/' + token })
    : templates.completeRequest({ ref: a.ref, orgName: a.org_name, amount, link: siteUrl(env) + '/grants/apply.html#complete/' + token })) });
  return { ok: true };
}

/** The recipient opens the completion link: send back what's already known. */
export async function openCompletion(env, token) {
  const db = createDb(env);
  const a = await db.one('applications?select=ref,org_name,cc_check,approved_amount,purpose,imported,kind&completed_at=is.null&complete_token_hash=eq.' + (await hashToken(token)));
  if (a && a.kind === 'individual') return { ok: true, kind: 'individual', ref: a.ref, orgName: a.org_name, approved: a.approved_amount ? Number(a.approved_amount) : null };
  if (!a || !a.cc_check) return { ok: false };
  const purpose = a.purpose && a.purpose !== campaignNames(a) ? a.purpose : '';
  return { ok: true, ref: a.ref, orgName: a.org_name, charity: charityForForm(a.cc_check), approved: a.approved_amount ? Number(a.approved_amount) : null, purpose };
}

/** The recipient submits the completed form: same checks as a new application, saved onto the imported grant. */
export async function completeApplication(env, formData, ip) {
  const db = createDb(env);
  const a = await db.one('applications?select=*,agreements(id)&completed_at=is.null&complete_token_hash=eq.' + (await hashToken(formData.get('token'))));
  if (!a) throw new UserError('This link has expired or the form has already been completed.');
  let raw;
  try { raw = JSON.parse(String(formData.get('form') || '')); } catch (e) { throw new UserError('The form could not be read. Please try again.'); }
  raw.registered = true; raw.charityNumber = a.charity_number;
  const v = validateApplication(raw);
  if (v.errors) return { ok: false, errors: v.errors };
  const form = v.data;
  const bankProof = formData.get('bankProof');
  const be = checkFile(bankProof, 'proof of bank'); if (be) return { ok: false, errors: { 'bank.proof': be } };

  let cc = a.cc_check, ccRaw = cc && cc.raw;
  try { ({ check: cc, raw: ccRaw } = await checkCharity(a.charity_number, env.CHARITY_COMMISSION_API_KEY)); } catch (e) { console.error('recheck on completion', e); }
  const orgEmail = cc.email || '';
  const applicantName = [form.app.title, form.app.first, form.app.last].filter(Boolean).join(' ');
  const applicantEmail = form.app.same ? (orgEmail || form.app.email) : form.app.email;
  if (!applicantEmail) return { ok: false, errors: { 'app.email': "The register has no email for this charity. Untick 'same contact details' and enter yours." } };

  await db.update('applications', 'id=eq.' + a.id, {
    ...(!a.purpose || a.purpose === campaignNames(a) ? { purpose: String(form.grant.use || '').slice(0, 1000) } : {}),
    form: { ...form, orgPhone: cc.phone, submittedFromIp: ip || null, imported: true },
    org_email: orgEmail || applicantEmail, applicant_name: applicantName, applicant_email: applicantEmail,
    cc_check: { ...cc, raw: ccRaw }, cc_checked_at: cc.checkedAt || isoNow(),
    details_incorrect: form.incorrect ? form.incorrectNote : null,
    completed_at: isoNow(), complete_token_hash: null,
  });
  await storeFile(db, a.id, 'bank_proof', bankProof);
  const t = await threshold(db);
  const hasAgreement = (Array.isArray(a.agreements) ? a.agreements : a.agreements ? [a.agreements] : []).length > 0;
  if (a.approved_amount != null && needsAgreement(Number(a.approved_amount), t) && !hasAgreement) {
    await db.insert('agreements', [{ application_id: a.id, status: 'draft' }], { returning: false });
  }

  const meta = { ref: a.ref, orgName: a.org_name, submitted: londonTime(isoNow()) };
  const file = pdfName(a.ref, a.org_name);
  const pos = form.app.position === 'Other' ? form.app.positionOther : form.app.position;
  try {
    await sendEmail(env, { to: env.OFFICE_EMAIL, replyTo: applicantEmail, attachments: [{ name: file, html: applicationPdfHtml(form, cc, { ...meta, checked: cc && cc.checkedAt ? londonTime(cc.checkedAt) : '' }, { footer: await footerImage(env) }) }], ...templates.applicationReceived({
      completed: true, ref: a.ref, orgName: a.org_name, type: 'Registered charity ' + a.charity_number + ' · imported past grant',
      applicant: `${applicantName}, ${pos} (${applicantEmail})`, cost: form.grant.cost, use: form.grant.use, warnings: cc.warnings || [],
      officeUrl: officeLink(env, a.id), details: applicationDetailsHtml(form, cc),
    }) });
  } catch (e) { console.error('office email', e); }
  try { await sendEmail(env, { to: applicantEmail, attachments: [{ name: file, html: applicationPdfHtml(form, cc, meta, { includeCheck: false, footer: await footerImage(env) }) }], ...templates.applicationConfirmation({ ref: a.ref, orgName: a.org_name, applicantName }) }); }
  catch (e) { console.error('confirmation email', e); }
  await note(db, { applicationId: a.id, ref: a.ref, fromName: applicantName, fromEmail: applicantEmail, subject: `Details completed: ${a.org_name} (${a.ref})`, body: `${applicantName} completed the pre-filled form.` });
  return { ok: true, ref: a.ref };
}

/* =========================== BANK TRANSFERS (past and present) =========================== */

/** Short, address-safe fingerprint of one bank transfer, so the same line is never added twice. */
async function bankKeyHash(key) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key)));
  return [...new Uint8Array(d)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Everything the upload page needs to suggest a grant for each transfer. */
export async function bankMatchData(env, request) {
  const { db } = await requireStaff(env, request);
  const [apps, learned, pending, counts] = await Promise.all([
    db.select('applications?select=id,ref,org_name,charity_number,approved_amount,source,form,imported,payments(amount,bank_key)&order=created_at.desc'),
    db.select('payee_matches?select=payee_key,application_id').catch(() => []),
    db.select('bank_lines?select=' + LINE_COLS + '&status=eq.pending&order=paid_on.desc&limit=3000'),
    lineCounts(db),
  ]);
  return { ok: true, learned, pending: pending.map(lineOut), counts, grants: apps.map((a) => ({
    id: a.id, ref: a.ref, name: a.org_name, number: a.charity_number,
    approved: a.approved_amount == null ? null : Number(a.approved_amount),
    paid: (a.payments || []).reduce((s, p) => s + Number(p.amount), 0),
    keys: (a.payments || []).map((p) => p.bank_key).filter(Boolean),
    acname: (a.form && a.form.bank && a.form.bank.acname) || '', acno: (a.form && a.form.bank && a.form.bank.acno) || '',
    sort: String((a.form && a.form.bank && a.form.bank.sort) || '').replace(/\D/g, ''),
    fileName: (a.imported && a.imported.fileOrgName) || '',
    campaigns: ((a.imported && a.imported.campaigns) || []).map((c) => String(c.number)),
  })) };
}

/** Save the transfers the admin confirmed as payments on their grants (up to 100 per call). */
export async function bankImport(env, request, body) {
  const { db, userId } = await requireStaff(env, request);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 40);
  if (!items.length) throw new UserError('Choose at least one payment to add.');
  const ids = [...new Set(items.map((i) => String(i.grantId || '')).filter((x) => /^[\w-]{10,}$/.test(x)))];
  const known = new Set((await db.select('applications?select=id&id=in.(' + ids.join(',') + ')')).map((r) => r.id));
  const rows = [];
  for (const it of items) {
    const amount = Math.round(Number(it.amount) * 100) / 100;
    if (!known.has(String(it.grantId)) || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) continue;
    rows.push({
      application_id: it.grantId, paid_on: it.date, amount, trustees_approved_on: null, recorded_by: userId,
      source: 'bank', bank: clean(it.bank, 20), payee: clean(it.payee, 200), reference: clean(it.reference, 300),
      bank_key: await bankKeyHash(it.key || [it.bank, it.bankRef, it.date, amount, it.payee].join('|')),
    });
  }
  const keys = [...new Set(rows.map((r) => r.bank_key))];
  const existing = keys.length ? new Set((await db.select('payments?select=bank_key&bank_key=in.(' + keys.join(',') + ')')).map((r) => r.bank_key)) : new Set();
  const seen = new Set();
  const fresh = rows.filter((r) => !existing.has(r.bank_key) && !seen.has(r.bank_key) && seen.add(r.bank_key));
  if (fresh.length) await db.insert('payments', fresh, { returning: false });
  // The saved statement lines move to "Added".
  const now = new Date().toISOString();
  // One call per grant (the host allows only so many database calls per request).
  const byGrant = new Map();
  for (const r of rows) { if (!byGrant.has(r.application_id)) byGrant.set(r.application_id, []); byGrant.get(r.application_id).push(r.bank_key); }
  await Promise.all([...byGrant].map(([gid, keys]) => db.update('bank_lines', 'bank_key=in.(' + keys.join(',') + ')', { status: 'added', application_id: gid, auto_added: !!body.auto, decided_at: now }).catch(() => {})));
  // Remember payee → grant for next time.
  const learn = new Map();
  for (const it of items) if (it.payeeKey && known.has(String(it.grantId))) learn.set(String(it.payeeKey).slice(0, 120), it.grantId);
  if (learn.size) await db.upsert('payee_matches', [...learn].map(([payee_key, application_id]) => ({ payee_key, application_id, updated_at: new Date().toISOString() })), 'payee_key').catch((e) => console.error('learn', e));
  return { ok: true, added: fresh.length, duplicates: rows.length - fresh.length };
}

/** Counts for the Toirem Management home page. Only grants staff get an answer. */
export async function officeSummary(env, request) {
  const list = await officeList(env, request);
  const by = {};
  let approved = 0, paid = 0;
  for (const g of list.grants) { by[g.status] = (by[g.status] || 0) + 1; approved += Number(g.approved) || 0; paid += Number(g.paid) || 0; }
  const n = (...k) => k.reduce((s, x) => s + (by[x] || 0), 0);
  const unread = (await createDb(env).select('messages?select=id&read_at=is.null&limit=1000').catch(() => [])).length;
  return { ok: true, total: list.grants.length, approved, paid, unread, counts: {
    attention: n('Needs attention'), newApps: n('New application'), toSend: n('Agreement to send'), awaitingSign: n('Awaiting signature'),
    monitoring: n('Breakdown requested', 'Breakdown to review', 'Proof requested', 'Receipts due'), toReview: n('Breakdown to review'),
    details: n('Details to complete', 'Awaiting details'), active: n('Approved', 'Active'), done: n('Fully paid'),
  } };
}

/** Take back bank payments that were added by mistake, and forget the payee match so they aren't added automatically again. */
export async function bankUndo(env, request, body) {
  const { db } = await requireStaff(env, request);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100);
  if (!items.length) throw new UserError('Nothing to undo.');
  let removed = 0;
  const hashes = [];
  for (const it of items) hashes.push(await bankKeyHash(it.key));
  const gone = await db.remove('payments', 'source=eq.bank&bank_key=in.(' + hashes.join(',') + ')');
  await db.update('bank_lines', 'bank_key=in.(' + hashes.join(',') + ')', { status: 'pending', application_id: null, auto_added: false, decided_at: null }).catch(() => {});
  removed = Array.isArray(gone) ? gone.length : 0;
  const payees = [...new Set(items.map((i) => String(i.payeeKey || '').slice(0, 120)).filter(Boolean))];
  if (payees.length) await db.remove('payee_matches', 'payee_key=in.(' + payees.map((k) => '"' + encodeURIComponent(k.replace(/"/g, '')) + '"').join(',') + ')').catch(() => {});
  return { ok: true, removed };
}

/* ---------- saved bank lines ---------- */
/** Text from a statement, safe for the database (PDFs can hold invisible control characters, which Postgres refuses). */
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, ' ').replace(/[\uD800-\uDFFF]/g, '').slice(0, n);
const LINE_COLS = 'id,bank_key,line_key,bank,paid_on,amount,payee,reference,bank_ref,sort_code,details,status,application_id,auto_added,file_name,decided_at';
const lineOut = (l) => ({ id: l.id, hash: l.bank_key, key: l.line_key, bank: l.bank, date: l.paid_on, amount: Number(l.amount), payee: l.payee || '',
  reference: l.reference || '', bankRef: l.bank_ref || '', sort: l.sort_code || '', extra: l.details || '', status: l.status,
  grantId: l.application_id, auto: l.auto_added, file: l.file_name || '', decided: l.decided_at });
async function lineCounts(db) {
  const all = await db.select('bank_lines?select=status&limit=100000');
  const c = { pending: 0, added: 0, ignored: 0 };
  for (const l of all) c[l.status] = (c[l.status] || 0) + 1;
  return c;
}

/** Save uploaded statement lines (up to 100 per call). Lines already saved are left as they are. */
export async function bankLinesSave(env, request, body) {
  const { db } = await requireStaff(env, request);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100);
  const rows = [];
  for (const it of items) {
    const amount = Math.round(Number(it.amount) * 100) / 100;
    if (!(amount > 0) || !it.key) continue;
    rows.push({ bank_key: await bankKeyHash(it.key), line_key: clean(it.key, 400), bank: clean(it.bank, 20),
      paid_on: /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : null, amount, payee: clean(it.payee, 200),
      reference: clean(it.reference, 300), bank_ref: clean(it.bankRef, 60), sort_code: clean(it.sort, 10),
      details: clean(it.extra, 1500), file_name: clean(body.file || it.file, 120),
      status: 'pending', application_id: null, decided_at: null });
  }
  if (!rows.length) return { ok: true, added: 0 };
  const have = new Set((await db.select('bank_lines?select=bank_key&bank_key=in.(' + rows.map((r) => r.bank_key).join(',') + ')')).map((r) => r.bank_key));
  // A transfer already recorded as a grant payment (from before lines were saved) is saved as added.
  const paid = await db.select('payments?select=bank_key,application_id&bank_key=in.(' + rows.map((r) => r.bank_key).join(',') + ')');
  const paidBy = new Map(paid.map((p) => [p.bank_key, p.application_id]));
  const seen = new Set();
  const fresh = rows.filter((r) => !have.has(r.bank_key) && !seen.has(r.bank_key) && seen.add(r.bank_key))
    .map((r) => (paidBy.has(r.bank_key) ? { ...r, status: 'added', application_id: paidBy.get(r.bank_key), decided_at: new Date().toISOString() } : r)); // every row has the same fields, as a bulk insert needs
  if (fresh.length) await db.insert('bank_lines', fresh, { returning: false });
  return { ok: true, added: fresh.length, already: rows.length - fresh.length };
}

/** Lines that were added or marked "not a grant payment" (newest first). */
export async function bankLines(env, request, status) {
  const { db } = await requireStaff(env, request);
  if (!['added', 'ignored', 'pending'].includes(status)) throw new UserError('Unknown list.');
  const rows = await db.select('bank_lines?select=' + LINE_COLS + '&status=eq.' + status + '&order=paid_on.desc&limit=3000');
  return { ok: true, lines: rows.map(lineOut) };
}

/** Mark lines as not grant payments, or move them back to "To check". */
export async function bankMark(env, request, body) {
  const { db } = await requireStaff(env, request);
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => /^[\w-]{10,}$/.test(String(x))).slice(0, 500);
  if (!ids.length) throw new UserError('Choose at least one payment.');
  const to = body.to === 'ignored' ? 'ignored' : 'pending';
  const done = await db.update('bank_lines', 'status=neq.added&id=in.(' + ids.join(',') + ')', { status: to, decided_at: to === 'pending' ? null : new Date().toISOString(), application_id: null });
  return { ok: true, changed: done.length };
}

/** The campaign names an imported grant came with (used to tell them apart from a real purpose). */
function campaignNames(a) {
  return ((a.imported && a.imported.campaigns) || []).map((c) => c.name).filter(Boolean).join('; ').slice(0, 1000);
}

/** Change the purpose of a grant, as long as its agreement isn't signed. */
export async function setPurpose(env, request, body) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, body.id);
  if (a.agreement && a.agreement.status === 'signed') throw new UserError('The agreement is signed, so the purpose can no longer be changed.');
  const purpose = String(body.purpose || '').trim();
  if (!purpose) throw new UserError('Enter the purpose of the grant.');
  await db.update('applications', 'id=eq.' + a.id, { purpose: purpose.slice(0, 1000) });
  return { ok: true };
}

/** Save edits to an agreement that hasn't been signed. Empty boxes go back to the details from the application. */
export async function editAgreement(env, request, body) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, body.id);
  if (!a.agreement) throw new UserError('This grant has no agreement.');
  if (a.agreement.status === 'signed') throw new UserError('The agreement is signed, so it can no longer be changed.');
  const f = body.fields || {};
  const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const o = {};
  for (const [k, n] of [['recipientName', 200], ['recipientAddress', 400], ['method', 60], ['bank_acname', 120], ['bank_bank', 120], ['bank_sort', 12], ['bank_acno', 12], ['extra', 4000]]) {
    const v = t(f[k], n); if (v) o[k] = v;
  }
  // The letter and clauses: kept only if different from the standard wording.
  const std = (await standardTerms(db)) || DEFAULT_TERMS;
  const terms = String(f.terms == null ? '' : f.terms).replace(/\r\n/g, '\n').trim().slice(0, 30000);
  if (terms && terms !== std.trim()) o.terms = terms;
  if (body.saveStandard && terms) await db.upsert('settings', [{ key: 'agreement_terms', value: terms }], 'key');
  if (f.date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) throw new UserError('Choose a valid date.'); o.date = f.date; }
  // Grant amount: kept only if it differs from the automatic one (total paid, rounded up).
  if (f.amount !== undefined && String(f.amount).trim() !== '') {
    const amt = Math.round(Number(String(f.amount).replace(/[£,\s]/g, '')) * 100) / 100;
    if (!(amt > 0)) throw new UserError('Enter the grant amount in pounds, e.g. 15001.');
    const auto = agreementData(a, { ...a.agreement, overrides: null }).amount;
    if (Math.abs(amt - auto) > 0.004) o.amount = amt;
  }
  if (o.bank_sort && !/^\d{2}-?\d{2}-?\d{2}$/.test(o.bank_sort)) throw new UserError('Sort code: enter 6 digits, e.g. 40-16-15.');
  if (o.bank_acno && !/^\d{6,10}$/.test(o.bank_acno)) throw new UserError('Account number: enter digits only.');
  const purpose = t(f.purpose, 1000);
  if (!purpose) throw new UserError('Enter the purpose of the grant.');
  await Promise.all([
    db.update('agreements', 'id=eq.' + a.agreement.id, { overrides: Object.keys(o).length ? o : null }),
    purpose !== a.purpose ? db.update('applications', 'id=eq.' + a.id, { purpose }) : null,
  ]);
  return { ok: true };
}

/** A request email as it will be sent (the recipient's link is made when it is actually sent). kind: breakdown | receipt */
async function requestEmail(env, db, body) {
  const a = await loadGrant(db, body.id);
  const from = String(body.from || ''), to = String(body.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new UserError('Choose a valid period.');
  const payments = a.payments.filter((p) => p.paid_on >= from && p.paid_on <= to).map((p) => ({ date: p.paid_on, amount: Number(p.amount) }));
  // No payments recorded here (e.g. paid through the platform): use the amount entered in the office.
  const entered = Math.round(Number(body.amount) * 100) / 100;
  const total = payments.length ? Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100 : entered;
  if (!(total > 0)) throw new UserError('There are no payments recorded in that period. Enter the amount paid.');
  const kind = body.kind === 'receipt' ? 'receipt' : 'breakdown';
  const link = body.link || siteUrl(env) + '/grants/link.html#' + kind + '/…';
  const mail = (kind === 'receipt' ? templates.donationReceiptRequest : templates.breakdownRequest)({ ref: a.ref, orgName: a.org_name, from, to, total, payments, link });
  const sendTo = String(body.email || '').trim() || a.applicant_email;
  return { a, kind, from, to, total, payments, to_: sendTo, ...mail };
}
export async function previewEmail(env, request, body) {
  const { db } = await requireStaff(env, request);
  const m = await requestEmail(env, db, body);
  return { ok: true, to: m.to_, subject: m.subject, html: m.html };
}
export async function requestEmailPdf(env, request, body) {
  const { db } = await requireStaff(env, request);
  const m = await requestEmail(env, db, body);
  const name = pdfName(m.a.ref + (m.kind === 'receipt' ? ' Receipt request' : ' Breakdown request'), m.a.org_name);
  const t = (x) => String(x || '').replace(/</g, '&lt;');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t(m.subject)}</title></head><body style="margin:28px">
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#666;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:16px">
      <b>To:</b> ${t(m.to_)}<br><b>Subject:</b> ${t(m.subject)}</div>${m.html}</body></html>`;
  const bytes = await makePdf(env, html, name).catch((e) => { throw new UserError(e.message); });
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
}

/** Ask the charity for a receipt for the donations paid in a period. */
export async function requestDonationReceipt(env, request, body) {
  const { db } = await requireStaff(env, request);
  const id = crypto.randomUUID();
  const token = await stableToken(env, 'receipt', id);
  const m = await requestEmail(env, db, { ...body, kind: 'receipt', link: recipientLink(env, 'receipt', token) });
  if (m.a.receipt_requests.some((r) => !r.received_at && r.period_from === m.from && r.period_to === m.to)) throw new UserError('A receipt for that period has already been requested.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.to_ || '')) throw new UserError('Enter a valid email address.');
  await db.insert('receipt_requests', [{ id, application_id: m.a.id, period_from: m.from, period_to: m.to, total: m.total, sent_to: m.to_, token_hash: await hashToken(token) }], { returning: false });
  await sendEmail(env, { to: m.to_, subject: m.subject, html: m.html });
  return { ok: true, to: m.to_, link: recipientLink(env, 'receipt', token) };
}

/** The charity uploads its receipt(s): several files at once, and the link keeps working so more can be added. */
export async function submitDonationReceipt(env, formData) {
  const db = createDb(env);
  const r = await db.one('receipt_requests?select=*,applications(id,ref,org_name,applicant_email)&token_hash=eq.' + (await hashToken(formData.get('token'))));
  if (!r) throw new UserError('This link has expired.');
  const files = formData.getAll('file').filter((f) => f && typeof f !== 'string' && f.size > 0);
  if (!files.length) throw new UserError('Choose at least one receipt to upload.');
  if (files.length + (r.file_ids || []).length > 20) throw new UserError('Up to 20 files in total, please. Combine extra ones into one PDF.');
  for (const f of files) { const err = checkFile(f, 'each receipt'); if (err) throw new UserError(err + ' (' + f.name + ')'); }
  const a = one(r.applications);
  const ids = [];
  for (const f of files) ids.push(await storeFile(db, a.id, 'donation_receipt', f));
  const first = !r.received_at;
  await db.update('receipt_requests', 'id=eq.' + r.id, { received_at: r.received_at || new Date().toISOString(), file_id: r.file_id || ids[0], file_ids: [...(r.file_ids || []), ...ids] });
  await note(db, { applicationId: a.id, ref: a.ref, fromName: a.org_name, fromEmail: r.sent_to || a.applicant_email,
    subject: `Donation receipt${files.length > 1 ? 's' : ''} uploaded: ${a.org_name} (${a.ref})`, body: `${files.length} file(s): ${files.map((f) => f.name).join(', ')}` });
  if (first && env.OFFICE_EMAIL) await sendEmail(env, { to: env.OFFICE_EMAIL, ...templates.donationReceiptReceived({ ref: a.ref, orgName: a.org_name, total: Number(r.total), from: r.period_from, to: r.period_to, link: officeLink(env, a.id) }) }).catch(() => {});
  return { ok: true, count: files.length };
}

/** Email someone the link to the online application form. */
export async function inviteToApply(env, request, body) {
  const { name: staffName } = await requireStaff(env, request);
  const to = String(body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new UserError('Enter a valid email address.');
  const mail = templates.applicationInvite({ name: String(body.name || '').trim().slice(0, 120), note: String(body.note || '').trim().slice(0, 2000), individual: body.form === 'individual', link: siteUrl(env) + (body.form === 'individual' ? '/grants/individual.html' : '/grants/apply.html'), from: staffName });
  await sendEmail(env, { to, ...mail });
  return { ok: true, to };
}

/* ---------- individuals and community accounts from the causes export ---------- */
const cleanUrls = (list) => [...new Set((Array.isArray(list) ? list : []).map((u) => String(u || '').trim()).filter((u) => /^https:\/\/[\w.-]+\//.test(u) && u.length < 600))].slice(0, 20);
function cleanDocs(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((d) => d && /^https:\/\/[\w.-]+\//.test(String(d.url || '')) && String(d.url).length < 600 && !seen.has(d.url) && seen.add(d.url))
    .slice(0, 200).map((d) => ({ url: String(d.url), type: String(d.type || '').slice(0, 10), attached: String(d.attached || '').slice(0, 40), campaign: String(d.campaign || '').slice(0, 30) }));
}

/** Import individuals ("General Support") and community accounts, one grant per beneficiary (up to 50 per call). */
export async function importPeople(env, request, body) {
  const { db, userId } = await requireStaff(env, request);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50).map((it) => ({
    id: String(it.id || '').trim().toUpperCase().slice(0, 40), name: String(it.name || '').trim().slice(0, 200),
    kind: it.kind === 'club' ? 'club' : 'individual', currency: String(it.currency || 'GBP').slice(0, 5),
    campaigns: (Array.isArray(it.campaigns) ? it.campaigns : []).slice(0, 60).map((c) => ({ number: String(c.number || '').slice(0, 30), name: String(c.name || '').slice(0, 200), approved: Number(c.approved) || 0, redeemed: Number(c.redeemed) || 0 })),
    docs: cleanDocs(it.docs), consent: cleanUrls(it.consent),
  })).filter((it) => it.id && it.name);
  if (!items.length) throw new UserError('Nothing to import.');
  const ids = items.map((it) => '"' + it.id.replace(/"/g, '') + '"').join(',');
  const prior = await db.select('applications?select=ref,beneficiary_id,imported&kind=in.(individual,club)&beneficiary_id=in.(' + ids + ')');
  const results = [], rows = [];
  for (const it of items) {
    const had = prior.filter((p) => p.beneficiary_id === it.id);
    const seen = new Set(had.flatMap((p) => ((p.imported && p.imported.campaigns) || []).map((c) => String(c.number))));
    if (had.length && it.campaigns.every((c) => seen.has(c.number))) { results.push({ id: it.id, name: it.name, skipped: true, message: 'Already imported as ' + had.map((p) => p.ref).join(', ') }); continue; }
    // Causes of one person share one pot: the grant is the highest approved amount; paid is everything redeemed.
    const approved = Math.round(Math.max(0, ...it.campaigns.map((c) => c.approved)) * 100) / 100;
    const redeemed = Math.round(it.campaigns.reduce((s, c) => s + c.redeemed, 0) * 100) / 100;
    rows.push({
      source: 'import', kind: it.kind, registered: false, beneficiary_id: it.id, org_name: it.name, org_email: null, applicant_name: null, applicant_email: null,
      form: { registered: false, imported: true, kind: it.kind }, approved_amount: approved > 0 ? approved : null, approved_by: userId,
      payment_method: 'Bank transfer', purpose: null,
      imported: { fileName: String(body.fileName || '').slice(0, 200), fileOrgName: it.name, currency: it.currency, approved, redeemed, campaigns: it.campaigns, docs: it.docs, consent: it.consent, importedAt: isoNow() },
    });
  }
  if (rows.length) {
    const made = await db.insert('applications', rows);
    for (const m of made) results.push({ id: m.beneficiary_id, grantId: m.id, ref: m.ref, name: m.org_name });
  }
  return { ok: true, results };
}

const FILE_LABEL = { bank_proof: 'Proof of bank', id_document: 'ID', benefits_letter: 'Benefits letter' };

/** The individual application form: a new application, or completing an imported past grant (token). */
export async function submitIndividual(env, formData, ip) {
  const db = createDb(env);
  let form;
  try { form = JSON.parse(String(formData.get('form') || '{}')); } catch (e) { throw new UserError('The form could not be read. Please try again.'); }
  const files = { proof: formData.get('proof'), id: formData.get('id'), benefits: formData.get('benefits') };
  const has = (f) => f && typeof f !== 'string' && f.size > 0;
  const v = validateIndividual(form, { proof: has(files.proof), id: has(files.id), benefits: has(files.benefits) });
  if (Object.keys(v.errors).length) return { ok: false, errors: v.errors, message: 'Please check the highlighted fields.' };
  for (const [k, label] of [['proof', 'proof of bank'], ['id', 'your ID'], ['benefits', 'the benefits letter']]) {
    if (has(files[k])) { const e = checkFile(files[k], label); if (e) return { ok: false, errors: { ['doc.' + k]: e }, message: e }; }
  }
  const f = v.form, test = form.test === true && !formData.get('token');
  const name = (test ? 'TEST – ' : '') + individualName(f);
  let a;
  const token = formData.get('token');
  const fields = {
    org_name: name, org_email: f.person.email, applicant_name: name, applicant_email: f.person.email,
    form: { ...f, test, submittedFromIp: ip || null, bank: f.method === 'Bank transfer' ? f.bank : {} },
  };
  if (token) {
    a = await db.one('applications?select=id,ref,purpose,approved_amount,kind&kind=eq.individual&completed_at=is.null&complete_token_hash=eq.' + (await hashToken(token)));
    if (!a) throw new UserError('This link has expired or the form has already been completed.');
    await db.update('applications', 'id=eq.' + a.id, { ...fields, ...(a.purpose ? {} : { purpose: purposeText(f).slice(0, 1000) }), completed_at: isoNow(), complete_token_hash: null });
  } else {
    [a] = await db.insert('applications', [{ ...fields, kind: 'individual', registered: false, source: 'form', purpose: purposeText(f).slice(0, 1000),
      payment_method: f.method === 'Prepaid card' ? 'Prepaid card' : 'Bank transfer' }]);
  }
  const kinds = [];
  for (const [k, kind] of [['proof', 'bank_proof'], ['id', 'id_document'], ['benefits', 'benefits_letter']]) {
    if (has(files[k])) { await storeFile(db, a.id, kind, files[k]); kinds.push(FILE_LABEL[kind]); }
  }
  const meta = { ref: a.ref, submitted: londonTime(new Date()), docs: kinds, approved: a.approved_amount == null ? null : Number(a.approved_amount) };
  const logo = await siteImage(env, 'toirem-logo-light.png');
  const file = pdfName(a.ref, name);
  const info = { ref: a.ref, name, amount: f.grant.amount, frequency: f.grant.frequency, purpose: purposeText(f), endorser: [f.endorser.name, f.endorser.position, f.endorser.phone].filter(Boolean).join(', '), officeUrl: officeLink(env, a.id), completed: !!token };
  try { if (env.OFFICE_EMAIL) await sendEmail(env, { to: env.OFFICE_EMAIL, replyTo: f.person.email, attachments: [{ name: file, html: individualPdfHtml(f, meta, { logo }) }], ...templates.individualReceived(info) }); }
  catch (e) { console.error('office email', e); }
  try { await sendEmail(env, { to: test ? env.OFFICE_EMAIL : f.person.email, attachments: [{ name: file, html: individualPdfHtml(f, meta, { includeOffice: false, logo }) }], ...templates.individualConfirmation(info) }); }
  catch (e) { console.error('applicant email', e); }
  await note(db, { applicationId: a.id, ref: a.ref, fromName: name, fromEmail: f.person.email, subject: `${token ? 'Individual form completed' : 'New individual application'}: ${name} (${a.ref})`, body: `${name} asked for £${f.grant.amount} (${f.grant.frequency}).\nPurpose: ${purposeText(f)}` });
  return { ok: true, ref: a.ref };
}

/* =========================== INBOX =========================== */

/** Note something a recipient sent back through a form, so it shows in the inbox. Never stops the main action. */
async function note(db, { applicationId = null, ref = '', fromName = '', fromEmail = '', subject, body = '' }) {
  try {
    await db.insert('messages', [{ source: 'form', application_id: applicationId, ref, from_name: String(fromName || '').slice(0, 200), from_email: String(fromEmail || '').slice(0, 200),
      subject: String(subject).slice(0, 300), body: String(body || '').slice(0, 8000) }], { returning: false });
  } catch (e) { console.error('inbox note', e); }
}
export { note as inboxNote };

const REF_RE = /TG-\d{4}-\d{3,}/i;
/** Fetch new replies from Gmail into the inbox. Quiet if the mailer isn't updated yet. */
async function syncInbox(env, db) {
  const last = await db.one('messages?select=received_at&source=eq.email&order=received_at.desc&limit=1').catch(() => null);
  const y = new Date().getFullYear();
  const query = `-from:me newer_than:60d (subject:"TG-${y}" OR subject:"TG-${y - 1}" OR subject:"Toirem grant" OR subject:"grant from Toirem" OR subject:"Toirem's donations")`;
  const r = await mailer(env, { action: 'replies', query, since: last ? new Date(last.received_at).getTime() : 0 });
  const msgs = r.messages || [];
  if (!msgs.length) return 0;
  const have = new Set((await db.select('messages?select=gmail_id&gmail_id=in.(' + msgs.map((m) => '"' + String(m.id).replace(/"/g, '') + '"').join(',') + ')')).map((x) => x.gmail_id));
  const fresh = msgs.filter((m) => !have.has(m.id));
  if (!fresh.length) return 0;
  const refs = [...new Set(fresh.map((m) => (String(m.subject).match(REF_RE) || [''])[0].toUpperCase()).filter(Boolean))];
  const apps = refs.length ? await db.select('applications?select=id,ref&ref=in.(' + refs.join(',') + ')') : [];
  const byRef = new Map(apps.map((a) => [a.ref.toUpperCase(), a.id]));
  await db.insert('messages', fresh.map((m) => {
    const ref = (String(m.subject).match(REF_RE) || [''])[0].toUpperCase();
    const addr = (String(m.from).match(/<([^>]+)>/) || [null, m.from])[1].trim();
    return { source: 'email', gmail_id: String(m.id), thread_id: String(m.threadId || ''), application_id: byRef.get(ref) || null, ref: ref || null,
      from_name: String(m.from).replace(/<[^>]+>/, '').replace(/"/g, '').trim().slice(0, 200) || addr, from_email: addr.slice(0, 200),
      subject: String(m.subject || '(no subject)').slice(0, 300), body: String(m.body || '').slice(0, 8000), attachments: m.attachments || [], received_at: m.date };
  }), { returning: false });
  return fresh.length;
}

/** The inbox: messages newest first. ?sync=1 fetches new emails first. */
export async function inboxList(env, request, url) {
  const { db } = await requireStaff(env, request);
  let synced = null, syncError = '';
  if (url.searchParams.get('sync')) { try { synced = await syncInbox(env, db); } catch (e) { syncError = e.message; } }
  const show = url.searchParams.get('show') || 'all';
  const filter = show === 'unread' ? '&read_at=is.null' : show === 'read' ? '&read_at=not.is.null' : '';
  const [messages, unread] = await Promise.all([
    db.select('messages?select=*&order=received_at.desc&limit=300' + filter),
    db.select('messages?select=id&read_at=is.null&limit=1000'),
  ]);
  return { ok: true, messages, unread: unread.length, synced, syncError };
}

export async function inboxMark(env, request, body) {
  const { db } = await requireStaff(env, request);
  const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).filter((x) => /^[\w-]{10,}$/.test(String(x || ''))).slice(0, 300);
  if (!ids.length) throw new UserError('Choose a message.');
  await db.update('messages', 'id=in.(' + ids.join(',') + ')', { read_at: body.read === false ? null : new Date().toISOString() });
  return { ok: true };
}

/** Reply to an email in its Gmail conversation. */
export async function inboxReply(env, request, body) {
  const { db, name } = await requireStaff(env, request);
  const m = await db.one('messages?select=*&id=eq.' + encodeURIComponent(String(body.id || '')));
  if (!m || m.source !== 'email' || !m.thread_id) throw new UserError('Only email messages can be replied to here.');
  const text = String(body.text || '').trim();
  if (!text) throw new UserError('Write your reply first.');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">${text.split(/\n/).map((l) => l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))).join('<br>')}<br><br>${String(name || 'Toirem').replace(/</g, '')}<br>Toirem Compliance</div>`;
  await mailer(env, { action: 'reply', threadId: m.thread_id, html });
  await db.update('messages', 'id=eq.' + m.id, { read_at: m.read_at || new Date().toISOString() });
  return { ok: true };
}

/** Daily job: fetch new replies (the GitHub Action calls the reminders job, which calls this). */
export async function cronInbox(env) {
  try { return await syncInbox(env, createDb(env)); } catch (e) { console.error('inbox sync', e); return 0; }
}

/** Delete a test grant made from the form's test mode (only those). */
export async function deleteTest(env, request, body) {
  const { db } = await requireStaff(env, request);
  const a = await loadGrant(db, body.id);
  if (!(a.form && a.form.test)) throw new UserError('Only test grants can be deleted.');
  await db.remove('messages', 'application_id=eq.' + a.id).catch(() => {});
  await db.remove('applications', 'id=eq.' + a.id);
  return { ok: true };
}
