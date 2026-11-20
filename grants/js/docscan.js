/* =====================================================================
   Document check (preview) – recognises each document on a grant in the browser:
   what it is (a short code), whose name is on it, and whether that name matches the grant.
   Nothing is saved to the grants: results are kept in this browser only (IndexedDB) and can
   be cleared, and the whole feature can be switched off (see enabled / setEnabled).
   Text: PDFs are read directly; photos and scans are read with Tesseract (free, in the browser).
   ===================================================================== */

export const CODES = {
  'APP-I': { label: 'Individual application form', color: '#1f5f99' },
  'APP-C': { label: 'Charity application form', color: '#1f5f99' },
  CONS: { label: 'Consent form', color: '#5b4a9e' },
  UC: { label: 'Universal Credit statement', color: '#0b7a75' },
  BEN: { label: 'Other benefits letter', color: '#0b7a75' },
  BS: { label: 'Bank statement', color: '#7a5a00' },
  POB: { label: 'Proof of bank', color: '#7a5a00' },
  'ID-P': { label: 'Passport', color: '#8a3b12' },
  'ID-D': { label: 'Driving licence', color: '#8a3b12' },
  ID: { label: 'Other ID', color: '#8a3b12' },
  LTR: { label: 'Letter / other document', color: '#555f6e' },
  '?': { label: 'Not sure – please check', color: '#b3473a' },
};
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

/* ---------- on / off (the undo switch) ---------- */
const OFF_KEY = 'toirem.docscan.off';
export function enabled() { try { return localStorage.getItem(OFF_KEY) !== '1'; } catch { return true; } }
export function setEnabled(on) { try { if (on) localStorage.removeItem(OFF_KEY); else localStorage.setItem(OFF_KEY, '1'); } catch { /* private window */ } }

