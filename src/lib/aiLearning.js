// How the AI learns from vouchers people have already checked.
//
// For each company, the app looks at its recently validated vouchers and:
//   1. picks a few as worked examples (picture + correct values), preferring ones the AI got
//      wrong before — so every correction a person makes teaches the next reading;
//   2. works out facts (voucher numbers are 7 digits, account numbers 4–5 digits, common amounts,
//      Hebrew dates…) that are given to the AI and used to check its answers;
//   3. flags answers that don't fit those facts, so they get a second, stronger reading;
//   4. learns WHERE each detail is on that company's voucher (from where the AI found values that
//      turned out right) and sends zoomed close-ups of exactly those places;
//   5. learns from every correction people made (ai_corrections): which digits get misread as what,
//      dropped zeros, swapped day/month, boxes mixed up… — and shows the AI close-ups of the
//      corrected values, so it learns how this company's numbers and handwriting look.
import { supabase } from './supabase.js'
import { autoLevels } from './imageTools.js'

const VALIDATED = ['valid', 'post_dated', 'not_valid', 'sent', 'received_success', 'received_pending', 'rejected', 'paid']
const SAMPLE = 300
const MAX_EXAMPLES = 2
const CACHE_MS = 10 * 60 * 1000
const HEBREW = /[֐-׿]/

export const FIELD_LABELS = { voucher_number: 'voucher number', account_number: 'account number', amount: 'amount', date: 'date' }
const FIELD_VALUE = { voucher_number: 'voucher_number', account_number: 'donor_account', amount: 'amount', date: 'expiry_date' }

const knowledgeCache = new Map() // company id → { at, promise }
const imageCache = new Map() // voucher id → promise of base64 JPEG

const digits = (s) => String(s || '').replace(/\s+/g, '')
const noZeros = (s) => digits(s).replace(/^0+/, '')

// Values that cover most vouchers (e.g. the usual lengths), or null if there is no clear pattern.
function usual(values, share = 0.9) {
  if (values.length < 5) return null
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const keep = []
  let covered = 0
  for (const [v, n] of sorted) {
    keep.push(v)
    covered += n
    if (covered / values.length >= share) break
    if (keep.length >= 3) return null // too varied to be a rule
  }
  return covered / values.length >= share ? keep : null
}

function lengthText(lengths) {
  const l = [...lengths].sort((a, b) => a - b)
  return l.length === 1 ? `${l[0]}` : `${l.slice(0, -1).join(', ')} or ${l[l.length - 1]}`
}

// Did the AI get any field wrong on this checked voucher?
export function aiWasWrong(v) {
  const ai = v.ai_data
  if (!ai) return false
  if (ai.voucher_number && v.voucher_number && noZeros(ai.voucher_number) !== noZeros(v.voucher_number)) return true
  if (ai.account_number && v.donor_account && noZeros(ai.account_number) !== noZeros(v.donor_account)) return true
  if (ai.amount != null && v.amount != null && Number(ai.amount) !== Number(v.amount)) return true
  if (ai.date && v.expiry_date && ai.date !== v.expiry_date) return true
  return false
}

