export const STATUS_LABELS = {
  pending: 'Pending',
  valid: 'Valid',
  post_dated: 'Post-dated',
  not_valid: 'Not valid',
  sent: 'Sent',
  received_success: 'Received – success',
  received_pending: 'Received – pending',
  rejected: 'Rejected',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

export const STATUS_ORDER = [
  'pending', 'valid', 'post_dated', 'not_valid', 'sent',
  'received_success', 'received_pending', 'rejected', 'paid', 'cancelled',
]

export const METHOD_LABELS = {
  physical: 'Physical drop-off',
  api: 'API',
  email: 'Email',
  portal: 'Website upload',
}

export const ROLE_LABELS = {
  admin: 'Admin',
  batch_entry: 'Batch entry',
  reconciler: 'Reconciler',
}

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })

export function money(n) {
  if (n === null || n === undefined || n === '') return '—'
  return gbp.format(Number(n))
}

export function date(d) {
  if (!d) return '—'
  const s = String(d).slice(0, 10)
  const [y, m, day] = s.split('-')
  return `${day}/${m}/${y}`
}

export function dateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
}

export function today() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

// How a collector is shown: name if known, otherwise email.
export function collectorLabel(c) {
  if (!c) return ''
  return c.name || c.email || ''
}