/* ---------- results, kept in this browser only ---------- */
let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise((ok, bad) => {
    const r = indexedDB.open('toirem-docscan', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('docs', { keyPath: 'key' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
  return dbp;
}
const tx = async (mode, fn) => { const d = await idb(); return new Promise((ok, bad) => { const t = d.transaction('docs', mode); const st = t.objectStore('docs'); const out = fn(st); t.oncomplete = () => ok(out && out.result !== undefined ? out.result : out); t.onerror = () => bad(t.error); }); };
export const getAll = () => tx('readonly', (st) => st.getAll()).catch(() => []);
export const putRec = (rec) => tx('readwrite', (st) => st.put(rec));
export const clearAll = () => tx('readwrite', (st) => st.clear());
/** key -> record, for showing codes on a grant page. */
export async function resultsMap() { const m = new Map(); if (!enabled()) return m; for (const r of await getAll()) m.set(r.key, r); return m; }
/** What to show for a record: the office's correction wins over the automatic result. */
export function shown(r) {
  if (!r) return null;
  const u = r.user || {};
  return { code: u.code || r.code, name: u.name != null ? u.name : r.name, match: u.name != null || u.code ? (CHECKED.has(u.code || r.code) ? matchName(u.name != null ? u.name : r.name, r.grantName, r.grantAlt, r.grantKind, '') : '') : r.match, edited: !!(u.code || u.name != null) };
}

/* ---------- reading the text ---------- */
let tess = null, schedEng = null, workHeb = null;
async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (!tess) tess = new Promise((ok, bad) => { const s = document.createElement('script'); s.src = TESSERACT; s.onload = () => ok(window.Tesseract); s.onerror = () => bad(new Error("The free text reader couldn't be loaded (check the internet connection).")); document.head.appendChild(s); });
  return tess;
}
/** Read a canvas: { text, conf } (conf 0–100 is the reader's own confidence). */
async function ocrFull(canvas, lang = 'eng') {
  const T = await loadTesseract();
  let d;
  if (lang === 'heb') { if (!workHeb) workHeb = T.createWorker('heb'); d = (await (await workHeb).recognize(canvas)).data; }
  else {
    if (!schedEng) schedEng = (async () => { const sc = T.createScheduler(); for (let i = 0; i < 2; i++) sc.addWorker(await T.createWorker('eng')); return sc; })();
    d = (await (await schedEng).addJob('recognize', canvas)).data;
  }
  return { text: d.text || '', conf: Number(d.confidence) || 0 };
}
const ocr = async (canvas, lang) => (await ocrFull(canvas, lang)).text;
export async function stopReaders() {
  try { if (schedEng) await (await schedEng).terminate(); } catch { /* already gone */ }
  try { if (workHeb) await (await workHeb).terminate(); } catch { /* already gone */ }
  schedEng = null; workHeb = null;
}
/** Quick self-test for the office: reads a line drawn on a canvas. */
export async function testReader() {
  const c = document.createElement('canvas'); c.width = 900; c.height = 160;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000'; x.font = '48px Arial'; x.fillText('Universal Credit statement', 30, 100);
  const t0 = performance.now(); const text = await ocr(c);
  return { ok: /universal\s*credit/i.test(text), text: text.trim(), ms: Math.round(performance.now() - t0) };
}

let PDFJS = null;
async function pdfjs() { if (!PDFJS) { PDFJS = await import('/vendor/pdfjs/pdf.min.mjs'); PDFJS.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'; } return PDFJS; }
const sniff = (b) => (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 ? 'pdf' : (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0x47 && b[1] === 0x49) || (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) ? 'image' : '');
const letters = (t) => (String(t).match(/[A-Za-z֐-׿]/g) || []).length;
function scaled(src, w, h, max = 1800, rotate = 0) {
  const k = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
  const W = Math.round(w * k), H = Math.round(h * k);
  if (rotate % 180) { c.width = H; c.height = W; } else { c.width = W; c.height = H; }
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.translate(c.width / 2, c.height / 2); x.rotate((rotate * Math.PI) / 180); x.drawImage(src, -W / 2, -H / 2, W, H);
  return c;
}
const thumbOf = (c) => scaled(c, c.width, c.height, 170).toDataURL('image/jpeg', 0.6);

/** Read a document's text (first two pages). Returns { text, thumb, how, pages }. */
async function readDoc(blob, wantHeb) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), kind = sniff(bytes);
  if (kind === 'pdf') {
    const P = await pdfjs();
    const task = P.getDocument({ data: bytes, isEvalSupported: false }), pdf = await task.promise;
    let text = '', thumb = '', how = 'pdf text';
    try {
      for (let n = 1; n <= Math.min(2, pdf.numPages); n++) {
        const page = await pdf.getPage(n);
        const tc = await page.getTextContent();
        let t = tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('');
        const vp = page.getViewport({ scale: Math.min(2.2, 1700 / page.getViewport({ scale: 1 }).width) });
        let cv = null;
        if (n === 1 || letters(t) < 60) {
          cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
          const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
          await page.render({ canvasContext: x, viewport: vp }).promise;
          if (n === 1) thumb = thumbOf(cv);
        }
        if (letters(t) < 60 && cv) { t = await ocr(cv); how = 'scanned pdf'; if (wantHeb || letters(t) < 40) t += '\n' + await ocr(cv, 'heb'); }
        text += t + '\n';
      }
      return { text, thumb, how, pages: pdf.numPages };
    } finally { try { task.destroy(); } catch { /* already closed */ } }
  }
  if (kind === 'image') {
    const bmp = await createImageBitmap(blob);
    const base = scaled(bmp, bmp.width, bmp.height);
    let { text, conf } = await ocrFull(base), best = base;
    if (conf < 65 || words(text).length < 8) {            // maybe a sideways or upside-down photo: try turning it
      for (const r of [90, 270, 180]) {
        const c = scaled(bmp, bmp.width, bmp.height, 1800, r), o = await ocrFull(c);
        if (o.conf > conf + 10) { text = o.text; conf = o.conf; best = c; }
        if (conf >= 80) break;
      }
    }
    if (wantHeb || letters(text) < 40) text += '\n' + await ocr(best, 'heb');
    return { text, thumb: thumbOf(best), how: 'photo', pages: 1 };
  }
  throw new Error('unsupported');
}
const words = (t) => (String(t).toLowerCase().match(/[a-z֐-׿]{3,}/g) || []);

/* ---------- what is it? ---------- */
const BANKS = ['lloyds', 'barclays', 'hsbc', 'natwest', 'santander', 'metro bank', 'monzo', 'starling', 'nationwide', 'tsb', 'halifax', 'royal bank of scotland', 'rbs', 'co-operative bank', 'cooperative bank', 'co-op bank', 'virgin money', 'revolut', 'first direct', 'bank of scotland', 'clydesdale', 'yorkshire bank', 'unity trust', 'caf bank', 'charities aid foundation', 'tide', 'wise', 'chase', 'coutts', 'allica', 'kroo', 'cashplus', 'tandem', 'triodos', 'handelsbanken', 'bank leumi', 'leumi', 'hapoalim', 'mizrahi', 'discount bank', 'post office'];
const has = (t, ...xs) => xs.some((x) => (x instanceof RegExp ? x.test(t) : t.includes(x)));
/** Returns { code, conf: 'high'|'low' } */
export function classify(raw, doc = {}) {
  const t = ' ' + String(raw).toLowerCase().replace(/\s+/g, ' ') + ' ';
  const bank = BANKS.some((b) => t.includes(' ' + b) || t.includes(b + ' '));
  const moneyLines = (String(raw).match(/\d{1,2}[\s/.-](?:\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s/.-]\d{2,4}.{0,80}?\d+\.\d{2}/gi) || []).length;
  if (has(t, 'individual grant application', /grant application form.{0,400}(marital|family information|dependent children|endorser)/)) return { code: 'APP-I', conf: 'high' };
  if (has(t, 'grant application') && has(t, 'charity number', 'registered charity', 'organisation', 'organization', 'trustee')) return { code: 'APP-C', conf: 'high' };
  if (doc.source === 'consent' || has(t, 'consent form', 'i consent', 'i give consent', 'i give my consent', 'hereby consent')) return { code: 'CONS', conf: doc.source === 'consent' ? 'high' : 'low' };
  if (has(t, 'p<gbr', /p<[a-z]{3}[a-z<]{5,}/) || (has(t, 'passport') && has(t, 'nationality', 'date of birth', 'surname', 'given names'))) return { code: 'ID-P', conf: 'high' };
  if (has(t, 'driving licence', 'driving license', 'dvla', 'provisional licence')) return { code: 'ID-D', conf: 'high' };
  // a bank statement can list a "UNIVERSAL CREDIT" payment, so statements are recognised first
  if (bank && moneyLines >= 4 && has(t, 'balance', 'statement', 'paid in', 'paid out', 'money in', 'money out')) return { code: 'BS', conf: 'high' };
  if (has(t, 'universal credit')) return { code: 'UC', conf: has(t, 'assessment period', 'your statement', 'standard allowance', 'payment', 'claimant') ? 'high' : 'low' };
  if (has(t, 'child benefit', 'housing benefit', 'council tax reduction', 'council tax support', 'pension credit', 'jobseeker', 'employment and support allowance', 'tax credit', 'personal independence payment', 'carer\'s allowance', 'carers allowance', 'attendance allowance', 'department for work and pensions', ' dwp ', 'hm revenue', 'hmrc', 'benefit award', 'award notice')) return { code: 'BEN', conf: 'high' };
  if (has(t, 'passport')) return { code: 'ID-P', conf: 'low' };
  if (has(t, 'identity card', 'residence permit', 'biometric residence', 'national insurance card', 'teudat', 'תעודת זהות', 'id card')) return { code: 'ID', conf: 'high' };
  if (bank && (moneyLines >= 4 || (has(t, 'statement') && has(t, 'balance')))) return { code: 'BS', conf: moneyLines >= 4 ? 'high' : 'low' };
  if (bank && has(t, 'account holder', 'account name', 'confirm', 'this letter', 'sort code', 'account number', 'iban', 'debit card', 'bank details')) return { code: 'POB', conf: 'high' };
  if (moneyLines >= 6 && has(t, 'balance')) return { code: 'BS', conf: 'low' };
  if (bank) return { code: 'POB', conf: 'low' };
  if (words(raw).length >= 25) return { code: 'LTR', conf: has(t, 'dear ', 'yours sincerely', 'yours faithfully', 'to whom it may concern') ? 'high' : 'low' };
  return { code: '?', conf: 'low' };
}

/* ---------- whose name? ---------- */
const TITLE = '(?:mr|mrs|miss|ms|mx|dr|rabbi|rev|mstr|master)';
const NAMEWORD = "[A-Z][A-Za-z'’-]+";   // names stay on one line: words are joined by spaces or tabs only
const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[^A-Za-z֐-׿'’&.\- ]/g, '').trim();
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Mr|Mrs|Ms|Dr)\b\.?/g, '$1').replace(/\bLtd\b/gi, 'Ltd');
export function extractName(code, raw, grant = {}) {
  const text = String(raw);
  // Passport: the machine-readable line P<GBRSURNAME<<GIVEN<NAMES<<<
  const mrz = text.toUpperCase().replace(/\s+/g, '').match(/P<([A-Z]{3})([A-Z]+)<<([A-Z<]+?)<{2,}/);
  if (mrz) return titleCase(mrz[3].replace(/</g, ' ').trim() + ' ' + mrz[2]);
  // Driving licence fields 1. surname 2. given names
  if (code === 'ID-D') {
    const s = text.match(/\b1\.\s*([A-Z][A-Z'’-]{1,})/), g = text.match(/\b2\.\s*([A-Z][A-Z'’ -]{1,40})/);
    if (s && g) return titleCase(g[1].trim().split(/\s{2,}|\n/)[0] + ' ' + s[1]);
  }
  // A charity's own name anywhere in the text (bank statements, receipts…)
  if (grant.kind === 'charity') { const org = findOrg(text, [grant.name, ...(grant.alt || [])]); if (org) return org; }
  // Labelled names
  const lab = text.match(/(?:account[ \t]*(?:name|holder)s?|name of account holder|customer name|claimant|full name|name)[ \t]*[:\-]?[ \t]*((?:(?:Mr|Mrs|Miss|Ms|Dr|Rabbi)\.?[ \t]+)?[A-Z][A-Za-z'’-]+(?:[ \t]+[A-Z][A-Za-z'’-]+){1,3})/);
  if (lab) return titleCase(clean(lab[1]));
  // Mr / Mrs …  (address blocks, "Dear Mr …")
  const t = text.match(new RegExp('\\b' + TITLE + '\\.?[ \\t]+((?:' + NAMEWORD + '|[A-Z]\\.?)(?:[ \\t]+(?:' + NAMEWORD + '|[A-Z]\\.?)){0,3})', 'i'));
  if (t) return titleCase(clean(t[0]));
  // Hebrew: the grant's own name written in Hebrew, if it appears
  const heb = [grant.name, ...(grant.alt || [])].find((n) => /[֐-׿]/.test(n || '') && text.includes(n));
  if (heb) return heb;
  // the grant's name appears somewhere in capitals, e.g. "S LAZAR"
  const found = findPerson(text, grant.name);
  return found || '';
}
const STOP = new Set(['ltd', 'limited', 'the', 'trust', 'charity', 'charitable', 'foundation', 'of', 'and', 'for', 'fund', 'uk', 'cio', 'association', 'society', 'inc', 'co', 'company']);
const tokens = (s) => clean(s).toLowerCase().replace(/[.'’]/g, '').split(/[\s&-]+/).filter(Boolean);
function findOrg(text, names) {
  const low = ' ' + text.toLowerCase().replace(/[^a-z0-9֐-׿]+/g, ' ') + ' ';
  for (const n of names.filter(Boolean)) {
    const key = tokens(n).filter((w) => !STOP.has(w) && w.length > 1);
    if (key.length && key.every((w) => low.includes(' ' + w + ' '))) return n;
  }
  return '';
}
function findPerson(text, name) {
  const tk = tokens(name).filter((w) => !/^(mr|mrs|miss|ms|dr|rabbi)$/.test(w));
  if (!tk.length) return '';
  const last = tk[tk.length - 1];
  const m = text.match(new RegExp('\\b((?:[A-Z][A-Za-z]*\\.?[ \\t]+){0,3})' + last.replace(/[^a-z֐-׿]/g, '') + '\\b', 'i'));
  return m && last.length > 2 ? titleCase(clean(m[0])) : '';
}
/** 'yes' | 'no' | '' (no name found) */
export function matchName(found, grantName, alt = [], kind = 'individual', text = '') {
  if (!found) return '';
  const f = tokens(found).filter((w) => !/^(mr|mrs|miss|ms|mx|dr|rabbi|rev)$/.test(w));
  const names = [grantName, ...(alt || [])].filter(Boolean);
  for (const n of names) {
    const g = tokens(n).filter((w) => !/^(mr|mrs|miss|ms|mx|dr|rabbi|rev)$/.test(w));
    if (!g.length) continue;
    if (kind === 'charity') {
      const a = g.filter((w) => !STOP.has(w)), b = new Set(f.filter((w) => !STOP.has(w)));
      if (a.length && a.filter((w) => b.has(w)).length / a.length >= 0.6) return 'yes';
      continue;
    }
    const gl = g[g.length - 1], fl = f[f.length - 1];
    const sameLast = f.includes(gl) || (fl && fl === gl);
    const firstOk = !f.length || f.length === 1 || f.some((w) => w === g[0] || (w.length === 1 && w === g[0][0]) || (g[0].length === 1 && w[0] === g[0]));
    if (sameLast && firstOk) return 'yes';
    if (n === found) return 'yes';
  }
  return 'no';
}

/* ---------- grouping by layout (same printed form = same group) ---------- */
export function signature(text) { return [...new Set(words(text).filter((w) => w.length >= 4))].slice(0, 120); }
export function group(recs) {
  const groups = [];
  for (const r of recs) {
    if (!r.sig || r.sig.length < 8) continue;
    const s = new Set(r.sig);
    let best = null, bestJ = 0;
    for (const g of groups) {
      const inter = g.rep.filter((w) => s.has(w)).length, j = inter / (g.rep.length + s.size - inter);
      if (j > bestJ) { bestJ = j; best = g; }
    }
    if (best && bestJ >= 0.3) best.items.push(r); else groups.push({ rep: r.sig, items: [r] });
  }
  for (const g of groups) {
    const count = {}; for (const r of g.items) { const c = shown(r).code; count[c] = (count[c] || 0) + 1; }
    g.code = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
  }
  groups.sort((a, b) => b.items.length - a.items.length);
  const n = {}; groups.forEach((g, i) => { g.letter = i < 26 ? String.fromCharCode(65 + i) : 'Z' + (i - 25); if (/^APP-/.test(g.code) && g.items.length > 1) { n[g.code] = (n[g.code] || 0) + 1; g.version = 'v' + n[g.code]; } });
  return groups;
}

/** Documents whose name should be the applicant's (or the charity's): only these get ✓ / ⚠. */
export const CHECKED = new Set(['UC', 'BEN', 'BS', 'POB', 'ID-P', 'ID-D', 'ID']);

/* ---------- one document ---------- */
/** grant = { id, ref, kind, name, alt }, doc = { key, title, source, url?, fileId? }, fetchBlob(doc) -> Blob */
export async function analyse(grant, doc, fetchBlob) {
  const base = { key: doc.key, grantId: grant.id, ref: grant.ref, grantName: grant.name, grantAlt: grant.alt || [], grantKind: grant.kind, title: doc.title, source: doc.source, url: doc.url || '', fileId: doc.fileId || '', at: new Date().toISOString() };
  try {
    const blob = await fetchBlob(doc);
    const wantHeb = /[֐-׿]/.test([grant.name, ...(grant.alt || [])].join(' '));
    const { text, thumb, how, pages } = await readDoc(blob, wantHeb);
    const { code, conf } = classify(text, doc);
    const name = /^(APP-|CONS)/.test(code) ? '' : extractName(code, text, grant);
    return { ...base, code, conf, name, match: CHECKED.has(code) ? matchName(name, grant.name, grant.alt, grant.kind, text) : '', how, pages, size: blob.size, type: blob.type, thumb, sig: signature(text), chars: text.length, snippet: text.replace(/\s+/g, ' ').trim().slice(0, 300) };
  } catch (e) {
    return { ...base, code: '?', conf: 'low', name: '', match: '', err: e.message === 'unsupported' ? "This kind of file can't be read" : 'Could not open: ' + (e.message || e), sig: [] };
  }
}
/** The chip shown next to a document: "UC · Mr Y Lazar ✓" */
export function chipHtml(r, esc) {
  const s = shown(r); if (!s) return '';
  const c = CODES[s.code] || CODES['?'];
  const mark = s.match === 'yes' ? '<b style="color:#1f7a4a" title="Name matches the grant">✓</b>' : s.match === 'no' ? '<b style="color:#c46a00" title="A different name from the grant">⚠</b>' : '';
  return `<span class="dchip" title="${esc(c.label)}${r.err ? ' – ' + esc(r.err) : ''}${s.edited ? ' (changed by you)' : ''}"><span class="dcode" style="background:${c.color}">${esc(s.code)}</span>${s.name ? ' ' + esc(s.name) : /^(APP-|CONS)/.test(s.code) ? '' : ' <i>name not found</i>'} ${mark}</span>`;
}
