/* =====================================================================
   Toirem Compliance – read outgoing payments from bank PDF statements.
   Supports:
   • Lloyds (and Metro) "Transaction Report" PDFs from commercial online banking
   • Metro Bank "Business Bank Account Statement" PDFs
   Works on the text of a PDF downloaded from online banking (not a scan).
   ===================================================================== */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n) => String(n).padStart(2, '0');
function isoDate(s) {
  const m = String(s).trim().match(/^(\d{1,2})[ -]([A-Za-z]{3})[ -](\d{4}|\d{2})$/);
  if (!m) return '';
  const mi = MONTHS.indexOf(m[2].toUpperCase());
  return mi < 0 ? '' : (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad(mi + 1) + '-' + pad(m[1]);
}
const num = (s) => parseFloat(String(s).replace(/[£,\s]/g, ''));

/** Text lines of every page, rebuilt from the PDF's positioned text (columns kept apart by wide gaps). */
export async function pdfLines(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, w: it.width || 0, s: it.str.replace(/[\u0000-\u001F\u007F]/g, ' ') });
    }
    rows.sort((a, b) => b.y - a.y);
    let lastY = null;
    for (const r of rows) {
      // A noticeably bigger gap than normal line spacing is a blank line, as on the printed page.
      if (lastY != null && lastY - r.y > 13) lines.push('');
      lastY = r.y;
      r.items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      for (const it of r.items) {
        if (end != null) { const gap = it.x - end; out += gap > 12 ? '     ' : gap > 1.5 ? ' ' : ''; }
        out += it.s; end = it.x + it.w;
      }
      lines.push(out.replace(/\s+$/, ''));
    }
    lines.push(''); // page break acts as a blank line
  }
  return lines;
}

/** Lloyds / Metro "Transaction Report": header line, then payee, bank ref, your reference, sort code, time. */
function readTransactionReport(lines) {
  const bankLine = lines.find((l) => /^\s*Bank Name:/.test(l)) || '';
  const bank = /metro/i.test(bankLine) ? 'Metro' : 'Lloyds';
  const out = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^Debit Transactions\b/.test(l)) { section = 'out'; continue; }
    if (/^Credit Transactions\b/.test(l)) { section = 'in'; continue; }
    const m = l.match(/^(.+?)\s{2,}(\d{2}-[A-Za-z]{3}-\d{4})\s{2,}([\d,]+\.\d{2})\s{2,}(\S+)(?:\s{2,}(.+))?$/);
    if (!m || section !== 'out') continue;
    const [, type, date, amount, bankRef, yourRef = ''] = m;
    const after = [];
    for (let j = i + 1; j < lines.length && after.length < 6; j++) {
      const t = lines[j].trim();
      if (!t) { if (after.length) break; continue; }
      if (/^(.+?)\s{2,}\d{2}-[A-Za-z]{3}-\d{4}\s/.test(t) || /^Transaction and balance/.test(t)) break;
      after.push(t);
    }
    const payee = after[0] || '';
    const sortLine = after.find((t) => /^\d{6}\s+\d+$/.test(t));
    out.push({ bank, date: isoDate(date), bankRef, payee, reference: /^\d+$/.test(yourRef.trim()) ? '' : yourRef.trim(),
      sort: sortLine ? sortLine.slice(0, 6) : '', extra: [type, yourRef, ...after].join(' '), amount: num(amount) });
  }
  return { bank, payments: out };
}

