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
    if (request.method === 'GET' && ['lookup', 'search', 'postcode'].includes(path)) {
      return json(await PUBLIC_JSON[path](env, Object.fromEntries(new URL(request.url).searchParams)));
    }
    if (path === 'office/list' && request.method === 'GET') return json(await H.officeList(env, request));
    if (path === 'office/signatories' && request.method === 'GET') return json(await H.officeSignatories(env, request));
    const pdf = path.match(/^office\/pdf\/([\w-]+)$/);
    if (pdf && request.method === 'GET') return await H.officePdf(env, request, pdf[1]);
    if (path === 'office/diagnostics' && request.method === 'GET') return json(await H.officeDiagnostics(env, request));
    if (request.method !== 'POST') return json({ ok: false, message: 'Not found' }, 404);

    // Forms with files.
    if (path === 'submit') return json(await H.submitApplication(env, await request.formData(), ip));
    if (path === 'proof') return json(await H.submitProof(env, await request.formData()));
    if (path === 'receipts') return json(await H.submitReceipts(env, await request.formData()));

    const body = await request.json().catch(() => ({}));
    if (path === 'sign') return json(await H.signAgreement(env, body, ip));
    if (PUBLIC_JSON[path]) return json(await PUBLIC_JSON[path](env, body));
    const office = path.startsWith('office/') && OFFICE_JSON[path.slice(7)];
    if (office) return json(await office(env, request, body));
    return json({ ok: false, message: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof H.UserError) return json({ ok: false, message: e.message }, 400);
    if (e instanceof H.NotAllowed) return json({ ok: false, message: e.message, signIn: true }, 401);
    console.error('grants api', path, e);
    return json({ ok: false, message: 'Something went wrong on our side. Please try again in a minute.' }, 500);
  }
}
