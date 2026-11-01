// VoucherFlow — read-voucher
// Reads one charity voucher image with Claude and returns the details it can see.
// The Claude API key is stored as the Supabase secret ANTHROPIC_API_KEY and never leaves this function.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const MODEL = 'claude-haiku-5-5'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
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

    const { image, media_type, companies } = await req.json()
    if (!image || typeof image !== 'string') return json({ error: 'No image sent' }, 400)
    if (image.length > 6_000_000) return json({ error: 'Image too large' }, 413)
    const names: string[] = Array.isArray(companies) ? companies.slice(0, 100).map(String) : []

    const instructions = `This is a scanned UK charity voucher (like a cheque, issued by a voucher company to a donor).
Read it and reply with ONLY a JSON object, no other text:
{"company": string|null, "voucher_number": string|null, "account_number": string|null, "date": "YYYY-MM-DD"|null, "amount": number|null}

Rules:
- company: the voucher company that issued it, chosen EXACTLY from this list, or null if unsure: ${JSON.stringify(names)}
- voucher_number: the voucher's own number as printed (digits only), not the barcode text.
- account_number: the donor account number exactly as printed, keeping leading zeros.
- date: the date written or printed on the voucher (UK day/month/year order), as YYYY-MM-DD.
- amount: the amount in pounds as a number (e.g. 18 or 2.5). Use the figure in the £ box; if only words, convert them.
- Use null for anything not clearly readable. Never guess.`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image } },
            { type: 'text', text: instructions },
          ],
        }],
      }),
    })
    const out = await res.json()
    if (!res.ok) return json({ error: out?.error?.message || `Claude API error ${res.status}` }, 502)

    const text = (out.content || []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('')
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return json({ error: 'Could not understand the reply', raw: text }, 502)
    const fields = JSON.parse(match[0])

    return json({
      company: names.includes(fields.company) ? fields.company : null,
      voucher_number: fields.voucher_number ? String(fields.voucher_number).replace(/\s+/g, '') : null,
      account_number: fields.account_number ? String(fields.account_number).replace(/\s+/g, '') : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(fields.date || '') ? fields.date : null,
      amount: typeof fields.amount === 'number' && fields.amount > 0 ? Math.round(fields.amount * 100) / 100 : null,
      model: MODEL,
    })
  } catch (e) {
    return json({ error: (e as Error).message || 'Unexpected error' }, 500)
  }
})
