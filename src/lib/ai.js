// Reading vouchers with AI (Claude), through the Supabase function "read-voucher".
// The AI only fills boxes that are still empty; barcode data always wins, and nothing is
// validated until a person presses ✓.
import { supabase } from './supabase.js'
import { parseHebrewDate } from './hebrewDate.js'
import { combineWithAi, suggestCompany } from './companyGuess.js'
import { checkReading, companyKnowledge, exampleImages, learnedCrops, sampleImages } from './aiLearning.js'

export async function aiEnabled() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'ai_reading').maybeSingle()
  return data?.value === true
}

export async function setAiEnabled(on) {
  await setAiSetting('ai_reading', on)
}

// How the AI reads: which model reads first, and whether it learns from checked vouchers.
export async function aiSettings() {
  const { data } = await supabase.from('app_settings').select('key, value').in('key', ['ai_model', 'ai_learning'])
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]))
  return { firstModel: m.ai_model === 'strong' ? 'strong' : 'fast', learning: m.ai_learning !== false }
}

export async function setAiSetting(key, value) {
  const { error } = await supabase.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() })
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
//   knowledge: what was learned from this company's checked vouchers (examples + facts)
//   excludeIds: vouchers not to use as examples (the one being read)
export async function aiReadImage(blob, companies, { company = null, strong = false, knowledge = null, excludeIds = [] } = {}) {
  const active = companies.filter((c) => c.active !== false)
  const bitmap = await bitmapOf(blob)
  let image
  const crops = []
  try {
    image = jpeg(bitmap, [0, 0, 1, 1], 2000, 2000)
    // Close-ups of the places learned for this company first, then any the admin ticked.
    if (company && knowledge) crops.push(...learnedCrops(bitmap, knowledge))
    for (const key of company?.ai_crop || []) {
      const preset = CLOSE_UPS[key]
      if (preset && crops.length < 6) crops.push({ label: preset.label, image: jpeg(bitmap, preset.area, 1400, 900, 2) })
    }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
  const [examples, samples] = company && knowledge
    ? await Promise.all([exampleImages(knowledge, excludeIds), sampleImages(knowledge, excludeIds)])
    : [[], []]
  const { data, error } = await supabase.functions.invoke('read-voucher', {
    body: {
      examples,
      samples,
      facts: company && knowledge ? knowledge.facts : '',
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
  return { ...data, date, company_id: found?.id ?? null, examples_used: data.examples_used ?? 0, read_at: new Date().toISOString() }
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

// Boxes on the voucher that each AI field fills.
const FIELD_COLUMN = { voucher_number: 'voucher_number', account_number: 'donor_account', amount: 'amount', date: 'expiry_date' }

// The AI's final answer: the second reading's values replace the first's where it gave one.
function combine(first, second) {
  if (!second) return first
  const out = { ...first }
  for (const [k, v] of Object.entries(second)) if (v !== null && v !== undefined && v !== '') out[k] = v
  return out
}

// Reads one voucher.
//  1. First reading — with worked examples and facts from the company's checked vouchers, when the company is known.
//  2. The answer is checked against those facts (lengths, usual amounts, sensible date) and the AI's own doubts.
//  3. If something is missing or looks wrong, a second reading with the stronger model and the examples;
//     its values replace the doubtful ones.
//  4. Whatever still looks doubtful is marked on the row so a person looks closely.
async function readOne(voucher, blob, companies, settings = { firstModel: 'fast', learning: true }) {
  const byId = Object.fromEntries(companies.map((c) => [c.id, c]))
  // A company only suggested by the number history is NOT told to the AI, so the AI gives
  // an independent second opinion.
  const fromHistory = voucher.company_hint?.state === 'history' && voucher.company_id === voucher.company_hint?.history?.company_id
  let company = fromHistory ? null : byId[voucher.company_id] || null
  let knowledge = settings.learning && company ? await companyKnowledge(company.id) : null
  const firstStrong = settings.firstModel === 'strong'
  const first = await aiReadImage(blob, companies, { company, strong: firstStrong, knowledge, excludeIds: [voucher.id] })
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
  if (settings.learning && company && !knowledge) knowledge = await companyKnowledge(company.id)

  // Only fields the AI itself filled can be doubted (barcode and typed values are left alone).
  const filled = patch.ai_data.filled || []
  let problems = checkReading(first, knowledge).filter((f) => filled.includes(FIELD_COLUMN[f]))
  const learnedLate = Boolean(knowledge?.examples?.length) && !first.examples_used
  const alreadyBest = firstStrong && first.examples_used > 0
  let second = null
  if (!alreadyBest && (stillMissing(after, company) || problems.length || learnedLate)) {
    // Clear the doubtful AI values so the second reading can replace them.
    const base = { ...after }
    for (const f of problems) base[FIELD_COLUMN[f]] = voucher[FIELD_COLUMN[f]] ?? null
    try {
      second = await aiReadImage(blob, companies, { company, strong: true, knowledge, excludeIds: [voucher.id] })
      const patch2 = aiPatch(base, second)
      const filled2 = [...new Set([...filled, ...patch2.ai_data.filled])]
      patch = { ...patch, ...patch2 }
      patch.ai_data = { filled: filled2 }
      after = { ...voucher, ...patch }
      problems = checkReading(combine(first, second), knowledge).filter((f) => filled2.includes(FIELD_COLUMN[f]))
    } catch {
      /* keep the first reading */
      patch.ai_data = { filled }
    }
  }
  const final = combine(first, second)
  patch.ai_data = {
    ...final,
    company_id: first.company_id ?? final.company_id ?? null,
    filled: patch.ai_data.filled,
    problems,
    learned_from: final.examples_used || 0,
    first,
    ...(second ? { second } : {}),
  }
  return patch
}

// Tests the AI on vouchers people have already checked, without changing anything.
// Each method reads the same vouchers; the answers are compared with the confirmed values.
//   methods: [{ key, label, strong, learning }]
export async function aiTest({ company, companies, count = 10, methods, onProgress }) {
  const { data, error } = await supabase
    .from('vouchers')
    .select('id, batch_id, voucher_number, donor_account, amount, expiry_date, date_text, image_path, thumb_path')
    .eq('company_id', company.id)
    .in('status', ['valid', 'post_dated', 'not_valid', 'sent', 'received_success', 'received_pending', 'rejected', 'paid'])
    .is('deleted_at', null)
    .not('voucher_number', 'is', null)
    .order('created_at', { ascending: false })
    .limit(400)
  if (error) throw error
  const pool = [...(data || [])]
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
  const sample = pool.slice(0, count)
  if (!sample.length) throw new Error(`No checked ${company.name} vouchers to test on yet.`)
  const knowledge = methods.some((m) => m.learning) ? await companyKnowledge(company.id) : null

  const blobs = new Map()
  const total = sample.length * methods.length
  let done = 0
  const results = Object.fromEntries(methods.map((m) => [m.key, { ...m, fields: {}, mistakes: [], failed: 0 }]))
  const jobs = []
  for (const m of methods) for (const v of sample) jobs.push({ m, v })

  async function worker() {
    while (jobs.length) {
      const { m, v } = jobs.shift()
      const r = results[m.key]
      try {
        if (!blobs.has(v.id)) {
          blobs.set(v.id, supabase.storage.from('vouchers').download(v.image_path).then(({ data, error }) => { if (error) throw error; return data }))
        }
        const blob = await blobs.get(v.id)
        const ai = await aiReadImage(blob, companies, { company, strong: m.strong, knowledge: m.learning ? knowledge : null, excludeIds: [v.id] })
        const compare = [
          ['voucher_number', 'Voucher no.', ai.voucher_number, v.voucher_number, (a, b) => noZeros(a) === noZeros(b)],
          ['account_number', 'Account no.', ai.account_number, v.donor_account, (a, b) => noZeros(a) === noZeros(b)],
          ['amount', 'Amount', ai.amount, v.amount, (a, b) => Number(a) === Number(b)],
          ['date', 'Date', ai.date, v.expiry_date, (a, b) => a === b],
        ]
        for (const [key, label, got, want, same] of compare) {
          if (want === null || want === undefined || want === '') continue
          const f = (r.fields[key] = r.fields[key] || { label, right: 0, wrong: 0, blank: 0 })
          if (got === null || got === undefined || got === '') f.blank++
          else if (same(got, want)) f.right++
          else {
            f.wrong++
            r.mistakes.push({ voucherId: v.id, batchId: v.batch_id, number: v.voucher_number, field: label, got, want })
          }
        }
      } catch (e) {
        r.failed++
        r.error = e.message || String(e)
      }
      done++
      onProgress?.(done, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker))
  return { tested: sample.length, knowledge, results: Object.values(results) }
}

const noZeros = (s) => String(s ?? '').replace(/\s+/g, '').replace(/^0+/, '')

// Runs the AI over several vouchers, a few at a time.
//   items: [{ voucher, blob? }] — if blob is missing the image is downloaded from storage
//   onProgress(done, total)
export async function aiReadMany(items, companies, onProgress) {
  const settings = await aiSettings().catch(() => ({ firstModel: 'fast', learning: true }))
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
        const patch = await readOne(voucher, image, companies, settings)
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
