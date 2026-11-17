/* =====================================================================
   Toirem Donations – the app (screens and actions)
   ===================================================================== */
import * as C from './core.js';
import { createApi, AuthError } from './api.js';
import { makeReceiptPdf, makeCombinedPdf, mergeLayout, FIELD_LABELS } from './receipt.js';

const CFG = window.TOIREM_CONFIG || {};
const api = createApi(CFG);
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = C.money;
const chunks = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };
const today = () => C.isoDate(new Date());
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- state ---------------- */
const S = {
  view: 'home', prepTab: '', rMode: 'all', setTab: 'donors', rFilter: 'all', rSearch: '', iSearch: '', iFilter: 'all', dSearch: '', pSearch: '',
  iSel: new Set(), rSel: new Set(), pSel: new Set(), pEdit: {}, rShown: 100, dShown: 100, pShown: 50, drawer: null,
  receipts: [], inbox: [], donors: [], idx: null, settings: {}, setAside: 0, ignored: 0, dupLog: 0, loaded: false
};
window.S = S;

const SETTING_DEFAULTS = {
  email_subject: 'Your Donation Receipt - Receipt {receipt}', email_body: 'Dear {name},\n\nThank you for your donation of {amount}.\n\nPlease find your receipt attached.',
  daf_names: [], methods: [{ method: 'Transfer', box: 'Transfer' }, { method: 'Cheque', box: 'Cheque' }, { method: 'Card', box: 'Card' }],
  next_number: null, relay_url: '', relay_secret: '', receipt_layout: null, receipt_template: '', org: { name: 'Toirem', line1: '', line2: '' },
  email_reserve: 50, from_name: 'Toirem', reply_to: '', daf_emails: {}, daf_default_done: false,
  combined_subject: 'Combined donation receipt {receipt} – {from} to {to}',
  combined_body: 'Dear {name},\n\nPlease find attached our combined receipt {receipt} for the {count} donations, totalling {amount}, received from you between {from} and {to}.\n\nThank you for your generous support.\n\nWith gratitude,\n\nMoshe Hirsch\nTrustee\n\n[This is an automated message from our donation system.]'
};
const set = k => S.settings[k] !== undefined && S.settings[k] !== null ? S.settings[k] : SETTING_DEFAULTS[k];

/* ---------------- loading ---------------- */
async function loadAll() {
  const [settings, receipts, inbox, donors, setAside, ignored, dupLog] = await Promise.all([
    api.all('settings', 'select=key,value&order=key.asc'),
    api.all('receipts'),
    api.all('payments', 'select=*&place=eq.inbox'),
    api.all('donors'),
    api.count('payments', 'place=eq.set_aside'),
    api.count('payments', 'place=eq.ignored'),
    api.count('duplicates_log')
  ]);
  S.settings = {}; settings.forEach(s => { S.settings[s.key] = s.value; });
  S.receipts = receipts.map(decorate);
  S.inbox = inbox;
  setDonors(donors);
  Object.assign(S, { setAside, ignored, dupLog, loaded: true });
  templateCache = null;
}
function setDonors(rows) { S.donors = C.prepareDonors(rows); S.idx = C.donorIndex(S.donors); }

/** Adds what the screens need to a receipt row. */
function decorate(r) {
  r.amount = r.amount == null ? null : Number(r.amount);
  r.cat = catOf(r);
  r.isDafNoName = r.source === 'DAF' && C.normaliseBankName(r.payer_name) === C.normaliseBankName(r.payer);
  return r;
}
function catOf(r) {
  switch (r.stage) {
    case 'sent': return 'sent';
    case 'old': return 'old';
    case 'failed': return 'error';
    case 'queued': return 'busy';
    case 'info': case 'skip': return 'info';
    case 'held': return 'wait';
    case 'confirm': return 'past';
    default: return r.number ? 'wait' : 'none';
  }
}
/** The status shown for each donation. */
function labelOf(r) {
  switch (r.stage) {
    case 'sent': return 'Sent';
    case 'old': return 'Issued (old system)';
    case 'queued': return 'Sending…';
    case 'failed': return 'Failed';
    case 'confirm': return 'Donor to verify';
    case 'check': return r.name && C.isValidEmail(r.one_off || r.email) ? 'Ready to send' : 'Needs donor details';
    case 'info': return 'Needs donor details';
    case 'held': return 'Already has a receipt?';
    case 'skip': return r.source === 'DAF' ? 'DAF – no receipt' : 'No receipt needed';
    default: return r.stage;
  }
}
/** Where a donation sits on "Receipts to prepare" (or null when nothing is needed). */
function prepOf(r) {
  if (r.stage === 'confirm') return 'verify';
  if (r.stage === 'failed') return 'ready';
  if (r.stage === 'check') return r.name && C.isValidEmail(r.one_off || r.email) ? 'ready' : 'attention';
  if (r.stage === 'info' && r.source !== 'Old system') return 'attention';
  if (r.stage === 'held') return 'attention';
  return null;
}
const isPastCheck = r => r.past && r.stage === 'info';
const needsAction = r => !isPastCheck(r) && (['wait', 'error', 'none'].includes(r.cat) || (r.stage === 'info' && r.source !== 'Old system'));
const isPastDup = r => r.stage === 'held';
function statusText(r) {
  if (r.stage === 'sent') return 'Receipt ' + r.number + ' sent to ' + r.sent_to + (r.sent_at ? ' on ' + niceStamp(r.sent_at) : '') + '.';
  if (r.stage === 'old') return 'Imported from the old receipt system.' + (r.message ? ' ' + r.message : '');
  if (r.stage === 'queued') return 'Waiting to be emailed' + (OUT.paused ? ' – today\'s email allowance is used, it goes after midnight.' : !relayReady() ? ' – email sending is not set up yet (Settings › Email sending).' : '.');
  if (r.stage === 'confirm') return 'Verify the donor on Receipts to prepare › Donors to verify' + (r.past ? ' – past receipts are then ready for you to send.' : ' – the receipt is then emailed.');
  if (r.stage === 'skip') return 'No receipt needed. To make one anyway, press "Make receipt".';
  if (r.message) return r.message;
  if (r.stage === 'info') return 'No receipt made yet. Check the donor name & email, then press "Verify & send" (or "Make receipt").';
  return r.number ? 'Receipt ' + r.number + ' is ready but not sent. Check the donor name & email, then press "Verify & send".'
                  : 'Check the donor name & email, then press "Verify & send".';
}

