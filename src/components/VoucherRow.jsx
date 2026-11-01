import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { decideStatus, missingFields } from '../lib/rules.js'
import { date, today } from '../lib/format.js'
import { parseHebrewDate } from '../lib/hebrewDate.js'
import { useAuth } from '../auth.jsx'
import { StatusPill } from '../components.jsx'

const EDITABLE = ['pending', 'valid', 'post_dated', 'not_valid']

function draftFrom(v) {
  return {
    voucher_number: v.voucher_number || '',
    donor_account: v.donor_account || '',
    company_id: v.company_id || '',
    amount: v.amount ?? '',
    expiry_date: v.expiry_date || '',
    date_text: v.date_text || '',
  }
}

function clean(d) {
  const out = {
    voucher_number: d.voucher_number.trim() || null,
    donor_account: d.donor_account.trim() || null,
    company_id: d.company_id || null,
    amount: d.amount === '' || d.amount === null ? null : Number(d.amount),
    expiry_date: d.expiry_date || null,
  }
  // Only sent when a Hebrew (written) date is involved.
  if (d.date_text) out.date_text = d.expiry_date ? d.date_text : null
  return out
}

// One voucher row on the batch page, with the data entered directly in the row.
// Leaving a box saves it; Enter (or ✓) validates the voucher and jumps to the next one.
const VoucherRow = forwardRef(function VoucherRow(
  { v, batch, companies, companyById, thumb, expanded, onToggleImage, onUpdated, onNext, canEdit },
  ref
) {
  const { session } = useAuth()
  const [d, setD] = useState(draftFrom(v))
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState(null)
  const numberRef = useRef(null)
  const companyRef = useRef(null)
  const amountRef = useRef(null)
  const accountRef = useRef(null)
  const [suggested, setSuggested] = useState(null) // { account, from, distance }
  const [hebrewOpen, setHebrewOpen] = useState(false)
  const [hebrewText, setHebrewText] = useState('')
  const [hebrewProblem, setHebrewProblem] = useState(false)
  const editable = canEdit && EDITABLE.includes(v.status)
  // Vouchers still to do are shown large; once validated they shrink back (click to review).
  const pictureSize = v.status === 'pending'
    ? (expanded ? 'thumb-big thumb-huge' : 'thumb-big')
    : (expanded ? 'thumb-big' : '')

  // Keep the boxes in step when the voucher changes (saved, or barcode re-read),
  // without wiping anything still being typed in another box.
  const synced = useRef(draftFrom(v))
  useEffect(() => {
    const fresh = draftFrom(v)
    const prev = synced.current
    setD((x) => {
      const out = { ...x }
      for (const k of Object.keys(fresh)) if (String(x[k]) === String(prev[k])) out[k] = fresh[k]
      return out
    })
    synced.current = fresh
  }, [v.voucher_number, v.donor_account, v.company_id, v.amount, v.expiry_date, v.date_text, v.updated_at])

  useImperativeHandle(ref, () => ({
    focus() {
      if (!d.voucher_number) numberRef.current?.focus()
      else if (!d.company_id) companyRef.current?.focus()
      else if (d.amount === '' || d.amount === null) amountRef.current?.focus()
      else if (!d.donor_account) accountRef.current?.focus()
      else amountRef.current?.select()
      numberRef.current?.closest('tr')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },
  }))

  // When you start on a row with no account, suggest one from the nearest known voucher.
  async function suggestAccount() {
    if (!editable || d.donor_account || suggested === false) return
    const num = d.voucher_number.trim()
    if (!d.company_id || !/^\d+$/.test(num)) return
    const { data, error } = await supabase.rpc('suggest_account', { p_company: d.company_id, p_voucher: num, p_range: 10 })
    const s = !error && data?.[0]
    if (!s) { setSuggested(false); return }
    setSuggested({ account: s.donor_account, from: s.from_voucher, distance: s.distance })
    setD((x) => (x.donor_account ? x : { ...x, donor_account: s.donor_account }))
  }

  // Boxes the AI filled in and nobody has changed yet are shown in a different colour.
  const aiFilled = v.status === 'pending' ? (v.ai_data?.filled || []) : []
  const aiCls = (field) => (aiFilled.includes(field) && String(d[field] ?? '') === String(v[field] ?? '') ? ' ai' : '')

  // Live check of the date on the voucher, so problems show before validating.
  const dateCheck = (() => {
    if (!d.expiry_date || !EDITABLE.includes(v.status)) return null
    const r = decideStatus({ company: companyById[d.company_id], expiry_date: d.expiry_date, receivedDate: batch.received_date, today: today() })
    if (r.status === 'not_valid') return { kind: 'bad-text', text: r.reason }
    if (r.status === 'post_dated') return { kind: 'warn-text', text: r.reason }
    if (r.urgent) return { kind: 'warn-text', text: `Urgent: expires ${date(r.sendBy)}` }
    if (r.sendBy && r.sendBy !== d.expiry_date) return { kind: 'muted', text: `Valid until ${date(r.sendBy)}` }
    return null
  })()

  // A Hebrew date typed in is converted to the ordinary date; the Hebrew text is kept too.
  function applyHebrew() {
    if (!hebrewText.trim()) { setHebrewOpen(false); return }
    const r = parseHebrewDate(hebrewText)
    if (!r) { setHebrewProblem(true); return }
    setD((x) => ({ ...x, expiry_date: r.iso, date_text: r.text }))
    if (editable) update({ expiry_date: r.iso, date_text: r.text }).catch((e) => setProblem(e.message))
    setHebrewOpen(false)
    setHebrewProblem(false)
    setHebrewText('')
  }

  function set(field, value) {
    if (field === 'expiry_date') setD((x) => ({ ...x, date_text: '' }))
    if (field === 'voucher_number' || field === 'company_id') setSuggested(null)
    setD((x) => ({ ...x, [field]: value }))
    setProblem(null)
  }

  async function update(patch) {
    const { data, error } = await supabase.from('vouchers').update(patch).eq('id', v.id).select().single()
    if (error) throw error
    onUpdated(data)
    return data
  }

  // Saves whatever was typed, without changing the status.
  async function saveField() {
    if (!editable) return
    const now = clean(d)
    if (v.date_text && !d.date_text) now.date_text = null // a normal date replaced a Hebrew one
    const before = clean(draftFrom(v))
    if (JSON.stringify(now) === JSON.stringify(before)) return
    try {
      await update(now)
    } catch (e) {
      setProblem(e.message)
    }
  }

  // Validates the voucher: applies the rules and sets valid / not valid.
  async function validate(e) {
    e?.preventDefault()
    if (!editable || saving) return
    const values = clean(d)
    if (v.date_text && !d.date_text) values.date_text = null
    const missing = missingFields(values)
    if (missing.length) {
      setProblem(`Missing: ${missing.join(', ')}`)
      return
    }
    setSaving(true)
    try {
      const { count } = await supabase
        .from('vouchers')
        .select('id', { count: 'exact', head: true })
        .eq('voucher_number', values.voucher_number)
        .neq('id', v.id)
        .is('deleted_at', null)
      const { status, reason, sendBy, urgent, holdUntil } = decideStatus({
        company: companyById[values.company_id],
        expiry_date: values.expiry_date,
        receivedDate: batch.received_date,
        today: today(),
      })
      await update({
        ...values,
        status,
        status_reason: reason,
        send_by: sendBy,
        urgent,
        ...(holdUntil ? { hold_until: holdUntil } : {}),
        possible_duplicate: (count ?? 0) > 0,
        validated_by: session.user.id,
        validated_at: new Date().toISOString(),
      })
      onNext(v.id)
    } catch (err) {
      setProblem(err.message)
    } finally {
      setSaving(false)
    }
  }

  function onKey(e) {
    if (e.key === 'Enter') validate(e)
  }

  return (
    <tr onFocus={suggestAccount} className={problem ? 'row-problem' : v.status === 'pending' ? 'row-pending' : ''}>
      <td>
        {thumb
          ? <img className={`thumb zoomable ${pictureSize}`} src={thumb} alt="Voucher" loading="lazy" title={expanded ? "Click to make smaller" : "Click to enlarge"} onClick={() => onToggleImage(v.id)} />
          : <div className="thumb" />}
      </td>
      <td>
        {editable
          ? <input ref={numberRef} className={"cell mono" + aiCls("voucher_number")} value={d.voucher_number} onChange={(e) => set('voucher_number', e.target.value)} onBlur={saveField} onKeyDown={onKey} placeholder="Voucher no." />
          : <span className="mono">{v.voucher_number || '—'}</span>}
      </td>
      <td>
        {editable ? (
          <>
            <input ref={accountRef} className={`cell mono acc${aiCls("donor_account")} ${suggested && d.donor_account === suggested.account ? 'suggested' : ''}`} value={d.donor_account}
              onChange={(e) => set('donor_account', e.target.value)} onBlur={saveField} onKeyDown={onKey} placeholder="Account no." />
            {suggested && d.donor_account === suggested.account && (
              <div className="muted small" title={`From voucher ${suggested.from}`}>suggested · check it</div>
            )}
          </>
        ) : (v.donor_account || '—')}
      </td>
      <td>
        {editable ? (
          <select ref={companyRef} className={"cell" + aiCls("company_id")} value={d.company_id} onChange={(e) => set('company_id', e.target.value)} onBlur={saveField} onKeyDown={onKey}>
            <option value="">— company —</option>
            {companies.filter((c) => c.active !== false || c.id === d.company_id).map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.active === false ? ' (inactive)' : ''}</option>
            ))}
          </select>
        ) : (companyById[v.company_id]?.name || '—')}
      </td>
      <td className="num">
        {editable
          ? <input ref={amountRef} className={"cell num" + aiCls("amount")} type="number" step="0.01" min="0" inputMode="decimal" value={d.amount} onChange={(e) => set('amount', e.target.value)} onBlur={saveField} onKeyDown={onKey} placeholder="£" />
          : (v.amount != null ? `£${Number(v.amount).toFixed(2)}` : '—')}
      </td>
      <td>
        {editable
          ? (
            <>
              <div className="date-wrap">
                <input className={"cell" + aiCls("expiry_date")} type="date" value={d.expiry_date} onChange={(e) => set('expiry_date', e.target.value)} onBlur={saveField} onKeyDown={onKey} />
                <button type="button" className="btn heb-btn" title="Type a Hebrew date" onClick={() => setHebrewOpen(!hebrewOpen)}>עב</button>
              </div>
              {hebrewOpen && (
                <input className={`cell heb-input ${hebrewProblem ? 'bad' : ''}`} dir="auto" autoFocus value={hebrewText}
                  placeholder='e.g. ט"ו חשון תשפ"ז / 15 Cheshvan 5787'
                  onChange={(e) => { setHebrewText(e.target.value); setHebrewProblem(false) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyHebrew() } if (e.key === 'Escape') setHebrewOpen(false) }}
                  onBlur={() => { applyHebrew(); }} />
              )}
              {hebrewProblem && <div className="small bad-text">Couldn't read that Hebrew date</div>}
            </>
          )
          : date(v.expiry_date)}
        {d.date_text && <div className="small muted" dir="auto">{d.date_text}</div>}
        {dateCheck && <div className={`small ${dateCheck.kind}`}>{dateCheck.text}</div>}
      </td>
      <td className="status-cell">
        <StatusPill status={v.status} />
        {v.status_reason && <div className="muted small">{v.status_reason}</div>}
        <div className="flags">
          {!v.barcode_read && <span className="flag warn">No barcode</span>}
          {v.company_id && !companyById[v.company_id] && <span className="flag bad">Company not found ({String(v.company_id).slice(0, 8)})</span>}
          {v.barcode_read && !v.company_id && v.status === 'pending' && (
            <span className="flag warn" title={`Barcode read: ${v.barcode_raw}`}>Barcode not recognised: {v.barcode_raw}</span>
          )}
          {v.possible_duplicate && <span className="flag bad">Duplicate?</span>}
          {v.prefilled && v.status === 'pending' && <span className="flag info">Prefilled</span>}
          {aiFilled.length > 0 && <span className="flag ai-flag" title="Filled in by AI — please check against the picture">AI – check</span>}
          {v.urgent && v.status === 'valid' && <span className="flag bad">Urgent – send by {date(v.send_by)}</span>}
        </div>
        {problem && <div className="bad-text small">{problem}</div>}
      </td>
      <td>
        {editable && (
          <button type="button" className="btn ok-btn" disabled={saving} onClick={validate} title="Validate (Enter)">
            {saving ? '…' : '✓'}
          </button>
        )}
      </td>
    </tr>
  )
})

export default VoucherRow
