import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const configured = Boolean(url && key)
export const supabase = configured ? createClient(url, key) : null

// Supabase returns at most 1,000 rows per request; this fetches all pages.
// `build` receives a fresh query each time, e.g. () => supabase.from('vouchers').select('*')
export async function fetchAll(build, pageSize = 1000) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...data)
    if (data.length < pageSize) break
  }
  return rows
}

// Gets viewing links for stored images, 100 at a time, valid for 6 hours.
// If one group fails the others still work, so a few broken pictures never blank the whole page.
export async function signedUrls(paths, seconds = 6 * 3600) {
  const list = [...new Set(paths.filter(Boolean))]
  const map = {}
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100)
    try {
      const { data, error } = await supabase.storage.from('vouchers').createSignedUrls(part, seconds)
      if (error || !data) continue
      for (const item of data) if (item.signedUrl) map[item.path] = item.signedUrl
    } catch {
      /* skip this group */
    }
  }
  return map
}

// Makes a small copy of a voucher picture (long side 900px) so pages load quickly.
export async function makeThumbnail(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

// Stores a small copy for a voucher and returns its path (or null if that wasn't possible).
export async function storeThumbnail(batchId, blob) {
  try {
    const small = await makeThumbnail(blob)
    if (!small) return null
    const path = `${batchId}/thumbs/${crypto.randomUUID()}.jpg`
    const { error } = await supabase.storage.from('vouchers').upload(path, small, { contentType: 'image/jpeg' })
    return error ? null : path
  } catch {
    return null
  }
}