// Everything learned about one company's vouchers (cached for 10 minutes).
export function companyKnowledge(companyId) {
  const hit = knowledgeCache.get(companyId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise
  const promise = buildKnowledge(companyId).catch(() => null)
  knowledgeCache.set(companyId, { at: Date.now(), promise })
  return promise
}

export function forgetKnowledge() {
  knowledgeCache.clear()
}

async function buildKnowledge(companyId) {
  const cols = 'id, voucher_number, donor_account, amount, expiry_date, date_text, ai_data, thumb_path, image_path, validated_at, created_at'
  const query = (extra) => supabase
    .from('vouchers')
    .select(cols + extra)
    .eq('company_id', companyId)
    .in('status', VALIDATED)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(SAMPLE)
  // marked_boxes = places people pointed to on the picture (database update 16); works without it too.
  let { data, error } = await query(', marked_boxes')
  if (error) ({ data, error } = await query(''))
  if (error) throw error
  const rows = data || []

  const numbers = rows.map((r) => digits(r.voucher_number)).filter((x) => /^\d+$/.test(x))
  const accounts = rows.map((r) => digits(r.donor_account)).filter(Boolean)
  const numberLengths = usual(numbers.map((x) => x.length))
  const accountLengths = usual(accounts.map((x) => x.length))
  const prefix = usual(numbers.filter((x) => x.length >= 4).map((x) => x.slice(0, 2)), 0.85)
  const accountsLeadingZero = accounts.some((a) => a.startsWith('0'))
  const amounts = rows.map((r) => r.amount).filter((a) => a != null).map(Number)
  const amountCounts = new Map()
  for (const a of amounts) amountCounts.set(a, (amountCounts.get(a) || 0) + 1)
  const commonAmounts = amounts.length >= 10
    ? [...amountCounts.entries()].filter(([, n]) => n / amounts.length >= 0.04).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([a]) => a)
    : []
  const withDate = rows.filter((r) => r.expiry_date)
  const hebrewShare = withDate.length ? withDate.filter((r) => HEBREW.test(r.date_text || '')).length / withDate.length : 0
  const accountShare = rows.length ? accounts.length / rows.length : 0

  const facts = []
  if (numberLengths) facts.push(`voucher numbers are ${lengthText(numberLengths)} digits${prefix?.length === 1 ? ` and currently start with ${prefix[0]}` : ''}`)
  if (accountLengths) facts.push(`account numbers are ${lengthText(accountLengths)} characters${accountsLeadingZero ? ' (some start with 0 — keep it)' : ''}`)
  else if (accountsLeadingZero) facts.push('some account numbers start with 0 — keep it')
  if (rows.length >= 10 && accountShare < 0.3) facts.push('most vouchers have no account number')
  if (commonAmounts.length) facts.push(`the most common amounts are ${commonAmounts.map((a) => `£${a}`).join(', ')} (other amounts do occur)`)
  if (withDate.length >= 5 && hebrewShare >= 0.2) facts.push(`${Math.round(hebrewShare * 100)}% of dates are written as Hebrew dates`)

  // Worked examples: vouchers the AI got wrong come first, then recent complete ones.
  const usable = rows.filter((r) => r.voucher_number && (r.thumb_path || r.image_path))
  const corrected = usable.filter(aiWasWrong)
  const complete = usable.filter((r) => !aiWasWrong(r) && r.amount != null && r.expiry_date)
  const hebrewOne = usable.find((r) => HEBREW.test(r.date_text || ''))
  const pool = [...corrected.slice(0, 2), ...(hebrewShare >= 0.2 && hebrewOne ? [hebrewOne] : []), ...complete, ...usable]
  const examples = []
  for (const r of pool) {
    if (!examples.some((e) => e.id === r.id)) examples.push(r)
    if (examples.length >= MAX_EXAMPLES + 2) break // a couple spare, in case one is the voucher being read
  }

  // Where each detail is: the middle of the places where the AI found values that were confirmed right.
  const layout = {}
  const layoutCount = {}
  const layoutSource = {}
  for (const field of Object.keys(FIELD_LABELS)) {
    // Places a person pointed to are certain: one is enough, and they win over the AI's own.
    const marked = rows.map((r) => r.marked_boxes?.[field]).filter(Boolean)
    if (marked.length) {
      layout[field] = [0, 1, 2, 3].map((i) => median(marked.map((b) => b[i])))
      layoutCount[field] = marked.length
      layoutSource[field] = 'marked'
      continue
    }
    const boxes = rows
      .filter((r) => r.ai_data?.boxes?.[field] && valueRight(field, r.ai_data, r))
      .map((r) => r.ai_data.boxes[field])
    layoutCount[field] = boxes.length
    layoutSource[field] = 'ai'
    if (boxes.length >= 3) {
      const med = [0, 1, 2, 3].map((i) => median(boxes.map((b) => b[i])))
      const spread = median(boxes.map((b) => Math.abs(b[0] - med[0]) + Math.abs(b[1] - med[1])))
      if (spread < 0.15) layout[field] = med // the place is consistent on this company's vouchers
    }
  }
  if (Object.keys(layout).length) {
    facts.push('where details usually are (from the top-left corner, as % of width/height): ' +
      Object.entries(layout).map(([f, b]) => `${FIELD_LABELS[f]} around ${Math.round(b[0] * 100)}% across, ${Math.round(b[1] * 100)}% down`).join('; '))
  }

  // Lessons from the corrections people made.
  const { data: corr } = await supabase
    .from('ai_corrections')
    .select('voucher_id, field, source, wrong_value, right_value, kind, detail, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(500)
  const corrections = corr || []
  const lessons = lessonsFrom(corrections.filter((c) => c.source === 'ai'))
  if (lessons.length) facts.push('LESSONS from mistakes people corrected on these vouchers: ' + lessons.join('; '))
  const barcodeMistakes = corrections.filter((c) => c.source === 'barcode')

  // Marked vouchers also make good close-up samples ("the account number here is 0123").
  const markedSamples = []
  for (const r of rows) {
    for (const [field, box] of Object.entries(r.marked_boxes || {})) {
      const value = field === 'account_number' ? r.donor_account : r[FIELD_VALUE[field]]
      if (value != null && value !== '') markedSamples.push({ voucher_id: r.id, field, box, right_value: String(value), kind: 'marked' })
    }
  }

  return {
    layout,
    layoutCount,
    layoutSource,
    markedSamples,
    lessons,
    corrections: corrections.filter((c) => c.source === 'ai'),
    barcodeMistakes,
    companyId,
    checked: rows.length,
    aiWrongVouchers: corrected.length,
    facts: facts.join('; '),
    numberLengths: numberLengths ? new Set(numberLengths) : null,
    accountLengths: accountLengths ? new Set(accountLengths) : null,
    knownAmounts: amounts.length >= 30 ? new Set(amounts) : null,
    examples,
  }
}

// The answer an example voucher should have given.
function answerOf(r) {
  const a = { voucher_number: r.voucher_number, account_number: r.donor_account || null, amount: r.amount ?? null, date: r.expiry_date || null }
  if (r.date_text) a.date_as_written = r.date_text
  return a
}

// Example pictures (small copies) as base64, ready to send — skipping the voucher being read.
export async function exampleImages(knowledge, excludeIds = []) {
  if (!knowledge?.examples?.length) return []
  const chosen = knowledge.examples.filter((r) => !excludeIds.includes(r.id)).slice(0, MAX_EXAMPLES)
  const out = await Promise.all(chosen.map(async (r) => {
    try {
      const image = await exampleImage(r)
      return image ? { image, answer: answerOf(r) } : null
    } catch {
      return null
    }
  }))
  return out.filter(Boolean)
}

function exampleImage(r) {
  if (!imageCache.has(r.id)) {
    imageCache.set(r.id, (async () => {
      const { data, error } = await supabase.storage.from('vouchers').download(r.thumb_path || r.image_path)
      if (error) throw error
      const bitmap = await createImageBitmap(data)
      try {
        const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(bitmap.width * scale)
        canvas.height = Math.round(bitmap.height * scale)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close()
      }
    })().catch((e) => { imageCache.delete(r.id); throw e }))
  }
  return imageCache.get(r.id)
}

// Checks an AI answer against what's known about the company. Returns the fields that look wrong
// (or that the AI itself said it wasn't sure about).
export function checkReading(ai, knowledge, today = new Date().toISOString().slice(0, 10)) {
  const problems = new Set((ai?.unsure || []).filter((f) => ['voucher_number', 'account_number', 'amount', 'date'].includes(f)))
  if (!ai) return []
  const num = digits(ai.voucher_number)
  if (num && knowledge?.numberLengths && !knowledge.numberLengths.has(num.length)) problems.add('voucher_number')
  if (num && !/^\d+$/.test(num)) problems.add('voucher_number')
  const acc = digits(ai.account_number)
  if (acc && knowledge?.accountLengths && !knowledge.accountLengths.has(acc.length)) problems.add('account_number')
  if (ai.amount != null && knowledge?.knownAmounts && !knowledge.knownAmounts.has(Number(ai.amount))) problems.add('amount')
  if (ai.amount != null && (ai.amount <= 0 || ai.amount > 5000)) problems.add('amount')
  if (ai.date) {
    const d = new Date(ai.date)
    const t = new Date(today)
    const days = (d - t) / 86400000
    if (Number.isNaN(days) || days > 370 || days < -730) problems.add('date')
  }
  return [...problems]
}

export const PROBLEM_LABELS = {
  voucher_number: 'voucher no.',
  account_number: 'account no.',
  amount: 'amount',
  date: 'date',
}

function median(list) {
  const a = [...list].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function valueRight(field, ai, r) {
  const got = field === 'account_number' ? ai.account_number : ai[field]
  const want = r[FIELD_VALUE[field]]
  if (got == null || want == null) return false
  if (field === 'amount') return Number(got) === Number(want)
  return noZeros(got) === noZeros(want)
}

// Turns the corrections into short lessons for the AI (only patterns seen at least twice).
export function lessonsFrom(corrections) {
  const out = []
  const count = (pred) => corrections.filter(pred).length
  // Misread characters: "1→4" means the AI read 1 where it was really 4.
  const pairs = new Map()
  for (const c of corrections) {
    if (c.kind !== 'digits' || !c.detail) continue
    for (const p of c.detail.split(', ')) pairs.set(p, (pairs.get(p) || 0) + 1)
  }
  for (const [p, n] of [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    if (n < 2) break
    const [a, b] = p.split('→')
    out.push(`in this company's writing/font a character that looks like "${a}" was really "${b}" ${n} times — look closely before reading "${a}"`)
  }
  for (const f of Object.keys(FIELD_LABELS)) {
    const label = FIELD_LABELS[f]
    const lz = count((c) => c.field === f && c.kind === 'leading_zero')
    if (lz >= 2) out.push(`the ${label} keeps its leading zero(s) — dropped ${lz} times`)
    const miss = count((c) => c.field === f && c.kind === 'missing_digit')
    if (miss >= 2) out.push(`a character of the ${label} was missed ${miss} times — count every digit`)
    const extra = count((c) => c.field === f && c.kind === 'extra_digit')
    if (extra >= 2) out.push(`an extra character was added to the ${label} ${extra} times`)
    const none = count((c) => c.field === f && c.kind === 'not_on_voucher')
    if (none >= 2) out.push(`a ${label} was given ${none} times when the voucher had none — give null if it isn't there`)
    const places = corrections.filter((c) => c.field === f && c.kind === 'wrong_place')
    if (places.length >= 2) out.push(`the ${label} was mixed up with another box ${places.length} times (${places[0].detail}) — take it only from its own place`)
  }
  for (const f of Object.keys(FIELD_LABELS)) {
    const missed = count((c) => c.field === f && c.kind === 'missed')
    if (missed >= 2) out.push(`the ${FIELD_LABELS[f]} was left blank ${missed} times although it was on the voucher — look for it carefully${f === 'date' ? ' (it may be handwritten or a Hebrew date)' : ''}`)
  }
  const mixups = corrections.filter((c) => c.kind === 'company')
  if (mixups.length >= 2) {
    const names = [...new Set(mixups.map((c) => c.wrong_value))].slice(0, 3).join(', ')
    out.push(`these vouchers were mistaken for ${names} ${mixups.length} times — check the company name and logo`)
  }
  const dm = count((c) => c.kind === 'day_month')
  if (dm >= 2) out.push(`day and month were swapped ${dm} times — dates are written day/month/year`)
  const amounts = corrections.filter((c) => c.field === 'amount' && c.kind === 'different')
  if (amounts.length >= 2) {
    out.push(`amounts were misread ${amounts.length} times (e.g. ${amounts.slice(0, 3).map((c) => `£${c.wrong_value} instead of £${c.right_value}`).join(', ')}) — check figures against the words`)
  }
  return out
}

// Close-ups of values people corrected, cut from those checked vouchers at full resolution,
// so the AI sees how this company's digits and handwriting really look.
const sampleCache = new Map()
export async function sampleImages(knowledge, excludeIds = [], max = 2) {
  const pool = [...(knowledge?.corrections || []), ...(knowledge?.markedSamples || [])]
  if (!pool.length) return []
  const picks = []
  for (const c of pool) {
    if (excludeIds.includes(c.voucher_id) || !c.right_value) continue
    if (!['voucher_number', 'account_number', 'date', 'amount'].includes(c.field)) continue
    if (picks.some((p) => p.voucher_id === c.voucher_id || (p.field === c.field && p.right_value === c.right_value))) continue
    picks.push(c)
    if (picks.length >= max) break
  }
  const out = await Promise.all(picks.map(async (c) => {
    try {
      const image = await sampleImage(c, knowledge.layout)
      if (!image) return null
      const right = c.field === 'amount' ? `£${c.right_value}` : `"${c.right_value}"`
      const wrong = c.field === 'amount' ? `£${c.wrong_value}` : `"${c.wrong_value}"`
      const why = c.kind === 'marked' ? 'a person marked exactly where it is'
        : c.kind === 'missed' || !c.wrong_value ? 'it was once missed — this is where to find it'
          : `it was once misread as ${wrong}`
      return { image, text: `the ${FIELD_LABELS[c.field]} here is ${right} (${why})` }
    } catch {
      return null
    }
  }))
  return out.filter(Boolean)
}

function sampleImage(c, layout) {
  const key = `${c.voucher_id}|${c.field}`
  if (!sampleCache.has(key)) {
    sampleCache.set(key, (async () => {
      let { data: v, error: colErr } = await supabase.from('vouchers').select('image_path, ai_data, marked_boxes').eq('id', c.voucher_id).maybeSingle()
      if (colErr) ({ data: v } = await supabase.from('vouchers').select('image_path, ai_data').eq('id', c.voucher_id).maybeSingle())
      const box = c.box || v?.marked_boxes?.[c.field] || v?.ai_data?.boxes?.[c.field] || layout?.[c.field]
      if (!v?.image_path || !box) return null
      const { data, error } = await supabase.storage.from('vouchers').download(v.image_path)
      if (error) throw error
      const bitmap = await createImageBitmap(data)
      try {
        return cropJpeg(bitmap, padBox(box, c.box || v?.marked_boxes?.[c.field] ? 0.25 : 0.6), 700)
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close()
      }
    })().catch((e) => { sampleCache.delete(key); throw e }))
  }
  return sampleCache.get(key)
}

// Makes a box bigger on every side (the AI's boxes are approximate), staying inside the picture.
export function padBox([l, t, w, h], pad = 0.5) {
  const pw = Math.max(w * pad, 0.04)
  const ph = Math.max(h * pad, 0.04)
  const left = Math.max(0, l - pw)
  const top = Math.max(0, t - ph)
  return [left, top, Math.min(1, l + w + pw) - left, Math.min(1, t + h + ph) - top]
}

// Cuts part of a picture out, enlarged, as base64 JPEG.
export function cropJpeg(bitmap, [fx, fy, fw, fh], minWidth = 900) {
  const sx = Math.round(fx * bitmap.width)
  const sy = Math.round(fy * bitmap.height)
  const sw = Math.max(1, Math.round(fw * bitmap.width))
  const sh = Math.max(1, Math.round(fh * bitmap.height))
  const scale = Math.min(3, Math.max(1, minWidth / sw), 1600 / sw, 1200 / sh)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  autoLevels(ctx, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
}

// Close-ups of the voucher being read, at the places learned for this company.
export function learnedCrops(bitmap, knowledge) {
  const out = []
  for (const [field, box] of Object.entries(knowledge?.layout || {})) {
    if (out.length >= 3) break
    out.push({ label: `where the ${FIELD_LABELS[field]} usually is on this company's vouchers`, image: cropJpeg(bitmap, padBox(box, 0.6), 800) })
  }
  return out
}

// Which companies' vouchers get mistaken for which (from corrections), for reading a voucher
// whose company isn't known yet. Cached for 10 minutes.
let confusionCache = null
export function companyConfusions() {
  if (confusionCache && Date.now() - confusionCache.at < CACHE_MS) return confusionCache.promise
  const promise = (async () => {
    const { data } = await supabase.from('ai_corrections').select('wrong_value, right_value')
      .eq('field', 'company').eq('source', 'ai').order('created_at', { ascending: false }).limit(500)
    const counts = new Map()
    for (const c of data || []) {
      const k = `${c.right_value}|${c.wrong_value}`
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n]) => { const [right, wrong] = k.split('|'); return `${right} vouchers were read as ${wrong} ${n} times` })
      .join('; ')
  })().catch(() => '')
  confusionCache = { at: Date.now(), promise }
  return promise
}
