// VoucherFlow — read-voucher (version 4: learns from checked vouchers, their layout and the corrections people made)
// Reads one charity voucher image with Claude and returns the details it can see.
// The Claude API key is stored as the Supabase secret ANTHROPIC_API_KEY and never leaves this function.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const MODELS: Record<string, string> = {
  fast: 'claude-haiku-5-5',     // first read: quick and very cheap
  strong: 'claude-sonnet-5-5',  // second try on vouchers where something is still missing
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

type Crop = { label: string; image: string }
// A voucher of the same company already checked by a person: its picture and the correct values.
type Example = { image: string; answer: Record<string, unknown> }
// A close-up from a checked voucher with what it really says (teaches this company's number shapes).
type Sample = { text: string; image: string }

// Keeps only sensible [left, top, width, height] boxes (fractions 0–1).
function cleanBoxes(b: unknown) {
  const out: Record<string, number[]> = {}
  if (!b || typeof b !== 'object') return out
  for (const k of ['voucher_number', 'account_number', 'amount', 'date']) {
    const v = (b as Record<string, unknown>)[k]
    if (!Array.isArray(v) || v.length !== 4) continue
    const n = v.map(Number)
    if (n.some((x) => !Number.isFinite(x) || x < 0 || x > 1) || n[2] <= 0 || n[3] <= 0) continue
    out[k] = n.map((x) => Math.round(x * 1000) / 1000)
  }
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    // Only signed-in, active VoucherFlow users may use this.
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return json({ error: 'Not signed in' }, 401)
    const { data: profile } = await supabase.from('profiles').select('active').eq('id', user.id).maybeSingle()
    if (!profile?.active) return json({ error: 'Account not active' }, 403)

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY secret is not set in Supabase' }, 500)

    const body = await req.json()
    const { image, media_type, companies, company, hints, model } = body
    const crops: Crop[] = Array.isArray(body.crops) ? body.crops.slice(0, 6) : []
    const examples: Example[] = Array.isArray(body.examples) ? body.examples.filter((e: Example) => e?.image).slice(0, 4) : []
    const samples: Sample[] = Array.isArray(body.samples) ? body.samples.filter((e: Sample) => e?.image).slice(0, 6) : []
    const facts = typeof body.facts === 'string' ? body.facts.slice(0, 4000) : ''
    if (!image || typeof image !== 'string') return json({ error: 'No image sent' }, 400)
    const size = image.length + [...crops, ...examples, ...samples].reduce((n, c) => n + (c.image?.length || 0), 0)
    if (size > 12_000_000) return json({ error: 'Images too large' }, 413)
    const names: string[] = Array.isArray(companies) ? companies.slice(0, 100).map(String) : []
    const modelId = MODELS[model] || MODELS.fast

    const about = company
      ? `This voucher is from ${company}.${hints ? `\nLayout notes for ${company} vouchers: ${hints}` : ''}` +
        (facts ? `\nWhat we know from ${company} vouchers already checked by people: ${facts}` : '')
      : `The company that issued it is one of: ${JSON.stringify(names)}`

    const instructions = `This is a scanned UK charity voucher (like a cheque) issued by a voucher company to a donor.
${about}
${examples.length ? `You were first shown ${examples.length} example voucher(s) from the same company with their correct readings, checked by a person. Use them to learn where each detail is and how it looks (e.g. handwriting style, number length) — but read THIS voucher's own values; never copy values from the examples.` : ''}
${samples.length ? `You were also shown close-ups from checked vouchers of the same company with what they really say — study how this company's digits and handwriting look, so you read the same shapes correctly here.` : ''}
${crops.length ? `After the full voucher you also get zoomed close-ups of parts of it (labelled) — use them to read small print.` : ''}

Reply with ONLY a JSON object, no other text:
{"company": string|null, "voucher_number": string|null, "account_number": string|null,
 "amount": number|null, "amount_words": string|null,
 "date": "YYYY-MM-DD"|null, "date_text": string|null, "date_hebrew": string|null,
 "unsure": string[],
 "boxes": {"voucher_number": [l,t,w,h], "account_number": [l,t,w,h], "amount": [l,t,w,h], "date": [l,t,w,h]}}

How to read each field:
- company: ${company ? `"${company}".` : 'chosen EXACTLY from the list above, or null if unsure.'}
- voucher_number: the voucher's own number as printed (digits only), not the barcode text.
- account_number: the donor account number exactly as printed or written, keeping leading zeros.
- amount: amounts are often HANDWRITTEN — read them. Use the figure in the £ box and check it against the amount
  written in words (e.g. "Two Pounds only" = 2). If figures and words agree, give the amount. If only one is
  readable, give that. If they clearly disagree, give null. Put the words, as written, in amount_words.
- date: the date written or printed on the voucher. It is often handwritten, and may be in the Hebrew (Jewish)
  calendar, e.g. ט"ו חשון תשפ"ז. Put the date exactly as written in date_text.
  If it is a Hebrew date: put it in date_hebrew as "day monthname year" with an English month name and full year,
  e.g. "15 Cheshvan 5787" (use Adar I / Adar II where relevant), and set date to null — it will be converted exactly.
  Otherwise give date as YYYY-MM-DD (UK order: day/month/year) and date_hebrew null.
- boxes: for each field you found, WHERE it is on the full voucher image (not the close-ups): [left, top, width, height]
  as fractions of the image width and height (0 to 1), tightly around the value itself (not its label). Leave out fields you didn't find.
- unsure: names of the fields above you could read but are NOT sure about (e.g. a digit that could be 1 or 7), else [].
- Use null for anything you cannot read. Do not invent values.`

    const content: unknown[] = []
    examples.forEach((ex, i) => {
      content.push({ type: 'text', text: `Example ${i + 1} (already checked by a person). Correct reading: ${JSON.stringify(ex.answer)}` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ex.image } })
    })
    for (const sm of samples) {
      content.push({ type: 'text', text: `Close-up from a checked voucher: ${String(sm.text || '')}` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sm.image } })
    }
    content.push(
      { type: 'text', text: examples.length || samples.length ? 'Now the voucher to read — full voucher:' : 'Full voucher:' },
      { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image } },
    )
    for (const c of crops) {
      if (!c?.image) continue
      content.push({ type: 'text', text: `Close-up: ${String(c.label || 'detail')}` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.image } })
    }
    content.push({ type: 'text', text: instructions })

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, max_tokens: 800, messages: [{ role: 'user', content }] }),
    })
    const out = await res.json()
    if (!res.ok) {
      // Busy / too many requests: tell the app to wait and try again.
      const busy = res.status === 429 || res.status === 529 || res.status >= 500
      return json({
        error: out?.error?.message || `Claude API error ${res.status}`,
        retry_after: Number(res.headers.get('retry-after')) || null,
      }, busy ? 429 : 502)
    }

    const text = (out.content || []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('')
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return json({ error: 'Could not understand the reply', raw: text }, 502)
    const f = JSON.parse(match[0])
    const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v).trim())

    return json({
      company: company || (names.includes(f.company) ? f.company : null),
      voucher_number: str(f.voucher_number)?.replace(/\s+/g, '') ?? null,
      account_number: str(f.account_number)?.replace(/\s+/g, '') ?? null,
      amount: typeof f.amount === 'number' && f.amount > 0 ? Math.round(f.amount * 100) / 100 : null,
      amount_words: str(f.amount_words),
      date: /^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? f.date : null,
      date_text: str(f.date_text),
      date_hebrew: str(f.date_hebrew),
      boxes: cleanBoxes(f.boxes),
      unsure: Array.isArray(f.unsure) ? f.unsure.map(String).slice(0, 10) : [],
      examples_used: examples.length,
      model: modelId,
    })
  } catch (e) {
    return json({ error: (e as Error).message || 'Unexpected error' }, 500)
  }
})
