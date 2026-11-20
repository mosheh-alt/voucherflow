/* =====================================================================
   Toirem Grants – the server address /api/grants/… (Cloudflare Pages Function).
   Cloudflare runs this automatically from the "functions" folder; no build step needed.
   Settings it needs are listed in GRANTS.md (Cloudflare › Pages project › Settings › Variables and Secrets).
   ===================================================================== */
import * as H from '../../../grants-server/handlers.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const PUBLIC_JSON = {
  lookup: H.lookupCharity,
  search: H.searchCharity,
  postcode: H.checkPostcode,
  link: H.openLink,
  breakdown: H.submitBreakdown,
};
const OFFICE_JSON = {
  grant: H.officeGrant,
  approve: H.approve,
  'send-agreement': H.sendAgreement,
  payment: H.recordPayment,
  override: H.overrideToSupplier,
  'request-breakdown': H.requestBreakdown,
  'request-proof': H.requestProof,
  'close-breakdown': H.closeBreakdown,
  'resolve-alert': H.resolveAlert,
  'import-check': H.importCheck,
  'import': H.importGrants,
  'send-completion': H.sendCompletion,
  'bank-import': H.bankImport,
  'set-purpose': H.setPurpose,
  'agreement-edit': H.editAgreement,
  'email-preview': H.previewEmail,
  'request-receipt': H.requestDonationReceipt,
  'request-both': H.requestBoth,
  'scan-list': H.scanList,
  'request-view': H.requestView,
  'request-update': H.requestUpdate,
  'request-cancel': H.requestCancel,
  'invite': H.inviteToApply,
  'inbox-mark': H.inboxMark,
  'delete-test': H.deleteTest,
  'delete': H.deleteItem,
  'inbox-reply': H.inboxReply,
  'import-people': H.importPeople,
  'bank-undo': H.bankUndo,
  'bank-lines-save': H.bankLinesSave,
  'bank-mark': H.bankMark,
};

export async function onRequest({ request, env, params }) {
  const path = [].concat(params.path || []).join('/');
  const ip = request.headers.get('CF-Connecting-IP') || '';
  try {
    // Scheduled jobs (GitHub Action), protected by a shared secret.
    if (path === 'cron/reminders' || path === 'cron/recheck') {
      if (request.method !== 'POST' || !env.CRON_SECRET || request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) return json({ ok: false, message: 'Not allowed' }, 403);
      return json(path === 'cron/reminders' ? await H.cronReminders(env) : await H.cronRecheck(env));
    }
    // Read-only public lookups also answer plain GET requests (…/lookup?number=…, …/search?q=…, …/postcode?postcode=…).
    // Public settings for the forms. The Google Maps key is a browser key, protected by its website restriction in Google Cloud.
    if (path === 'config' && request.method === 'GET') return json({ ok: true, mapsKey: env.GOOGLE_MAPS_KEY || '' });
    if (request.method === 'GET' && ['lookup', 'search', 'postcode'].includes(path)) {
      return json(await PUBLIC_JSON[path](env, Object.fromEntries(new URL(request.url).searchParams)));
    }
    if (path === 'office/list' && request.method === 'GET') return json(await H.officeList(env, request));
    if (path === 'office/signatories' && request.method === 'GET') return json(await H.officeSignatories(env, request));
    const fileM = path.match(/^office\/file\/([\w-]+)$/);
    if (fileM && request.method === 'GET') return await H.officeFile(env, request, fileM[1], new URL(request.url).searchParams.get('download') === '1');
    if (path === 'office/doc' && request.method === 'GET') { const q = new URL(request.url).searchParams; return await H.officeDocProxy(env, request, q.get('url'), q.get('download') === '1'); }
    const pdf = path.match(/^office\/pdf\/([\w-]+)$/);
    if (pdf && request.method === 'GET') return await H.officePdf(env, request, pdf[1]);
    const agPdf = path.match(/^office\/agreement-pdf\/([\w-]+)$/);
    if (agPdf && request.method === 'GET') return await H.officeAgreementPdf(env, request, agPdf[1]);
    if (path === 'office/summary' && request.method === 'GET') return json(await H.officeSummary(env, request));
    if (path === 'office/bank-lines' && request.method === 'GET') return json(await H.bankLines(env, request, new URL(request.url).searchParams.get('status')));
    if (path === 'office/inbox' && request.method === 'GET') return json(await H.inboxList(env, request, new URL(request.url)));
    if (path === 'office/bank-data' && request.method === 'GET') return json(await H.bankMatchData(env, request));
    if (path === 'office/diagnostics' && request.method === 'GET') return json(await H.officeDiagnostics(env, request));
    if (request.method !== 'POST') return json({ ok: false, message: 'Not found' }, 404);

    // Forms with files.
    if (path === 'submit') return json(await H.submitApplication(env, await request.formData(), ip));
    if (path === 'proof') return json(await H.submitProof(env, await request.formData()));
    if (path === 'complete') return json(await H.completeApplication(env, await request.formData(), ip));
    if (path === 'receipts') return json(await H.submitReceipts(env, await request.formData()));
    if (path === 'individual') return json(await H.submitIndividual(env, await request.formData(), ip));
    if (path === 'donation-receipt') return json(await H.submitDonationReceipt(env, await request.formData()));

    const body = await request.json().catch(() => ({}));
    if (path === 'office/email-pdf') return await H.requestEmailPdf(env, request, body);
    if (path === 'office/request-pdf') return await H.requestViewPdf(env, request, body);
    if (agPdf) return await H.officeAgreementPdf(env, request, agPdf[1], body); // POST: draft with the trustee chosen on screen
    if (path === 'sign') return json(await H.signAgreement(env, body, ip));
    if (PUBLIC_JSON[path]) return json(await PUBLIC_JSON[path](env, body));
    const office = path.startsWith('office/') && OFFICE_JSON[path.slice(7)];
    if (office) return json(await office(env, request, body));
    return json({ ok: false, message: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof H.UserError) return json({ ok: false, message: e.message }, 400);
    if (e instanceof H.NotAllowed) return json({ ok: false, message: e.message, signIn: true }, 401);
    console.error('grants api', path, e);
    // Office pages are for signed-in staff only, so they get the technical detail to pass on.
    const detail = path.startsWith('office/') && e && e.message ? ' (' + String(e.message).slice(0, 300) + ')' : '';
    return json({ ok: false, message: 'Something went wrong on our side. Please try again in a minute.' + detail }, 500);
  }
}
