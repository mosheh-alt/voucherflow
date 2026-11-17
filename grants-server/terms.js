/* =====================================================================
   Toirem Grants – the wording of the grant agreement.
   The letter and clauses are plain text so they can be edited in the office:
     ## 1. USE OF THE GRANT      a heading
     1.1 The Grant must be …     a numbered clause
     - the Grant is used …       a bullet under the clause above
     any other line              a paragraph (blank lines separate paragraphs)
   {recipient} is replaced with the recipient's name.
   Used by the server (PDF, signing) and the office page.
   ===================================================================== */

export const DEFAULT_TERMS = `Dear {recipient},

On behalf of Toirem, I am pleased to confirm that the Trustees have approved the grant set out above. This letter sets out the terms on which it is made. By accepting the Grant, you agree to be bound by these terms.

## 1. USE OF THE GRANT
1.1 The Grant must be used solely for the Purpose stated above.
1.2 You confirm that all information provided to Toirem is accurate and complete, and that you are in a position to carry out the Purpose.
1.3 Payment will be made once all required documentation has been received and the Trustees are satisfied that due diligence is complete.

## 2. RECORDS AND REPORTING
2.1 You must keep all invoices, receipts, and supporting documents relating to the Grant for at least six years from the date of payment.
2.2 You must provide Toirem with a brief account of how the Grant was spent once the funds have been used if requested.

## 3. CONDITIONS
3.1 You must not assign or transfer the Grant to any other person or organisation without Toirem's prior written agreement.
3.2 You must comply with all applicable laws in carrying out the Purpose, including those relating to data protection, safeguarding, and financial crime.

## 4. REPAYMENT
4.1 Toirem may require repayment of the Grant in full or in part if:
- the Grant is used for purposes other than the Purpose;
- false or misleading information was provided in connection with the Grant;
- there is a material breach of these terms which is not remedied within 30 days of notice;
- you or your organisation become subject to a regulatory or criminal investigation connected to the Grant; or
- fraud is found to have taken place in connection with the Grant.
4.2 You must notify Toirem promptly if any of the above circumstances arise.

## 5. LIABILITY
5.1 Toirem is not liable for any consequences arising from the activities you carry out using the Grant. Our liability under this agreement is limited to the payment of the Grant.

## 6. CONFIDENTIALITY
6.1 Neither party may disclose the other's confidential information without prior written agreement, unless required by law or the information is already publicly available.

## 7. GENERAL
7.1 These terms apply from the date of signing until the Grant has been fully spent and Toirem has confirmed in writing that it is satisfied with your expenditure report.
7.2 This agreement is governed by the laws of England and Wales and represents the full terms on which this Grant is made.

To accept the Grant and agree to these terms, please sign below.

Yours sincerely`;

/**
 * Turn the text into blocks: {h} heading, {p} paragraph, {n, text, bullets[]} clause.
 * A bullet with no clause above it becomes its own list.
 */
export function parseTerms(text, recipient = '') {
  const lines = String(text || DEFAULT_TERMS).replace(/\{recipient\}/g, recipient).split(/\r?\n/);
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ p: para.join(' ') }); para = []; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    let m;
    if ((m = l.match(/^#{1,3}\s*(.+)$/))) { flush(); out.push({ h: m[1] }); continue; }
    if ((m = l.match(/^(\d+(?:\.\d+)+)\s+(.+)$/))) { flush(); out.push({ n: m[1], text: m[2], bullets: [] }); continue; }
    if ((m = l.match(/^[-•*]\s+(.+)$/))) {
      flush();
      const last = out[out.length - 1];
      if (last && last.bullets) last.bullets.push(m[1]); else out.push({ n: '', text: '', bullets: [m[1]] });
      continue;
    }
    para.push(l);
  }
  flush();
  return out;
}
