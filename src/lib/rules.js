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
  return pattern.split(/\r?\n/).map((p) => p.trim()).filter(Boolean).every((p) => compilePattern(p) !== null)
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

// A company can have several barcode formats: one pattern per line.
export function companyPatterns(company) {
  return String(company?.barcode_pattern || '')
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

// Amount groups: (?<pence>) is in pence, (?<tenths>) in 10p units, (?<pounds>) in pounds,
// and (?<amount>) uses the company's "amount in barcode" setting.
function amountFromGroups(g, company) {
  // A code that stands for a fixed amount (e.g. Miffal: 04 = £3), looked up in the company's amount codes.
  if (g.amountcode) {
    const v = company.amount_codes?.[g.amountcode]
    return v === undefined || v === null || v === '' ? null : Number(v)
  }
  if (g.pence) return parseBarcodeAmount(g.pence, 100)
  if (g.tenths) return parseBarcodeAmount(g.tenths, 10)
  if (g.pounds) return parseBarcodeAmount(g.pounds, 1)
  if (g.amount) return parseBarcodeAmount(g.amount, company.amount_divisor)
  return null
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
  const code = String(barcode).trim()
  for (const company of companies || []) {
    if (company.active === false) continue
    for (const pattern of companyPatterns(company)) {
      const re = compilePattern(pattern)
      if (!re) continue
      const m = code.match(re)
      if (!m) continue
      const g = m.groups || {}
      result.company = company
      // Some barcodes hold the voucher number in two parts (e.g. Miffal): (?<voucher1>…) + (?<voucher2>…)
      if (!g.voucher && g.voucher1) g.voucher = `${g.voucher1}${g.voucher2 || ''}`
      if (g.voucher) {
        // Numeric voucher numbers are stored without leading zeros (03924783 → 3924783).
        result.fields.voucher_number = /^\d+$/.test(g.voucher) ? g.voucher.replace(/^0+(?=\d)/, '') : g.voucher
      } else {
        result.fields.voucher_number = code
      }
      result.fields.amount = amountFromGroups(g, company)
      // An account of all zeros means "no account printed in the barcode".
      if (g.account && !/^0+$/.test(g.account)) result.fields.donor_account = g.account
      if (g.expiry) result.fields.expiry_date = parseBarcodeDate(g.expiry, company.expiry_format)
      result.prefilled = Boolean(
        result.fields.amount != null || result.fields.donor_account || result.fields.expiry_date
      )
      return result
    }
  }
  return result
}

// Adds whole months to a yyyy-mm-dd date (31 Aug + 6 months → 28/29 Feb).
export function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + Number(months), 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, lastDay))
  return target.toISOString().slice(0, 10)
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000)
}

// The last day a voucher can be used. For companies whose voucher date is the issue date
// (e.g. AAC: "valid for 6 months from the date"), that's the date plus the validity period.
// Only companies whose date starts a validity period (e.g. AAC: 6 months) have a last valid day.
// For all others the date is just when the voucher was written, and it doesn't expire.
export function lastValidDate(company, voucherDate) {
  if (!voucherDate) return null
  if (company && company.date_type === 'issue' && Number(company.validity_months) > 0) {
    return addMonths(voucherDate, company.validity_months)
  }
  return null
}

// Decide the status when a voucher is validated.
//   expiry_date: the date written on the voucher;  receivedDate: batch drop-off date;  today: yyyy-mm-dd
// Returns { status, reason, sendBy, urgent, daysLeft }
export function decideStatus({ company, expiry_date, receivedDate, today }) {
  if (company && company.accepted === false) {
    return { status: 'not_valid', reason: 'Company no longer accepted', sendBy: null, urgent: false }
  }
  // Post-dated: the date on the voucher is still in the future, so it can't be used yet.
  if (expiry_date && today && expiry_date > today) {
    return {
      status: 'post_dated',
      reason: `Post-dated: valid from ${expiry_date.split('-').reverse().join('/')}`,
      sendBy: lastValidDate(company, expiry_date),
      holdUntil: expiry_date,
      urgent: false,
    }
  }
  const sendBy = lastValidDate(company, expiry_date)
  if (sendBy && receivedDate && sendBy < receivedDate) {
    return { status: 'not_valid', reason: 'Expired at drop-off', sendBy, urgent: false }
  }
  if (sendBy && today && sendBy < today) {
    return { status: 'not_valid', reason: `Expired on ${sendBy.split('-').reverse().join('/')}`, sendBy, urgent: false }
  }
  const warnDays = Number(company?.urgent_days ?? 3)
  const daysLeft = sendBy && today ? daysBetween(today, sendBy) : null
  const urgent = daysLeft !== null && daysLeft <= warnDays
  return {
    status: 'valid',
    reason: urgent ? `Urgent: expires ${sendBy.split('-').reverse().join('/')} — send within 1–2 days` : null,
    sendBy,
    urgent,
    daysLeft,
  }
}

// Which fields are still missing before a voucher can be saved as valid.
export function missingFields({ voucher_number, company_id, amount }) {
  const missing = []
  if (!voucher_number) missing.push('voucher number')
  if (!company_id) missing.push('company')
  if (amount === null || amount === undefined || amount === '' || Number(amount) <= 0) missing.push('amount')
  return missing
}
