// Records what a person corrected when validating a voucher, and what kind of mistake it was,
// so the AI can be taught from it (see aiLearning.js).
import { supabase } from './supabase.js'
import { interpretBarcode, isPlaceholderBarcode } from './rules.js'

// field → [column on the voucher, key in the AI answer, key in the barcode fields]
export const FIELDS = {
  voucher_number: ['voucher_number', 'voucher_number', 'voucher_number'],
  account_number: ['donor_account', 'account_number', 'donor_account'],
  amount: ['amount', 'amount', 'amount'],
  date: ['expiry_date', 'date', 'expiry_date'],
}

const text = (v) => (v === null || v === undefined || v === '' ? null : String(v).replace(/\s+/g, ''))

function sameValue(field, a, b) {
  if (field === 'amount') return Number(a) === Number(b)
  return text(a) === text(b)
}

// Is `short` the same as `long` with one character left out?
function oneLeftOut(short, long) {
  if (long.length !== short.length + 1) return false
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true
  return false
}

// What kind of mistake: returns { kind, detail }.
export function classify(field, wrong, right, finalValues = {}) {
  const w = text(wrong)
  const r = text(right)
  if (r === null) return { kind: 'not_on_voucher', detail: null }
  // The value of another box on the voucher was read into this one.
  for (const [other, [column]] of Object.entries(FIELDS)) {
    if (other !== field && other !== 'amount' && text(finalValues[column]) === w) return { kind: 'wrong_place', detail: `read the ${other.replace('_', ' ')}` }
  }
  if (field === 'date') {
    const [y1, m1, d1] = w.split('-')
    const [y2, m2, d2] = r.split('-')
    if (y1 === y2 && m1 === d2 && d1 === m2) return { kind: 'day_month', detail: 'day and month swapped' }
    if (m1 === m2 && d1 === d2 && y1 !== y2) return { kind: 'different', detail: `year ${y1}→${y2}` }
  }
  if (field === 'amount') return { kind: 'different', detail: `£${wrong}→£${right}` }
  if (w.replace(/^0+/, '') === r.replace(/^0+/, '')) return { kind: 'leading_zero', detail: w.length < r.length ? 'leading zero dropped' : 'zero added in front' }
  if (oneLeftOut(w, r)) return { kind: 'missing_digit', detail: `a character missed (${w}→${r})` }
  if (oneLeftOut(r, w)) return { kind: 'extra_digit', detail: `an extra character (${w}→${r})` }
  if (w.length === r.length) {
    const swaps = []
    for (let i = 0; i < w.length; i++) if (w[i] !== r[i]) swaps.push(`${w[i]}→${r[i]}`)
    if (swaps.length <= 3) return { kind: 'digits', detail: swaps.join(', ') }
  }
  return { kind: 'different', detail: null }
}

// Compares what the barcode and the AI gave with what the person confirmed, and saves the differences.
//   voucher: the voucher as it was before validating (with barcode_raw, ai_data)
//   final: the confirmed values { voucher_number, donor_account, amount, expiry_date, company_id }
export async function recordCorrections(voucher, final, companies, userId) {
  try {
    const companyId = final.company_id || voucher.company_id
    if (!companyId) return
    const sources = []
    if (voucher.ai_data) sources.push(['ai', voucher.ai_data, (k) => FIELDS[k][1], voucher.ai_data.model || voucher.ai_data.second?.model || null])
    if (voucher.barcode_read && voucher.barcode_raw && !isPlaceholderBarcode(voucher.barcode_raw)) {
      const read = interpretBarcode(voucher.barcode_raw, companies.filter((c) => c.active !== false))
      if (read.company && read.company.id === companyId) sources.push(['barcode', read.fields, (k) => FIELDS[k][2], null])
    }
    const rows = []
    for (const [source, values, keyOf, model] of sources) {
      for (const field of Object.keys(FIELDS)) {
        // The barcode only counts for the fields its rule actually provides.
        if (source === 'barcode' && field !== 'voucher_number' && values[keyOf(field)] == null) continue
        const wrong = values[keyOf(field)]
        const right = final[FIELDS[field][0]]
        if (text(wrong) === null || sameValue(field, wrong, right)) continue
        const { kind, detail } = classify(field, wrong, right, final)
        rows.push({ voucher_id: voucher.id, company_id: companyId, field, source, wrong_value: text(wrong), right_value: text(right), kind, detail, model, created_by: userId })
      }
    }
    if (!rows.length) return
    // Don't record the same correction twice (e.g. a voucher validated again later).
    const { data: before } = await supabase.from('ai_corrections').select('field, source, wrong_value, right_value').eq('voucher_id', voucher.id)
    const seen = new Set((before || []).map((r) => `${r.field}|${r.source}|${r.wrong_value}|${r.right_value}`))
    const fresh = rows.filter((r) => !seen.has(`${r.field}|${r.source}|${r.wrong_value}|${r.right_value}`))
    if (fresh.length) await supabase.from('ai_corrections').insert(fresh)
  } catch {
    /* learning is a bonus: never block validation */
  }
}
