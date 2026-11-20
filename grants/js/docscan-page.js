/* =====================================================================
   Grants Office › Document check (preview).
   Reads every document on every grant in this browser, gives each a code (UC, BS, POB, ID-P…),
   the name on it and whether that name matches the grant. Groups pages that share a printed layout,
   so the different versions of the application form show up. Saves nothing to the grants.
   ===================================================================== */
import * as DS from './docscan.js';

const S = { grants: null, recs: new Map(), running: false, limit: '500', filter: 'all', view: 'docs', page: 0, msg: '', times: [], done: 0, total: 0, confirmClear: false, test: null };
let C = null;   // { app, frame, notice, esc, api, fetchDoc, bindTop }
const PAGE = 50;

export async function scanPage(ctx) {
  C = ctx;
  if (!DS.enabled()) return renderOff();
  C.app().innerHTML = C.frame('Document check', null, '<p class="loading">Loading…</p>'); C.bindTop();
  if (!S.grants) {
    const r = await C.api('scan-list', {});
    if (!r.ok) { C.app().innerHTML = C.frame('Document check', null, C.notice('bad', C.esc(r.message || 'Could not load the grants.'))); return; }
    S.grants = r.grants;
  }
  S.recs = new Map((await DS.getAll()).map((x) => [x.key, x]));
  render();
}

function renderOff() {
  C.app().innerHTML = C.frame('Document check', null, `${C.notice('warn', '<b>Document check is turned off.</b> No codes are shown on the grants. Any results already made are still kept in this browser.')}
    <div class="actions"><button class="primary small" type="button" id="dsOn">Turn document check on</button></div>`);
  C.bindTop();
  document.getElementById('dsOn').addEventListener('click', () => { DS.setEnabled(true); scanPage(C); });
}

const fmtN = (n) => Number(n).toLocaleString('en-GB');
function queue() {
  const lim = S.limit === 'all' ? Infinity : Number(S.limit);
  const out = [];
  S.grants.slice(0, lim).forEach((g) => g.docs.forEach((d) => out.push({ g, d })));
  return out;
}
const docsInScope = () => queue().length;

