// Searching vouchers by voucher no., account no., company, amount, status (category),
// collector reference or batch number. Several words narrow the search ("aac 18" = AAC vouchers for £18).
import { STATUS_LABELS } from './format.js'

// Extra words that pick a status, besides the status names themselves.
const STATUS_WORDS = {
  pending: ['pending', 'to do', 'todo', 'to validate'],
  valid: ['valid', 'ready'],
  post_dated: ['post-dated', 'post dated', 'postdated', 'post'],
  not_valid: ['not valid', 'invalid', 'notvalid', 'expired'],
  sent: ['sent'],
  received_success: ['received', 'success'],
  received_pending: ['received', 'pending at company'],
  rejected: ['rejected'],
  paid: ['paid'],
}

export const FILTERS = {
  '': 'All',
  pending: 'Pending',
  valid: 'Valid',
  post_dated: 'Post-dated',
  not_valid: 'Not valid',
  duplicates: 'Duplicates',
  urgent: 'Urgent',
  sent: 'Sent',
  received: 'Received',
  rejected: 'Rejected',
  paid: 'Paid',
}

// Does a voucher pass the category filter chosen in the list?
export function passesFilter(v, filter) {
  if (!filter) return true
  if (filter === 'duplicates') return Boolean(v.possible_duplicate)
  if (filter === 'urgent') return Boolean(v.urgent)
  if (filter === 'received') return ['received_success', 'received_pending'].includes(v.status)
  return v.status === filter
}

// Splits the search text into words; quoted phrases stay together; "£5" → "5".
export function searchWords(text) {
  const out = []
  const re = /"([^"]+)"|(\S+)/g
  let m
  while ((m = re.exec(String(text || '').toLowerCase()))) out.push((m[1] || m[2]).replace(/^£/, '').trim())
  return out.filter(Boolean)
}

function amountMatches(amount, word) {
  if (amount == null || !/^\d+(\.\d{1,2})?$/.test(word)) return false
  return Number(amount) === Number(word)
}

function statusMatches(status, word) {
  if (!status) return false
  if ((STATUS_LABELS[status] || '').toLowerCase().startsWith(word)) return true
  return (STATUS_WORDS[status] || []).some((w) => w.startsWith(word))
}

// True if every word of the search matches something on the voucher.
export function voucherMatches(v, text, companyById = {}) {
  const words = searchWords(text)
  if (!words.length) return true
  const company = (companyById[v.company_id]?.name || '').toLowerCase()
  const batchNo = v.batches?.batch_no ?? v.batch_no
  return words.every((w) =>
    (v.voucher_number || '').toLowerCase().includes(w) ||
    (v.donor_account || '').toLowerCase().includes(w) ||
    (v.collector_reference || '').toLowerCase().includes(w) ||
    company.includes(w) ||
    amountMatches(v.amount, w) ||
    statusMatches(v.status, w) ||
    (w.startsWith('#') && batchNo != null && String(batchNo) === w.slice(1)) ||
    (['duplicate', 'duplicates'].includes(w) && v.possible_duplicate) ||
    (w === 'urgent' && v.urgent)
  )
}

// The same search done by the database, for searching every voucher at once.
// Returns a list of PostgREST "or" filters, one per word (all must match).
export function searchFilters(text, companies = []) {
  // Batch numbers ("#12") are checked afterwards by voucherMatches.
  return searchWords(text).filter((w) => !w.startsWith('#')).map((w) => {
    const safe = w.replace(/[,()*%\\"]/g, '')
    const parts = []
    if (safe) {
      parts.push(`voucher_number.ilike."*${safe}*"`, `donor_account.ilike."*${safe}*"`, `collector_reference.ilike."*${safe}*"`)
    }
    if (/^\d+(\.\d{1,2})?$/.test(w)) parts.push(`amount.eq.${Number(w)}`)
    const companyIds = companies.filter((c) => (c.name || '').toLowerCase().includes(w)).map((c) => c.id)
    if (companyIds.length) parts.push(`company_id.in.(${companyIds.join(',')})`)
    const statuses = Object.keys(STATUS_WORDS).filter((s) => statusMatches(s, w))
    if (statuses.length) parts.push(`status.in.(${statuses.join(',')})`)
    if (w === 'duplicate' || w === 'duplicates') parts.push('possible_duplicate.is.true')
    if (w === 'urgent') parts.push('urgent.is.true')
    return parts.length ? parts.join(',') : 'voucher_number.eq.__nothing__'
  })
}
