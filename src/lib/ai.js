// Reading vouchers with AI (Claude), through the Supabase function "read-voucher".
// The AI only fills boxes that are still empty; barcode data always wins, and nothing is
// validated until a person presses ✓.
import { supabase } from './supabase.js'

export async function aiEnabled() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'ai_reading').maybeSingle()
  return data?.value === true
}

export async function setAiEnabled(on) {
  const { error } = await supabase.from('app_settings').upsert({ key: 'ai_reading', value: on, updated_at: new Date().toISOString() })
  if (error) throw error
}

// Shrinks the image (long side 1500px, JPEG) so it's quick and cheap to send.
async function toJpegBase64(blob) {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  if (typeof bitmap.close === 'function') bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
}

// Asks the AI to read one voucher image. Returns its raw answer with company_id added.
export async function aiReadImage(blob, companies) {
  const active = companies.filter((c) => c.active !== false)
  const image = await toJpegBase64(blob)
  const { data, error } = await supabase.functions.invoke('read-voucher', {
    body: { image, media_type: 'image/jpeg', companies: active.map((c) => c.name) },
  })
  if (error) {
    let message = error.message
    try { message = (await error.context.json()).error || message } catch { /* keep message */ }
    throw new Error(message)
  }
  if (data?.error) throw new Error(data.error)
  const company = active.find((c) => c.name === data.company)
  return { ...data, company_id: company?.id ?? null, read_at: new Date().toISOString() }
}

// Works out which empty boxes the AI result can fill. Returns the database changes.
export function aiPatch(voucher, ai) {
  const patch = {}
  const filled = []
  if (!voucher.company_id && ai.company_id) { patch.company_id = ai.company_id; filled.push('company_id') }
  // The barcode's voucher number wins; the AI fills it only when no barcode was read.
  if (!voucher.barcode_read && !voucher.voucher_number && ai.voucher_number) {
    patch.voucher_number = ai.voucher_number; filled.push('voucher_number')
  }
  if (!voucher.donor_account && ai.account_number) { patch.donor_account = ai.account_number; filled.push('donor_account') }
  if ((voucher.amount === null || voucher.amount === undefined) && ai.amount != null) { patch.amount = ai.amount; filled.push('amount') }
  if (!voucher.expiry_date && ai.date) { patch.expiry_date = ai.date; filled.push('expiry_date') }
  patch.ai_data = { ...ai, filled }
  return patch
}

// Runs the AI over several vouchers, a few at a time.
//   items: [{ voucher, blob? }] — if blob is missing the image is downloaded from storage
//   onProgress(done, total)
export async function aiReadMany(items, companies, onProgress) {
  let done = 0
  let updated = 0
  const failures = []
  const queue = [...items]
  async function worker() {
    while (queue.length) {
      const { voucher, blob } = queue.shift()
      try {
        let image = blob
        if (!image) {
          const { data, error } = await supabase.storage.from('vouchers').download(voucher.image_path)
          if (error) throw error
          image = data
        }
        const ai = await aiReadImage(image, companies)
        const { error } = await supabase.from('vouchers').update(aiPatch(voucher, ai)).eq('id', voucher.id)
        if (error) throw error
        updated++
      } catch (e) {
        failures.push(e.message || String(e))
      }
      done++
      onProgress?.(done, items.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
  return { updated, failures }
}