function render() {
  const esc = C.esc, all = [...S.recs.values()];
  const inScope = docsInScope(), done = queue().filter((q) => S.recs.has(q.d.key)).length;
  const counts = {}; for (const r of all) { const c = DS.shown(r).code; counts[c] = (counts[c] || 0) + 1; }
  const m = { yes: 0, no: 0, none: 0 }; for (const r of all) { const s = DS.shown(r); if (DS.CHECKED.has(s.code)) m[s.match === 'yes' ? 'yes' : s.match === 'no' ? 'no' : 'none']++; }
  const avg = S.times.length ? S.times.reduce((a, b) => a + b, 0) / S.times.length : 0;
  const left = avg ? Math.round(((inScope - done) * avg) / 2 / 60000) : null;
  const tile = (k, n, label, color) => `<button type="button" class="tile" data-dsf="${esc(k)}" aria-pressed="${S.filter === k}" ${color ? `style="border-top:4px solid ${color}"` : ''}><b>${fmtN(n || 0)}</b><span>${esc(label)}</span></button>`;
  C.app().innerHTML = C.frame('Document check', `<span class="pill p-new">Preview</span>`, `
    <p class="note" style="margin-top:0">Reads the documents on your grants <b>in this browser</b> and labels each one: what it is, whose name is on it, and whether that name matches the grant. It also groups pages with the same printed layout, so the different versions of the application form show up. <b>Nothing is saved to the grants</b>: results stay in this browser until you clear them.</p>
    <div class="panel">
      <div class="grid">
        <label class="f"><span class="lab">Grants to check</span><select id="dsLimit">
          ${[['100', 'The first 100 grants'], ['500', 'The first 500 grants'], ['1000', 'The first 1,000 grants'], ['all', `All grants (${fmtN(S.grants.length)})`]].map(([v, l]) => `<option value="${v}" ${S.limit === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <div class="f"><span class="lab">Progress</span><div id="dsProg" style="padding-top:6px"><b>${fmtN(done)}</b> of ${fmtN(inScope)} documents checked${S.running && left != null ? ` · about ${left < 1 ? 'a minute' : left + ' min'} left` : ''}</div>
          <div style="height:8px;background:#e7ebf2;border-radius:6px;margin-top:6px;overflow:hidden"><div id="dsBar" style="height:100%;width:${inScope ? Math.round((done / inScope) * 100) : 0}%;background:var(--orange,#e8521c)"></div></div></div>
      </div>
      <div class="actions">
        ${S.running ? '<button class="primary small" type="button" id="dsPause">Pause</button>' : `<button class="primary small" type="button" id="dsStart" ${done >= inScope ? 'disabled' : ''}>${done ? 'Continue' : 'Start'}</button>`}
        <button class="ghost small" type="button" id="dsTest" ${S.running ? 'disabled' : ''}>Test the reader</button>
        <span class="note" id="dsMsg">${esc(S.msg)}</span></div>
      ${S.test ? `<p class="note">${S.test.ok ? `✓ The reader works (${S.test.ms} ms): “${esc(S.test.text)}”` : `✗ ${esc(S.test.text || 'The reader did not read the test line.')}`}</p>` : ''}
      <p class="note">You can leave this page open in a tab while it runs. If you pause or close it, Continue picks up where it stopped. The first run downloads the free text reader (about 10 MB).</p>
    </div>
    ${all.length ? `
    <div class="tiles" style="flex-wrap:wrap">${tile('all', all.length, 'All checked')}${Object.keys(DS.CODES).filter((k) => counts[k]).map((k) => tile(k, counts[k], k + ' · ' + DS.CODES[k].label, DS.CODES[k].color)).join('')}</div>
    <div class="tiles" style="flex-wrap:wrap;margin-top:8px">${tile('m:yes', m.yes, '✓ Name matches the grant', '#1f7a4a')}${tile('m:no', m.no, '⚠ A different name', '#c46a00')}${tile('m:none', m.none, 'Name not found', '#8a99ad')}</div>
    <div class="actions" style="margin-top:14px">
      <button class="${S.view === 'docs' ? 'primary' : 'ghost'} small" type="button" data-dsv="docs">Documents</button>
      <button class="${S.view === 'groups' ? 'primary' : 'ghost'} small" type="button" data-dsv="groups">Form versions and layouts</button>
      <span style="flex:1"></span>
      <button class="ghost small" type="button" id="dsCsv">Download results (CSV)</button></div>
    ${S.view === 'groups' ? groupsView() : docsView(all)}` : ''}
    <details class="panel" style="margin-top:22px" id="dsUndo" ${S.undoOpen ? 'open' : ''}><summary style="cursor:pointer;font-weight:700">Turn off or undo</summary>
      <p class="note"><b>Turn off</b> hides Document check codes everywhere; results are kept, so turning it back on shows them again. <b>Clear all results</b> deletes every result and every change you made here, from this browser. Neither touches the grants or their documents.</p>
      <div class="actions"><button class="ghost small" type="button" id="dsOff">Turn document check off</button>
        <button class="ghost small" type="button" id="dsClear" style="color:#c0262d;border-color:#c0262d">${S.confirmClear ? 'Press again to delete all results' : 'Clear all results'}</button></div></details>`);
  C.bindTop(); bind();
}

function filtered(all) {
  const f = S.filter;
  return all.filter((r) => { const s = DS.shown(r); if (f === 'all') return true; if (f.startsWith('m:')) { const k = f.slice(2); return DS.CHECKED.has(s.code) && (k === 'none' ? !s.match : s.match === k); } return s.code === f; })
    .sort((a, b) => String(a.ref).localeCompare(String(b.ref)) || String(a.title).localeCompare(String(b.title)));
}
function docsView(all) {
  const esc = C.esc, list = filtered(all), pages = Math.max(1, Math.ceil(list.length / PAGE));
  if (S.page >= pages) S.page = pages - 1;
  const rows = list.slice(S.page * PAGE, S.page * PAGE + PAGE);
  return `<div class="tbl" style="margin-top:8px"><table class="list"><thead><tr><th></th><th>Grant</th><th>Document</th><th>Code</th><th>Name on the document</th><th></th></tr></thead><tbody>
    ${rows.map((r) => { const s = DS.shown(r); return `<tr>
      <td>${r.thumb ? `<img src="${r.thumb}" alt="" style="width:54px;max-height:74px;object-fit:contain;border:1px solid #dde2ea;background:#fff">` : ''}</td>
      <td><a href="#grant/${esc(r.grantId)}">${esc(r.ref)}</a><br><span class="note">${esc(r.grantName)}</span></td>
      <td>${esc(r.title)}${r.err ? `<br><span class="note" style="color:#c0262d">${esc(r.err)}</span>` : r.conf === 'low' ? '<br><span class="note">Worth a look</span>' : ''}</td>
      <td><select data-dscode="${esc(r.key)}" aria-label="Code for ${esc(r.title)}" style="min-width:90px">${Object.keys(DS.CODES).map((k) => `<option value="${k}" ${s.code === k ? 'selected' : ''}>${k}</option>`).join('')}</select>${s.edited ? '<br><span class="note">changed by you</span>' : ''}</td>
      <td><input data-dsname="${esc(r.key)}" value="${esc(s.name || '')}" placeholder="${/^(APP-|CONS)/.test(s.code) ? '' : 'name not found'}" aria-label="Name on ${esc(r.title)}" style="width:210px"></td>
      <td style="font-size:18px">${s.match === 'yes' ? '<span style="color:#1f7a4a" title="Matches the grant">✓</span>' : s.match === 'no' ? '<span style="color:#c46a00" title="A different name from the grant">⚠</span>' : ''}</td></tr>`; }).join('')}
  </tbody></table></div>
  ${pages > 1 ? `<div class="actions"><button class="ghost small" type="button" data-dsp="-1" ${S.page ? '' : 'disabled'}>‹ Previous</button><span class="note">Page ${S.page + 1} of ${pages} · ${fmtN(list.length)} documents</span><button class="ghost small" type="button" data-dsp="1" ${S.page < pages - 1 ? '' : 'disabled'}>Next ›</button></div>` : ''}`;
}
function groupsView() {
  const esc = C.esc, gs = DS.group([...S.recs.values()]);
  const forms = gs.filter((g) => /^(APP-|CONS|\?)/.test(g.code));
  return `<p class="note">Pages are grouped when they share most of their printed words, so every copy of the same printed form lands in the same group, whatever was written on it. The application form groups below are the versions in use.</p>
    <div class="actions"><button class="primary small" type="button" id="dsZip" ${forms.length ? '' : 'disabled'}>Download samples of the form versions (zip)</button>
      <span class="note">Up to 4 examples of each application-form, consent-form and “not sure” group, with a list saying which grant each came from. Send that zip to Claude to set up each version.</span></div>
    ${gs.length ? gs.map((g) => `<div class="panel" style="margin-top:10px"><h3 style="margin:0 0 6px">Group ${esc(g.letter)} · <span class="dcode" style="background:${(DS.CODES[g.code] || DS.CODES['?']).color}">${esc(g.code)}</span> ${esc((DS.CODES[g.code] || {}).label || '')}${g.version ? ' · version ' + esc(g.version) : ''} <span class="note">· ${fmtN(g.items.length)} page${g.items.length === 1 ? '' : 's'}</span></h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${g.items.slice(0, 8).map((r) => `<a href="#grant/${esc(r.grantId)}" title="${esc(r.ref + ' · ' + r.title)}">${r.thumb ? `<img src="${r.thumb}" alt="${esc(r.ref + ' ' + r.title)}" style="width:80px;height:110px;object-fit:contain;border:1px solid #dde2ea;background:#fff">` : esc(r.ref)}</a>`).join('')}</div></div>`).join('') : '<p class="note">Not enough text read yet to group pages.</p>'}`;
}

function bind() {
  const on = (id, fn, ev = 'click') => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('dsLimit', (e) => { S.limit = e.target.value; render(); }, 'change');
  on('dsStart', () => run());
  on('dsPause', () => { S.running = false; S.msg = 'Pausing after the documents being read now…'; render(); });
  on('dsTest', async () => { S.msg = 'Loading the reader…'; render(); try { S.test = await DS.testReader(); } catch (e) { S.test = { ok: false, text: e.message }; } S.msg = ''; render(); });
  on('dsOff', async () => { S.running = false; DS.setEnabled(false); await DS.stopReaders(); renderOff(); });
  on('dsClear', async () => { if (!S.confirmClear) { S.confirmClear = true; render(); return; } S.confirmClear = false; S.running = false; await DS.clearAll(); S.recs = new Map(); S.times = []; S.msg = 'All results deleted from this browser.'; render(); });
  const ud = document.getElementById('dsUndo'); if (ud) ud.addEventListener('toggle', () => { S.undoOpen = ud.open; });
  on('dsCsv', csv);
  on('dsZip', zip);
  document.querySelectorAll('[data-dsf]').forEach((b) => b.addEventListener('click', () => { S.filter = S.filter === b.dataset.dsf ? 'all' : b.dataset.dsf; S.page = 0; S.view = 'docs'; render(); }));
  document.querySelectorAll('[data-dsv]').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.dsv; render(); }));
  document.querySelectorAll('[data-dsp]').forEach((b) => b.addEventListener('click', () => { S.page += Number(b.dataset.dsp); render(); scrollTo(0, 0); }));
  document.querySelectorAll('[data-dscode]').forEach((el) => el.addEventListener('change', async () => { const r = S.recs.get(el.dataset.dscode); r.user = { ...(r.user || {}), code: el.value === r.code ? undefined : el.value }; await DS.putRec(r); render(); }));
  document.querySelectorAll('[data-dsname]').forEach((el) => el.addEventListener('change', async () => { const r = S.recs.get(el.dataset.dsname); const v = el.value.trim(); r.user = { ...(r.user || {}), name: v === (r.name || '') ? undefined : v }; await DS.putRec(r); render(); }));
}

/** Read the documents in scope that haven't been read yet, two at a time. */
async function run() {
  const todo = queue().filter((q) => !S.recs.has(q.d.key));
  if (!todo.length) return;
  S.running = true; S.msg = 'Loading the reader…'; render();
  let i = 0, lastPaint = 0;
  const fetchBlob = (d) => C.fetchDoc(d.fileId ? '/api/grants/office/file/' + d.fileId : '/api/grants/office/doc?url=' + encodeURIComponent(d.url));
  const worker = async () => {
    while (S.running && i < todo.length && location.hash === '#docscan') {
      const { g, d } = todo[i++], t0 = performance.now();
      const rec = await DS.analyse(g, d, fetchBlob);
      S.recs.set(rec.key, rec); await DS.putRec(rec).catch(() => {});
      S.times.push(performance.now() - t0); if (S.times.length > 40) S.times.shift();
      S.msg = `Reading ${g.ref} · ${d.title}`;
      const now = Date.now();
      if (now - lastPaint > 4000) { lastPaint = now; if (location.hash === '#docscan') render(); }
      else { const p = document.getElementById('dsMsg'); if (p) p.textContent = S.msg; }
    }
  };
  try { await Promise.all([worker(), worker()]); }
  catch (e) { S.msg = 'Stopped: ' + (e.message || e); }
  const finished = i >= todo.length;
  S.running = false;
  if (finished) S.msg = 'Finished.';
  else if (!/^Stopped/.test(S.msg)) S.msg = 'Paused.';
  if (location.hash === '#docscan') render();
}

function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 15000); }
const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
function csv() {
  const head = ['Grant', 'Grant name', 'Document', 'Code', 'Code meaning', 'Name on document', 'Name matches', 'Changed by you', 'Problem', 'Link'];
  const rows = [...S.recs.values()].sort((a, b) => String(a.ref).localeCompare(String(b.ref))).map((r) => { const s = DS.shown(r); return [r.ref, r.grantName, r.title, s.code, (DS.CODES[s.code] || {}).label, s.name, s.match === 'yes' ? 'Yes' : s.match === 'no' ? 'No' : '', s.edited ? 'Yes' : '', r.err || '', r.url]; });
  save(new Blob(['﻿' + [head, ...rows].map((x) => x.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }), 'Document check ' + new Date().toISOString().slice(0, 10) + '.csv');
}
async function zip() {
  const btn = document.getElementById('dsZip'); btn.disabled = true; btn.textContent = 'Making the zip…';
  try {
    if (!window.JSZip) await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = '/vendor/jszip.min.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
    const z = new window.JSZip(), list = [['Group', 'Code', 'Version', 'File', 'Grant', 'Grant name', 'Document']];
    const gs = DS.group([...S.recs.values()]).filter((g) => /^(APP-|CONS|\?)/.test(g.code));
    for (const g of gs) {
      const pick = g.items.filter((r) => !r.err).slice(0, 4);
      for (const [n, r] of pick.entries()) {
        btn.textContent = `Adding group ${g.letter} (${n + 1}/${pick.length})…`;
        const blob = await C.fetchDoc(r.fileId ? '/api/grants/office/file/' + r.fileId : '/api/grants/office/doc?url=' + encodeURIComponent(r.url)).catch(() => null);
        if (!blob) continue;
        const ext = (r.type || blob.type || '').includes('pdf') ? 'pdf' : (r.type || blob.type || '').includes('png') ? 'png' : 'jpg';
        const file = `group-${g.letter}${g.version ? '-' + g.version : ''}-${g.code}/${r.ref}-${String(r.title).replace(/[^\w.-]+/g, '_')}.${ext}`;
        z.file(file, blob); list.push([g.letter, g.code, g.version || '', file, r.ref, r.grantName, r.title]);
      }
    }
    z.file('list.csv', '﻿' + list.map((x) => x.map(cell).join(',')).join('\r\n'));
    save(await z.generateAsync({ type: 'blob' }), 'Toirem form versions ' + new Date().toISOString().slice(0, 10) + '.zip');
  } catch (e) { S.msg = "The zip couldn't be made: " + (e.message || e); }
  render();
}
