// Submissions: one send of vouchers to one company (database update 19).
import { supabase } from './supabase.js'
import { pictureUrl } from './imageUrls.js'

export const SUBMISSION_STATUS = { draft: 'Ready to send', sent: 'Sent', cancelled: 'Cancelled' }

// Creates a submission from vouchers that are ready to send (valid) for ONE company.
export async function createSubmission({ company, vouchers, userId, method }) {
  const ready = vouchers.filter((v) => v.status === 'valid' && v.company_id === company.id && !v.submission_id)
  if (!ready.length) throw new Error('None of the selected vouchers can go in a submission (they must be valid, from this company, and not already in one).')
  const total = ready.reduce((t, v) => t + Number(v.amount || 0), 0)
  const { data: sub, error } = await supabase.from('submissions').insert({
    company_id: company.id,
    method: method || company.submission_method || 'portal',
    voucher_count: ready.length,
    total: Math.round(total * 100) / 100,
    created_by: userId,
  }).select().single()
  if (error) {
    if (/submissions/.test(error.message || '')) throw new Error('Run database update 019 (submissions) in Supabase first.')
    throw error
  }
  for (let i = 0; i < ready.length; i += 200) {
    const { error: e2 } = await supabase.from('vouchers').update({ submission_id: sub.id }).in('id', ready.slice(i, i + 200).map((v) => v.id))
    if (e2) throw e2
  }
  return { submission: sub, skipped: vouchers.length - ready.length }
}

export async function loadSubmission(id) {
  const { data: sub, error } = await supabase.from('submissions').select('*').eq('id', id).single()
  if (error) throw error
  const { data: vouchers, error: e2 } = await supabase.from('vouchers')
    .select('id, batch_id, voucher_number, donor_account, amount, expiry_date, status, image_path, thumb_path, collector_reference, sent_at')
    .eq('submission_id', id).is('deleted_at', null).order('voucher_number')
  if (e2) throw e2
  return { submission: sub, vouchers: vouchers || [] }
}

// Recalculates count and total (e.g. after a voucher was taken out).
export async function refreshTotals(id) {
  const { data } = await supabase.from('vouchers').select('amount').eq('submission_id', id).is('deleted_at', null)
  const rows = data || []
  const total = Math.round(rows.reduce((t, v) => t + Number(v.amount || 0), 0) * 100) / 100
  await supabase.from('submissions').update({ voucher_count: rows.length, total }).eq('id', id)
}

export async function removeFromSubmission(submissionId, voucherId) {
  const { error } = await supabase.from('vouchers').update({ submission_id: null }).eq('id', voucherId)
  if (error) throw error
  await refreshTotals(submissionId)
}

// Marks the submission and all its vouchers as sent.
export async function markSubmissionSent(sub, { reference, method, userId, when }) {
  const stamp = when ? new Date(`${when}T12:00:00`).toISOString() : new Date().toISOString()
  const { error } = await supabase.from('vouchers').update({
    status: 'sent', sent_at: stamp, sent_method: method || sub.method, sent_reference: reference || `Submission #${sub.submission_no}`, sent_by: userId,
  }).eq('submission_id', sub.id).eq('status', 'valid')
  if (error) throw error
  const { error: e2 } = await supabase.from('submissions').update({
    status: 'sent', sent_at: stamp, sent_by: userId, reference: reference || null, method: method || sub.method,
  }).eq('id', sub.id)
  if (e2) throw e2
}

// Cancels a submission that hasn't been sent: its vouchers go back to "ready to send".
export async function cancelSubmission(sub) {
  if (sub.status === 'sent') throw new Error('This submission was already sent.')
  const { error } = await supabase.from('vouchers').update({ submission_id: null }).eq('submission_id', sub.id)
  if (error) throw error
  const { error: e2 } = await supabase.from('submissions').update({ status: 'cancelled' }).eq('id', sub.id)
  if (e2) throw e2
}

// File name for a voucher picture: its voucher number, with the picture's own extension.
function fileName(v, used) {
  const ext = (v.image_path.split('.').pop() || 'jpg').toLowerCase()
  let base = String(v.voucher_number || v.id).replace(/[^\w.-]+/g, '_')
  let name = `${base}.${ext}`
  for (let n = 2; used.has(name); n++) name = `${base}_${n}.${ext}`
  used.add(name)
  return name
}

// Saves all the submission's pictures (originals, named by voucher number) into a folder the
// person picks — ready to drag into a company's portal. Falls back to one download per picture.
export async function downloadPictures(vouchers, onProgress) {
  const used = new Set()
  const items = vouchers.map((v) => ({ v, name: fileName(v, used) }))
  let folder = null
  if (typeof window.showDirectoryPicker === 'function') {
    try { folder = await window.showDirectoryPicker({ mode: 'readwrite' }) } catch { return 0 }
  }
  let done = 0
  for (const { v, name } of items) {
    const { data: blob, error } = await supabase.storage.from('vouchers').download(v.image_path)
    if (error) throw error
    if (folder) {
      const file = await folder.getFileHandle(name, { create: true })
      const w = await file.createWritable()
      await w.write(blob)
      await w.close()
    } else {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 30000)
      await new Promise((r) => setTimeout(r, 300))
    }
    onProgress?.(++done, items.length)
  }
  return done
}

// ---------- The VoucherFlow Chrome add-on ----------
// The add-on announces itself on VoucherFlow pages; jobs and results pass through window messages.

export function addonVersion() {
  return document.documentElement.dataset.voucherflowAddon || null
}

// Everything the add-on needs to upload this submission to a portal: picture links + names.
export async function buildUploadJob(sub, company, vouchers) {
  const used = new Set()
  const files = []
  for (const v of vouchers) {
    const url = await pictureUrl(v.image_path, true)
    if (!url) throw new Error(`No link for the picture of voucher ${v.voucher_number}`)
    files.push({ name: fileName(v, used), url, voucher_number: v.voucher_number, amount: v.amount })
  }
  const total = vouchers.reduce((t, v) => t + Number(v.amount || 0), 0)
  return {
    id: sub.id,
    no: sub.submission_no,
    company: company?.name || '',
    portal: company?.portal_url || 'https://charities.achisomoch.org/vouchers-scan.php',
    count: files.length,
    total: Math.round(total * 100) / 100,
    files,
    created: new Date().toISOString(),
  }
}

export function sendJobToAddon(job) {
  window.postMessage({ source: 'voucherflow-app', type: 'upload-job', job }, window.location.origin)
}

// Calls fn(result) whenever the add-on reports an upload as done; asks for results it kept meanwhile.
export function listenForAddonResults(fn) {
  const handler = (e) => {
    if (e.source !== window || e.data?.source !== 'voucherflow-addon' || e.data.type !== 'upload-result') return
    fn(e.data.result)
  }
  window.addEventListener('message', handler)
  window.postMessage({ source: 'voucherflow-app', type: 'get-results' }, window.location.origin)
  return () => window.removeEventListener('message', handler)
}

export function confirmResultHandled(id) {
  window.postMessage({ source: 'voucherflow-app', type: 'result-handled', id }, window.location.origin)
}
