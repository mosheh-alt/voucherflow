/* =====================================================================
   Toirem Grants – checks every application on the server (the form checks too,
   but the server never trusts the browser). Returns { errors } or { data }.
   ===================================================================== */

export const POSITIONS = ['Trustee', 'Secretary', 'Volunteer', 'Other'];
export const ROLES = ['Chair', 'Treasurer', 'Secretary', 'Trustee', 'Other'];
export const TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Rabbi', 'Dr'];
export const SIGNATURE_FONTS = ['Dancing Script', 'Great Vibes', 'Allura', 'Homemade Apple', 'Caveat', 'Kalam'];

const s = (v, max = 2000) => String(v == null ? '' : v).trim().slice(0, max);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export function validateApplication(input) {
  const E = {};
  const need = (k, v, msg = 'This field is required.') => { if (!v) E[k] = msg; };
  const f = input && typeof input === 'object' ? input : {};
  const registered = f.registered === true ? true : f.registered === false ? false : null;
  if (registered === null) E.registered = 'Choose whether you are a registered charity.';

  const a = f.app || {}, b = f.bank || {}, g = f.grant || {};
  const app = {
    trustee: s(a.trustee, 10), title: s(a.title, 10), first: s(a.first, 80), last: s(a.last, 80),
    position: s(a.position, 20), positionOther: s(a.positionOther, 80), same: a.same === true,
    phone: s(a.phone, 40), mobile: s(a.mobile, 40), email: s(a.email, 200),
  };
  if (!TITLES.includes(app.title)) E['app.title'] = 'Choose a title.';
  need('app.first', app.first); need('app.last', app.last);
  if (!POSITIONS.includes(app.position)) E['app.position'] = 'Choose a position.';
  if (app.position === 'Other') need('app.positionOther', app.positionOther, 'Please specify the position.');
  if (!app.same) { need('app.phone', app.phone); if (!isEmail(app.email)) E['app.email'] = 'Enter a valid email address.'; }

  const bank = { bank: s(b.bank, 100), acname: s(b.acname, 100), sort: s(b.sort, 10), acno: s(b.acno, 10) };
  need('bank.bank', bank.bank); need('bank.acname', bank.acname);
  if (!/^\d{2}-?\d{2}-?\d{2}$/.test(bank.sort)) E['bank.sort'] = 'Enter 6 digits, e.g. 40-16-15.';
  if (!/^\d{8}$/.test(bank.acno)) E['bank.acno'] = 'Enter the 8 digit account number.';

  const grant = {
    cost: Number(g.cost), annual: Number(g.annual), use: s(g.use, 5000), declare: g.declare === true,
    sign: s(g.sign, 120), date: s(g.date, 10), font: SIGNATURE_FONTS.includes(g.font) ? g.font : SIGNATURE_FONTS[0],
  };
  if (!(grant.cost > 0)) E['grant.cost'] = 'Enter the total cost.';
  if (!(grant.annual > 0)) E['grant.annual'] = 'Enter the estimated annual donations.';
  need('grant.use', grant.use);
  if (!grant.declare) E['grant.declare'] = 'Tick to agree to the declarations.';
  need('grant.sign', grant.sign, 'Type your full name to sign.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(grant.date)) E['grant.date'] = 'Choose the date you signed.';

  let data;
  if (registered) {
    const charityNumber = s(f.charityNumber, 12).replace(/\D/g, '');
    if (!/^\d{6,8}$/.test(charityNumber)) E.charityNumber = 'Enter a 6 to 8 digit charity number.';
    data = { registered: true, charityNumber, incorrect: f.incorrect === true, incorrectNote: s(f.incorrectNote), app, bank, grant };
    if (data.incorrect) need('incorrectNote', data.incorrectNote);
  } else if (registered === false) {
    const o = f.org || {};
    const org = { name: s(o.name, 200), line1: s(o.line1, 200), postcode: s(o.postcode, 10), town: s(o.town, 80), country: s(o.country, 80), phone: s(o.phone, 40), email: s(o.email, 200), website: s(o.website, 200) };
    ['name', 'line1', 'postcode', 'town', 'country', 'phone'].forEach((k) => need('org.' + k, org[k]));
    if (!isEmail(org.email)) E['org.email'] = 'Enter a valid email address.';
    const trustees = (Array.isArray(f.trustees) ? f.trustees : []).slice(0, 30).map((t) => ({ name: s(t && t.name, 120), role: s(t && t.role, 20), other: s(t && t.other, 80) }));
    if (!trustees.length) E['t0.name'] = 'Add at least one trustee.';
    trustees.forEach((t, i) => {
      need('t' + i + '.name', t.name);
      if (!ROLES.includes(t.role)) E['t' + i + '.role'] = 'Choose a role.';
      if (t.role === 'Other') need('t' + i + '.other', t.other, 'Please specify the role.');
    });
    const route = f.route === 'supplier' ? 'supplier' : 'club';
    data = { registered: false, org, trustees, route, app, bank, grant };
  }
  return Object.keys(E).length ? { errors: E } : { data };
}