const METRO_PAGE = /^(MBS\w*_|Statement number|Business Bank Account|Sort code|Your transactions|Date\s+Transaction|Balance carried|Page \d)/i;
/** Metro Bank account statement: date, "Outward Faster Payment <name>", money out, balance; then name overflow and the reference. */
function readMetroStatement(lines) {
  const out = [];
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const bf = l.match(/^Balance (?:brought|carried) forward\s+([\d,]+\.\d{2})/i);
    if (bf) { prev = num(bf[1]); continue; }
    const m = l.match(/^(\d{2} [A-Z]{3} \d{4})\s+(.+?)\s{2,}([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/);
    if (!m) continue;
    const [, date, desc, amountS, balS] = m;
    const amount = num(amountS), bal = num(balS);
    const isOut = prev != null ? Math.abs(prev - amount - bal) < 0.005 : /^(Outward|Direct Debit|Standing Order)/i.test(desc);
    prev = bal;
    if (!isOut || /charges|chgs/i.test(desc)) continue;
    // Lines under the payment: first group = rest of the name, then the reference; later groups = more reference.
    const groups = [[]];
    for (let j = i + 1; j < lines.length && j < i + 12; j++) {
      const t = lines[j].trim();
      if (/^\d{2} [A-Z]{3} \d{4}\s/.test(t) || METRO_PAGE.test(t)) break;
      if (!t) { if (groups[groups.length - 1].length) groups.push([]); continue; }
      groups[groups.length - 1].push(t);
    }
    const first = groups[0], more = groups.slice(1).flat();
    const after = [...first, ...more];
    const kind = (desc.match(/^(Outward Faster Payment|Outward SWIFT Payment|Outward Payment|Direct Debit|Standing Order|Account to Account Transfer)\s*/i) || [''])[0];
    // The last line under a Faster Payment is the reference ("NA" = none); lines before it continue the name.
    const ref = [first.length ? first[first.length - 1] : '', ...more].filter((x) => x && !/^NA$/i.test(x)).join(' · ');
    const nameMore = first.slice(0, -1);
    const payee = [desc.slice(kind.length), ...nameMore].join(' ').replace(/\s+/g, ' ').trim();
    out.push({ bank: 'Metro', date: isoDate(date), bankRef: '', payee, reference: ref,
      sort: '', extra: [desc, ...after].join(' '), amount });
  }
  return { bank: 'Metro', payments: out };
}

/**
 * Metro Bank "Interim Statement of Account": date, bank reference (FT…), signed amount (minus = out), running balance;
 * then the payment type, the recipient's name and the reference on the lines below (sometimes continued on the next page).
 */
const INTERIM_HEAD = /^(\d{2} [A-Z]{3} \d{2})\s+(\S+)\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})$/;
const INTERIM_PAGE = /^(Page \d+ of \d+|Your Transactions|Date\s+Transaction|Transaction Amount|Running Balance|Interim Statement|One Southampton|London,? WC1B|T: 0345|metrobankonline|Account Summary|Account No|Sort Code|Currency|Date :)/i;
function readMetroInterim(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(INTERIM_HEAD);
    if (!m) continue;
    const [, date, bankRef, amountS] = m;
    const amount = num(amountS);
    const after = [];
    for (let j = i + 1; j < lines.length && j < i + 25 && after.length < 6; j++) {
      const t = lines[j].trim();
      if (INTERIM_HEAD.test(t) || /^Balance at Period/i.test(t)) break;
      if (!t || INTERIM_PAGE.test(t)) continue;
      after.push(t);
    }
    if (!(amount < 0)) continue;
    const [type = '', payee = '', ...refs] = after;
    if (/charge|chgs|interest/i.test(type)) continue;
    out.push({ bank: 'Metro', date: isoDate(date), bankRef, payee, reference: refs.filter((x) => !/^NA$/i.test(x)).join(' · '),
      sort: '', extra: after.join(' '), amount: -amount });
  }
  return { bank: 'Metro', payments: out };
}

/** Outgoing payments from the lines of a bank PDF. Throws a readable error if the layout isn't recognised. */
export function readBankPdfLines(lines) {
  const text = lines.join('\n');
  if (/Transaction Report/.test(text) && /Debit Transactions|Credit Transactions/.test(text)) return readTransactionReport(lines);
  if (/Interim Statement of Account/i.test(text) || (/Transaction Amount/i.test(text) && /Running Balance/i.test(text))) return readMetroInterim(lines);
  if (/metro\s*bank/i.test(text) && /Money out/i.test(text)) return readMetroStatement(lines);
  if (lines.filter((l) => l.trim()).length < 5) throw new Error('This PDF has no readable text (it may be a scan). Download the statement from online banking instead.');
  throw new Error('This PDF is not a Lloyds Transaction Report or a Metro Bank statement layout that can be read yet. Send it to be added.');
}