/* ---------------- small UI helpers ---------------- */
function niceDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(d || '')) return esc(d || '');
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function niceStamp(s) {
  const d = new Date(s);
  return isNaN(d) ? esc(s || '') : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toTimeString().slice(0, 5);
}
let msgTimer;
function showMsg(text, bad) {
  const m = $('msg');
  m.className = 'msg on' + (bad ? ' bad' : '');
  m.innerHTML = esc(text) + '<button type="button" onclick="hideMsg()">OK</button>';
  clearTimeout(msgTimer);
  if (!bad) msgTimer = setTimeout(hideMsg, Math.min(12000, 4000 + text.length * 40));
}
function hideMsg() { $('msg').className = 'msg'; }
function showBusy(t) { $('busyText').textContent = t; $('busy').classList.add('on'); }
function hideBusy() { $('busy').classList.remove('on'); }
function closeDlg(id) { $(id).close(); }
function head(title, sub, actions) {
  return '<div class="head"><div><h1>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div><div class="actions">' + (actions || '') + '</div></div>';
}
/** Runs an action with a "working" overlay and a message; any database error is shown plainly. */
async function act(text, fn, opts) {
  opts = opts || {};
  if (!opts.silent) showBusy(text || 'Working…');
  try { const msg = await fn(); if (msg) showMsg(msg); return true; }
  catch (err) {
    if (err instanceof AuthError) { showLogin(err.message); return false; }
    showMsg(String(err && err.message || err), true); return false;
  } finally { if (!opts.silent) hideBusy(); render(); }
}
/** Background work (the button answers at once). */
const BG = { jobs: 0 };
function background(label, fn) {
  BG.jobs++; showQueue();
  return fn().catch(err => {
    if (err instanceof AuthError) showLogin(err.message); else showMsg(label + ': ' + (err && err.message || err), true);
  }).finally(() => { BG.jobs--; showQueue(); render(); });
}
function showQueue() {
  const sending = S.receipts.filter(r => r.stage === 'queued').length;
  const on = BG.jobs > 0 || (OUT.running && sending > 0);
  $('queue').classList.toggle('on', on);
  $('queueText').textContent = BG.jobs > 0 ? 'Saving…' : sending === 1 ? 'Emailing 1 receipt…' : 'Emailing receipts… ' + sending + ' left';
}
window.addEventListener('beforeunload', e => { if (BG.jobs > 0 || (OUT.running && S.receipts.some(r => r.stage === 'queued'))) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------- rendering ---------------- */
function render() {
  if (!S.loaded) return;
  $('app').hidden = false;
  $('who').textContent = api.email ? 'Signed in as ' + api.email : '';
  const toType = S.inbox.filter(p => p.type === C.T_DAF_CHOOSE).length;
  setCount('c-inbox', S.inbox.length, false);
  const pc = prepCounts();
  setCount('c-prepare', pc.verifyPayers + pc.ready + pc.attention, S.receipts.some(r => r.stage === 'failed'));
  document.querySelectorAll('.nav').forEach(b => b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false'));
  $('donorList').innerHTML = S.donors.map(d => '<option value="' + esc(d.name) + '">').join('');
  const views = { home: viewHome, prepare: viewPrepare, inbox: viewInbox, receipts: viewReceipts, settings: viewSettings, search: viewSearch };
  $('main').innerHTML = views[S.view]();
  if (S.drawer && S.drawer.refresh) S.drawer.refresh();
  if (S.view === 'settings' && S.setTab === 'people' && isAdmin()) loadStaff().catch(() => {});
  if (S.view === 'settings' && S.setTab === 'log' && isAdmin()) loadLog().catch(err => { const el = $('logList'); if (el) el.textContent = 'Could not load the log: ' + err.message; });
  showQueue();
}
function setCount(id, n, alert) { const el = $(id); el.textContent = n ? n : ''; el.style.display = n ? '' : 'none'; el.classList.toggle('alert', !!alert); }
function go(view, extra) {
  // older links: "Today" and "Payers to confirm" now live on Receipts to prepare
  if (view === 'desk') view = 'prepare';
  if (view === 'payers') { view = 'prepare'; S.prepTab = 'verify'; }
  if (extra && extra.prepTab) S.prepTab = extra.prepTab;
  if (view !== S.view) { S.rSearch = ''; S.rSel.clear(); S.rShown = 100; }
  S.view = view;
  if (extra && extra.rFilter) { S.rFilter = extra.rFilter; S.rShown = 100; }
  if (extra && extra.iFilter) S.iFilter = extra.iFilter;
  if (extra && extra.setTab) S.setTab = extra.setTab;
  closeDrawer(); render(); window.scrollTo(0, 0);
}
function rerenderKeepFocus(el) {
  const pos = el.selectionStart, ph = el.placeholder;
  render();
  const again = [...document.querySelectorAll('input.search')].find(x => x.placeholder === ph);
  if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* */ } }
}

/* ================= HOME ================= */
// Compliance numbers come from the grants office. Only people with grants access get them;
// everyone else sees the Donations card alone.
const HOME = { grants: undefined, loading: false, at: 0 };
function loadGrantsSummary() {
  if (HOME.loading || (HOME.grants !== undefined && Date.now() - HOME.at < 60000)) return;
  HOME.loading = true;
  let tok = '';
  try { tok = (JSON.parse(localStorage.getItem('toirem.session.v1') || 'null') || {}).access_token || ''; } catch (e) { /* private window */ }
  fetch('/api/grants/office/summary', { headers: { Authorization: 'Bearer ' + tok } })
    .then(r => r.ok ? r.json() : null).catch(() => null)
    .then(j => { HOME.grants = j && j.ok ? j : null; HOME.at = Date.now(); HOME.loading = false; if (S.view === 'home') render(); });
}
function hstat(n, label, onclick, tone) {
  const cls = 'hstat' + (!n ? ' zero' : tone ? ' ' + tone : '');
  return onclick.charAt(0) === '/' ? '<a class="' + cls + '" href="' + onclick + '"><b>' + n + '</b><span>' + esc(label) + '</span></a>'
    : '<button class="' + cls + '" type="button" onclick="' + onclick + '"><b>' + n + '</b><span>' + esc(label) + '</span></button>';
}
function viewHome() {
  loadGrantsSummary();
  const pc = prepCounts();
  const queued = S.receipts.filter(r => r.stage === 'queued').length;
  const month = today().slice(0, 7);
  const thisMonth = S.receipts.filter(r => (r.date || '').slice(0, 7) === month).concat(S.inbox.filter(p => (p.date || '').slice(0, 7) === month));
  const monthTotal = thisMonth.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const sentMonth = S.receipts.filter(r => r.stage === 'sent' && (r.date || '').slice(0, 7) === month).length;
  const hour = new Date().getHours();
  const hello = (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
  const donations = '<section class="hcard" aria-labelledby="hDon"><div class="htop"><h2 id="hDon">Donations</h2><span class="htag">Receipts</span></div>' +
    '<p class="hsum">This month: <strong>' + money(monthTotal) + '</strong> from ' + thisMonth.length + ' donation' + (thisMonth.length === 1 ? '' : 's') + ' · ' + sentMonth + ' receipt' + (sentMonth === 1 ? '' : 's') + ' sent</p>' +
    '<div class="hstats">' +
      hstat(S.inbox.length, 'In the inbox', "go('inbox')", 'warn') +
      hstat(pc.verifyPayers + pc.verify, 'Donors to verify', "go('prepare',{prepTab:'verify'})", 'warn') +
      hstat(pc.ready, 'Receipts ready to send', "go('prepare',{prepTab:'ready'})") +
      hstat(pc.attention, 'Need attention', "go('prepare',{prepTab:'attention'})", 'bad') +
    '</div>' + (queued ? '<p class="hnote">' + queued + ' receipt' + (queued === 1 ? ' is' : 's are') + ' waiting to be emailed.</p>' : '') +
    '<button class="btn primary hgo" type="button" onclick="go(\'inbox\')">Open Donations</button></section>';
  const g = HOME.grants;
  let compliance = '';
  if (g === undefined) compliance = '<section class="hcard"><div class="htop"><h2>Toirem Compliance</h2><span class="htag">Grants</span></div><p class="hsum">Loading…</p></section>';
  else if (g) {
    const c = g.counts, L = '/grants/office.html#';
    compliance = '<section class="hcard" aria-labelledby="hCom"><div class="htop"><h2 id="hCom">Toirem Compliance</h2><span class="htag">Grants</span></div>' +
      '<p class="hsum">' + g.total + ' grant' + (g.total === 1 ? '' : 's') + ' · <strong>' + money(g.approved) + '</strong> approved · ' + money(g.paid) + ' paid</p>' +
      '<div class="hstats">' +
        hstat(c.newApps, 'New applications', L, 'warn') +
        hstat(c.toSend + c.awaitingSign, 'Agreements to send or sign', L) +
        hstat(c.monitoring, 'Monitoring due', L, 'warn') +
        hstat(c.attention, 'Charity Commission alerts', L, 'bad') +
      '</div>' + (g.unread ? '<p class="hnote"><a href="/grants/office.html#inbox"><b>' + g.unread + ' unread message' + (g.unread === 1 ? '' : 's') + '</b> in the Compliance inbox</a></p>' : '') +
      (c.details ? '<p class="hnote">' + c.details + ' past grant' + (c.details === 1 ? '' : 's') + ' waiting for details from the charity.</p>' : '') +
      '<a class="btn primary hgo" href="/grants/office.html">Open Compliance</a></section>';
  }
  return head(hello, 'Toirem Management · ' + new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) +
    '<div class="home-grid">' + donations + compliance + '</div>';
}

/* ================= SEARCH EVERYTHING ================= */
const G = { q: '', extra: null, loading: false, shown: 100 };
function whereIs(x) {
  if (x.kind === 'inbox') return ['Inbox', 'Waiting to be added to its campaign'];
  if (x.kind === 'set_aside') return ['Set aside', 'DAF voucher / donor card (Settings › Data & backup)'];
  if (x.kind === 'ignored') return ['Not a donation', 'Marked "not a donation" (Settings › Data & backup)'];
  const r = x.r;
  if (r.stage === 'confirm') return ['Receipts to prepare – Donors to verify', 'Waiting for you to verify the donor'];
  if (prepOf(r)) return ['Receipts to prepare – ' + (prepOf(r) === 'ready' ? 'Ready to send' : 'Needs attention'), labelOf(r)];
  return ['Receipts – ' + labelOf(r), r.message || ''];
}
function searchAll() {
  const test = C.donationSearch(G.q);
  const out = [];
  S.receipts.forEach(r => { if (test(r)) out.push({ kind: 'receipt', r, date: r.date, id: 'r' + r.id }); });
  S.inbox.forEach(p => { if (test(p)) out.push({ kind: 'inbox', r: p, date: p.date, id: 'p' + p.id }); });
  (G.extra || []).forEach(p => { if (test(p)) out.push({ kind: p.place, r: p, date: p.date, id: 'p' + p.id }); });
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
function viewSearch() {
  if (!G.q.trim()) return head('Search', 'Type in the box on the left: a donor or payer name, a campaign number, an amount, a date or a receipt number.');
  if (G.extra === null && !G.loading) {
    G.loading = true;
    api.all('payments', 'select=*&place=in.(set_aside,ignored)').then(rows => { G.extra = rows; G.loading = false; if (S.view === 'search') render(); })
      .catch(() => { G.extra = []; G.loading = false; });
  }
  const all = searchAll(), rows = all.slice(0, G.shown);
  const total = all.reduce((a, x) => a + (Number(x.r.amount) || 0), 0);
  return head('Search: ' + G.q, all.length ? all.length + ' donation' + (all.length === 1 ? '' : 's') + ' found · ' + money(total) : 'Nothing found. Try part of the name, the campaign number, the amount (e.g. 2700) or the date (e.g. 23/09/2026 or Sep 2026).') +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Donor / payer</th><th>Campaign</th><th class="num">Amount</th><th>Receipt</th><th>Where it is</th></tr></thead><tbody>' +
      rows.map(x => {
        const r = x.r, [where, why] = whereIs(x);
        const who = (r.printed_name || r.name || '') || r.payer_name || r.payer || '';
        const bankName = r.payer_name || r.payer || '';
        return '<tr class="click" onclick="openFound(\'' + x.id + '\')"><td class="date">' + niceDate(r.date) + (r.bank ? '<span class="sub">' + esc(r.bank) + '</span>' : '') + '</td>' +
          '<td>' + esc(who) + (bankName && bankName !== who ? '<span class="sub">' + esc(bankName) + '</span>' : '') + (r.email ? '<span class="sub">' + esc(r.email) + '</span>' : '') + '</td>' +
          '<td>' + (r.campaign ? '<span class="ref">' + esc(r.campaign) + '</span>' : '<span class="sub">–</span>') + '</td><td class="num">' + money(r.amount) + '</td>' +
          '<td>' + (r.number ? '<strong>' + esc(r.number) + '</strong>' : '<span class="sub">–</span>') + '</td>' +
          '<td>' + esc(where) + (why ? '<span class="sub">' + esc(why.length > 110 ? why.slice(0, 110) + '…' : why) + '</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (all.length > rows.length ? '<div class="more"><button class="btn" onclick="G.shown+=200;render()">Show more (' + (all.length - rows.length) + ' left)</button></div>' : '') + '</div>' : '');
}
function openFound(id) {
  const n = +id.slice(1);
  if (id[0] === 'r') {
    const r = S.receipts.find(x => x.id === n);
    if (r && r.stage === 'confirm') { S.pSearch = r.payer_name || r.payer || ''; S.pShown = 50; go('prepare', { prepTab: 'verify' }); return; }
    openReceipt(n); return;
  }
  const p = S.inbox.find(x => x.id === n);
  if (p) { S.iSearch = p.payer_name || p.payer || ''; S.iFilter = 'all'; go('inbox'); return; }
  go('settings', { setTab: 'data' });
}

/* ================= RECEIPTS TO PREPARE ================= */
function prepCounts() {
  const c = { verify: 0, verifyPayers: 0, ready: 0, attention: 0, unnumbered: 0 };
  S.receipts.forEach(r => { const k = prepOf(r); if (k) c[k]++; if (r.number == null && ['confirm', 'check', 'info', 'failed', 'queued'].includes(r.stage) && r.source !== 'DAF') c.unnumbered++; });
  c.verifyPayers = payerGroups().length;
  return c;
}
/** Messages that matter on any working day: email set-up, numbering, sending. */
function statusCards() {
  const R = S.receipts, out = [];
  const queued = R.filter(r => r.stage === 'queued').length, failed = R.filter(r => r.stage === 'failed').length;
  if (!relayReady()) out.push(['Email sending is not set up yet', 'Receipts are prepared, but none can be emailed until the email helper is connected.', '<button class="btn primary" onclick="go(\'settings\',{setTab:\'sending\'})">Set up email</button>']);
  if (!set('next_number') && !R.some(r => r.number)) out.push(['Receipt numbering is not set', 'Set the first receipt number so receipts can be numbered.', '<button class="btn primary" onclick="go(\'settings\',{setTab:\'numbering\'})">Set number</button>']);
  if (queued) out.push([queued + (queued === 1 ? ' receipt being emailed' : ' receipts being emailed'),
    OUT.paused ? 'Today\'s email allowance is used – they carry on by themselves after midnight while the app is open.' : OUT.error ? 'Paused: ' + OUT.error : 'Sent from your Toirem Gmail, one after another. Keep this page open until they finish.',
    OUT.running ? '' : '<button class="btn" onclick="startOutbox(true)">Send now</button>']);
  if (failed) out.push([failed + (failed === 1 ? ' receipt failed' : ' receipts failed'), 'They are in Ready to send – open one to see why, or tick them and press Send again (they keep their numbers).', '']);
  return out.length ? '<div class="statuses">' + out.map(x => '<div class="todo-item"><span class="t">' + esc(x[0]) + '<small>' + esc(x[1]) + '</small></span>' + x[2] + '</div>').join('') + '</div>' : '';
}
function viewPrepare() {
  const c = prepCounts();
  if (!S.prepTab || (S.prepTab === 'verify' && !c.verifyPayers && (c.ready || c.attention)) || (S.prepTab === 'ready' && !c.ready && c.verifyPayers)) {
    S.prepTab = c.verifyPayers ? 'verify' : c.ready ? 'ready' : c.attention ? 'attention' : 'verify';
  }
  const tabs = [['verify', 'Donors to verify', c.verifyPayers], ['ready', 'Ready to send', c.ready], ['attention', 'Needs attention', c.attention]]
    .map(([k, l, n]) => '<button type="button" aria-pressed="' + (S.prepTab === k) + '" onclick="S.prepTab=\'' + k + '\';S.rSel.clear();render()">' + l + ' <span class="sub" style="display:inline">' + n + '</span></button>').join('');
  const sub = { verify: 'Check each payer\'s donor name and email once. New donations are then emailed straight away; past donations become ready for you to send.',
    ready: 'Prepared receipts with a verified donor and email. Tick the ones to send (or all) and press Send.',
    attention: 'Missing a donor name or email, cheques paid in, or a gift that may already have a receipt. Open each one to decide.' }[S.prepTab];
  return head('Receipts to prepare', sub,
      (c.unnumbered ? '<button class="btn" onclick="giveNumbers()">Give receipt numbers (' + c.unnumbered + ')</button>' : '')) +
    statusCards() +
    '<div class="toolbar"><div class="seg" role="tablist" aria-label="Receipts to prepare">' + tabs + '</div></div>' +
    (S.prepTab === 'verify' ? payersBody() : prepList(S.prepTab));
}
function prepRows(kind) {
  let rows = S.receipts.filter(r => prepOf(r) === kind);
  if (S.rSearch.trim()) rows = rows.filter(C.donationSearch(S.rSearch, S.rMode));
  return rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.number || 0) - (b.number || 0));
}
function prepList(kind) {
  const all = prepRows(kind), rows = all.slice(0, S.rShown);
  const valid = new Set(all.map(r => r.id));
  S.rSel.forEach(id => { if (!valid.has(id)) S.rSel.delete(id); });
  const pick = kind === 'ready' || kind === 'attention';
  return searchBar('Search these', 'rSearch') +
    (rows.length ? '<div class="table-wrap"><table><thead><tr>' + (pick ? '<th><input type="checkbox" aria-label="Select all" onclick="selAllPrep(this.checked)" ' + (all.length && all.every(r => S.rSel.has(r.id)) ? 'checked' : '') + '></th>' : '') +
      '<th>Date</th><th>Donor</th><th>Campaign</th><th class="num">Amount</th><th>Receipt</th><th>Status</th></tr></thead><tbody>' +
      rows.map(r => '<tr class="click' + (S.rSel.has(r.id) ? ' sel' : '') + '" onclick="openReceipt(' + r.id + ')">' +
        (pick ? '<td onclick="event.stopPropagation()"><input type="checkbox" aria-label="Select" ' + (S.rSel.has(r.id) ? 'checked ' : '') + 'onclick="selRec(' + r.id + ',this.checked)"></td>' : '') +
        '<td class="date">' + niceDate(r.date) + (r.past ? '<span class="sub">Past</span>' : '') + '</td>' +
        '<td>' + esc(r.name || r.payer_name || r.payer || '(no name)') + '<span class="sub">' + esc(r.one_off || r.email || 'No email') + '</span></td>' +
        '<td>' + (r.campaign ? '<span class="ref">' + esc(r.campaign) + '</span>' : '<span class="sub">–</span>') + '</td><td class="num">' + money(r.amount) + '</td>' +
        '<td>' + (r.number ? '<strong>' + esc(r.number) + '</strong>' : '<span class="sub">–</span>') + '</td>' +
        '<td><span class="pill ' + r.cat + '">' + esc(labelOf(r)) + '</span>' + (kind === 'attention' && r.message ? '<span class="sub">' + esc(r.message.length > 120 ? r.message.slice(0, 120) + '…' : r.message) + '</span>' : '') + '</td></tr>').join('') +
      '</tbody></table>' + (all.length > rows.length ? '<div class="more"><button class="btn" onclick="S.rShown+=300;render()">Show more (' + (all.length - rows.length) + ' left)</button></div>' : '') + '</div>'
      : '<div class="table-wrap"><div class="empty">' + (S.rSearch ? 'Nothing matches.' : kind === 'ready' ? 'Nothing waiting to be sent.' : 'Nothing needs attention.') + '</div></div>') +
    (pick ? '<div class="bulk' + (S.rSel.size ? ' on' : '') + '"><span>' + S.rSel.size + ' selected</span>' +
      (kind === 'ready' ? '<button class="btn small send" onclick="sendMany()">Send ' + S.rSel.size + '</button>' : '<button class="btn small" onclick="skipMany()">No receipt needed</button>') +
      '<button class="btn small ghost" style="color:#fff" onclick="S.rSel.clear();render()">Clear</button></div>' : '');
}
function selAllPrep(on) { prepRows(S.prepTab).forEach(r => on ? S.rSel.add(r.id) : S.rSel.delete(r.id)); render(); }
/** One search box with a choice of what to search by. */
function searchBar(placeholder, key) {
  const modes = [['all', 'Search all'], ['donor', 'Donor'], ['date', 'Date'], ['amount', 'Amount'], ['campaign', 'Campaign number']];
  const hint = { all: 'Donor, campaign, amount, date or receipt no…', donor: 'Donor or payer name, or email…', date: 'e.g. 23/09/2026, 23 Sep 2026 or Sep 2026', amount: 'e.g. 2700 or £2,700.00', campaign: '5-digit campaign number' }[S.rMode];
  return '<div class="toolbar searchbar"><input class="search" type="search" placeholder="' + esc(hint) + '" value="' + esc(S[key]) +
    '" oninput="S.' + key + '=this.value;S.rShown=100;rerenderKeepFocus(this)" aria-label="' + esc(placeholder) + '">' +
    '<select aria-label="Search by" onchange="S.rMode=this.value;S.rShown=100;render()">' + modes.map(([k, l]) => '<option value="' + k + '"' + (S.rMode === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>';
}
/** Gives every prepared receipt that has none its number (in date order). Can't be undone, so it asks first. */
function giveNumbers() {
  const ids = S.receipts.filter(r => r.number == null && ['confirm', 'check', 'info', 'failed', 'queued'].includes(r.stage) && r.source !== 'DAF')
    .sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(r => r.id);
  if (!ids.length) return;
  if (!confirm('Give receipt numbers to ' + ids.length + ' donation(s) that have none yet?\n\nThey are numbered in date order, starting at ' + nextNumber() +
      '. Nothing is emailed. Numbers can\'t be taken back once given.')) return;
  act('Numbering ' + ids.length + ' receipts…', async () => {
    let n = 0;
    for (const part of chunks(ids, 400)) {
      const nums = await api.rpc('issue_numbers', { ids: part });
      part.forEach(id => { const r = S.receipts.find(x => x.id === id); if (r && nums[id]) { r.number = nums[id]; r.printed_name = r.name; decorate(r); n++; } });
    }
    return n + ' receipt(s) numbered.';
  });
}
function nextNumber() {
  const used = S.receipts.reduce((m, r) => Math.max(m, r.number || 0), 0);
  const n = parseInt(set('next_number'), 10);
  return isNaN(n) ? (used ? used + 1 : '') : Math.max(n, used + 1);
}

/* ================= INBOX ================= */
function inboxRows() {
  let rows = S.iSearch.trim() ? S.inbox.filter(C.donationSearch(S.iSearch)) : S.inbox.slice();
  if (S.iFilter === 'daf') rows = rows.filter(p => C.isDafType(p.type));
  if (S.iFilter === 'bank') rows = rows.filter(p => !C.isDafType(p.type));
  if (S.iFilter === 'noref') rows = rows.filter(p => !p.campaign);
  return rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id - b.id);
}
function viewInbox() {
  const rows = inboxRows();
  const valid = new Set(rows.map(p => p.id));
  S.iSel.forEach(r => { if (!valid.has(r)) S.iSel.delete(r); });
  const banks = [...new Set(S.inbox.map(p => p.bank))];
  const seg = [['all', 'All'], ['bank', 'Bank'], ['daf', 'DAF'], ['noref', 'No campaign number']]
    .map(([k, l]) => '<button type="button" aria-pressed="' + (S.iFilter === k) + '" onclick="S.iFilter=\'' + k + '\';render()">' + l + '</button>').join('');
  const selDaf = [...S.iSel].some(id => { const p = S.inbox.find(x => x.id === id); return p && C.isDafType(p.type); });
  return head('Inbox', 'New payments from the bank. Add each one to its campaign – its receipt is made and numbered at once (and emailed when the donor is verified).',
      '<button class="btn" onclick="openBank(\'past\')">Upload past donations</button><button class="btn primary" onclick="openBank()">Upload bank export</button>') +
    '<div class="toolbar"><input class="search" type="search" placeholder="Search payer, campaign, amount, date…" value="' + esc(S.iSearch) +
      '" oninput="S.iSearch=this.value;rerenderKeepFocus(this)" aria-label="Search the Inbox"><div class="seg" role="group" aria-label="Show">' + seg + '</div></div>' +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all" onclick="selAllInbox(this.checked)" ' +
      (rows.every(p => S.iSel.has(p.id)) ? 'checked' : '') + '></th><th>Date</th><th>Payer</th><th>Campaign</th><th class="hide-s">Bank reference</th><th class="num">Amount</th><th>Type</th><th></th></tr></thead><tbody>' +
      rows.slice(0, 500).map(p => {
        const daf = C.isDafType(p.type), blocked = false;
        const typeCell = daf
          ? '<select class="type" aria-label="DAF type (optional)" onchange="setType(' + p.id + ',this.value)">' +
              C.DAF_TYPES.map(t => '<option' + (t === p.type ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>'
          : '<span class="sub">' + esc(p.type) + '</span>';
        const notes = (p.note || '').split(' | ').filter(n => n && !/^No 5-digit|^Payer:/.test(n));
        return '<tr class="' + (S.iSel.has(p.id) ? 'sel' : '') + '"><td><input type="checkbox" aria-label="Select" ' + (S.iSel.has(p.id) ? 'checked ' : '') + 'onclick="selInbox(' + p.id + ',this.checked)"></td>' +
          '<td class="date">' + niceDate(p.date) + (banks.length > 1 || p.bank !== 'Lloyds' ? '<span class="sub">' + esc(p.bank) + '</span>' : '') + (p.past ? '<span class="sub">Past</span>' : '') + '</td>' +
          '<td>' + esc(p.payer_name || p.payer) + (p.payer_name && p.payer_name !== p.payer ? '<span class="sub">' + esc(p.payer) + '</span>' : '') +
            notes.map(n => '<span class="sub">' + esc(n) + '</span>').join('') + '</td>' +
          '<td>' + (p.campaign ? '<span class="ref">' + esc(p.campaign) + '</span>' : '<span class="noref">No campaign number</span>') + (p.reference ? '<span class="sub">' + esc(p.reference) + '</span>' : '') + '</td>' +
          '<td class="hide-s bankref">' + esc(p.bank_ref || '–') + '</td><td class="num">' + money(p.amount) + '</td><td>' + typeCell + '</td>' +
          '<td style="white-space:nowrap"><button class="btn small" onclick="openAdd(' + p.id + ')">Add to campaign</button>' +
            (p.type === C.T_OWN || p.type === C.T_CHEQUE ? '' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' + (rows.length > 500 ? '<div class="more sub">Showing the first 500 – use the search or filters to find the rest.</div>' : '') + '</div>'
      : '<div class="table-wrap"><div class="empty">' + (S.inbox.length ? 'Nothing matches.' : 'The Inbox is empty. Upload the bank export to bring in new payments.') + '</div></div>') +
    '<div class="bulk' + (S.iSel.size ? ' on' : '') + '"><span>' + S.iSel.size + ' selected</span><button class="btn small" onclick="addToCampaign([...S.iSel])">Add to campaign</button>' +
      (selDaf ? '<select aria-label="Set DAF type for the selected payments" onchange="setTypeMany(this.value)"><option value="">Set DAF type…</option>' +
        C.DAF_TYPES.slice(1).map(t => '<option>' + esc(t) + '</option>').join('') + '</select>' : '') +
      '<button class="btn small" onclick="notDonation([...S.iSel])">Not a donation</button>' +
      '<button class="btn small ghost" style="color:#fff" onclick="S.iSel.clear();render()">Clear</button></div>' +
    '<p class="month">DAF payments (online, vouchers or donor cards) go to Receipts as "No receipt needed" – the DAF gets one combined receipt (Receipts › Combined DAF receipt).</p>';
}
function selInbox(id, on) { on ? S.iSel.add(id) : S.iSel.delete(id); render(); }
function selAllInbox(on) { inboxRows().forEach(p => on ? S.iSel.add(p.id) : S.iSel.delete(p.id)); render(); }

/** What a payment becomes on Receipts. */
function receiptPlan(p) {
  const daf = C.isDafType(p.type) || C.matchesDaf(set('daf_names'), p.payer, p.payer_name);
  const methods = set('methods');
  const method = daf ? (methods.some(m => m.method === 'DAF') ? 'DAF' : 'Transfer') : p.type === C.T_CHEQUE ? 'Cheque' : 'Transfer';
  if (!p.payer_name) return { source: 'Bank', method, name: '', email: '', stage: 'info', message: 'No payer name on the bank line (e.g. a cheque paid in) – enter the donor name & email, then press "Verify & send".' };
  const who = C.donorFor(S.idx, p.payer_name);
  const dafNoName = daf && C.normaliseBankName(p.payer_name) === C.normaliseBankName(p.payer);
  if (daf) return { source: 'DAF', method, name: dafNoName ? '' : who.name, email: dafNoName ? '' : who.email, stage: 'skip', message: C.DAF_SKIP_MSG };
  if (dafNoName) return { source: 'DAF', method, name: '', email: '', stage: 'check', message: 'DAF donation – the bank line names the DAF, not the donor. Enter the donor name & email, then press "Verify & send".' };
  const auto = who.verified && C.isValidEmail(who.email) && !p.past;
  return { source: daf ? 'DAF' : 'Bank', method, name: who.name, email: who.email, stage: auto ? 'queued' : 'confirm',
           message: auto ? '' : 'Not sent yet: ' + who.why + '. Verify the donor on Receipts to prepare › Donors to verify.' };
}
function addToCampaign(ids) {
  const ps = ids.map(id => S.inbox.find(p => p.id === id)).filter(Boolean);
  const go_ = ps;
  if (!go_.length) return;
  S.iSel.clear();
  const items = go_.map(p => ({ payment_id: p.id, receipt: receiptPlan(p) }));
  const gone = new Set(go_.map(p => p.id));
  S.inbox = S.inbox.filter(p => !gone.has(p.id));          // off the list at once
  render();
  background('Add to campaign', async () => {
    for (const part of chunks(items, 200)) {
      const res = await api.rpc('add_to_campaign', { items: part });
      if (res.ids && res.ids.length) {
        const rows = await api.all('receipts', 'select=*&id=in.(' + res.ids.join(',') + ')');
        // every donation except DAF gets its receipt number straight away; verified donors are emailed
        const toNumber = rows.filter(r => r.stage !== 'skip' && r.stage !== 'held').map(r => r.id);
        if (toNumber.length && (set('next_number') || S.receipts.some(r => r.number))) {
          const nums = await api.rpc('issue_numbers', { ids: toNumber });
          rows.forEach(r => { if (nums[r.id]) { r.number = nums[r.id]; r.printed_name = r.name; } });
        }
        S.receipts.push(...rows.map(decorate));
      }
      if (res.already) showMsg(res.already + ' payment(s) were already on Receipts – no second receipt was made.');
    }
    startOutbox();
  });
}
/* ---------- add one payment to its campaign – the full amount, or part of it (the rest: vouchers, donor card, another campaign) ---------- */
let ADD = null;
const isDafPayment = p => C.isDafType(p.type) || C.matchesDaf(set('daf_names'), p.payer, p.payer_name);
function openAdd(id) {
  const p = S.inbox.find(x => x.id === id);
  if (!p) return;
  ADD = { id };
  $('aWho').textContent = niceDate(p.date).replace(/&amp;/g, '&') + ' · ' + (p.payer_name || p.payer) + ' · ' + money(p.amount) + (p.reference ? ' · ' + p.reference : '');
  $('aCampaign').value = p.campaign || '';
  $('aFull').textContent = money(p.amount);
  document.querySelector('input[name=aAmt][value=full]').checked = true;
  $('aPart').value = ''; $('aRestType').value = 'DAF – Vouchers';
  // splitting is only for DAF payments: part online donation for the campaign, the rest vouchers or donor card
  $('aSplitBox').hidden = !isDafPayment(p);
  addFormChanged();
  $('dlgAdd').showModal();
}
function addFormChanged() {
  const p = S.inbox.find(x => x.id === (ADD && ADD.id));
  if (!p) return;
  const part = document.querySelector('input[name=aAmt]:checked').value === 'part';
  $('aRestBox').hidden = !part;
  const v = parseFloat(String($('aPart').value).replace(/[£,]/g, ''));
  $('aRest').textContent = part && v > 0 && v < p.amount ? money(Math.round((p.amount - v) * 100) / 100) : '…';
  if (part && document.activeElement !== $('aPart') && !$('aPart').value) $('aPart').focus();
}
function saveAdd() {
  const p = S.inbox.find(x => x.id === (ADD && ADD.id));
  if (!p) { closeDlg('dlgAdd'); return; }
  const camp = $('aCampaign').value.trim();
  if (camp && !/^\d{5}$/.test(camp)) { showMsg('The campaign number should be 5 digits.', true); return; }
  const part = isDafPayment(p) && document.querySelector('input[name=aAmt]:checked').value === 'part';
  const v = Math.round(parseFloat(String($('aPart').value).replace(/[£,]/g, '')) * 100) / 100;
  if (part && !(v > 0 && v < p.amount)) { showMsg('Enter the part for this campaign – more than £0 and less than ' + money(p.amount) + '.', true); return; }
  const restType = $('aRestType').value;
  closeDlg('dlgAdd');
  act(part ? 'Splitting the payment…' : 'Adding…', async () => {
    if (camp !== (p.campaign || '')) { await api.update('payments', [p.id], { campaign: camp }); p.campaign = camp; }
    if (!part) { addToCampaign([p.id]); return ''; }
    const res = await api.rpc('split_payment', { p_id: p.id, p_first: v, p_rest_type: restType === 'inbox' ? '' : restType, p_rest_campaign: '' });
    S.inbox = await api.all('payments', 'select=*&place=eq.inbox');
    const ids = [p.id].concat(restType === 'inbox' ? [] : [res.rest_id]);
    addToCampaign(ids);
    return 'Split: ' + money(v) + ' to campaign ' + (camp || '(none)') + ', ' + money(res.rest) + ' ' +
      (restType === 'inbox' ? 'left in the Inbox' : 'as ' + restType.replace('DAF – ', 'DAF ').toLowerCase()) + '.';
  });
}
function setType(id, type) {
  const p = S.inbox.find(x => x.id === id);
  if (!p) return;
  setTypes([p], type);
}
function setTypeMany(type) {
  if (!type) return;
  const ps = [...S.iSel].map(id => S.inbox.find(p => p.id === id)).filter(p => p && C.isDafType(p.type));
  setTypes(ps, type);
}
function setTypes(ps, type) {
  const aside = false;   // all DAF types stay with the others now (no receipt by default, combined receipt for the DAF)
  ps.forEach(p => { p.type = type; });
  if (aside) { const gone = new Set(ps.map(p => p.id)); S.inbox = S.inbox.filter(p => !gone.has(p.id)); S.setAside += ps.length; S.iSel.clear(); }
  render();
  background('DAF type', () => api.update('payments', ps.map(p => p.id), aside ? { type, place: 'set_aside', moved_at: new Date().toISOString() } : { type }));
}
function notDonation(ids) {
  const ps = ids.map(id => S.inbox.find(p => p.id === id)).filter(Boolean);
  if (!ps.length || !confirm('Mark ' + ps.length + ' payment(s) as "not a donation"? They leave the Inbox and get no receipt. (You can bring them back from Settings › Data.)')) return;
  const gone = new Set(ps.map(p => p.id));
  S.inbox = S.inbox.filter(p => !gone.has(p.id)); S.ignored += ps.length; S.iSel.clear();
  render();
  background('Not a donation', () => api.update('payments', ps.map(p => p.id), { place: 'ignored', moved_at: new Date().toISOString() }));
}

/** Metro "Account to Account Transfer" payments were first taken for own transfers – they are normal donations. */
async function fixAccountTransfers() {
  const recs = S.receipts.filter(r => r.stage === 'info' && /^Past transfer between accounts/.test(r.message || ''));
  const inbox = S.inbox.filter(p => p.type === C.T_OWN && p.kind === 'Account to Account Transfer');
  if (!recs.length && !inbox.length) return;
  const memo = new Map();
  for (const r of recs) {
    const who = C.donorFor(S.idx, r.payer_name || r.payer, memo);
    const patch = { name: who.name, email: who.email, stage: 'confirm', message: 'Past donation – verify the donor on Receipts to prepare.',
      note: String(r.note || '').replace(/ ?\|? ?Transfer between accounts – check it is a donation/, '') };
    await api.update('receipts', [r.id], patch); Object.assign(r, patch); decorate(r);
  }
  if (inbox.length) {
    await api.update('payments', inbox.map(p => p.id), { type: C.T_BANK });
    inbox.forEach(p => { p.type = C.T_BANK; p.note = String(p.note || '').replace(/ ?\|? ?Transfer between accounts – check it is a donation/, ''); });
  }
}

/** Past donations never belong in the Inbox: any found there (from an earlier upload) go to Receipts. */
async function movePastFromInbox() {
  const past = S.inbox.filter(p => p.past);
  if (!past.length) return;
  $('busyText').textContent = 'Moving ' + past.length + ' past payments from the Inbox to Receipts…';
  const decide = C.pastDecider({ receipts: S.receipts, donors: S.idx, dafNames: set('daf_names') });
  const counts = { verified: 0, toConfirm: 0, held: 0, check: 0, daf: 0 };
  const items = past.map(p => ({ payment_id: p.id, receipt: decide(p, counts) }));
  for (const part of chunks(items, 200)) await api.rpc('add_to_campaign', { items: part });
  await loadAll();
  showMsg(past.length + ' past payment(s) moved from the Inbox to Receipts (past donations don\'t need adding to a campaign). ' +
    (counts.held ? counts.held + ' look like receipts already issued and are held back. ' : '') +
    (counts.check ? counts.check + ' need a donor name or a check – see Receipts to prepare › Needs attention.' : ''));
}

/* ================= RECEIPTS ================= */
const FILTERS = {
  action: needsAction, pastcheck: isPastCheck, wait: r => r.cat === 'wait' || r.cat === 'error',
  none: r => !isPastCheck(r) && (r.cat === 'none' || (r.stage === 'info' && r.source !== 'Old system')),
  sent: r => r.cat === 'sent', past: r => r.past, held: isPastDup, old: r => r.cat === 'old', all: () => true, sending: r => r.stage === 'queued'
};
function filteredReceipts() {
  let rows = S.rSearch.trim() ? S.receipts.filter(C.donationSearch(S.rSearch, S.rMode)) : S.receipts.slice();
  // newest donation first; the old system's receipts without a date go last, by number
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.number || 0) - (a.number || 0) || b.id - a.id);
}
const canSend = r => (r.cat === 'wait' || r.cat === 'none' || r.cat === 'error' || (r.stage === 'info' && r.source !== 'Old system')) && r.stage !== 'held';
function statusCell(r) {
  const extra = r.stage === 'sent' && r.sent_at ? niceDate(String(r.sent_at).slice(0, 10)) + (r.sent_to ? ' · ' + esc(String(r.sent_to).split('; ').pop()) : '')
    : r.stage === 'old' && r.sent_to ? esc(r.sent_to) : '';
  return '<span class="pill ' + r.cat + '">' + esc(labelOf(r)) + '</span>' + (extra ? '<span class="sub">' + extra + '</span>' : '');
}
function viewReceipts() {
  const all = filteredReceipts();
  const rows = all.slice(0, S.rShown);
  const total = all.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  return head('Receipts', 'Every donation, newest first, with its receipt and status. Click a row to see or change it.',
      '<button class="btn" onclick="downloadCsv()">Download list</button><button class="btn" onclick="openCombined()">Combined DAF receipt</button><button class="btn primary" onclick="openNew()">New donation</button>') +
    searchBar('Search receipts', 'rSearch') +
    '<p class="sub" style="margin:0 0 8px">' + all.length + ' donation' + (all.length === 1 ? '' : 's') + (S.rSearch.trim() ? ' found' : '') + ' · ' + money(total) + '</p>' +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Donor</th><th>Campaign</th><th class="num">Amount</th><th>Receipt no.</th><th>Status</th></tr></thead><tbody>' +
      rows.map(r => '<tr class="click" onclick="openReceipt(' + r.id + ')">' +
        '<td class="date">' + (r.date ? niceDate(r.date) : '<span class="sub">–</span>') + (r.bank ? '<span class="sub">' + esc(r.bank) + (r.past ? ' · past' : '') + '</span>' : '') + '</td>' +
        '<td>' + esc(r.printed_name || r.name || r.payer_name || r.payer || '(no name)') +
          ((r.payer_name || r.payer) && (r.payer_name || r.payer) !== (r.printed_name || r.name) ? '<span class="sub">' + esc(r.payer_name || r.payer) + '</span>' : '') + '</td>' +
        '<td>' + (r.campaign ? '<span class="ref">' + esc(r.campaign) + '</span>' : '<span class="sub">–</span>') + '</td>' +
        '<td class="num">' + money(r.amount) + '</td>' +
        '<td>' + (r.number ? '<strong>' + esc(r.number) + '</strong>' : '<span class="sub">–</span>') + '</td>' +
        '<td>' + statusCell(r) + '</td></tr>').join('') +
      '</tbody></table>' + (all.length > rows.length ? '<div class="more"><button class="btn" onclick="S.rShown+=300;render()">Show more (' + (all.length - rows.length) + ' left)</button></div>' : '') + '</div>'
      : '<div class="table-wrap"><div class="empty">' + (S.rSearch.trim() ? 'Nothing matches – check the "Search by" choice next to the box.' : 'No donations yet.') + '</div></div>');
}
function selRec(id, on) { on ? S.rSel.add(id) : S.rSel.delete(id); render(); }
function selAllRec(on) { filteredReceipts().filter(canSend).forEach(r => on ? S.rSel.add(r.id) : S.rSel.delete(r.id)); render(); }

/** "Verify & send": the donor is confirmed (their bank name is saved) and the receipt is emailed. */
function verifyAndQueue(list) {
  const ok = [], noEmail = [];
  list.forEach(r => (C.isValidEmail(r.one_off || r.email) && r.name ? ok : noEmail).push(r));
  if (!ok.length) { showMsg('Nothing to send – ' + (noEmail.length === 1 ? 'this receipt needs' : 'these receipts need') + ' a donor name and a valid email first.', true); return; }
  ok.forEach(r => { r.stage = 'queued'; r.message = ''; decorate(r); });
  render();
  background('Verify & send', async () => {
    await saveDonors(ok.filter(r => r.payer_name && r.source !== 'Manual' && !r.isDafNoName).map(r => ({ name: r.name, email: r.email, bank: r.payer_name })), true);
    await api.update('receipts', ok.map(r => r.id), { stage: 'queued', message: '' });
    startOutbox(true);
  });
  if (noEmail.length) showMsg(ok.length + ' will be sent. ' + noEmail.length + ' skipped – they need a donor name and a valid email first.', true);
}
function sendMany() {
  const list = [...S.rSel].map(id => S.receipts.find(r => r.id === id)).filter(Boolean);
  S.rSel.clear();
  verifyAndQueue(list);
}
function skipMany() {
  const list = [...S.rSel].map(id => S.receipts.find(r => r.id === id)).filter(r => r && !['sent', 'old', 'queued'].includes(r.stage));
  if (!list.length) { showMsg('Receipts already sent can\'t be marked "No receipt needed".', true); return; }
  if (list.some(r => r.number) && !confirm('Mark ' + list.length + ' donation(s) as "No receipt needed"? Their receipts are never sent' + (list.some(r => r.number) ? ' (the receipt numbers they were given stay unused)' : '') + '.')) return;
  S.rSel.clear();
  list.forEach(r => { r.stage = 'skip'; decorate(r); });
  render();
  background('No receipt needed', () => api.update('receipts', list.map(r => r.id), { stage: 'skip' }));
}
function retryFailed() {
  const list = S.receipts.filter(r => r.cat === 'error');
  verifyAndQueue(list);
}

/* ---------- receipt drawer ---------- */
function openReceipt(id) {
  S.drawer = { type: 'receipt', id, edits: {}, fix: {}, refresh: drawReceipt };
  drawReceipt(); openDrawer();
}
function currentRec() { return S.drawer && S.receipts.find(x => x.id === S.drawer.id); }
function boxFor(method) {
  const m = set('methods').find(x => x.method.toLowerCase() === String(method || '').toLowerCase());
  return m ? m.box : /cheque/i.test(method) ? 'Cheque' : /card/i.test(method) ? 'Card' : /transfer|bank|standing|daf/i.test(method) ? 'Transfer' : 'None';
}
function drawReceipt() {
  const d = S.drawer, r = currentRec();
  if (!r) { closeDrawer(); return; }
  const e = d.edits;
  const name = e.name !== undefined ? e.name : r.name;
  const email = e.email !== undefined ? e.email : r.email;
  const oneOff = e.one_off !== undefined ? e.one_off : r.one_off;
  const done = r.stage === 'sent' || r.stage === 'old';
  const box = boxFor(r.method);
  const shown = done ? (d.fix.name !== undefined ? d.fix.name : r.printed_name || r.name) : name;
  $('drawer').innerHTML =
    '<header><div><h3 id="drawerTitle">' + (r.number ? 'Receipt ' + esc(r.number) : 'Donation – no receipt yet') + '</h3><p>' +
      esc(r.source === 'Old system' ? 'Imported from the old receipts' : r.source === 'Manual' ? 'Entered by hand' : r.source === 'DAF' ? 'DAF online donation' : (r.bank || 'Bank') + ' payment') +
      (r.payer_name && r.payer_name !== name ? ' from ' + esc(r.payer_name) : '') + (r.past ? ' · past donation' : '') + '</p></div><button class="close" aria-label="Close" onclick="closeDrawer()">×</button></header>' +
    '<div class="body">' +
      '<div class="status-box ' + r.cat + '"><b>' + esc(labelOf(r)) + '.</b> ' + esc(statusText(r)) + '</div>' +
      '<div class="slip" aria-label="Receipt preview"><div class="top"><span>' + niceDate(r.date) + '</span><b>No. ' + esc(r.number || '—') + '</b></div>' +
        '<div class="who" id="slipWho">' + esc(shown || '…') + '</div><div class="amt">' + money(r.amount) + '</div><div class="words">' + esc(C.amountToWords(r.amount || 0)) + '</div>' +
        '<div class="meth"><span class="' + (box === 'Cheque' ? 'on' : '') + '">Cheque</span><span class="' + (box === 'Transfer' ? 'on' : '') + '">Transfer</span><span class="' + (box === 'Card' ? 'on' : '') + '">Card</span></div></div>' +
      (done ? correctSection(r) :
        '<div class="field"><label for="dName">Donor name on the receipt</label><input id="dName" list="donorList" autocomplete="off" value="' + esc(name) + '" oninput="donorTyped(this.value)">' +
          '<div class="hint">' + (r.payer_name ? 'The bank shows: ' + esc(r.payer_name) + '. ' : '') + 'Pick from your donors to fill in the email.</div></div>' +
        '<div class="field"><label for="dEmail">Donor email</label><input id="dEmail" type="email" value="' + esc(email) + '" oninput="S.drawer.edits.email=this.value"></div>' +
        '<div class="grid2"><div class="field"><label for="dCamp">Campaign number</label><input id="dCamp" inputmode="numeric" value="' + esc(e.campaign !== undefined ? e.campaign : r.campaign) + '" oninput="S.drawer.edits.campaign=this.value"></div>' +
        '<div class="field"><label for="dMethod">Payment method</label><select id="dMethod" onchange="S.drawer.edits.method=this.value">' + methodOptions(e.method !== undefined ? e.method : r.method) + '</select></div></div>') +
      '<div class="field"><label for="dOne">Send to a different address, once</label><input id="dOne" type="email" placeholder="Optional" value="' + esc(oneOff) + '" oninput="S.drawer.edits.one_off=this.value">' +
        '<div class="hint">' + (done ? 'Sends a copy of this receipt there. The donor\'s saved email stays the same.' : 'Used instead of the donor email for this receipt only.') + '</div></div>' +
      '<dl class="facts">' +
        (done && r.campaign ? '<dt>Campaign</dt><dd class="ref">' + esc(r.campaign) + '</dd>' : '') +
        (done ? '<dt>Method</dt><dd>' + esc(r.method || '–') + '</dd>' : '') +
        (r.bank_ref ? '<dt>Bank reference</dt><dd>' + esc(r.bank_ref) + '</dd>' : '') +
        (r.sent_to ? '<dt>Sent to</dt><dd>' + esc(r.sent_to) + (r.sent_at ? '<br><span class="sub">last on ' + niceStamp(r.sent_at) + '</span>' : '') + '</dd>' : '') +
        (done && r.email ? '<dt>Donor email</dt><dd>' + esc(r.email) + '</dd>' : '') +
        (r.old_pdf ? '<dt>Saved PDF</dt><dd><a href="' + esc(r.old_pdf) + '" target="_blank" rel="noopener">Open the PDF in Google Drive</a></dd>' : '') +
        (r.note ? '<dt>Note</dt><dd>' + esc(r.note) + '</dd>' : '') +
      '</dl></div>' +
    '<footer>' +
      (r.number ? '<button class="btn" onclick="viewPdf(' + r.id + ')">View PDF</button>' : '') +
      (done ? '<button class="btn send" onclick="sendCopy()">Send copy</button>'
        : (r.payment_id && !r.number ? '<button class="btn ghost" onclick="backToInbox()">Back to Inbox</button>' : '') +
          (!r.number && r.stage !== 'skip' ? '<button class="btn ghost" onclick="skipOne()">No receipt needed</button>' : '') +
          '<button class="btn" onclick="saveRec()">Save</button><button class="btn" onclick="makeRec()">' + (r.number ? 'Update receipt' : 'Make receipt') + '</button>' +
          '<button class="btn send" onclick="verifySend()">Verify &amp; send</button>') + '</footer>';
}
function methodOptions(current) {
  const list = set('methods').map(m => m.method);
  if (current && !list.includes(current)) list.unshift(current);
  return (current ? '' : '<option value="">Choose…</option>') + list.map(m => '<option' + (m === current ? ' selected' : '') + '>' + esc(m) + '</option>').join('');
}
function correctSection(r) {
  const f = S.drawer.fix;
  const val = (k, d) => f[k] !== undefined ? f[k] : d;
  return '<details class="fix"' + (f.open ? ' open' : '') + ' ontoggle="S.drawer.fix.open=this.open"><summary>Correct this receipt</summary>' +
    '<p class="sub">Change the donor name or email. The receipt keeps its number ' + esc(r.number || '') + '.</p>' +
    '<div class="field"><label for="fName">Donor name on the receipt</label><input id="fName" list="donorList" autocomplete="off" value="' + esc(val('name', r.printed_name || r.name)) + '" oninput="fixTyped(this.value)"></div>' +
    '<div class="field"><label for="fEmail">Donor email</label><input id="fEmail" type="email" value="' + esc(val('email', r.email)) + '" oninput="S.drawer.fix.email=this.value"></div>' +
    '<div class="grid2"><div class="field"><label for="fMethod">Payment method</label><select id="fMethod" onchange="S.drawer.fix.method=this.value">' + methodOptions(val('method', r.method)) + '</select></div>' +
    '<div class="field"><label for="fDate">Donation date</label><input id="fDate" type="date" value="' + esc(val('date', r.date || '')) + '" onchange="S.drawer.fix.date=this.value"></div></div>' +
    '<div class="actions"><button class="btn" type="button" onclick="fixRec(false)">Save correction</button>' +
    '<button class="btn send" type="button" onclick="fixRec(true)">Save &amp; send again</button></div></details>';
}
function donorTyped(v) {
  S.drawer.edits.name = v;
  const d = S.idx.byKey.get(C.donorKey(v));
  if (d && d.email && d.name.toLowerCase() === v.trim().toLowerCase()) { S.drawer.edits.email = d.email; const e = $('dEmail'); if (e) e.value = d.email; }
  const slip = $('slipWho'); if (slip) slip.textContent = v || '…';
}
function fixTyped(v) {
  S.drawer.fix.name = v;
  const d = S.idx.byKey.get(C.donorKey(v));
  if (d && d.email && d.name.toLowerCase() === v.trim().toLowerCase()) { S.drawer.fix.email = d.email; const e = $('fEmail'); if (e) e.value = d.email; }
  const slip = $('slipWho'); if (slip) slip.textContent = v || '…';
}
function drawerPatch(r) {
  const e = S.drawer.edits, patch = {};
  ['name', 'email', 'one_off', 'campaign', 'method'].forEach(k => { if (e[k] !== undefined && String(e[k]).trim() !== String(r[k] || '')) patch[k] = String(e[k]).trim(); });
  if (patch.name !== undefined) patch.name = C.cleanDonorName(patch.name);
  if (patch.email && !C.isValidEmail(patch.email)) throw new Error('The donor email looks wrong: ' + patch.email);
  if (patch.one_off && !C.isValidEmail(patch.one_off)) throw new Error('The one-off address looks wrong: ' + patch.one_off);
  return patch;
}
async function saveRecNow(r) {
  const patch = drawerPatch(r);
  if (Object.keys(patch).length) { Object.assign(r, (await api.update('receipts', [r.id], patch))[0]); decorate(r); }
  S.drawer.edits = {};
  return r;
}
function saveRec() { const r = currentRec(); act('Saving…', async () => { await saveRecNow(r); return 'Saved.'; }); }
function makeRec() {
  const r = currentRec();
  act('Making the receipt…', async () => {
    await saveRecNow(r);
    if (!r.name) throw new Error('Enter the donor name first.');
    if (!r.method) throw new Error('Choose the payment method first.');
    const nums = await api.rpc('issue_numbers', { ids: [r.id] });
    r.number = nums[r.id]; r.printed_name = r.name;
    if (r.stage === 'skip' || r.stage === 'held' || r.stage === 'confirm' || r.stage === 'info') { await api.update('receipts', [r.id], { stage: 'check', message: '' }); r.stage = 'check'; r.message = ''; }
    decorate(r);
    return 'Receipt ' + r.number + ' made. Press "View PDF" to see it, or "Verify & send" to email it.';
  });
}
function verifySend() {
  const r = currentRec();
  let patch;
  try { patch = drawerPatch(r); } catch (e) { showMsg(e.message, true); return; }
  Object.assign(r, patch);
  if (!r.name) { showMsg('Enter the donor name first.', true); return; }
  if (!C.isValidEmail(r.one_off || r.email)) { showMsg('Enter the donor email (or a one-off address) first.', true); const el = $('dEmail'); if (el) el.focus(); return; }
  if (!r.method) { showMsg('Choose the payment method first.', true); return; }
  closeDrawer();
  if (Object.keys(patch).length) background('Saving', () => api.update('receipts', [r.id], patch));
  verifyAndQueue([r]);
}
function skipOne() { const r = currentRec(); S.rSel = new Set([r.id]); closeDrawer(); skipMany(); }
function backToInbox() {
  const r = currentRec();
  act('Moving back…', async () => {
    const msg = await api.rpc('back_to_inbox', { receipt_id: r.id });
    if (/^Moved/.test(msg)) {
      S.receipts = S.receipts.filter(x => x.id !== r.id);
      const p = await api.all('payments', 'select=*&id=eq.' + r.payment_id);
      S.inbox.push(...p);
      closeDrawer();
    }
    return msg;
  });
}
function fixRec(send) {
  const r = currentRec(), f = S.drawer.fix;
  const patch = {};
  if (f.name !== undefined && C.cleanDonorName(f.name) !== (r.printed_name || r.name)) patch.name = C.cleanDonorName(f.name);
  if (f.email !== undefined && f.email.trim() !== r.email) patch.email = f.email.trim();
  if (f.method && f.method !== r.method) patch.method = f.method;
  if (f.date && f.date !== r.date) patch.date = f.date;
  const one = (S.drawer.edits.one_off || '').trim();
  if (patch.name === '') { showMsg('Enter the donor name.', true); return; }
  if (patch.email && !C.isValidEmail(patch.email)) { showMsg('The email looks wrong.', true); return; }
  if (one && !C.isValidEmail(one)) { showMsg('The one-off address looks wrong.', true); return; }
  if (send && !C.isValidEmail(one || patch.email || r.email)) { showMsg('Enter the donor email (or a one-off address) to send it.', true); return; }
  if (!send && !Object.keys(patch).length) { showMsg('Change the name, email, method or date first.', true); return; }
  if (!r.date && !patch.date) { showMsg('Enter the donation date first – this receipt has none recorded.', true); return; }
  if (!r.method && !patch.method) { showMsg('Choose the payment method first – this receipt has none recorded.', true); return; }
  closeDrawer();
  act(send ? 'Correcting and sending…' : 'Saving the correction…', async () => {
    if (one) patch.one_off = one;
    if (send) patch.stage = 'queued';
    if (patch.name || patch.method || patch.date) patch.old_pdf = '';   // the saved PDF no longer matches – a new one is made
    Object.assign(r, (await api.update('receipts', [r.id], patch))[0]);
    if (patch.name) { const n = await api.rpc('issue_numbers', { ids: [r.id] }); r.printed_name = r.name; r.number = n[r.id]; }
    decorate(r);
    if (send) startOutbox(true);
    return send ? 'Receipt ' + r.number + ' corrected – it is being emailed now.' : 'Receipt ' + r.number + ' corrected. Press "Send copy" to email it.';
  });
}
function sendCopy() {
  const r = currentRec();
  const to = (S.drawer.edits.one_off || '').trim() || r.email;
  if (!C.isValidEmail(to)) { showMsg('Enter the address to send the copy to.', true); $('dOne').focus(); return; }
  closeDrawer();
  r.stage = 'queued'; r.one_off = to === r.email ? '' : to; decorate(r); render();
  background('Send copy', async () => { await api.update('receipts', [r.id], { stage: 'queued', one_off: r.one_off }); startOutbox(true); });
}

/* ================= PAST DONATIONS: payers to confirm ================= */
function payerGroups() {
  const groups = new Map();
  S.receipts.forEach(r => {
    if (r.stage !== 'confirm') return;
    const k = C.normaliseBankName(r.payer_name || r.payer);
    let g = groups.get(k);
    if (!g) groups.set(k, g = { bank: r.payer_name || r.payer, count: 0, total: 0, name: r.name, email: r.email, first: r.date, last: r.date, ids: [] });
    g.count++; g.total += r.amount || 0; g.ids.push(r.id);
    if (!g.email && r.email) g.email = r.email;
    if (r.date && (!g.first || r.date < g.first)) g.first = r.date;
    if (r.date && r.date > g.last) g.last = r.date;
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || b.total - a.total);
}
function payerList() {
  if (!S.pSearch.trim()) return payerGroups();
  const test = C.donationSearch(S.pSearch);
  // a payer shows if any of their donations matches (name, campaign, amount, date…) or the name/email typed for them
  const q = S.pSearch.trim().toLowerCase();
  const exact = g => [g.bank, payerVal(g).name].join(' ').toLowerCase().includes(q) ? 0 : 1;   // the payer whose name contains exactly what was typed comes first
  return payerGroups().filter(g => g.ids.some(id => test(S.receipts.find(r => r.id === id) || {})) || test({ name: payerVal(g).name, email: payerVal(g).email, payer: g.bank }))
    .sort((a, b) => exact(a) - exact(b));
}
const payerVal = g => S.pEdit[g.bank] || { name: g.name, email: g.email };
/** Receipts already issued, by bank payer and by donor name – shown next to each payer so nothing is sent twice by mistake. */
function issuedByWho() {
  const byPayer = new Map(), byName = new Map();
  const put = (m, k, r) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  S.receipts.forEach(r => { if (!C.isIssued(r)) return; put(byPayer, C.normaliseBankName(r.payer_name || r.payer), r); put(byName, C.personKey(r.printed_name || r.name), r); });
  return { byPayer, byName };
}
function payersBody() {
  const all = payerList(), rows = all.slice(0, S.pShown);
  const iss = issuedByWho();
  const valid = new Set(all.map(g => g.bank));
  S.pSel.forEach(b => { if (!valid.has(b)) S.pSel.delete(b); });
  return '<div class="toolbar"><input class="search" type="search" placeholder="Search payer, name, campaign, amount, date…" value="' + esc(S.pSearch) +
      '" oninput="S.pSearch=this.value;S.pShown=50;rerenderKeepFocus(this)" aria-label="Search payers"></div>' +
    (rows.length ? '<div class="table-wrap payers"><table><thead><tr><th><input type="checkbox" aria-label="Select all" onclick="selAllPayers(this.checked)" ' +
      (all.every(g => S.pSel.has(g.bank)) ? 'checked' : '') + '></th><th>Payer (as the bank shows it)</th><th>Donor name on the receipt</th><th>Email</th><th></th></tr></thead><tbody>' +
      rows.map((g, i) => {
        const v = payerVal(g);
        return '<tr class="' + (S.pSel.has(g.bank) ? 'sel' : '') + '"><td><input type="checkbox" aria-label="Select" ' + (S.pSel.has(g.bank) ? 'checked ' : '') + 'onclick="selPayer(' + i + ',this.checked)"></td>' +
          '<td><strong>' + esc(g.bank) + '</strong>' + (C.findDonorByBankName(S.idx, g.bank) && C.findDonorByBankName(S.idx, g.bank).verified ? ' <span class="pill sent">Verified donor</span>' : '') + '<span class="sub meta">' + g.count + ' donation' + (g.count === 1 ? '' : 's') + ' · ' + money(g.total) +
            ' · ' + niceDate(g.first) + (g.last !== g.first ? ' – ' + niceDate(g.last) : '') + '</span>' + (() => {
              const v0 = payerVal(g);
              const seen = new Map();
              (iss.byPayer.get(C.normaliseBankName(g.bank)) || []).concat(iss.byName.get(C.personKey(v0.name)) || []).forEach(r => seen.set(r.id, r));
              const had = [...seen.values()].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
              return had.length ? '<span class="sub meta" style="color:var(--wait)">Already has ' + had.length + ' receipt' + (had.length === 1 ? '' : 's') + ': ' +
                had.slice(0, 4).map(r => r.number + ' (' + money(r.amount) + ', ' + niceDate(r.date) + ')').join(', ') + (had.length > 4 ? '…' : '') + ' – matching gifts are held back, not sent again</span>' : '';
            })() + '</td>' +
          '<td><input class="pin" id="p' + i + 'n" list="donorList" autocomplete="off" value="' + esc(v.name) + '" aria-label="Donor name for ' + esc(g.bank) + '" oninput="payerTyped(' + i + ')"></td>' +
          '<td><input class="pin" id="p' + i + 'e" type="email" value="' + esc(v.email) + '" placeholder="No email – receipt made, not sent" aria-label="Email for ' + esc(g.bank) + '" oninput="payerTyped(' + i + ')"></td>' +
          '<td><button class="btn small send" onclick="confirmPayers([' + i + '])">Verify</button></td></tr>';
      }).join('') + '</tbody></table>' +
      (all.length > rows.length ? '<div class="more"><button class="btn" onclick="S.pShown+=100;render()">Show more (' + (all.length - rows.length) + ' left)</button></div>' : '') + '</div>'
      : '<div class="table-wrap"><div class="empty">' + (S.pSearch ? 'Nothing matches.' : 'Every donor is verified.') + '</div></div>') +
    '<div class="bulk' + (S.pSel.size ? ' on' : '') + '"><span>' + S.pSel.size + ' selected</span>' +
      '<button class="btn small send" onclick="confirmPayers(\'sel\')">Verify ' + S.pSel.size + '</button>' +
      '<button class="btn small" onclick="payersReceipted()">Already receipted</button>' +
      '<button class="btn small" onclick="skipPayers()">No receipt needed</button>' +
      '<button class="btn small" onclick="payersAreDaf()">These are DAFs</button>' +
      '<button class="btn small ghost" style="color:#fff" onclick="S.pSel.clear();render()">Clear</button></div>';
}
function selPayer(i, on) { const g = payerList()[i]; if (!g) return; on ? S.pSel.add(g.bank) : S.pSel.delete(g.bank); render(); }
function selAllPayers(on) { payerList().forEach(g => on ? S.pSel.add(g.bank) : S.pSel.delete(g.bank)); render(); }
function payerTyped(i) {
  const g = payerList()[i]; if (!g) return;
  const n = $('p' + i + 'n'), e = $('p' + i + 'e');
  const d = S.idx.byKey.get(C.donorKey(n.value));
  if (d && d.email && document.activeElement === n && !e.dataset.typed && d.name.toLowerCase() === n.value.trim().toLowerCase()) e.value = d.email;
  if (document.activeElement === e) e.dataset.typed = '1';
  S.pEdit[g.bank] = { name: n.value, email: e.value };
}
function confirmPayers(which) {
  const list = payerList();
  const picked = which === 'sel' ? list.filter(g => S.pSel.has(g.bank)) : which.map(i => list[i]).filter(Boolean);
  const items = picked.map(g => { const v = payerVal(g); return { g, name: C.cleanDonorName(String(v.name || '').trim()), email: String(v.email || '').trim() }; });
  const noName = items.filter(x => !x.name);
  if (noName.length) { showMsg('Type a donor name for ' + noName.map(x => x.g.bank).join(', ') + '.', true); return; }
  const bad = items.filter(x => x.email && !C.isValidEmail(x.email));
  if (bad.length === items.length) { showMsg('These emails look wrong – correct them first: ' + bad.map(x => x.email).join(', '), true); return; }
  if (bad.length) { items.splice(0, items.length, ...items.filter(x => !bad.includes(x))); }
  // Check every gift again, now that the donor's name is known: was a receipt already issued for it?
  const idx = C.issuedIndex(S.receipts), used = new Set();
  const plan = [];   // [receipt, patch]
  items.forEach(x => x.g.ids.forEach(id => {
    const r = S.receipts.find(y => y.id === id);
    const twin = C.findIssued(idx, r, x.name, used);
    if (twin) {
      used.add(twin.id);
      plan.push([r, { name: x.name, email: x.email, stage: 'held', message: 'Already has a receipt: ' + twin.number + ' (' + niceDate(twin.date) + ', same donor and amount) – not sent again. If it is a separate gift, press "Verify & send".' }]);
    } else if (!x.email) {
      plan.push([r, { name: x.name, email: '', stage: 'info', message: 'No email saved for this donor – add it, then press "Verify & send".' }]);
    } else if (r.past) {
      // past donations are never emailed automatically – they wait in Ready to send
      plan.push([r, { name: x.name, email: x.email, stage: 'check', message: 'Donor verified – ready to send (Receipts to prepare › Ready to send).' }]);
    } else {
      plan.push([r, { name: x.name, email: x.email, stage: 'queued', message: '' }]);
    }
  }));
  const toSend = plan.filter(([, p]) => p.stage === 'queued').length, held = plan.filter(([, p]) => p.stage === 'held').length;
  const ready = plan.filter(([, p]) => p.stage === 'check').length, noEmail = plan.filter(([, p]) => p.stage === 'info').length;
  if (!confirm('Verify ' + items.length + ' donor(s):\n' +
      (toSend ? '\n• ' + toSend + ' new receipt(s) will be emailed now' : '') +
      (ready ? '\n• ' + ready + ' past receipt(s) become ready to send – nothing is emailed until you send them from Ready to send' : '') +
      (held ? '\n• ' + held + ' will NOT be sent – a receipt was already issued for that gift (Needs attention)' : '') +
      (noEmail ? '\n• ' + noEmail + ' prepared but not sent – no email' : '') +
      '\n\nIf these donors already received receipts some other way (outside this app), press Cancel and use "Already receipted" instead.')) return;
  items.forEach(x => { S.pSel.delete(x.g.bank); delete S.pEdit[x.g.bank]; });
  plan.forEach(([r, p]) => { Object.assign(r, p); decorate(r); });
  showMsg(items.length + ' donor(s) verified.' + (toSend ? ' ' + toSend + ' receipt(s) are being emailed.' : '') + (ready ? ' ' + ready + ' past receipt(s) are ready to send.' : '') +
    (held ? ' ' + held + ' held back: they already have a receipt.' : '') +
    (bad.length ? '\n' + bad.length + ' not confirmed because the email looks wrong – correct it and confirm again: ' + bad.map(x => x.g.bank + ' (' + x.email + ')').join(', ') : ''), bad.length > 0);
  render();
  background('Confirm payers', async () => {
    await saveDonors(items.map(x => ({ name: x.name, email: x.email, bank: x.g.bank })), true);
    // same changes go together
    const groups = new Map();
    plan.forEach(([r, p]) => { const k = JSON.stringify(p); if (!groups.has(k)) groups.set(k, { p, ids: [] }); groups.get(k).ids.push(r.id); });
    for (const { p, ids } of groups.values()) await api.update('receipts', ids, p);
    startOutbox(true);
  });
}
/** The ticked payers already got their receipts some other way: save the donor, send nothing. */
function payersReceipted() {
  const picked = payerList().filter(g => S.pSel.has(g.bank));
  if (!picked.length) return;
  const n = picked.reduce((a, g) => a + g.count, 0);
  if (!confirm('Mark ' + n + ' past donation(s) from ' + picked.length + ' payer(s) as "receipt already issued"? Nothing is emailed and no receipt number is used. The donor names and emails you typed are saved for the future.')) return;
  const items = picked.map(g => { const v = payerVal(g); return { g, name: C.cleanDonorName(String(v.name || '').trim()), email: String(v.email || '').trim() }; });
  const patch = { stage: 'skip', message: 'Receipt already issued outside the app – not sent again. To send one anyway, press "Make receipt".' };
  const ids = [];
  items.forEach(x => { S.pSel.delete(x.g.bank); delete S.pEdit[x.g.bank]; x.g.ids.forEach(id => { const r = S.receipts.find(y => y.id === id); Object.assign(r, patch, x.name ? { name: x.name } : {}, C.isValidEmail(x.email) ? { email: x.email } : {}); decorate(r); ids.push(id); }); });
  render();
  background('Already receipted', async () => {
    const save = items.filter(x => x.name && (!x.email || C.isValidEmail(x.email)));
    if (save.length) await saveDonors(save.map(x => ({ name: x.name, email: x.email, bank: x.g.bank })), true);
    for (const x of items) await api.update('receipts', x.g.ids, Object.assign({}, patch, x.name ? { name: x.name } : {}, C.isValidEmail(x.email) ? { email: x.email } : {}));
  });
}
/** The ticked payers are DAF companies: add them to the DAF names, and their past donations need no receipt. */
function payersAreDaf() {
  const picked = payerList().filter(g => S.pSel.has(g.bank));
  if (!picked.length) return;
  const n = picked.reduce((a, g) => a + g.count, 0);
  if (!confirm('Add ' + picked.map(g => g.bank).join(', ') + ' to the DAF names? Their ' + n + ' past donation(s) will be marked "No receipt needed" and go on the DAF combined receipt.')) return;
  const add = picked.map(g => C.cleanDonorName(g.bank)).filter(Boolean);
  act('Saving…', async () => {
    const names = set('daf_names').concat(add.filter(a => !set('daf_names').some(n => n.toLowerCase() === a.toLowerCase())));
    await api.setSetting('daf_names', names); S.settings.daf_names = names;
    const ids = picked.flatMap(g => g.ids);
    const patch = { stage: 'skip', message: C.DAF_SKIP_MSG, source: 'DAF', method: 'DAF' };
    await api.update('receipts', ids, patch);
    ids.forEach(id => { const r = S.receipts.find(y => y.id === id); if (r) { Object.assign(r, patch); decorate(r); } });
    picked.forEach(g => S.pSel.delete(g.bank));
    return add.length + ' DAF name(s) added – ' + n + ' donation(s) marked "No receipt needed".';
  });
}
function skipPayers() {
  const picked = payerList().filter(g => S.pSel.has(g.bank));
  if (!picked.length) return;
  const n = picked.reduce((a, g) => a + g.count, 0);
  if (!confirm('Mark ' + n + ' past donation(s) from ' + picked.length + ' payer(s) as "no receipt needed"?')) return;
  const ids = [];
  picked.forEach(g => { S.pSel.delete(g.bank); g.ids.forEach(id => { const r = S.receipts.find(y => y.id === id); r.stage = 'skip'; decorate(r); ids.push(id); }); });
  render();
  background('No receipt needed', () => api.update('receipts', ids, { stage: 'skip' }));
}

/**
 * Saves donors: an existing donor (same name, ignoring Ltd/punctuation) gets the bank name added and the
 * new email (the old one kept in Notes); a new donor is added. verify = receipts then go automatically.
 */
async function saveDonors(people, verify) {
  if (!people.length) return;
  const byKey = new Map(S.donors.map(d => [d.key, d]));
  const changed = new Map(), fresh = new Map();
  people.forEach(p => {
    const k = C.donorKey(p.name);
    if (!k) return;
    const bank = String(p.bank || '').trim();
    let d = byKey.get(k);
    if (d) {
      const row = changed.get(d.id) || { id: d.id, name: d.name, email: d.email, bank_names: d.bank_names || '', verified: d.verified, notes: d.notes || '' };
      const list = row.bank_names.split(/[;\n]/).map(C.normaliseBankName).filter(Boolean);
      if (bank && !list.includes(C.normaliseBankName(bank))) row.bank_names = row.bank_names.trim() ? row.bank_names.trim() + '; ' + bank : bank;
      if (p.email && p.email.toLowerCase() !== String(row.email || '').toLowerCase()) {
        if (row.email) row.notes = (row.notes ? row.notes + ' | ' : '') + 'Previous email: ' + row.email;
        row.email = p.email;
      }
      if (verify && bank) row.verified = true;
      changed.set(d.id, row);
    } else {
      const f = fresh.get(k) || { name: p.name, email: p.email || '', bank_names: '', verified: false, notes: 'Added ' + niceDate(today()) };
      if (bank && !f.bank_names.split('; ').includes(bank)) f.bank_names = f.bank_names ? f.bank_names + '; ' + bank : bank;
      if (p.email) f.email = p.email;
      if (verify && bank) f.verified = true;
      fresh.set(k, f);
    }
  });
  const now = new Date().toISOString();
  if (changed.size) await api.insert('donors', [...changed.values()].map(r => Object.assign(r, { updated_at: now })), { upsert: true, onConflict: 'id', returning: false });
  if (fresh.size) await api.insert('donors', [...fresh.values()], { returning: false });
  setDonors(await api.all('donors'));
}

/* ================= EMAIL SENDING (the "outbox") ================= */
const OUT = { running: false, paused: false, quota: null, error: '', timer: null };
const relayReady = () => !!(set('relay_url') && set('relay_secret'));
const HELPER_ACCESS = 'In the helper: Deploy › Manage deployments › pencil – "Execute as" must be Me and "Who has access" must be Anyone (not "Anyone with a Google account" or "only myself"). Then copy the Web app address (ending /exec) into Settings › Email sending.';
async function relay(payload) {
  let res, text;
  try {
    res = await fetch(set('relay_url'), { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ secret: set('relay_secret') }, payload)) });
    text = await res.text();
  } catch (e) {
    const err = new Error('Could not reach the email helper. ' + HELPER_ACCESS); err.network = true; throw err;
  }
  try { return JSON.parse(text); }
  catch (e) {
    if (/accounts\.google\.com|ServiceLogin|sign in/i.test(text)) throw new Error('The email helper asked for a Google sign-in, so it is not open to the app. ' + HELPER_ACCESS);
    if (/Script function not found: doPost/i.test(text)) throw new Error('The helper\'s code is missing – paste Code.gs into it, save, and deploy a new version.');
    throw new Error('The email helper did not answer properly (' + (res && res.status) + '). ' + HELPER_ACCESS);
  }
}
// Receipts use the Google Slides template (same design as the old app) – made by the email helper
const useSlides = () => relayReady() && set('receipt_design') !== 'builtin';
function slideFields(r) {
  const amt = Number(r.amount) || 0;
  return { name: r.printed_name || r.name, number: String(r.number), date: C.longDate(r.date), amount: '£' + amt.toFixed(2),
    words: C.amountToWords(amt), box: boxFor(r.method) };
}
function checkHelperVersion(q) {
  if (useSlides() && !(q.version >= 2)) throw new Error('Your email helper is the old version – it cannot make the receipts from your Google Slides template. Paste the new Code.gs into it and deploy a new version (see Settings › Email sending).');
}
function startOutbox(now) {
  clearTimeout(OUT.timer);
  if (now) { OUT.paused = false; OUT.error = ''; }
  pumpOutbox();
}
async function pumpOutbox() {
  if (OUT.running || OUT.hold || !relayReady() || !S.loaded) return;
  OUT.running = true; showQueue();
  try {
    for (;;) {
      const todo = S.receipts.filter(r => r.stage === 'queued').sort((a, b) => (a.past - b.past) || (a.date || '').localeCompare(b.date || '') || a.id - b.id);
      if (!todo.length || OUT.hold) break;
      if (OUT.quota == null || OUT.paused) {
        const q = await relay({ action: 'quota' });
        if (!q.ok) throw new Error(q.error || 'The email helper refused the request.');
        checkHelperVersion(q);
        OUT.quota = q.quota; OUT.paused = false;
      }
      const reserve = Number(set('email_reserve')) || 0;
      // today's receipts may use every email left; past ones leave the reserve free
      let pastRoom = Math.max(0, OUT.quota - reserve), room = OUT.quota;
      const batch = [];
      for (const r of todo) {
        if (batch.length >= 10 || room < 1) break;
        if (r.past) { if (pastRoom < 1) continue; pastRoom--; }
        room--; batch.push(r);
      }
      if (!batch.length) { OUT.paused = true; break; }
      const need = batch.filter(r => !r.number || r.printed_name !== r.name).map(r => r.id);
      if (need.length) {
        const nums = await api.rpc('issue_numbers', { ids: need });
        batch.forEach(r => { if (nums[r.id]) { r.number = nums[r.id]; r.printed_name = r.name; } });
      }
      let stop = false;
      await pool(batch, 3, async r => {
        if (stop) return;
        const res = await sendOne(r);
        if (res === 'quota') { stop = true; OUT.paused = true; OUT.quota = 0; }
      });
      render();
      if (stop) break;
    }
  } catch (err) {
    if (err instanceof AuthError) { showLogin(err.message); }
    else { OUT.error = String(err.message || err); }
  } finally {
    OUT.running = false; render();
    // carry on later: after a pause (daily limit) or a hiccup, try again while the app is open
    if (S.receipts.some(r => r.stage === 'queued')) OUT.timer = setTimeout(() => { OUT.error = ''; pumpOutbox(); }, OUT.paused ? 30 * 60000 : 60000);
  }
}
async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}
async function sendOne(r) {
  const to = String(r.one_off || r.email || '').trim();
  if (!C.isValidEmail(to)) {
    r.stage = 'check'; r.message = 'Not sent – no valid email. Add it, then press "Verify & send".'; decorate(r);
    await api.update('receipts', [r.id], { stage: 'check', message: r.message });
    return 'skip';
  }
  let res;
  try {
    const msg = { action: 'send', to, subject: C.fillTemplate(set('email_subject'), r), body: C.fillTemplate(set('email_body'), r),
      filename: 'Receipt ' + r.number + ' - ' + safeFile(r.printed_name || r.name) + '.pdf', fromName: set('from_name'), replyTo: set('reply_to') };
    if (useSlides()) msg.receipt = slideFields(r);
    else msg.pdf = toBase64(await receiptPdf(r));
    res = await relay(msg);
  } catch (err) { res = { ok: false, error: String(err.message || err), network: !!err.network }; }
  if (res.ok) {
    await api.rpc('mark_sent', { receipt_id: r.id, sent_to: to });
    if (res.pdfUrl) { r.old_pdf = res.pdfUrl; await api.update('receipts', [r.id], { old_pdf: res.pdfUrl }); }
    r.stage = 'sent'; r.sent_at = new Date().toISOString(); r.sent_to = r.sent_to ? r.sent_to + '; ' + to : to; r.one_off = ''; r.message = '';
    if (typeof res.quota === 'number') OUT.quota = res.quota; else if (OUT.quota) OUT.quota--;
    decorate(r); return 'sent';
  }
  if (res.quotaOut) return 'quota';
  if (res.network) throw new Error(res.error + ' (Will try again in a minute.)');
  r.stage = 'failed'; r.message = 'Email not sent: ' + res.error; decorate(r);
  await api.update('receipts', [r.id], { stage: 'failed', message: r.message });
  return 'failed';
}
const safeFile = s => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80);
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
let templateCache = null;
async function receiptPdf(r) {
  if (useSlides()) {
    const res = await relay({ action: 'make', receipt: slideFields(r) });
    if (!res.ok) throw new Error(res.error === 'Unknown request.' || /out of date/.test(res.error || '') ? 'Your email helper is the old version – paste the new Code.gs and deploy a new version.' : res.error);
    return fromBase64(res.pdf);
  }
  if (templateCache === null) templateCache = set('receipt_template') ? fromBase64(set('receipt_template')) : false;
  return makeReceiptPdf(window.PDFLib, { number: r.number, name: r.printed_name || r.name, date: r.date, amount: r.amount },
    { layout: set('receipt_layout'), templateBytes: templateCache || null, box: boxFor(r.method), org: set('org') });
}
let pdfUrl = null;
async function viewPdf(id) {
  const r = S.receipts.find(x => x.id === id);
  try {
    if (useSlides()) showBusy('Making the receipt from your Google Slides template…');
    let bytes;
    try { bytes = await receiptPdf(r); } finally { if (useSlides()) hideBusy(); }
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    $('pdfFrame').src = pdfUrl;
    $('pdfDownload').href = pdfUrl;
    $('pdfDownload').download = 'Receipt ' + r.number + ' - ' + safeFile(r.printed_name || r.name) + '.pdf';
    $('pdfTitle').textContent = 'Receipt ' + r.number;
    if (!$('dlgPdf').open) $('dlgPdf').showModal();
  } catch (err) { showMsg('Could not make the PDF: ' + err.message, true); }
}

/* ================= COMBINED DAF RECEIPT ================= */
const CB = { pays: null, groups: new Map() };
const isoDay = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
async function openCombined() {
  $('dlgCombined').showModal();
  $('cList').textContent = 'Loading the DAF payments…'; $('cHist').innerHTML = '';
  try {
    const dafNames = set('daf_names');
    const pays = await api.all('payments', 'select=id,date,campaign,amount,payer,payer_name,bank_ref,reference,type,place&place=neq.ignored&order=date.asc,id.asc');
    const byPayment = new Map(S.receipts.filter(r => r.payment_id).map(r => [r.payment_id, r]));
    const groups = new Map();
    const add = (dafName, it) => { if (!groups.has(dafName)) groups.set(dafName, []); groups.get(dafName).push(it); };
    const nameOf = (...t) => dafNames.find(n => C.matchesDaf([n], ...t));
    pays.forEach(p => {
      const dn = nameOf(p.payer, p.payer_name) || (C.isDafType(p.type) ? (p.payer_name || p.payer) : null);
      if (!dn) return;
      const r = byPayment.get(p.id);
      const donor = r && r.name && C.normaliseBankName(r.name) !== C.normaliseBankName(p.payer) ? r.name : '';
      add(dn, { date: p.date, campaign: p.campaign, ref: p.bank_ref || p.reference || '', donor, amount: Number(p.amount),
                own: r && r.number && r.stage !== 'skip' ? r.number : null });
    });
    // DAF donations entered by hand or from the old system (no bank line)
    S.receipts.filter(r => !r.payment_id && (r.source === 'DAF' || r.method === 'DAF')).forEach(r => {
      add(nameOf(r.payer, r.payer_name) || r.payer_name || r.payer || 'DAF', { date: r.date, campaign: r.campaign, ref: r.bank_ref || '', donor: r.name || '', amount: Number(r.amount),
        own: r.number && r.stage !== 'skip' ? r.number : null });
    });
    CB.groups = groups;
    const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    $('cPayer').innerHTML = names.length ? names.map(n => '<option>' + esc(n) + '</option>').join('') : '<option value="">No DAF payments found</option>';
    combinedPayer();
  } catch (err) { $('cList').textContent = 'Could not load: ' + err.message; }
}
function combinedPayer() {
  const items = CB.groups.get($('cPayer').value) || [];
  const years = [...new Set(items.map(i => (i.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const keep = $('cYear').value;
  $('cYear').innerHTML = years.map(y => '<option value="' + y + '">' + y + ' (whole year)</option>').join('') + '<option value="">Choose dates…</option>';
  if (keep && years.includes(keep)) $('cYear').value = keep;
  $('cRecipient').value = $('cPayer').value;
  $('cEmail').value = (set('daf_emails') || {})[$('cPayer').value] || '';
  combinedYear();
  loadCombinedHistory();
}
function combinedYear() {
  const y = $('cYear').value;
  if (y) { $('cFrom').value = y + '-01-01'; $('cTo').value = y + '-12-31'; }
  combinedList();
}
function combinedItems() {
  const from = $('cFrom').value, to = $('cTo').value;
  const all = (CB.groups.get($('cPayer').value) || []).filter(i => i.date && (!from || i.date >= from) && (!to || i.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { items: all.filter(i => !i.own), own: all.filter(i => i.own) };
}
function combinedList() {
  const { items, own } = combinedItems();
  const total = items.reduce((a, i) => a + i.amount, 0);
  $('cList').innerHTML = !items.length ? '<p class="sub">No donations from this DAF in that period.</p>' :
    '<p><strong>' + items.length + ' donation' + (items.length === 1 ? '' : 's') + ' – ' + money(total) + '</strong>' +
      (own.length ? ' <span class="sub" style="display:inline">(' + own.length + ' left out – they already have their own receipt: ' + own.map(i => i.own).join(', ') + ')</span>' : '') + '</p>' +
    '<div class="table-wrap" style="max-height:260px;overflow:auto"><table><thead><tr><th>Date</th><th>Campaign</th><th>Donor / reference</th><th class="num">Amount</th></tr></thead><tbody>' +
      items.map(i => '<tr><td class="date">' + niceDate(i.date) + '</td><td>' + esc(i.campaign || '–') + '</td><td class="sub">' + esc([i.donor, i.ref].filter(Boolean).join(' – ') || '–') + '</td><td class="num">' + money(i.amount) + '</td></tr>').join('') +
    '</tbody></table></div>';
}
async function loadCombinedHistory() {
  const el = $('cHist'); if (!el) return;
  try {
    const rows = await api.all('combined_receipts', 'select=id,number,recipient,date_from,date_to,count,total,sent_to,sent_at,made_at&payer=eq.' + encodeURIComponent($('cPayer').value) + '&order=id.desc');
    el.innerHTML = rows.length ? '<h3 style="font-size:15px;margin:0 0 6px">Combined receipts already made for ' + esc($('cPayer').value) + '</h3><div class="table-wrap"><table><tbody>' +
      rows.map(r => '<tr><td><strong>' + r.number + '</strong></td><td>' + niceDate(r.date_from) + ' – ' + niceDate(r.date_to) + '</td><td class="num">' + r.count + ' · ' + money(r.total) + '</td><td class="sub">' +
        (r.sent_at ? 'Sent to ' + esc(r.sent_to) + ' on ' + niceStamp(r.sent_at) : 'Not emailed') + '</td></tr>').join('') + '</tbody></table></div>' : '';
  } catch (err) { el.innerHTML = '<p class="sub">Run the updated schema.sql in Supabase to keep combined receipts.</p>'; }
}
function combinedMake(send) {
  const { items } = combinedItems();
  const from = $('cFrom').value, to = $('cTo').value, recipient = $('cRecipient').value.trim(), email = $('cEmail').value.trim(), payer = $('cPayer').value;
  if (!from || !to || from > to) { showMsg('Choose the period (from and to).', true); return; }
  if (!items.length) { showMsg('There are no donations from this DAF in that period.', true); return; }
  if (!recipient) { showMsg('Enter the name for the receipt.', true); return; }
  if (send && !C.isValidEmail(email)) { showMsg('Enter the email to send it to.', true); $('cEmail').focus(); return; }
  if (send && !relayReady()) { showMsg('Email sending is not set up yet (Settings › Email sending). Use "Make & view PDF" and download it instead.', true); return; }
  act(send ? 'Making and emailing the combined receipt…' : 'Making the combined receipt…', async () => {
    const c = await api.rpc('make_combined', { c: { payer, recipient, email, date_from: from, date_to: to,
      items: items.map(i => ({ date: i.date, campaign: i.campaign, ref: i.ref, donor: i.donor, amount: i.amount })) } });
    if (email && C.isValidEmail(email)) { const m = Object.assign({}, set('daf_emails') || {}, { [payer]: email }); await api.setSetting('daf_emails', m); S.settings.daf_emails = m; }
    const bytes = await makeCombinedPdf(window.PDFLib, { number: c.number, recipient, from, to, issued: today(), items: c.items, total: Number(c.total) }, { org: set('org') });
    const file = 'Combined receipt ' + c.number + ' - ' + safeFile(recipient) + ' - ' + from + ' to ' + to + '.pdf';
    if (send) {
      const r = { name: recipient, amount: Number(c.total), number: c.number, date: to };
      const fill = t => C.fillTemplate(t, r).replace(/\{from\}/g, C.longDate(from)).replace(/\{to\}/g, C.longDate(to)).replace(/\{count\}/g, c.count);
      const res = await relay({ action: 'send', to: email, subject: fill(set('combined_subject')), body: fill(set('combined_body')),
        pdf: toBase64(bytes), filename: file, fromName: set('from_name'), replyTo: set('reply_to') });
      if (!res.ok) throw new Error(res.error || 'The email was not sent.');
      await api.rpc('combined_sent', { p_id: c.id, p_to: email });
      loadCombinedHistory();
      return 'Combined receipt ' + c.number + ' (' + c.count + ' donations, ' + money(c.total) + ') emailed to ' + email + '.';
    }
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    $('pdfFrame').src = pdfUrl; $('pdfDownload').href = pdfUrl; $('pdfDownload').download = file; $('pdfTitle').textContent = 'Combined receipt ' + c.number;
    if (!$('dlgPdf').open) $('dlgPdf').showModal();
    loadCombinedHistory();
    return 'Combined receipt ' + c.number + ' made.';
  });
}

/**
 * DAF payments on Receipts that have no receipt number yet become "No receipt needed".
 * names: DAF names to recognise by payer; stages: which waiting stages to change; known: also rows already marked DAF.
 */
const WAITING = ['info', 'check', 'confirm', 'queued', 'held', 'failed'];
async function applyDafRules(names, stages, known) {
  const list = S.receipts.filter(r => r.number == null && stages.includes(r.stage) &&
    ((known && (r.source === 'DAF' || r.method === 'DAF')) || C.matchesDaf(names, r.payer, r.payer_name)));
  if (!list.length) return 0;
  const patch = { stage: 'skip', message: C.DAF_SKIP_MSG, source: 'DAF', method: 'DAF' };
  await api.update('receipts', list.map(r => r.id), patch);
  list.forEach(r => { Object.assign(r, patch); decorate(r); });
  return list.length;
}
async function fixDafDefaults() {
  // every time: a DAF never waits on "Payers to confirm"
  await applyDafRules(set('daf_names'), ['confirm'], true);
  if (set('daf_default_done')) return;
  await applyDafRules(set('daf_names'), WAITING, true);   // once: everything that was waiting
  await api.setSetting('daf_default_done', true); S.settings.daf_default_done = true;
}

/* ================= NEW DONATION (cheque, card, cash…) ================= */
function openNew() {
  $('newForm').reset();
  $('nDate').value = today();
  $('nMethod').innerHTML = methodOptions('Cheque');
  $('nName').oninput = () => { const d = S.idx.byKey.get(C.donorKey($('nName').value)); if (d && d.email) $('nEmail').value = d.email; };
  $('dlgNew').showModal();
}
function saveNew(action) {
  const d = { date: $('nDate').value, amount: parseFloat($('nAmount').value), method: $('nMethod').value, name: C.cleanDonorName($('nName').value), email: $('nEmail').value.trim(),
              campaign: $('nRef').value.trim(), note: $('nNote').value.trim() };
  if (!d.date || !(d.amount > 0) || !d.name) { showMsg('Fill in the date, amount and donor name.', true); return; }
  if (d.email && !C.isValidEmail(d.email)) { showMsg('The email looks wrong.', true); return; }
  if (action === 'send' && !d.email) { showMsg('Enter the donor email to send the receipt, or choose "Make receipt".', true); return; }
  $('dlgNew').close();
  act(action === 'send' ? 'Saving and sending…' : 'Making the receipt…', async () => {
    const [r] = await api.insert('receipts', [Object.assign(d, { source: 'Manual', stage: action === 'send' ? 'queued' : 'check' })]);
    const nums = await api.rpc('issue_numbers', { ids: [r.id] });
    r.number = nums[r.id]; r.printed_name = r.name;
    S.receipts.push(decorate(r));
    if (d.email) await saveDonors([{ name: d.name, email: d.email }], false);
    if (action === 'send') startOutbox(true);
    S.view = 'receipts'; S.rFilter = 'all';
    return 'Receipt ' + r.number + (action === 'send' ? ' made – it is being emailed now.' : ' made.');
  });
}

/* ================= UPLOADS ================= */
let bankMode = 'today', LAST_UPLOAD = null;
const UP = { stop: false, likely: [], upload: null };
function openBank(mode) {
  bankMode = mode === 'past' ? 'past' : 'today';
  $('bankTitle').textContent = bankMode === 'past' ? 'Upload past donations' : 'Upload bank export';
  $('bankLead').textContent = bankMode === 'past'
    ? 'Choose a Lloyds or Metro Bank export for earlier dates (CSV, Excel or the online-banking transaction report). Each donation goes straight to Receipts with its receipt number (DAF payments get none). ' +
      'Nothing is emailed: verify the donors and send past receipts yourself from Receipts to prepare. Payments already in the app are never added twice, and gifts that already have a receipt are held back.'
    : 'Choose the Lloyds or Metro Bank export (CSV, Excel or the online-banking transaction report). Payments already in the app are never added twice.';
  $('pastFromBox').hidden = bankMode !== 'past';
  $('bankProgress').hidden = true; $('bankStop').hidden = true;
  $('bankFile').value = ''; $('bankResult').style.display = 'none'; $('dlgBank').showModal();
}
function closeBank() { if ($('bankGo').disabled) { showMsg('The upload is still running – press Stop to end it after the current part.'); return; } closeDlg('dlgBank'); }
async function readAnyFile(file) {
  if (/\.xlsx$/i.test(file.name)) {
    const sheets = await C.readXlsx(window.JSZip, await file.arrayBuffer());
    const sh = sheets.find(s => s.rows.some(r => r.some(v => /posting date|bank reference number/i.test(String(v))))) || sheets[0];
    return sh.rows;
  }
  if (/\.xls$/i.test(file.name)) throw new Error('This is an old-style .xls file. Open it in Excel or Google Sheets and save/download it as .xlsx or .csv, then upload that.');
  return C.parseCsv(await file.text());
}
async function uploadBank() {
  const btn = $('bankGo');
  if (btn.disabled) return;
  const file = $('bankFile').files[0];
  if (!file) { showMsg('Choose a file first.', true); return; }
  btn.disabled = true;
  try {
    let parsed;
    try { parsed = C.readBankRows(await readAnyFile(file), set('daf_names')); }
    catch (err) { $('bankResult').textContent = '❌ ' + err.message; $('bankResult').style.display = 'block'; return; }
    const from = bankMode === 'past' ? ($('pastFrom').value || '') : '';
    let incoming = parsed.payments.filter(p => !from || !p.date || p.date >= from);
    const before = parsed.payments.length - incoming.length;
    // The same payment may already be in the app from a different download of the same account (other references) – leave those out
    $('bankResult').style.display = 'none'; $('bankProgress').hidden = false; $('bankBar').style.width = '0%';
    $('bankPText').textContent = 'Checking for payments already in the app…';
    const ds = incoming.map(p => p.date).filter(Boolean).sort();
    let likely = [], known = 0;
    if (ds.length) {
      const lo = C.isoDate(new Date(Date.parse(ds[0]) - 3 * 86400000)), hi = C.isoDate(new Date(Date.parse(ds[ds.length - 1]) + 3 * 86400000));
      const existing = await api.all('payments', 'select=id,key,bank,date,amount,payer,payer_name&bank=eq.' + encodeURIComponent(parsed.bank) +
        '&date=gte.' + lo + '&date=lte.' + hi + '&order=id.asc');
      const same = C.sameAsExisting(incoming, existing);
      likely = incoming.filter(p => same.has(p.key)).map(p => Object.assign(p, { _same: same.get(p.key) }));
      // exactly the same payment (same bank reference) is already in the app: never planned, never counted
      const keys = new Set(existing.map(e => e.key));
      known = incoming.filter(p => keys.has(p.key)).length;
      incoming = incoming.filter(p => !same.has(p.key) && !keys.has(p.key));
    }
    $('bankPText').textContent = '';
    let rows = incoming, counts = {};
    if (bankMode === 'past') {
      const plan = C.planPastImport(incoming, { receipts: S.receipts, donors: S.idx, dafNames: set('daf_names'), from: '' });
      rows = plan.rows; counts = plan.counts;
    }
    const dates = rows.map(r => r.date).filter(Boolean).sort();
    const span = dates.length ? niceDate(dates[0]) + ' to ' + niceDate(dates[dates.length - 1]) : 'no dates';
    if (!rows.length && !likely.length) { $('bankProgress').hidden = true; $('bankResult').textContent = 'Nothing new in this file: ' + parsed.payments.length + ' incoming payment(s)' + (known ? ', ' + known + ' already in the app' : '') + (before ? ', ' + before + ' before the chosen date' : '') + '.'; $('bankResult').style.display = 'block'; return; }
    if (!confirm('Please check this is the right file:\n\n' + parsed.bank + ' Bank file "' + file.name + '"\n' + parsed.payments.length + ' incoming payment(s)' +
        (rows.length ? ', ' + span : '') + '\n' +
        (known ? '\n' + known + ' are already in the app – skipped.' : '') +
        (likely.length ? '\n' + likely.length + ' look like payments already in the app (same payer, amount and date from another download) – they are left out and listed afterwards.' : '') +
        (before ? '\n' + before + ' dated before ' + niceDate(from) + ' – left out.' : '') +
        '\n\n' + (bankMode === 'past' ? 'The rest go straight to Receipts as PAST donations, each with its receipt number. Nothing is emailed – you send past receipts yourself from Receipts to prepare.'
          : 'The rest go to the Inbox.') + '\n\nUpload them?')) return;
    const upload = await newUpload(parsed.bank, file.name, rows.concat(likely));
    if (!upload) return;
    const tot = await importRows(rows, upload);
    if (!tot) return;
    UP.likely = likely; UP.upload = upload; UP.bank = parsed.bank;
    const left = parsed.left.map(l => l.count + ' ' + l.why + ' left out.');
    const lines = bankMode === 'past' ? [
      parsed.bank + ' file: ' + parsed.payments.length + ' incoming payment(s).',
      tot.receipts + ' past donation(s) added to Receipts' + (tot.numbered ? ', ' + tot.numbered + ' given their receipt number' : '') + '.',
      counts.verified + counts.toConfirm ? (counts.verified + counts.toConfirm) + ' wait for you to verify the donor (Receipts to prepare › Donors to verify).' : '',
      counts.held ? counts.held + ' already have a receipt (old receipts) – held back, not numbered, never sent.' : '',
      counts.daf ? counts.daf + ' DAF payment(s) – no receipt, they go on the DAF combined receipt.' : '',
      counts.check ? counts.check + ' need a donor name (cheques paid in, payments with no name) – Receipts to prepare › Needs attention.' : '',
      known + tot.skipped ? (known + tot.skipped) + ' already in the app (same bank reference) – skipped.' : '',
      before ? before + ' dated before ' + niceDate(from) + ' – left out.' : ''
    ] : [
      parsed.bank + ' file: ' + tot.added + ' new payment(s) added to the Inbox.',
      known + tot.skipped ? (known + tot.skipped) + ' already in the app (same bank reference) – skipped.' : ''
    ];
    lines.push(...left);
    if (tot.failed) lines.push('⚠️ Stopped: ' + tot.failed + ' Nothing is lost – upload the same file again; what was saved is skipped automatically.');
    if (tot.stopped) lines.push('Stopped. Upload the same file again to carry on.');
    $('bankResult').innerHTML = esc(lines.filter(Boolean).join('\n')) +
      (likely.length ? '<div class="likely"><strong>' + likely.length + ' left out – they look like payments already in the app</strong> (same payer and amount, at most 2 days apart, from another download of this account):' +
        '<div class="table-wrap" style="max-height:220px;overflow:auto;margin-top:6px"><table><thead><tr><th>In this file</th><th>Already in the app</th><th class="num">Amount</th></tr></thead><tbody>' +
        likely.map(p => '<tr><td>' + niceDate(p.date) + ' · ' + esc(p.payer_name || p.payer) + '</td><td>' + niceDate(p._same.date) + ' · ' + esc(p._same.payer_name || p._same.payer) + '</td><td class="num">' + money(p.amount) + '</td></tr>').join('') +
        '</tbody></table></div><button class="btn small" type="button" style="margin-top:8px" onclick="addLikelyAnyway()">They are separate gifts – add them anyway</button></div>' : '') +
      '<div style="margin-top:10px"><button class="btn small" type="button" onclick="undoUpload(' + upload.id + ',null,null)">Wrong file? Undo this upload</button></div>';
    $('bankResult').style.display = 'block';
    $('bankFile').value = '';
    await loadAll(); render(); startOutbox();
  } catch (err) {
    if (err instanceof AuthError) { showLogin(err.message); return; }
    $('bankResult').textContent = '❌ ' + (err.message || err); $('bankResult').style.display = 'block';
  } finally { btn.disabled = false; $('bankStop').hidden = true; }
}
async function newUpload(bank, fileName, rows) {
  const dates = rows.map(r => r.date).filter(Boolean).sort();
  try {
    const [upload] = await api.insert('uploads', [{ made_by: api.email || '', bank, file_name: fileName, mode: bankMode, lines: rows.length,
      first_date: dates[0] || null, last_date: dates[dates.length - 1] || null }]);
    LAST_UPLOAD = upload.id;
    return upload;
  } catch (err) {
    if (err instanceof AuthError) { showLogin(err.message); return null; }
    $('bankResult').textContent = '❌ The database needs a small update first: in Supabase › SQL Editor, paste the latest schema.sql and press Run. (' + err.message + ')';
    $('bankResult').style.display = 'block'; return null;
  }
}
/** Saves rows in parts of 500, with the progress bar. */
async function importRows(rows, upload) {
  rows.forEach(r => { r.upload_id = upload.id; delete r._same; });
  const parts = chunks(rows, 500);
  UP.stop = false;
  $('bankStop').hidden = parts.length < 2; $('bankStop').disabled = false; $('bankStop').textContent = 'Stop';
  $('bankProgress').hidden = false; $('bankResult').style.display = 'none';
  const tot = { added: 0, skipped: 0, receipts: 0, numbered: 0, failed: '', stopped: false };
  let done = 0;
  for (let i = 0; i < parts.length && !UP.stop; i++) {
    $('bankBar').style.width = Math.round(i / parts.length * 100) + '%';
    $('bankPText').textContent = 'Saving part ' + (i + 1) + ' of ' + parts.length + '…';
    try { const res = await api.rpc('import_payments', { rows: parts[i] }); tot.added += res.added; tot.skipped += res.skipped; tot.receipts += res.receipts; tot.numbered += res.numbered || 0; done++; }
    catch (err) { if (err instanceof AuthError) { showLogin(err.message); return null; } tot.failed = err.message; break; }
  }
  tot.stopped = UP.stop && done < parts.length;
  $('bankBar').style.width = (parts.length ? Math.round(done / parts.length * 100) : 100) + '%';
  $('bankPText').textContent = parts.length ? (done === parts.length ? 'Done.' : done + ' of ' + parts.length + ' parts saved.') : 'Nothing new in this file.';
  return tot;
}
/** The user says the left-out look-alikes are separate gifts after all. */
function addLikelyAnyway() {
  const list = UP.likely || [];
  if (!list.length) return;
  if (!confirm('Add these ' + list.length + ' payment(s) as separate gifts?')) return;
  act('Adding…', async () => {
    let rows = list;
    if (bankMode === 'past') rows = C.planPastImport(list, { receipts: S.receipts, donors: S.idx, dafNames: set('daf_names'), from: '' }).rows;
    const tot = await importRows(rows, UP.upload);
    UP.likely = [];
    $('bankResult').querySelectorAll('.likely').forEach(el => el.remove());
    await loadAll();
    return tot ? tot.added + ' payment(s) added.' : '';
  });
}

/* ================= UNDO AN UPLOAD ================= */
async function undoUpload(id, bank, minute) {
  const h = HIST.find(x => (id && x.upload_id === id) || (!id && x.bank === bank && x.minute === minute));
  const what = h ? h.bank + ' file' + (h.file_name && h.file_name[0] !== '(' ? ' "' + h.file_name + '"' : '') + ' – ' + h.payments + ' payment(s), ' +
    niceDate(h.first_date) + ' to ' + niceDate(h.last_date) : 'this upload';
  if (!confirm('Undo the upload of ' + what + '?\n\nIts payments and their receipts are removed. Receipts that were already emailed are kept ' +
      '(an email can\'t be called back).')) return;
  OUT.hold = true;
  await act('Undoing the upload…', async () => {
    while (OUT.running) await sleep(300);            // let any email being sent finish first
    const res = await api.rpc('undo_upload', { p_upload: id, p_bank: bank, p_minute: minute });
    await loadAll();
    if ($('dlgBank').open) { $('bankResult').textContent = 'Upload undone.'; }
    HIST = []; loadHistory();
    return 'Upload undone: ' + res.payments + ' payment(s) and ' + res.receipts + ' receipt(s) removed.' +
      (res.kept ? ' ' + res.kept + ' receipt(s) were kept because they were already emailed' + (res.numbers ? ' (' + res.numbers + ')' : '') + ' – open them in Receipts if they need correcting.' : '');
  });
  OUT.hold = false; startOutbox();
}
let HIST = [];
async function loadHistory() {
  const el = $('histList'); if (!el) return;
  try { HIST = await api.rpc('upload_history'); }
  catch (err) { el.innerHTML = '<p class="sub">Upload history needs a small database update: in Supabase › SQL Editor, paste the latest schema.sql and press Run.</p>'; return; }
  el.innerHTML = HIST.length ? '<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Uploaded</th><th>File</th><th class="num">Payments</th><th>Dates in the file</th><th></th></tr></thead><tbody>' +
    HIST.map(h => '<tr><td class="date">' + niceStamp(h.at) + '</td><td>' + esc(h.bank) + ' · ' + (h.mode === 'past' ? 'past' : 'today') +
      '<span class="sub">' + esc(h.file_name) + '</span><span class="sub">' + esc((h.sample || []).join(', ')) + '…</span></td>' +
      '<td class="num">' + h.payments + (h.sent ? '<span class="sub">' + h.sent + ' emailed</span>' : '') + '</td>' +
      '<td class="date">' + niceDate(h.first_date) + ' – ' + niceDate(h.last_date) + '</td>' +
      '<td>' + (h.undone_at ? '<span class="pill old">Undone</span>' : h.payments ? '<button class="btn small" onclick=\'undoUpload(' + (h.upload_id || 'null') + ',' +
        (h.upload_id ? 'null,null' : JSON.stringify(h.bank) + ',' + JSON.stringify(h.minute)) + ')\'>Undo</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>'
    : '<p class="sub">No uploads yet.</p>';
}

/* ================= SETTINGS ================= */
const SET_TABS = [['donors', 'Donors'], ['recognise', 'Recognising payments'], ['methods', 'Payment methods'], ['email', 'Receipt email'],
                  ['sending', 'Email sending'], ['design', 'Receipt design'], ['numbering', 'Receipt numbering'], ['data', 'Data & backup'], ['people', 'People'], ['log', 'Activity log']];
const isAdmin = () => S.role === 'admin';
function viewSettings() {
  if (S.setTab === 'log' && !isAdmin()) S.setTab = 'people';
  const tab = S.setTab;
  const bar = '<div class="seg settabs" role="tablist" aria-label="Settings sections">' + SET_TABS.filter(([k]) => k !== 'log' || isAdmin()).map(([k, l]) =>
    '<button type="button" role="tab" aria-selected="' + (tab === k) + '" aria-pressed="' + (tab === k) + '" onclick="S.setTab=\'' + k + '\';render()">' + l + '</button>').join('') + '</div>';
  const panels = { donors: panelDonors, recognise: panelRecognise, methods: panelMethods, email: panelEmail, sending: panelSending, design: panelDesign, numbering: panelNumbering, data: panelData, people: panelPeople, log: panelLog };
  return head('Settings', 'Donors, how payments are recognised, and how receipts are made and sent.') + bar + (panels[tab] || panelDonors)();
}
async function saveSetting(k, v, label) {
  await act('Saving…', async () => { await api.setSetting(k, v); S.settings[k] = v; if (k === 'receipt_template') templateCache = null; return (label || 'Saved') + '.'; });
}

function panelDonors() {
  const q = S.dSearch.toLowerCase();
  const stats = new Map();
  S.receipts.forEach(r => { const k = C.donorKey(r.name); if (!k) return; const s = stats.get(k) || { n: 0, total: 0 }; s.n++; s.total += r.amount || 0; stats.set(k, s); });
  const all = S.donors.filter(d => !q || [d.name, d.email, d.bank_names].join(' ').toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  const rows = all.slice(0, S.dShown);
  const noEmail = S.donors.filter(d => !C.isValidEmail(d.email)).length;
  return '<div class="toolbar"><input class="search" type="search" placeholder="Search name, email, bank name…" value="' + esc(S.dSearch) +
      '" oninput="S.dSearch=this.value;S.dShown=100;rerenderKeepFocus(this)" aria-label="Search donors">' +
      '<span class="sub">' + S.donors.length + ' donors' + (noEmail ? ', ' + noEmail + ' without a usable email' : '') + '</span>' +
      '<span style="flex:1"></span><button class="btn" onclick="openImport(\'donors\')">Import donor list</button><button class="btn primary" onclick="openDonor(null)">Add donor</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Donor</th><th class="hide-s">Bank names</th><th>Sending</th><th class="num">Receipts</th><th class="num hide-s">Total</th></tr></thead><tbody>' +
      rows.map(d => { const st = stats.get(d.key) || { n: 0, total: 0 }; const ok = C.isValidEmail(d.email);
        return '<tr class="click" onclick="openDonor(' + d.id + ')"><td>' + esc(d.name) + '<span class="sub"' + (ok || !d.email ? '' : ' style="color:var(--err)"') + '>' +
          esc(d.email || 'No email') + (ok || !d.email ? '' : ' – check this address') + '</span></td><td class="hide-s"><span class="sub">' + esc(d.bank_names || '–') + '</span></td>' +
          '<td>' + (d.verified && d.bank_names ? '<span class="pill sent">Automatic</span>' : '<span class="pill old">Check first</span>') + '</td>' +
          '<td class="num">' + st.n + '</td><td class="num hide-s">' + (st.total ? money(st.total) : '') + '</td></tr>'; }).join('') +
    '</tbody></table>' + (all.length > rows.length ? '<div class="more"><button class="btn" onclick="S.dShown+=300;render()">Show more (' + (all.length - rows.length) + ' left)</button></div>' : '') +
    (all.length ? '' : '<div class="empty">No donors match.</div>') + '</div>';
}
function openDonor(id) {
  const d = S.donors.find(x => x.id === id) || { name: '', email: '', bank_names: '', verified: false, notes: '' };
  S.drawer = { type: 'donor', id, refresh: null };
  const recs = id ? S.receipts.filter(r => C.donorKey(r.name) === d.key) : [];
  $('drawer').innerHTML = '<header><div><h3 id="drawerTitle">' + (id ? esc(d.name) : 'Add donor') + '</h3><p>' + (id ? recs.length + ' receipt' + (recs.length === 1 ? '' : 's') : 'New donor') + '</p></div>' +
    '<button class="close" aria-label="Close" onclick="closeDrawer()">×</button></header><div class="body">' +
    '<div class="field"><label for="oName">Name on receipts</label><input id="oName" value="' + esc(d.name) + '"></div>' +
    '<div class="field"><label for="oEmail">Email</label><input id="oEmail" type="email" value="' + esc(d.email) + '"></div>' +
    '<div class="field"><label for="oBank">Bank names</label><input id="oBank" value="' + esc(d.bank_names) + '"><div class="hint">Exactly as the bank shows the payer, separated by ";". Payments from these names are recognised as this donor.</div></div>' +
    '<div class="field"><label><input type="checkbox" id="oAuto" ' + (d.verified ? 'checked' : '') + '> Send receipts automatically</label><div class="hint">Off means every receipt waits for you to press "Verify &amp; send".</div></div>' +
    '<div class="field"><label for="oNotes">Notes</label><input id="oNotes" value="' + esc(d.notes) + '"></div>' +
    (recs.length ? '<h2>Receipts</h2><div class="table-wrap"><table><tbody>' + recs.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 40).map(r =>
      '<tr class="click" onclick="openReceipt(' + r.id + ')"><td class="ref">' + esc(r.number || '–') + '</td><td class="date">' + niceDate(r.date) + '</td><td class="num">' + money(r.amount) + '</td><td><span class="pill ' + r.cat + '">' + esc(labelOf(r)) + '</span></td></tr>').join('') + '</tbody></table></div>' : '') +
    '</div><footer>' + (id ? '<button class="btn ghost" onclick="deleteDonor()">Delete</button>' : '') + '<button class="btn" onclick="closeDrawer()">Cancel</button><button class="btn primary" onclick="saveDonor()">Save donor</button></footer>';
  openDrawer();
}
function saveDonor() {
  const id = S.drawer.id, old = S.donors.find(x => x.id === id);
  const row = { name: C.cleanDonorName($('oName').value), email: $('oEmail').value.trim(), bank_names: $('oBank').value.trim(), verified: $('oAuto').checked, notes: $('oNotes').value.trim() };
  if (!row.name) { showMsg('Enter the donor name.', true); return; }
  if (row.email && !C.isValidEmail(row.email)) { showMsg('The email looks wrong.', true); return; }
  if (!id && S.idx.byKey.get(C.donorKey(row.name))) { showMsg('A donor with this name already exists – open them from the list instead.', true); return; }
  closeDrawer();
  act('Saving the donor…', async () => {
    if (id) await api.update('donors', [id], Object.assign(row, { updated_at: new Date().toISOString() })); else await api.insert('donors', [row], { returning: false });
    let extra = '';
    if (old && (old.name !== row.name || old.email !== row.email)) {
      // receipts not sent yet follow the new details; sent ones stay as they were (use "Correct this receipt")
      const open = S.receipts.filter(r => C.donorKey(r.name) === old.key && !['sent', 'old'].includes(r.stage));
      if (open.length) {
        await api.update('receipts', open.map(r => r.id), { name: row.name, email: row.email });
        open.forEach(r => { r.name = row.name; r.email = row.email; decorate(r); });
      }
      const sent = S.receipts.filter(r => C.donorKey(r.name) === old.key && ['sent', 'old'].includes(r.stage)).length;
      extra = (open.length ? ' ' + open.length + ' receipt(s) not sent yet now use the new details.' : '') +
        (sent ? ' ' + sent + ' receipt(s) already sent keep the old details – open one in Receipts and use "Correct this receipt" to reissue it.' : '');
    }
    setDonors(await api.all('donors'));
    return 'Donor saved.' + extra;
  });
}
function deleteDonor() {
  const id = S.drawer.id;
  if (!confirm('Delete this donor? Their receipts stay; only the donor record (name, email, bank names) is removed.')) return;
  closeDrawer();
  act('Deleting…', async () => { await api.remove('donors', 'id=eq.' + id); setDonors(await api.all('donors')); return 'Donor deleted.'; });
}

function panelRecognise() {
  const linked = S.donors.filter(d => d.bank_names).length;
  return '<div class="card"><h2>How a payment finds its donor</h2>' +
      '<p>Each bank payment shows the payer\'s name as the bank prints it (often cut short, e.g. "LANDS FINANC LTD"). The first time a payer is seen, the app suggests the closest donor and waits for you to press "Verify &amp; send". ' +
      'That bank name is then saved against the donor, and from then on their receipts are emailed automatically.</p>' +
      '<p><strong>' + linked + '</strong> donors are linked to bank names so far.</p></div>' +
    '<div class="card"><h2>DAF names</h2><p>Payments whose payer looks like one of these are treated as DAF: no receipt of their own (they go on the DAF\'s combined receipt). One per line; part of the name is enough. Adding a name here also moves that DAF\'s waiting payments to "No receipt needed".</p>' +
      '<div class="field"><textarea id="sDaf" aria-label="DAF names" style="min-height:140px">' + esc(set('daf_names').join('\n')) + '</textarea></div>' +
      '<button class="btn primary" onclick="saveDaf()">Save DAF names</button></div>' +
    '<div class="card"><h2>Campaign number</h2><p>The 5-digit number in the payment reference is the campaign. Payments with none (or more than one) are marked "No campaign number" – type it on the receipt.</p></div>' +
    '<div class="card"><h2>Banks</h2><p>Lloyds and Metro Bank exports (CSV, or Excel for Metro) are recognised automatically from their column headings. For Metro, the "Post Date" is used as the donation date, rejected payments are left out, cheques paid in at the counter wait in the Inbox for the donor\'s name, and transfers between accounts are flagged for checking.</p></div>';
}
function saveDaf() {
  const names = $('sDaf').value.split('\n').map(s => s.trim()).filter(Boolean);
  const before = set('daf_names').map(n => n.toLowerCase());
  const added = names.filter(n => !before.includes(n.toLowerCase()));
  act('Saving…', async () => {
    await api.setSetting('daf_names', names); S.settings.daf_names = names;
    // receipts from a newly added DAF that are still waiting: no receipt needed
    const moved = added.length ? await applyDafRules(added, WAITING, false) : 0;
    // Inbox payments follow the new list (only those not yet sorted)
    const changes = [];
    S.inbox.forEach(p => {
      const daf = C.matchesDaf(names, p.payer, p.payer_name);
      if (daf && p.type === C.T_BANK) changes.push([p, C.T_DAF_CHOOSE]);
      if (!daf && p.type === C.T_DAF_CHOOSE) changes.push([p, C.T_BANK]);
    });
    for (const [p, t] of changes) { await api.update('payments', [p.id], { type: t }); p.type = t; }
    return 'Saved DAF names.' + (changes.length ? ' ' + changes.length + ' Inbox payment(s) updated to match.' : '') +
      (moved ? ' ' + moved + ' waiting receipt(s) from ' + added.join(', ') + ' marked "No receipt needed".' : '');
  });
}
function panelMethods() {
  return '<div class="card"><h2>Payment methods</h2><p>The second column says which box is ticked on the printed receipt.</p><div id="mList">' +
      set('methods').map(m => methodRow(m.method, m.box)).join('') + '</div>' +
      '<div class="actions" style="margin-top:10px"><button class="btn" type="button" onclick="addMethod()">Add method</button>' +
      '<button class="btn primary" onclick="saveMethods()">Save payment methods</button></div></div>';
}
function methodRow(m, box) {
  return '<div class="mrow"><input aria-label="Payment method" value="' + esc(m) + '"><select aria-label="Box ticked">' +
    ['Transfer', 'Cheque', 'Card', 'None'].map(b => '<option' + (b === box ? ' selected' : '') + '>' + b + '</option>').join('') +
    '</select><button class="btn small ghost" type="button" aria-label="Remove" onclick="this.parentNode.remove()">×</button></div>';
}
function addMethod() { $('mList').insertAdjacentHTML('beforeend', methodRow('', 'None')); $('mList').lastElementChild.querySelector('input').focus(); }
function saveMethods() {
  const list = [...document.querySelectorAll('#mList .mrow')].map(r => ({ method: r.querySelector('input').value.trim(), box: r.querySelector('select').value })).filter(m => m.method);
  saveSetting('methods', list, 'Payment methods saved');
}
function panelEmail() {
  return '<div class="card"><h2>Receipt email</h2><div class="field"><label for="sSubj">Subject</label><input id="sSubj" value="' + esc(set('email_subject')) + '"></div>' +
      '<div class="field"><label for="sBody">Message</label><textarea id="sBody" style="min-height:240px">' + esc(set('email_body')) + '</textarea>' +
      '<div class="hint">{name}, {amount}, {receipt} and {date} are filled in for each receipt.</div></div>' +
      '<div class="grid2"><div class="field"><label for="sFrom">Sender name</label><input id="sFrom" value="' + esc(set('from_name')) + '"></div>' +
      '<div class="field"><label for="sReply">Replies go to (optional)</label><input id="sReply" type="email" value="' + esc(set('reply_to')) + '"></div></div>' +
      '<button class="btn primary" onclick="saveEmail()">Save email</button></div>' +
    '<div class="card"><h2>Combined DAF receipt email</h2><div class="field"><label for="sCSubj">Subject</label><input id="sCSubj" value="' + esc(set('combined_subject')) + '"></div>' +
      '<div class="field"><label for="sCBody">Message</label><textarea id="sCBody" style="min-height:200px">' + esc(set('combined_body')) + '</textarea>' +
      '<div class="hint">{name}, {amount} (the total), {receipt}, {count}, {from} and {to} are filled in.</div></div>' +
      '<button class="btn primary" onclick="saveSetting(\'combined_subject\',$(\'sCSubj\').value,\'Saved\').then(()=>saveSetting(\'combined_body\',$(\'sCBody\').value,\'Combined receipt email saved\'))">Save</button></div>';
}
function saveEmail() {
  act('Saving…', async () => {
    const vals = { email_subject: $('sSubj').value, email_body: $('sBody').value, from_name: $('sFrom').value.trim() || 'Toirem', reply_to: $('sReply').value.trim() };
    for (const k of Object.keys(vals)) { await api.setSetting(k, vals[k]); S.settings[k] = vals[k]; }
    return 'Email saved.';
  });
}
function panelSending() {
  const secret = set('relay_secret');
  return '<div class="card"><h2>Email sending</h2>' +
    '<p>Receipts are emailed from your Toirem Gmail through a small Google helper script (free; about 1,500 emails a day on Google Workspace). The setup guide shows how to make it in 5 minutes.</p>' +
    '<div class="field"><label for="sRelay">Helper web address</label><input id="sRelay" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(set('relay_url')) + '"></div>' +
    '<div class="field"><label for="sSecret">Secret password</label><input id="sSecret" value="' + esc(secret) + '">' +
      '<div class="hint">Put the same text in the helper\'s Script properties as SECRET. <button class="btn small" type="button" onclick="$(\'sSecret\').value=newSecret()">Make a new one</button></div></div>' +
    '<div class="field" style="max-width:260px"><label for="sReserve">Emails kept free each day for today\'s receipts</label><input id="sReserve" inputmode="numeric" value="' + esc(set('email_reserve')) + '">' +
      '<div class="hint">Past donations stop when only this many are left.</div></div>' +
    '<div class="actions"><button class="btn primary" onclick="saveSending()">Save</button><button class="btn" onclick="testSending(false)">Check connection</button>' +
      '<button class="btn" onclick="testSending(true)">Send me a test receipt</button></div>' +
    (OUT.quota != null ? '<p class="sub" style="margin-top:12px">Emails left today: <strong>' + OUT.quota + '</strong></p>' : '') + '</div>';
}
function newSecret() { const a = new Uint8Array(24); crypto.getRandomValues(a); return Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, 32); }
function saveSending() {
  act('Saving…', async () => {
    const url = $('sRelay').value.trim(), secret = $('sSecret').value.trim();
    if (url && !/^https:\/\/script\.google\.com\/.*\/exec$/.test(url)) throw new Error('The helper address should start with https://script.google.com/ and end with /exec.');
    for (const [k, v] of [['relay_url', url], ['relay_secret', secret], ['email_reserve', parseInt($('sReserve').value, 10) || 0]]) { await api.setSetting(k, v); S.settings[k] = v; }
    OUT.quota = null; startOutbox(true);
    return 'Saved. Press "Check connection" to test it.';
  });
}
function testSending(sendTest) {
  act(sendTest ? 'Sending a test…' : 'Checking…', async () => {
    if (!relayReady()) throw new Error('Save the helper address and secret first.');
    const q = await relay({ action: 'quota' });
    if (!q.ok) throw new Error(q.error);
    checkHelperVersion(q);
    OUT.quota = q.quota;
    if (useSlides() && !q.template) throw new Error('Connected, but the helper cannot open your Google Slides receipt template. Run "authorise" once in the helper, or set TEMPLATE_ID in its Script properties.');
    if (!sendTest) return 'Connected. Emails go from ' + (q.from || 'your Gmail') + '. ' + q.quota + ' emails left today.' + (useSlides() ? ' Receipts are made from "' + q.template + '".' : '');
    const r = { number: 'TEST', name: 'Test Donor', date: today(), amount: 123.45, method: 'Transfer' };
    const msg = { action: 'send', test: true, to: api.email, subject: '[TEST] ' + C.fillTemplate(set('email_subject'), r), body: C.fillTemplate(set('email_body'), r),
      filename: 'Receipt TEST.pdf', fromName: set('from_name'), replyTo: set('reply_to') };
    if (useSlides()) msg.receipt = slideFields(r); else msg.pdf = toBase64(await receiptPdf(r));
    const res = await relay(msg);
    if (!res.ok) throw new Error(res.error);
    return 'Test receipt sent to ' + api.email + '.';
  });
}
function panelDesign() {
  const L = mergeLayout(set('receipt_layout'));
  const org = set('org') || {};
  const slides = set('receipt_design') !== 'builtin';
  const top = '<div class="card"><h2>Receipt design</h2>' +
    '<label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px"><input type="radio" name="rdesign" ' + (slides ? 'checked' : '') + ' onchange="saveSetting(\'receipt_design\',\'slides\',\'Receipts will use your Google Slides template\')"> <span><strong>Your Google Slides receipt template</strong> – the same design as the old Google Sheet app. The email helper fills it in and saves each PDF in your receipts folder on Google Drive.' +
      (relayReady() ? '' : ' <em>Needs the email helper (Settings › Email sending).</em>') + '</span></label>' +
    '<label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="rdesign" ' + (slides ? '' : 'checked') + ' onchange="saveSetting(\'receipt_design\',\'builtin\',\'Receipts will be made in the app\')"> <span>Made in the app from an uploaded PDF background (settings below).</span></label>' +
    '<div class="actions" style="margin-top:10px"><button class="btn" onclick="previewReceipt()">Preview a receipt</button></div></div>';
  const orgCard = '<div class="card"><h2>Charity details</h2><p class="sub">Printed at the top of combined DAF receipts' + (slides ? '' : ' and on the plain receipt') + '.</p>' +
      '<div class="field"><label for="oN">Name</label><input id="oN" value="' + esc(org.name || 'Toirem') + '"></div>' +
      '<div class="field"><label for="o1">Line 1 (e.g. registered charity number)</label><input id="o1" value="' + esc(org.line1 || '') + '"></div>' +
      '<div class="field"><label for="o2">Line 2 (e.g. address)</label><input id="o2" value="' + esc(org.line2 || '') + '"></div>' +
      '<button class="btn primary" onclick="saveSetting(\'org\',{name:$(\'oN\').value,line1:$(\'o1\').value,line2:$(\'o2\').value},\'Saved\')">Save</button></div>';
  if (slides) return top + orgCard;
  return top + '<div class="card"><h2>Receipt template</h2>' +
    '<p>Upload your blank receipt (a PDF without the donor details – e.g. your Google Slides template with the placeholder words deleted, downloaded as PDF). The details are printed onto it. ' +
    (set('receipt_template') ? '<strong>A template is saved.</strong>' : 'Until then a plain Toirem receipt is used.') + '</p>' +
    '<div class="actions"><input type="file" id="tplFile" accept="application/pdf,.pdf" aria-label="Template PDF"><button class="btn primary" onclick="saveTemplate()">Save template</button>' +
    (set('receipt_template') ? '<button class="btn ghost" onclick="saveSetting(\'receipt_template\',\'\',\'Template removed\')">Remove template</button>' : '') +
    '<button class="btn" onclick="previewReceipt()">Preview a receipt</button></div></div>' +
    orgCard +
    '<div class="card"><h2>Where each detail is printed</h2><p class="sub">In points from the top-left corner of the page (72 points = 1 inch). Change a number, press Save, then Preview.</p>' +
    '<div class="table-wrap"><table><thead><tr><th>Detail</th><th>Across</th><th>Down</th><th>Width</th><th>Size</th><th>Align</th><th>Bold</th></tr></thead><tbody>' +
    Object.keys(FIELD_LABELS).map(k => { const f = L.fields[k];
      return '<tr data-f="' + k + '"><td>' + FIELD_LABELS[k] + '</td>' + ['x', 'y', 'w', 'size'].map(p => '<td><input class="pin" style="min-width:60px;width:70px" data-p="' + p + '" value="' + f[p] + '"></td>').join('') +
        '<td><select data-p="align">' + ['left', 'center', 'right'].map(a => '<option' + (f.align === a ? ' selected' : '') + '>' + a + '</option>').join('') + '</select></td>' +
        '<td><input type="checkbox" data-p="bold" ' + (f.bold ? 'checked' : '') + '></td></tr>'; }).join('') +
    '</tbody></table></div><div class="actions" style="margin-top:10px"><button class="btn primary" onclick="saveLayout()">Save positions</button><button class="btn" onclick="previewReceipt()">Preview</button>' +
    '<button class="btn ghost" onclick="saveSetting(\'receipt_layout\',null,\'Positions reset\')">Reset to standard</button></div></div>';
}
function saveTemplate() {
  const f = $('tplFile').files[0];
  if (!f) { showMsg('Choose the template PDF first.', true); return; }
  if (f.size > 3 * 1024 * 1024) { showMsg('That PDF is over 3 MB – please export a smaller one (one page).', true); return; }
  f.arrayBuffer().then(buf => saveSetting('receipt_template', toBase64(new Uint8Array(buf)), 'Template saved – press Preview to check it'));
}
function saveLayout() {
  const fields = {};
  document.querySelectorAll('tr[data-f]').forEach(tr => {
    const f = {};
    tr.querySelectorAll('[data-p]').forEach(el => { const p = el.dataset.p; f[p] = p === 'bold' ? el.checked : p === 'align' ? el.value : parseFloat(el.value) || 0; });
    fields[tr.dataset.f] = f;
  });
  saveSetting('receipt_layout', { fields }, 'Positions saved');
}
function previewReceipt() {
  const r = { id: 0, number: nextNumber() || 1000, name: 'Sample Donor Ltd', date: today(), amount: 1234.56, method: 'Transfer' };
  S.receipts.push(r); viewPdf(0).finally(() => { S.receipts = S.receipts.filter(x => x !== r); });
}
function panelNumbering() {
  return '<div class="card"><h2>Receipt numbering</h2><p>Next receipt number: <strong>' + esc(nextNumber() || 'not set') + '</strong></p>' +
      '<p class="sub">Numbers are given in date order and can never repeat. Change this only to set the first number or to skip ahead.</p>' +
      '<div class="field" style="max-width:240px"><label for="sNext">Next number</label><input id="sNext" inputmode="numeric"></div>' +
      '<button class="btn primary" onclick="setNext()">Set number</button></div>';
}
function setNext() {
  const n = parseInt($('sNext').value, 10);
  if (!n) return;
  act('Saving…', async () => { await api.rpc('set_next_number', { n }); S.settings.next_number = n; return 'Next receipt number: ' + n + '.'; });
}
function panelData() {
  setTimeout(loadHistory, 0);
  return '<div class="card" style="max-width:1000px"><h2>Uploads</h2><p>Every bank file uploaded. If a wrong file went in, press <strong>Undo</strong>: its payments and their receipts are removed ' +
      '(receipts already emailed are kept).</p><div id="histList" class="sub">Loading…</div></div>' +
    '<div class="card"><h2>Move from the old Google app</h2>' +
      '<p>Open your old donations spreadsheet, choose <strong>File › Download › Microsoft Excel (.xlsx)</strong>, then choose that file here. Receipts, donors, the Inbox, set-aside DAF payments and your settings are copied across (the old spreadsheet is not changed). Only possible while this app has no receipts yet.</p>' +
      '<div class="actions"><input type="file" id="migFile" accept=".xlsx" aria-label="Old spreadsheet (.xlsx)"><button class="btn primary" onclick="migrate()"' + (S.receipts.length ? ' disabled title="Already has receipts"' : '') + '>Move my data</button></div>' +
      '<div class="result" id="migResult"></div></div>' +
    '<div class="card"><h2>Backup</h2><p>Free databases have no automatic backup, so download one now and then (it\'s one file with everything). Keep it somewhere safe, e.g. your Google Drive.</p>' +
      '<div class="actions"><button class="btn primary" onclick="downloadBackup()">Download backup</button><button class="btn" onclick="downloadCsv()">Download receipts list (CSV)</button></div>' +
      (set('last_backup') ? '<p class="sub" style="margin-top:10px">Last backup: ' + niceStamp(set('last_backup')) + '</p>' : '') + '</div>' +
    '<div class="card"><h2>Set aside and ignored payments</h2><p>' + S.setAside + ' DAF voucher / donor card payment(s) set aside, ' + S.ignored + ' marked "not a donation", ' + S.dupLog + ' repeated payment(s) skipped by uploads.</p>' +
      '<div class="actions"><button class="btn" onclick="showSetAside()">Show and bring back</button></div><div id="asideList"></div></div>';
}
function showSetAside() {
  act('Loading…', async () => {
    const rows = await api.all('payments', 'select=*&place=in.(set_aside,ignored)');
    $('asideList').innerHTML = rows.length ? '<div class="table-wrap" style="margin-top:12px"><table><tbody>' + rows.map(p =>
      '<tr><td class="date">' + niceDate(p.date) + '</td><td>' + esc(p.payer_name || p.payer) + '<span class="sub">' + esc(p.place === 'ignored' ? 'Not a donation' : p.type) + '</span></td><td class="num">' + money(p.amount) +
      '</td><td><button class="btn small" onclick="bringBack(' + p.id + ')">Back to Inbox</button></td></tr>').join('') + '</tbody></table></div>' : '<p class="sub">None.</p>';
  }, { silent: false });
}
function bringBack(id) {
  act('Moving…', async () => {
    const [p] = await api.update('payments', [id], { place: 'inbox', moved_at: null });
    if (C.isDafType(p.type) && p.type !== C.T_DAF_ONLINE) { await api.update('payments', [id], { type: C.T_DAF_CHOOSE }); p.type = C.T_DAF_CHOOSE; }
    S.inbox.push(p);
    S.setAside = await api.count('payments', 'place=eq.set_aside'); S.ignored = await api.count('payments', 'place=eq.ignored');
    return 'Back in the Inbox.';
  });
}
function panelPeople() {
  const people = !isAdmin() ? '<div class="card"><h2>Your account</h2><p>Signed in as <strong>' + esc(api.email) + '</strong> (user). Only the admin can add or remove people.</p></div>'
    : '<div class="card"><h2>Who can use the app</h2>' +
      (S.oldSchema ? '<p class="err">Run the updated schema.sql in Supabase (SQL Editor) to turn on the admin role and the activity log – until then everyone has the same rights.</p>' : '') +
      '<p>Only people on this list, with a login, can see or change anything. <strong>Users</strong> do the daily work; only the <strong>admin</strong> can add or remove people and read the activity log.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Added</th><th></th></tr></thead><tbody id="staffList"><tr><td colspan="4" class="sub">Loading…</td></tr></tbody></table></div>' +
      '<p class="sub" style="margin-top:12px">To add someone: 1) in Supabase › Authentication › Users press "Add user" › "Create new user" (email + password, tick "Auto Confirm User"); 2) add the same email here. New people are added as users.</p>' +
      '<div class="actions"><input class="search" id="newStaff" type="email" placeholder="name@example.org" aria-label="Email to add"><button class="btn primary" onclick="addStaff()">Add user</button></div></div>';
  return people +
    '<div class="card"><h2>Your password</h2><div class="field" style="max-width:320px"><label for="pw1">New password</label><input id="pw1" type="password" autocomplete="new-password"></div>' +
    '<button class="btn" onclick="changePw()">Change password</button> <button class="btn ghost" onclick="signOut()">Sign out</button></div>';
}
async function loadStaff() {
  const el = $('staffList'); if (!el) return;
  const rows = await api.all('staff', S.oldSchema ? 'select=email,added_at&order=email.asc' : 'select=email,role,added_at&order=email.asc');
  const me = String(api.email).toLowerCase();
  el.innerHTML = rows.map(s => { const you = s.email.toLowerCase() === me, role = s.role || 'admin', e = esc(s.email).replace(/'/g, '');
    return '<tr><td>' + esc(s.email) + (you ? ' <span class="sub">(you)</span>' : '') + '</td><td>' + (role === 'admin' ? '<span class="pill sent">Admin</span>' : 'User') + '</td>' +
      '<td class="date">' + niceStamp(s.added_at) + '</td><td>' + (you ? '' :
        (S.oldSchema ? '' : '<button class="btn small" onclick="setRole(\'' + e + '\',\'' + (role === 'admin' ? 'user' : 'admin') + '\')">' + (role === 'admin' ? 'Make user' : 'Make admin') + '</button> ') +
        '<button class="btn small ghost" onclick="removeStaff(\'' + e + '\')">Remove</button>') + '</td></tr>'; }).join('');
}
function setRole(e, role) {
  if (role === 'admin' && !confirm('Make ' + e + ' an admin? They will be able to add and remove people and read the activity log.')) return;
  act('Saving…', async () => { await api.updateWhere('staff', 'email=eq.' + encodeURIComponent(e), { role }); return e + ' is now ' + (role === 'admin' ? 'an admin' : 'a user') + '.'; }).then(loadStaff);
}

/* ================= ACTIVITY LOG (admin only) ================= */
const LOG = { who: '', tbl: '', days: 7 };
const LOG_TABLES = { receipts: 'Receipts', payments: 'Bank payments', donors: 'Donors', settings: 'Settings', staff: 'People', uploads: 'Uploads' };
const LOG_FIELDS = { stage: 'status', number: 'receipt number', printed_name: 'name on receipt', one_off: 'one-off email', sent_to: 'sent to', sent_at: 'sent on',
  old_pdf: 'saved PDF', place: 'place', campaign: 'campaign', payer_name: 'payer', bank_names: 'bank names', undone_at: 'undone', undone_by: 'undone by' };
const STAGE_WORDS = { check: 'to check', queued: 'waiting to send', sent: 'sent', failed: 'failed', info: 'needs info', old: 'old', held: 'held (duplicate?)', confirm: 'payer to confirm', skip: 'no receipt needed' };
function panelLog() {
  return '<div class="card" style="max-width:none"><h2>Activity log</h2><p class="sub">Every change made in the app, by whom and when. It is written by the database itself, so it cannot be skipped or deleted. Only admins can see it.</p>' +
    '<div class="actions"><select id="logWho" aria-label="Person" onchange="LOG.who=this.value;loadLog()"><option value="">Everyone</option></select>' +
    '<select id="logTbl" aria-label="Area" onchange="LOG.tbl=this.value;loadLog()"><option value="">Everything</option>' + Object.entries(LOG_TABLES).map(([k, v]) => '<option value="' + k + '"' + (LOG.tbl === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>' +
    '<select id="logDays" aria-label="Period" onchange="LOG.days=+this.value;loadLog()">' + [[1, 'Today'], [7, 'Last 7 days'], [31, 'Last month'], [366, 'Last year']].map(([d, l]) => '<option value="' + d + '"' + (LOG.days === d ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
    '<button class="btn" onclick="downloadLog()">Download as CSV</button></div>' +
    '<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody id="logList"><tr><td colspan="4" class="sub">Loading…</td></tr></tbody></table></div></div>';
}
function logQuery() {
  const since = new Date(Date.now() - LOG.days * 86400000); if (LOG.days === 1) since.setHours(0, 0, 0, 0);
  return 'select=*&order=id.desc&at=gte.' + encodeURIComponent(since.toISOString()) + (LOG.who ? '&who=eq.' + encodeURIComponent(LOG.who) : '') + (LOG.tbl ? '&tbl=eq.' + LOG.tbl : '');
}
const logVal = (k, v) => v == null || v === '' ? '(empty)' : k === 'stage' ? (STAGE_WORDS[v] || v) : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80);
function logDetails(l) {
  if (l.action === 'changed' && l.changes) return Object.entries(l.changes).map(([k, [a, b]]) => (LOG_FIELDS[k] || k.replace(/_/g, ' ')) + ': ' + logVal(k, a) + ' → ' + logVal(k, b)).join('; ');
  if (l.changes && l.changes.rows) return l.changes.rows.slice(0, 3).join('; ') + (l.rows > 3 ? ' … and ' + (l.rows - 3) + ' more' : '');
  return '';
}
function logWhat(l) {
  const area = (LOG_TABLES[l.tbl] || l.tbl).toLowerCase();
  const verb = { added: 'Added', changed: 'Changed', deleted: 'Deleted' }[l.action] || l.action;
  const one = { payments: 'bank payment ', donors: 'donor ', settings: 'setting ', staff: 'person ', uploads: 'upload ' }[l.tbl] || '';
  if (!l.row_id && l.label && !/^\d+ \w+$/.test(l.label)) return l.label;   // summary line, e.g. "Uploaded 120 new bank payments"
  return verb + ' ' + (l.rows > 1 ? l.rows + ' ' + area : one + l.label);
}
let logRows = [];
async function loadLog() {
  const el = $('logList'); if (!el) return;
  logRows = await api.all('activity_log', logQuery());
  const who = $('logWho');
  if (who && who.options.length === 1) {
    try { (await api.all('staff', 'select=email&order=email.asc')).forEach(s => who.add(new Option(s.email, s.email, false, LOG.who === s.email))); } catch (e) { /* list stays short */ }
  }
  el.innerHTML = logRows.length ? logRows.slice(0, 1000).map(l => '<tr><td class="date" style="white-space:nowrap">' + niceStamp(l.at) + '</td><td>' + esc(l.who || 'system') + '</td><td style="min-width:260px">' + esc(logWhat(l)) + '</td><td class="sub" style="min-width:320px">' + esc(logDetails(l)) + '</td></tr>').join('') +
    (logRows.length > 1000 ? '<tr><td colspan="4" class="sub">Showing the latest 1,000 of ' + logRows.length + ' – download the CSV for all.</td></tr>' : '')
    : '<tr><td colspan="4" class="sub">Nothing in this period.</td></tr>';
}
function downloadLog() {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = ['When,Who,What,Details'].concat(logRows.map(l => [new Date(l.at).toLocaleString('en-GB'), l.who || 'system', logWhat(l), logDetails(l)].map(q).join(','))).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'Toirem activity log ' + today() + '.csv'; a.click();
}
function addStaff() {
  const e = $('newStaff').value.trim().toLowerCase();
  if (!C.isValidEmail(e)) { showMsg('Enter a valid email.', true); return; }
  act('Adding…', async () => {
    if ((await api.all('staff', 'select=email&order=email.asc&email=eq.' + encodeURIComponent(e))).length) return e + ' is already on the list.';
    await api.insert('staff', [{ email: e }], { returning: false }); return e + ' added as a user. They can sign in once they have a login.'; }).then(loadStaff);
}
function removeStaff(e) {
  if (!confirm('Remove ' + e + '? They will no longer see anything.')) return;
  act('Removing…', async () => { await api.remove('staff', 'email=eq.' + encodeURIComponent(e)); return 'Removed.'; }).then(loadStaff);
}
function changePw() {
  const p = $('pw1').value;
  if (p.length < 10) { showMsg('Use at least 10 characters.', true); return; }
  act('Saving…', async () => { await api.changePassword(p); return 'Password changed.'; });
}
function signOut() { api.signOut(); location.reload(); }

/* ---------- backup & export ---------- */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
function downloadBackup() {
  act('Preparing the backup…', async () => {
    const out = { made: new Date().toISOString(), by: api.email };
    for (const t of ['settings', 'donors', 'payments', 'receipts', 'staff']) out[t] = await api.all(t, t === 'settings' ? 'select=*&order=key.asc' : t === 'staff' ? 'select=*&order=email.asc' : undefined);
    download('toirem-donations-backup-' + today() + '.json', JSON.stringify(out));
    await api.setSetting('last_backup', out.made); S.settings.last_backup = out.made;
    return 'Backup downloaded (' + out.receipts.length + ' receipts, ' + out.donors.length + ' donors).';
  });
}
function downloadCsv() {
  const cols = [['number', 'Receipt No.'], ['date', 'Date'], ['name', 'Donor'], ['email', 'Email'], ['amount', 'Amount'], ['method', 'Method'], ['campaign', 'Campaign'],
                ['source', 'Source'], ['bank', 'Bank'], ['payer', 'Payer on statement'], ['bank_ref', 'Bank reference'], ['stage', 'Status'], ['sent_to', 'Sent to'], ['sent_at', 'Sent on'], ['note', 'Note']];
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = filteredReceipts();
  download('toirem-receipts-' + today() + '.csv', '﻿' + [cols.map(c => c[1]).join(',')].concat(rows.map(r => cols.map(c => q(r[c[0]])).join(','))).join('\r\n'), 'text/csv');
}

/* ---------- donor list import ---------- */
let importKind = '';
function openImport(kind) {
  importKind = kind;
  $('impResult').style.display = 'none'; $('impFile').value = '';
  $('impTitle').textContent = 'Import donor list';
  $('impLead').textContent = 'Choose a CSV or Excel file with a name column and an email column. Card details after names are removed and repeated donors are merged. Donors already here keep their details.';
  $('dlgImport').showModal();
}
async function runImport() {
  const f = $('impFile').files[0];
  if (!f) { showMsg('Choose a file first.', true); return; }
  let rows;
  try { rows = /\.xlsx$/i.test(f.name) ? (await C.readXlsx(window.JSZip, await f.arrayBuffer()))[0].rows.map(r => r.map(C.xv)) : C.parseCsv(await f.text()); }
  catch (err) { showMsg('Could not read the file: ' + err.message, true); return; }
  const head_ = (rows[0] || []).map(h => String(h).toLowerCase());
  let cName = head_.findIndex(h => /name/.test(h)), cEmail = head_.findIndex(h => /e-?mail/.test(h));
  if (cName < 0 || cEmail < 0) { showMsg('The file needs a column with "name" and a column with "email" in its heading.', true); return; }
  const fresh = new Map();
  let cards = 0;
  rows.slice(1).forEach(r => {
    const raw = String(r[cName] || ''), name = C.cleanDonorName(raw), email = String(r[cEmail] || '').trim();
    if (!name) return;
    if (name !== raw.replace(/\s+/g, ' ').trim().replace(/,$/, '')) cards++;
    const k = C.donorKey(name);
    if (!k || S.idx.byKey.has(k)) return;
    const d = fresh.get(k) || { name, email: '', bank_names: '', verified: false, notes: 'Imported ' + niceDate(today()) };
    d.name = name; if (C.isValidEmail(email)) d.email = email;
    fresh.set(k, d);
  });
  await act('Importing donors…', async () => {
    for (const part of chunks([...fresh.values()], 500)) await api.insert('donors', part, { returning: false });
    setDonors(await api.all('donors'));
    const msg = fresh.size + ' new donor(s) added' + (cards ? ' (card details removed from ' + cards + ' name(s))' : '') + '. Donors already here were left as they are.';
    $('impResult').textContent = msg; $('impResult').style.display = 'block';
    return msg;
  });
}

/* ---------- moving across from the old Google app ---------- */
async function migrate() {
  const f = $('migFile').files[0];
  if (!f) { showMsg('Choose the .xlsx file first.', true); return; }
  if (S.receipts.length && !confirm('This app already has receipts. Moving data again could create doubles. Continue?')) return;
  await act('Moving your data across… (about a minute)', async () => {
    const { migrateFromWorkbook } = await import('./migrate.js');
    const book = await C.readXlsx(window.JSZip, await f.arrayBuffer());
    const msg = await migrateFromWorkbook(api, book, m => { $('busyText').textContent = m; });
    await loadAll();
    $('migResult').textContent = msg; $('migResult').style.display = 'block';
    return msg;
  });
}

/* ---------- drawer ---------- */
function openDrawer() {
  $('scrim').classList.add('on'); $('drawer').classList.add('on');
  setTimeout(() => { const f = $('drawer').querySelector('input, button.close'); if (f) f.focus(); }, 50);
}
function closeDrawer() { S.drawer = null; $('scrim').classList.remove('on'); $('drawer').classList.remove('on'); }

/* ================= SIGN-IN AND START ================= */
function showLogin(message) {
  $('app').hidden = true; hideBusy();
  $('login').hidden = false;
  $('loginMsg').textContent = message || '';
  setTimeout(() => $('lEmail').focus(), 50);
}
async function doLogin(ev) {
  ev.preventDefault();
  $('loginGo').disabled = true; $('loginMsg').textContent = '';
  try {
    await api.signIn($('lEmail').value, $('lPass').value);
    $('lPass').value = '';
    $('login').hidden = true;
    await start();
  } catch (err) { $('loginMsg').textContent = err.message; }
  finally { $('loginGo').disabled = false; }
}
async function start() {
  if (!CFG.supabaseUrl || !CFG.supabaseKey) {
    $('fatal').hidden = false;
    $('fatal').innerHTML = '<h1 style="color:var(--navy-deep);margin-top:0">Almost there</h1><p>The app is not connected to its database yet. Put the Supabase address and key in <code>config.js</code> (see the setup guide).</p>';
    return;
  }
  if (!api.signedIn) { showLogin(); return; }
  showBusy('Loading donations…');
  try {
    if (!(await api.rpc('is_staff'))) { api.signOut(); hideBusy(); showLogin('This account is not on the staff list. Ask the administrator to add it (Settings › People).'); return; }
    try { S.role = (await api.rpc('my_role')) || 'user'; S.oldSchema = false; }
    catch (e) { if (e instanceof AuthError) throw e; S.role = 'admin'; S.oldSchema = true; }   // database not updated yet
    await loadAll();
    await movePastFromInbox();
    await fixAccountTransfers();
    await fixDafDefaults();
    hideBusy(); render();
    // Links from other Toirem Management pages, e.g. /#receipts
    const fromLink = location.hash.slice(1);
    if (['home', 'inbox', 'prepare', 'receipts', 'settings'].includes(fromLink)) { go(fromLink); history.replaceState(null, '', location.pathname); }
    if (!S.settings.next_number && !S.receipts.length) S.setTab = 'data';
    startOutbox();
    setInterval(() => { if (!OUT.running && S.receipts.some(r => r.stage === 'queued')) pumpOutbox(); }, 10 * 60000);
  } catch (err) {
    hideBusy();
    if (err instanceof AuthError) { showLogin(err.message); return; }
    if (/staff list|permission denied|row-level/i.test(err.message)) { showLogin('This account is not on the staff list. Ask the administrator to add it.'); api.signOut(); return; }
    $('fatal').hidden = false;
    $('fatal').innerHTML = '<h1 style="color:var(--navy-deep);margin-top:0">Toirem Management can\'t open</h1><p>' + esc(err.message) + '</p><p>Check the internet connection, then reload this page.</p>';
  }
}

Object.assign(window, {
  render, go, rerenderKeepFocus, hideMsg, closeDlg, closeDrawer, openReceipt, openDonor, saveDonor, deleteDonor,
  selInbox, selAllInbox, addToCampaign, openAdd, addFormChanged, saveAdd, selAllPrep, giveNumbers, prepRows, setType, setTypeMany, notDonation, selRec, selAllRec, sendMany, skipMany, retryFailed,
  donorTyped, fixTyped, saveRec, makeRec, verifySend, skipOne, backToInbox, fixRec, sendCopy, viewPdf,
  selPayer, selAllPayers, payerTyped, confirmPayers, skipPayers, payersAreDaf, payersReceipted, startOutbox,
  openNew, saveNew, openBank, closeBank, uploadBank, UP, openImport, runImport,
  addLikelyAnyway, saveDaf, addMethod, saveMethods, saveEmail, saveSending, testSending, newSecret, saveTemplate, saveLayout, previewReceipt, saveSetting,
  setNext, migrate, undoUpload, HIST_FOR_TEST: () => HIST.map(h => h.bank + ' ' + h.mode + ' ' + h.payments + (h.undone_at ? ' undone' : '')).join(' | '), downloadBackup, downloadCsv, showSetAside, bringBack, addStaff, removeStaff, changePw, signOut, $,
  filteredReceipts, payerGroups, payerList, OUT, G, openFound, openCombined, combinedPayer, combinedYear, combinedList, combinedMake, setRole, loadLog, downloadLog, LOG
});
document.querySelectorAll('.nav').forEach(b => b.onclick = () => go(b.dataset.view));
$('gsearch').addEventListener('input', e => {
  G.q = e.target.value; G.shown = 100;
  if (G.q.trim()) { if (S.view !== 'search') { S.back = S.view; S.view = 'search'; closeDrawer(); } }
  else if (S.view === 'search') S.view = S.back || 'home';
  render();
});
$('gsearch').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; G.q = ''; if (S.view === 'search') S.view = S.back || 'home'; render(); } });
$('scrim').onclick = closeDrawer;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.drawer) closeDrawer(); });
$('loginForm').addEventListener('submit', doLogin);
start();
