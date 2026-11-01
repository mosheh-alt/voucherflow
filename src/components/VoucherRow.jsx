import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { decideStatus, missingFields } from '../lib/rules.js'
import { useAuth } from '../auth.jsx'
import { StatusPill } from '../components.jsx'

const EDITABLE = ['pending', 'valid', 'not_valid']

function draftFrom(v) {
  return {
    voucher_number: v.voucher_number || '',
    company_id: v.company_id || '',
    amount: v.amount ?? '',
    expiry_date: v.expiry_date || '',
  }
}

function clean(d) {
  return {
    voucher_number: d.voucher_number.trim() || null,
    company_id: d.company_id || null,
    amount: d.amount === '' || d.amount === null ? null : Number(d.amount),
    expiry_date: d.expiry_date || null,
  }
}

// One voucher row on the batch page, with the data entered directly in the row.
// Leaving a box saves it; Enter (or ✓) validates the voucher and jumps to the next one.
const VoucherRow = forwardRef(function VoucherRow(
  { v, batch, companies, companyById, thumb, onZoom, onUpdated, onNext, canEdit },
  ref
) {
  const { session } = useAuth()
  const [d, setD] = useState(draftFrom(v))
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState(null)
  const numberRef = useRef(null)
  const companyRef = useRef(null)
  const amountRef = useRef(null)
  const editable = canEdit && EDITABLE.includes(v.status)

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
  }, [v.voucher_number, v.company_id, v.amount, v.expiry_date, v.updated_at])

  useImperativeHandle(ref, () => ({
    focus() {
      if (!d.voucher_number) numberRef.current?.focus()
      else if (!d.company_id) companyRef.current?.focus()
      else amountRef.current?.select()
      numberRef.current?.closest('tr')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    },
  }))

  function set(field, value) {
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
      const { status, reason } = decideStatus({
        company: companyById[values.company_id],
        expiry_date: values.expiry_date,
        receivedDate: batch.received_date,
      })
      await update({
        ...values,
        status,
        status_reason: reason,
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
    <tr className={problem ? 'row-problem' : v.status === 'pending' ? 'row-pending' : ''}>
      <td>
        {thumb
          ? <img className="thumb zoomable" src={thumb} alt="Voucher" title="Click to enlarge" onClick={() => onZoom(v)} />
          : <div className="thumb" />}
      </td>
      <td>
        {editable
          ? <input ref={numberRef} className="cell mono" value={d.voucher_number} onChange={(e) => set('voucher_number', e.target.value)} onBlur={saveField} onKeyDown={onKey} placeholder="Voucher no." />
          : <span className="mono">{v.voucher_number || '—'}</span>}
      </td>
      <td>
        {editable ? (
          <select ref={companyRef} className="cell" value={d.company_id} onChange={(e) => set('company_id', e.target.value)} onBlur={saveField} onKeyDown={onKey}>
            <option value="">— company —</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : (companyById[v.company_id]?.name || '—')}
      </td>
      <td className="num">
        {editable
          ? <input ref={amountRef} className="cell num" type="number" step="0.01" min="0" inputMode="decimal" value={d.amount} onChange={(e) => set('amount', e.target.value)} onBlur={saveField} onKeyDown={onKey} placeholder="£" />
          : (v.amount != null ? `£${Number(v.amount).toFixed(2)}` : '—')}
      </td>
      <td>
        {editable
          ? <input className="cell" type="date" value={d.expiry_date} onChange={(e) => set('expiry_date', e.target.value)} onBlur={saveField} onKeyDown={onKey} />
          : (v.expiry_date || '—')}
      </td>
      <td>
        <StatusPill status={v.status} />
        {v.status_reason && <div className="muted small">{v.status_reason}</div>}
        {problem && <div className="bad-text small">{problem}</div>}
      </td>
      <td className="flags">
        {!v.barcode_read && <span className="flag warn">No barcode</span>}
        {v.possible_duplicate && <span className="flag bad">Duplicate?</span>}
        {v.prefilled && v.status === 'pending' && <span className="flag info">Prefilled</span>}
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
