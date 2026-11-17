/* =====================================================================
   Toirem Grants – the Individual Grant Application Form (as the paper form, 2026).
   Choices and checks shared by the online form (browser) and the server.
   ===================================================================== */

export const IND_TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Rabbi', 'Dr'];
export const MARITAL = ['Married', 'Single', 'Divorced', 'Widowed'];
export const INCOME = ['Less than £750', '£750 – £1,000', '£1,000 – £1,500', 'More than £1,500'];
export const PURPOSES = ['Living Costs', 'Wedding Expenses', 'Medical', 'Special Education', 'Debt Repayment', 'Religious Purposes', 'Other'];
export const FREQUENCY = ['One-off', 'Ongoing'];
export const IND_METHODS = ['Prepaid card', 'Bank transfer'];

const s = (v, n = 300) => String(v == null ? '' : v).trim().slice(0, n);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');

/**
 * Check one individual application. f = the form object, files = { proof, id, benefits } (true when given).
 * Returns { form, errors } with the form cleaned up.
 */
export function validateIndividual(f = {}, files = {}) {
  const E = {};
  const need = (k, v, m = 'This field is required.') => { if (!String(v == null ? '' : v).trim()) E[k] = m; };
  const p = f.person || {}, fam = f.family || {}, g = f.grant || {}, b = f.bank || {}, en = f.endorser || {}, c = f.confirm || {};
  const form = {
    kind: 'individual',
    person: { title: IND_TITLES.includes(p.title) ? p.title : '', first: s(p.first, 80), last: s(p.last, 80), address: s(p.address, 200), town: s(p.town, 80),
      postcode: s(p.postcode, 12).toUpperCase(), phone: s(p.phone, 30), email: s(p.email, 160) },
    family: { status: MARITAL.includes(fam.status) ? fam.status : '', children: fam.children === 'yes' ? 'yes' : fam.children === 'no' ? 'no' : '',
      childrenCount: fam.children === 'yes' ? s(fam.childrenCount, 3) : '', income: INCOME.includes(fam.income) ? fam.income : '',
      benefits: fam.benefits === 'yes' ? 'yes' : fam.benefits === 'no' ? 'no' : '', benefitsAmount: fam.benefits === 'yes' ? s(fam.benefitsAmount, 40) : '' },
    grant: { purposes: (Array.isArray(g.purposes) ? g.purposes : []).filter((x) => PURPOSES.includes(x)), other: s(g.other, 300), comments: s(g.comments, 3000),
      amount: Number(g.amount) || 0, frequency: FREQUENCY.includes(g.frequency) ? g.frequency : '' },
    method: IND_METHODS.includes(f.method) ? f.method : '',
    bank: { acname: s(b.acname, 120), sort: s(b.sort, 10), acno: s(b.acno, 12), bank: s(b.bank, 120) },
    endorser: { name: s(en.name, 120), position: s(en.position, 120), address: s(en.address, 200), town: s(en.town, 80), postcode: s(en.postcode, 12).toUpperCase(), phone: s(en.phone, 30), email: s(en.email, 160) },
    confirm: { declare: c.declare === true, name: s(c.name, 120), sign: s(c.sign, 120), date: /^\d{4}-\d{2}-\d{2}$/.test(c.date || '') ? c.date : '', font: s(c.font, 40) },
  };
  const P = form.person, F = form.family, G = form.grant, B = form.bank, N = form.endorser, C = form.confirm;
  need('person.first', P.first); need('person.last', P.last); need('person.address', P.address); need('person.town', P.town); need('person.postcode', P.postcode);
  need('person.phone', P.phone);
  if (!isEmail(P.email)) E['person.email'] = 'Enter a valid email address.';
  if (!F.status) E['family.status'] = 'Choose one.';
  if (!F.children) E['family.children'] = 'Choose one.';
  if (F.children === 'yes' && !(Number(F.childrenCount) >= 1)) E['family.childrenCount'] = 'How many children?';
  if (!F.income) E['family.income'] = 'Choose one.';
  if (!F.benefits) E['family.benefits'] = 'Choose one.';
  if (F.benefits === 'yes') need('family.benefitsAmount', F.benefitsAmount, 'How much do you receive?');
  if (!G.purposes.length) E['grant.purposes'] = 'Tick at least one.';
  if (G.purposes.includes('Other')) need('grant.other', G.other, 'Please tell us the other purpose.');
  if (!(G.amount > 0)) E['grant.amount'] = 'Enter the amount you are asking for.';
  if (!G.frequency) E['grant.frequency'] = 'Choose one-off or ongoing.';
  if (!form.method) E.method = 'Choose how you would like to receive the grant.';
  if (form.method === 'Bank transfer') {
    need('bank.acname', B.acname);
    if (!/^\d{2}-?\d{2}-?\d{2}$/.test(B.sort)) E['bank.sort'] = 'Enter 6 digits, e.g. 40-16-15.';
    if (!/^\d{8}$/.test(B.acno)) E['bank.acno'] = 'Enter the 8 digit account number.';
    if (!files.proof) E['doc.proof'] = 'Upload proof of bank.';
  }
  if (!files.id) E['doc.id'] = 'Upload your ID.';
  if (F.benefits === 'yes' && !files.benefits) E['doc.benefits'] = 'Upload your benefits letter (full UC statement).';
  need('endorser.name', N.name); need('endorser.position', N.position); need('endorser.phone', N.phone);
  if (N.email && !isEmail(N.email)) E['endorser.email'] = 'Enter a valid email address.';
  if (!C.declare) E['confirm.declare'] = 'Tick to agree to the declarations.';
  need('confirm.name', C.name, 'Please print your name.'); need('confirm.sign', C.sign, 'Type your name to sign.'); need('confirm.date', C.date, 'Choose the date.');
  return { form, errors: E };
}

export const individualName = (f) => [f.person.title, f.person.first, f.person.last].filter(Boolean).join(' ');
export const purposeText = (f) => f.grant.purposes.map((x) => (x === 'Other' ? 'Other: ' + f.grant.other : x)).join(', ');
