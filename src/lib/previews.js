// Instant previews: a tiny copy of each voucher picture (a few KB) kept in the database
// (table voucher_previews, update 17). They arrive with the list in one request, so every
// picture appears at once for everyone; the sharp picture follows only where it's needed.
import { supabase } from './supabase.js'

const SIZE = 320 // longest side, in pixels
let tableMissing = false

// Makes the tiny preview as a data: URL (WebP where the browser can, otherwise JPEG).
export async function makePreview(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, SIZE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const webp = canvas.toDataURL('image/webp', 0.6)
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.6)
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

export async function savePreview(voucherId, batchId, data) {
  if (tableMissing || !data) return false
  const { error } = await supabase.from('voucher_previews').upsert({ voucher_id: voucherId, batch_id: batchId, data })
  if (error) {
    if (/voucher_previews/.test(error.message || '')) tableMissing = true
    return false
  }
  return true
}

// Makes and saves the preview for one voucher; returns the data URL (or null).
export async function createPreview(voucherId, batchId, blob) {
  try {
    const data = await makePreview(blob)
    return (await savePreview(voucherId, batchId, data)) ? data : null
  } catch {
    return null
  }
}

// Previews of a whole batch: { voucher_id: dataURL }.
export async function previewsForBatch(batchId) {
  if (tableMissing) return {}
  const out = {}
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('voucher_previews').select('voucher_id, data')
      .eq('batch_id', batchId).range(from, from + 999)
    if (error) { if (/voucher_previews/.test(error.message || '')) tableMissing = true; return out }
    for (const r of data || []) out[r.voucher_id] = r.data
    if (!data || data.length < 1000) return out
  }
}

// Previews of given vouchers (e.g. one page of the pool).
export async function previewsFor(ids) {
  if (tableMissing || !ids.length) return {}
  const out = {}
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('voucher_previews').select('voucher_id, data').in('voucher_id', ids.slice(i, i + 100))
    if (error) { if (/voucher_previews/.test(error.message || '')) tableMissing = true; return out }
    for (const r of data || []) out[r.voucher_id] = r.data
  }
  return out
}

export function previewsAvailable() {
  return !tableMissing
}
