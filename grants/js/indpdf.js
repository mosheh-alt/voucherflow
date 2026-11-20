/* The individual grant application as a PDF in the exact design of Toirem's paper form.
 * The original two pages (grants/img/individual-form.pdf) are copied unchanged, and the answers are
 * written on their lines, chosen circles filled in, and the "Office use only" table completed.
 * Answers are drawn by the browser (so Hebrew and any other script come out right) at 4x resolution.
 * Works in the office and on the public form. Needs /vendor/pdf-lib.min.js (loaded here when missing). */

const NAVY = '#2E4563', INK = '#14284a', GREY = '#7d8ca3', FILL = '#97DAE7';
const S = 4;                                  // canvas pixels per PDF point
const TEMPLATE = '/grants/img/individual-form.pdf';

export async function loadPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = '/vendor/pdf-lib.min.js'; s.onload = ok; s.onerror = () => bad(new Error('Could not load the PDF tools.')); document.head.appendChild(s); });
  return window.PDFLib;
}
let fontsReady = null;
function loadFonts(sigFontName) {
  if (!document.querySelector('link[data-indpdf]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.dataset.indpdf = '1';
    l.href = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&family=Dancing+Script:wght@600&family=Great+Vibes&family=Caveat:wght@600&family=Homemade+Apple&family=Allura&family=Kalam:wght@400&display=swap';
    document.head.appendChild(l);
  }
  const want = ['600 20px Montserrat', '500 20px Montserrat', `20px "${sigFontName}"`];
  const p = Promise.all(want.map((f) => document.fonts.load(f).catch(() => null)));
  fontsReady = Promise.race([p, new Promise((r) => setTimeout(r, 4000))]);   // never wait forever for fonts
  return fontsReady;
}

const money = (n) => (n === '' || n == null || isNaN(Number(String(n).replace(/[£,\s]/g, ''))) ? String(n || '') : '£' + Number(String(n).replace(/[£,\s]/g, '')).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Build the PDF. f = the saved form answers; meta = { ref, submitted, docs: ['Proof of bank', ...], authorised, approved }. Returns Uint8Array. */
export async function individualPdf(f, meta = {}, { office = true } = {}) {
  const PDFLib = await loadPdfLib();
  const C0 = f.confirm || {};
  await loadFonts(C0.font || 'Dancing Script');
  const tpl = await fetch(TEMPLATE).then((r) => { if (!r.ok) throw new Error('The form design file is missing (grants/img/individual-form.pdf).'); return r.arrayBuffer(); });
  const src = await PDFLib.PDFDocument.load(tpl);
  const out = await PDFLib.PDFDocument.create();
  const pages = await out.copyPages(src, [0, 1]);
  pages.forEach((p) => out.addPage(p));
  const W = pages[0].getWidth(), H = pages[0].getHeight();
  const layers = [0, 1].map(() => { const c = document.createElement('canvas'); c.width = Math.round(W * S); c.height = Math.round(H * S); const x = c.getContext('2d'); x.scale(S, S); x.textBaseline = 'alphabetic'; return { c, x }; });
  const P1 = layers[0].x, P2 = layers[1].x;

  const P = f.person || {}, F = f.family || {}, G = f.grant || {}, BK = f.bank || {}, E = f.endorser || {}, C = C0;
  const docs = meta.docs || [];
  const font = (x, size, w = 600, fam = 'Montserrat, Arial, sans-serif') => { x.font = `${w} ${size}px ${fam}`; };
  /** Write v on a line from x1 to x2 (baseline y); shrinks to fit, then shortens with … */
  const put = (x, v, x1, x2, y, { size = 9.5, min = 6, color = INK, align = 'left', w = 600, fam } = {}) => {
    v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); if (!v) return;
    let s = size; font(x, s, w, fam);
    while (x.measureText(v).width > x2 - x1 - 2 && s > min) { s -= 0.25; font(x, s, w, fam); }
    if (x.measureText(v).width > x2 - x1 - 2) { while (v.length > 1 && x.measureText(v + '…').width > x2 - x1 - 2) v = v.slice(0, -1); v += '…'; }
    x.fillStyle = color; x.textAlign = align; x.fillText(v, align === 'right' ? x2 - 1 : align === 'center' ? (x1 + x2) / 2 : x1 + 1, y); x.textAlign = 'left';
  };
  const dot = (x, cx, cy, on) => { if (!on) return; x.beginPath(); x.arc(cx, cy, 3.5, 0, Math.PI * 2); x.fillStyle = NAVY; x.fill(); };
  const circle = (x, cx, cy) => { x.beginPath(); x.arc(cx, cy, 5.5, 0, Math.PI * 2); x.fillStyle = FILL; x.fill(); x.lineWidth = 0.8; x.strokeStyle = NAVY; x.stroke(); };
  /** Split text into lines no wider than the widths given (one per line; the last repeats). */
  const wrap = (x, text, widths) => {
    const lines = []; let k = 0;
    for (const para of String(text || '').split(/\n+/)) {
      let cur = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = cur ? cur + ' ' + word : word, wmax = widths[Math.min(k, widths.length - 1)];
        if (x.measureText(t).width <= wmax || !cur) cur = t; else { lines.push(cur); k++; cur = word; }
      }
      if (cur) { lines.push(cur); k++; }
    }
    return lines;
  };

  /* ---------- page 1 ---------- */
  if (meta.ref || meta.submitted) put(P1, [meta.ref, meta.submitted ? 'Submitted ' + meta.submitted : ''].filter(Boolean).join('  ·  '), 300, 556, 70, { size: 7.5, color: GREY, align: 'right', w: 500 });
  // 1. Contact
  put(P1, P.title, 116, 142, 124); put(P1, P.first, 218, 308, 124); put(P1, P.last, 373, 548, 124);
  put(P1, P.address, 137, 258, 145.5, { min: 5.5 }); put(P1, P.town, 320, 390, 145.5); put(P1, P.postcode, 455, 548, 145.5);
  put(P1, P.phone, 126, 308, 167.5); put(P1, P.email, 346, 550, 167.5);
  // 2. Family
  [['Married', 128], ['Single', 231.8], ['Divorced', 335.8], ['Widowed', 439.5]].forEach(([m, cx]) => dot(P1, cx, 227, F.status === m));
  // 3. Children
  dot(P1, 359, 277.8, F.children === 'no'); dot(P1, 404.8, 277.8, F.children === 'yes');
  if (F.children === 'yes') put(P1, F.childrenCount, 503, 550, 281);
  // 4. Income (the paper form has three choices; a fourth is drawn the same way when chosen)
  const inc = String(F.income || '');
  dot(P1, 116.5, 375.2, /less than/i.test(inc)); dot(P1, 245.2, 375.2, /750\D+1,?000/.test(inc)); dot(P1, 356.8, 375.2, /1,?000\D+1,?500/.test(inc));
  if (/more than/i.test(inc)) { circle(P1, 456, 375.2); dot(P1, 456, 375.2, true); font(P1, 8.6, 500); P1.fillStyle = NAVY; P1.fillText('More than £1,500', 464, 378.4); }
  // 5. Benefits
  dot(P1, 96.8, 443.2, F.benefits === 'yes'); dot(P1, 298, 443.2, F.benefits === 'no');
  if (F.benefits === 'yes') put(P1, F.benefitsAmount, 193, 296, 446.5, { min: 5.5 });
  // 6. Purpose
  const pur = G.purposes || [];
  [['Living Costs', 91, 508.2], ['Wedding Expenses', 178.5, 508.2], ['Medical', 310.8, 508.2], ['Special Education', 381.5, 508.2], ['Debt Repayment', 501.8, 508.2], ['Religious Purposes', 157.5, 526]]
    .forEach(([n, cx, cy]) => dot(P1, cx, cy, pur.includes(n)));
  if (pur.includes('Other')) put(P1, G.other, 116, 550, 548.5);
  // comments: two lines on page 1, the rest continues on page 2's blank space
  font(P1, 9, 600);
  let com = wrap(P1, G.comments || '', [412, 460]);
  if (com.length > 2) com = wrap(P1, G.comments || '', [412, 340]);
  P1.fillStyle = INK; P1.textAlign = 'left';
  if (com[0]) P1.fillText(com[0], 132, 602.5);
  if (com[1]) P1.fillText(com[1], 86, 620.5);
  if (com.length > 2) { font(P1, 7.5, 700); P1.fillStyle = GREY; P1.fillText('(continued on page 2)', 86 + 345, 620.5); }
  const more = com.slice(2);
  // 7. Amount
  put(P1, money(G.amount), 356, 430, 647.5, { size: 10 });
  dot(P1, 432.8, 646.2, /one/i.test(G.frequency || '')); dot(P1, 514.8, 646.2, /ongoing/i.test(G.frequency || ''));
  // 8. Payment
  dot(P1, 337.5, 715.8, f.method === 'Prepaid card'); dot(P1, 441.2, 716.8, f.method === 'Bank transfer');
  if (f.method === 'Bank transfer') { put(P1, BK.acname, 162, 247, 742, { min: 5.5 }); put(P1, BK.sort, 302, 338, 742, { min: 6.5 }); put(P1, BK.acno, 430, 550, 742); }

  /* ---------- page 2 ---------- */
  const has = (d) => docs.includes(d);
  // a tick (provided) or a cross (not provided) in the margin before each document
  const mark = (on, x1, y) => { font(P2, on ? 10 : 8.5, 700, 'Arial, sans-serif'); P2.fillStyle = on ? '#1f7a4a' : '#b3473a'; P2.fillText(on ? '✓' : '✗', x1, y); };
  mark(has('Proof of bank'), 77, 59); mark(has('Benefits letter'), 77, 80); mark(has('ID'), 256, 81);
  put(P2, E.name, 122, 278, 141.5); put(P2, E.position, 328, 550, 141.5);
  put(P2, E.address, 136, 276, 159.5, { min: 5.5 }); put(P2, E.town, 337, 386, 159.5, { min: 6 }); put(P2, E.postcode, 442, 474, 159.5, { min: 5.5 });
  put(P2, E.phone, 89, 240, 177.5); put(P2, E.email, 279, 550, 177.5);
  put(P2, C.name, 217, 413, 439);
  put(P2, C.sign, 146, 306, 453.5, { size: 15, min: 9, w: 400, fam: `"${C.font || 'Dancing Script'}", "Brush Script MT", cursive` });
  put(P2, longDate(C.date), 339, 420, 453.5, { size: 9 });
  if (more.length) {
    font(P2, 9.5, 700); P2.fillStyle = NAVY; P2.fillText('6. Additional comments (continued from page 1)', 90, 488);
    font(P2, 9, 600); P2.fillStyle = INK;
    const lines = wrap(P2, more.join(' '), [455]);
    let y = 504; for (const l of lines) { if (y > 652) { P2.fillText('… (see the online record for the full text)', 90, y); break; } P2.fillText(l, 90, y); y += 13; }
  }
  if (office) {
    const cells = [[88.6, 206.6], [206.6, 324.7], [324.7, 440.6], [440.6, 558]];
    put(P2, meta.submitted || '', cells[0][0] + 4, cells[0][1] - 4, 735, { size: 8.5, min: 6 });
    const dl = docs.length ? `${docs.length} – ${docs.join(', ')}` : 'None';
    font(P2, 7.5, 600); const dlines = wrap(P2, dl, [cells[1][1] - cells[1][0] - 8]);
    P2.fillStyle = INK; if (dlines.length === 1) P2.fillText(dlines[0], cells[1][0] + 5, 735); else dlines.slice(0, 2).forEach((l, n) => P2.fillText(l, cells[1][0] + 5, 729 + n * 9));
    put(P2, meta.authorised ? longDate(meta.authorised) : '', cells[2][0] + 4, cells[2][1] - 4, 735, { size: 8.5, min: 6 });
    put(P2, meta.approved != null && meta.approved !== '' ? money(meta.approved) : '', cells[3][0] + 4, cells[3][1] - 4, 735, { size: 9 });
  }

  for (let n = 0; n < 2; n++) {
    const png = await new Promise((r) => layers[n].c.toBlob(r, 'image/png'));
    const img = await out.embedPng(await png.arrayBuffer());
    pages[n].drawImage(img, { x: 0, y: 0, width: W, height: H });
  }
  out.setTitle(`Individual Grant Application${meta.ref ? ' ' + meta.ref : ''}${P.first || P.last ? ' – ' + [P.first, P.last].filter(Boolean).join(' ') : ''}`);
  out.setAuthor('Toirem'); out.setCreator('Toirem Management');
  return out.save();
}
function longDate(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(d);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
