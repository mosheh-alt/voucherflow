// How the AI learns from vouchers people have already checked.
//
// For each company, the app looks at its recently validated vouchers and:
//   1. picks a few as worked examples (picture + correct values), preferring ones the AI got
//      wrong before — so every correction a person makes teaches the next reading;
//   2. works out facts (voucher numbers are 7 digits, account numbers 4–5 digits, common amounts,
//      Hebrew dates…) that are given to the AI and used to check its answers;
//   3. flags answers that don't fit those facts, so they get a second, stronger reading.
import { supabase } from './supabase.js'

const VALIDATED = ['valid', 'post_dated', 'not_valid', 'sent', 'received_success', 'received_pending', 'rejected', 'paid']
const SAMPLE = 300
const MAX_EXAMPLES = 3
const CACHE_MS = 10 * 60 * 1000
const HEBREW = /[֐-׿]/

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
  const { data, error } = await supabase
    .from('vouchers')
    .select('id, voucher_number, donor_account, amount, expiry_date, date_text, ai_data, thumb_path, image_path, validated_at, created_at')
    .eq('company_id', companyId)
    .in('status', VALIDATED)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(SAMPLE)
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

  return {
    companyId,
    checked: rows.length,
    corrections: corrected.length,
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
        const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height))
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
