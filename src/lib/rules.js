// Barcode → company matching, rich-barcode parsing, and validity rules.
// Pure functions (no browser or database code) so they can be tested on their own.

export const NOT_VALID_REASONS = [
  'Expired at drop-off',
  'Company no longer accepted',
  'Damaged / unreadable',
  'Unsigned',
  'Wrong charity name',
  'Other',
]

// Build a RegExp from a company's pattern. Patterns are anchored to the whole barcode.
export function compilePattern(pattern) {
  if (!pattern || !pattern.trim()) return null
  let src = pattern.trim()
  if (!src.startsWith('^')) src = '^' + src
  if (!src.endsWith('$')) src = src + '$'
  try {
    return new RegExp(src)
  } catch {
    return null
  }
}

export function isValidPattern(pattern) {
  if (!pattern || !pattern.trim()) return true
  return compilePattern(pattern) !== null
}

// Convert a barcode date string to ISO yyyy-mm-dd using a format like YYMMDD.
export function parseBarcodeDate(value, format = 'YYMMDD') {
  if (!value) return null
  const digits = String(value).replace(/\D/g, '')
  const fmt = (format || 'YYMMDD').toUpperCase()
  if (digits.length !== fmt.length) return null
  const pick = (token) => {
    const i = fmt.indexOf(token)
    return i === -1 ? null : digits.slice(i, i + token.length)
  }
  let year = pick('YYYY')
  if (!year) {
    const yy = pick('YY')
    if (!yy) return null
    year = String(2000 + Number(yy))
  }
  const month = pick('MM')
  if (!month) return null
  const m = Number(month)
  if (m < 1 || m > 12) return null
  // Formats without a day (e.g. MMYY) mean "valid until the end of that month".
  const day = pick('DD') ?? String(new Date(Date.UTC(Number(year), m, 0)).getUTCDate())
  const d = Number(day)
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const iso = `${year}-${month}-${day}`
  const check = new Date(iso + 'T00:00:00Z')
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== d) return null
  return iso
}

export function parseBarcodeAmount(value, divisor = 100) {
  if (value === undefined || value === null || value === '') return null
  const s = String(value).trim()
  if (s.includes('.')) {
    const n = Number(s)
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
  }
  const n = Number(s.replace(/\D/g, ''))
  if (!Number.isFinite(n)) return null
  const div = Number(divisor) || 1
  // An amount of zero in the barcode means "amount written by hand" (open voucher).
  if (n === 0) return null
  return Math.round((n / div) * 100) / 100
}

// Find the company whose barcode pattern matches, and read any fields it holds.
// Returns { company, fields: { voucher_number, amount, donor_account, expiry_date }, prefilled }
export function interpretBarcode(barcode, companies) {
  const result = {
    company: null,
    fields: { voucher_number: barcode || null, amount: null, donor_account: null, expiry_date: null },
    prefilled: false,
  }
  if (!barcode) return result
  for (const company of companies || []) {
    if (company.active === false) continue
    const re = compilePattern(company.barcode_pattern)
    if (!re) continue
    const m = barcode.match(re)
    if (!m) continue
    result.company = company
    const g = m.groups || {}
    if (g.voucher) result.fields.voucher_number = g.voucher
    if (g.amount) result.fields.amount = parseBarcodeAmount(g.amount, company.amount_divisor)
    if (g.account) result.fields.donor_account = g.account
    if (g.expiry) result.fields.expiry_date = parseBarcodeDate(g.expiry, company.expiry_format)
    result.prefilled = Boolean(g.amount || g.account || g.expiry)
    return result
  }
  return result
}

// Decide the status after a person validates a voucher.
// receivedDate: the batch drop-off date (yyyy-mm-dd).
export function decideStatus({ company, expiry_date, receivedDate }) {
  if (company && company.accepted === false) {
    return { status: 'not_valid', reason: 'Company no longer accepted' }
  }
  if (expiry_date && receivedDate && expiry_date < receivedDate) {
    return { status: 'not_valid', reason: 'Expired at drop-off' }
  }
  return { status: 'valid', reason: null }
}

// Which fields are still missing before a voucher can be saved as valid.
export function missingFields({ voucher_number, company_id, amount }) {
  const missing = []
  if (!voucher_number) missing.push('voucher number')
  if (!company_id) missing.push('company')
  if (amount === null || amount === undefined || amount === '' || Number(amount) <= 0) missing.push('amount')
  return missing
}
