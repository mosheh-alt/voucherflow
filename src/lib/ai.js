// Reading vouchers with AI (Claude), through the Supabase function "read-voucher".
// The AI only fills boxes that are still empty; barcode data always wins, and nothing is
// validated until a person presses ✓.
import { supabase } from './supabase.js'
import { parseHebrewDate } from './hebrewDate.js'
import { combineWithAi, suggestCompany } from './companyGuess.js'

export async function aiEnabled() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'ai_reading').maybeSingle()
  return data?.value === true
}

export async function setAiEnabled(on) {
  const { error } = await supabase.from('app_settings').upsert({ key: 'ai_reading', value: on, updated_at: new Date().toISOString() })
  if (error) throw error
}

// Parts of a voucher that can be sent as zoomed close-ups: [left, top, width, height] as fractions.
export const CLOSE_UPS = {
  top_right: { label: 'Top right (usually the date)', area: [0.5, 0, 0.5, 0.42] },
  middle_left: { label: 'Middle left (amount in words)', area: [0, 0.3, 0.62, 0.42] },
  middle_right: { label: 'Middle right (amount box)', area: [0.5, 0.3, 0.5, 0.42] },
  bottom_left: { label: 'Bottom left', area: [0, 0.68, 0.5, 0.32] },
  bottom_middle: { label: 'Bottom middle (often the account no.)', area: [0.22, 0.68, 0.5, 0.32] },
  bottom_right: { label: 'Bottom right', area: [0.5, 0.68, 0.5, 0.32] },
}

async function bitmapOf(blob) {
  return createImageBitmap(blob)
}

// Draws (part of) the image onto a white canvas and returns it as base64 JPEG.
function jpeg(bitmap, area, maxWidth, maxHeight, upscale = 1) {
  const [fx, fy, fw, fh] = area
  const sx = Math.round(fx * bitmap.width)
  const sy = Math.round(fy * bitmap.height)
  const sw = Math.max(1, Math.round(fw * bitmap.width))
  const sh = Math.max(1, Math.round(fh * bitmap.height))
  const scale = Math.min(upscale, maxWidth / sw, maxHeight / sh)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
}

// Asks the AI to read one voucher image.
//   company: the company if already known (from the barcode), so its hints and close-ups are used
//   strong: use the stronger model
export async function aiReadImage(blob, companies, { company = null, strong = false } = {}) {
  const active = companies.filter((c) => c.active !== false)
  const bitmap = await bitmapOf(blob)
  let image
  const crops = []
  try {
    image = jpeg(bitmap, [0, 0, 1, 1], 2000, 2000)
    for (const key of company?.ai_crop || []) {
      const preset = CLOSE_UPS[key]
      if (preset) crops.push({ label: preset.label, image: jpeg(bitmap, preset.area, 1400, 900, 2) })
    }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
  const { data, error } = await supabase.functions.invoke('read-voucher', {
    body: {
      image,
      media_type: 'image/jpeg',
      crops,
      companies: active.map((c) => c.name),
      company: company?.name || null,
      hints: company?.ai_hints || null,
      model: strong ? 'strong' : 'fast',
    },
  })
  if (error) {
    let message = error.message
    try { message = (await error.context.json()).error || message } catch { /* keep message */ }
    throw new Error(message)
  }
  if (data?.error) throw new Error(data.error)

  // Hebrew dates are converted here with an exact calendar calculation, not by the AI.
  let date = data.date
  if (data.date_hebrew) {
    const h = parseHebrewDate(data.date_hebrew)
    date = h ? h.iso : null
  }
  const found = active.find((c) => c.name === data.company)
  return { ...data, date, company_id: found?.id ?? null, read_at: new Date().toISOString() }
}

// Works out which empty boxes the AI result can fill. Returns the database changes.
export function aiPatch(voucher, ai) {
  const patch = {}
  const filled = []
  if (!voucher.company_id && ai.company_id) { patch.company_id = ai.company_id; filled.push('company_id') }
  // The barcode's voucher number wins; the AI fills it only when the barcode gave none.
  if (!voucher.voucher_number && ai.voucher_number) {
    patch.voucher_number = ai.voucher_number; filled.push('voucher_number')
  }
  if (!voucher.donor_account && ai.account_number) { patch.donor_account = ai.account_number; filled.push('donor_account') }
  if ((voucher.amount === null || voucher.amount === undefined) && ai.amount != null) { patch.amount = ai.amount; filled.push('amount') }
  if (!voucher.expiry_date && ai.date) {
    patch.expiry_date = ai.date
    if (ai.date_hebrew) patch.date_text = ai.date_text || ai.date_hebrew
    filled.push('expiry_date')
  }
  patch.ai_data = { ...ai, filled }
  return patch
}

// After a quick first read, decide whether a second, stronger read is worthwhile.
function stillMissing(after, company) {
  if (after.company_hint?.state === 'conflict') return false // a person will choose the company
  if (!after.company_id) return true
  if (after.amount === null || after.amount === undefined) return true
  if (!after.donor_account && (company?.ai_hints || company?.ai_crop?.length)) return true
  return false
}

// Reads one voucher: quick model first, stronger model only if something important is still missing.
async function readOne(voucher, blob, companies) {
  const byId = Object.fromEntries(companies.map((c) => [c.id, c]))
  // A company only suggested by the number history is NOT told to the AI, so the AI gives
  // an independent second opinion.
  const fromHistory = voucher.company_hint?.state === 'history' && voucher.company_id === voucher.company_hint?.history?.company_id
  let company = fromHistory ? null : byId[voucher.company_id] || null
  const first = await aiReadImage(blob, companies, { company })
  let patch = aiPatch(voucher, first)
  if (fromHistory) Object.assign(patch, combineWithAi(voucher, first.company_id))
  // The AI read a voucher number the barcode didn't have: ask the number history about the company too.
  if (patch.voucher_number && !voucher.company_id) {
    const hist = await suggestCompany(patch.voucher_number)
    if (hist) {
      if (!patch.company_id) {
        patch.company_id = hist.company_id
        patch.company_hint = { state: 'history', history: hist }
      } else {
        patch.company_hint = hist.company_id === patch.company_id
          ? { state: 'agree', history: hist, ai: patch.company_id }
          : { state: 'conflict', history: hist, ai: patch.company_id }
        if (hist.company_id !== patch.company_id) patch.company_id = null
      }
    }
  }
  let after = { ...voucher, ...patch }
  company = company || (after.company_hint?.state !== 'conflict' ? byId[after.company_id] : null) || null
  if (stillMissing(after, company)) {
    try {
      const second = await aiReadImage(blob, companies, { company, strong: true })
      const patch2 = aiPatch(after, second)
      const filled = [...new Set([...(patch.ai_data.filled || []), ...(patch2.ai_data.filled || [])])]
      patch = { ...patch, ...patch2, ai_data: { ...first, second, filled } }
    } catch {
      /* keep the first read */
    }
  }
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
        const patch = await readOne(voucher, image, companies)
        const { error } = await supabase.from('vouchers').update(patch).eq('id', voucher.id)
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
