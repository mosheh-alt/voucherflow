import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase, fetchAll, signedUrls } from '../lib/supabase.js'
import { NOT_VALID_REASONS, decideStatus, interpretBarcode, missingFields } from '../lib/rules.js'
import { collectorLabel, date, dateTime, money } from '../lib/format.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, StatusPill } from '../components.jsx'

const EDITABLE = ['pending', 'valid', 'not_valid']

function formFrom(v) {
  return {
    voucher_number: v.voucher_number || '',
    company_id: v.company_id || '',
    amount: v.amount ?? '',
    donor_account: v.donor_account || '',
    expiry_date: v.expiry_date || '',
  }
}

export default function Validate() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { session } = useAuth()
  const [batch, setBatch] = useState(null)
  const [vouchers, setVouchers] = useState([])
  const [companies, setCompanies] = useState([])
  const [imageUrl, setImageUrl] = useState(null)
  const [zoom, setZoom] = useState(false)
  const [form, setForm] = useState(null)
  const [error, setError] = useState(null)
  const [warning, setWarning] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState(NOT_VALID_REASONS[0])
  const [history, setHistory] = useState([])
  const [suggestion, setSuggestion] = useState(null) // { account, from, distance }
  const amountRef = useRef(null)
  const numberRef = useRef(null)
  const companyRef = useRef(null)

  useEffect(() => {
    async function load() {
      try {
        const { data: b, error: be } = await supabase.from('batches').select('*, collectors(name, email)').eq('id', id).single()
        if (be) throw be
        setBatch(b)
        const rows = await fetchAll(() =>
          supabase.from('vouchers').select('*').eq('batch_id', id).is('deleted_at', null).order('created_at')
        )
        setVouchers(rows)
        const { data: cs } = await supabase.from('companies').select('*').eq('active', true).order('name')
        setCompanies(cs || [])
      } catch (e) {
        setError(e)
      }
    }
    load()
  }, [id])

  const currentId = params.get('v') || vouchers.find((v) => v.status === 'pending')?.id || vouchers[0]?.id
  const index = vouchers.findIndex((v) => v.id === currentId)
  const current = index >= 0 ? vouchers[index] : null
  const companyById = useMemo(() => Object.fromEntries(companies.map((c) => [c.id, c])), [companies])

  const pendingCount = vouchers.filter((v) => v.status === 'pending').length
  const done = vouchers.length - pendingCount
  const validTotal = vouchers
    .filter((v) => !['pending', 'not_valid', 'cancelled'].includes(v.status))
    .reduce((s, v) => s + Number(v.amount || 0), 0)

  // Load the image, form and history whenever the voucher changes.
  useEffect(() => {
    if (!current) return
    setForm(formFrom(current))
    setSuggestion(null)
    setError(null)
    setRejecting(false)
    setZoom(false)
    setImageUrl(null)
    signedUrls([current.image_path]).then((m) => setImageUrl(m[current.image_path] || null))
    supabase
      .from('voucher_history')
      .select('changed_at, action, changed_by')
      .eq('voucher_id', current.id)
      .order('changed_at', { ascending: false })
      .limit(8)
      .then(({ data }) => setHistory(data || []))
    // Put the cursor where work is needed first.
    setTimeout(() => {
      if (!current.voucher_number) numberRef.current?.focus()
      else if (!current.company_id) companyRef.current?.focus()
      else amountRef.current?.select()
    }, 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  function go(voucherId) {
    if (voucherId) setParams({ v: voucherId })
  }

  function nextPendingAfter(list, fromIndex) {
    for (let k = 1; k <= list.length; k++) {
      const v = list[(fromIndex + k) % list.length]
      if (v.status === 'pending') return v.id
    }
    return null
  }

  // Suggest the donor account from the nearest known voucher of the same company.
  const formCompany = form?.company_id
  const formNumber = form?.voucher_number
  useEffect(() => {
    if (!form || !current || !EDITABLE.includes(current.status)) return
    const num = (formNumber || '').trim()
    const fromSuggestion = suggestion && form.donor_account === suggestion.account
    if (form.donor_account && !fromSuggestion) return // a person typed or saved an account: leave it
    if (!formCompany || !/^\d+$/.test(num)) return
    let cancelled = false
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('suggest_account', { p_company: formCompany, p_voucher: num, p_range: 10 })
      if (cancelled || error) return
      const s = data?.[0]
      if (s) {
        setSuggestion({ account: s.donor_account, from: s.from_voucher, distance: s.distance })
        setForm((f) => ({ ...f, donor_account: s.donor_account }))
      } else if (fromSuggestion) {
        setSuggestion(null)
        setForm((f) => ({ ...f, donor_account: '' }))
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formCompany, formNumber, current?.id])

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  // If someone types a barcode-style number for a rich-barcode company, fill the fields from it.
  function onNumberBlur() {
    if (!form.voucher_number || form.voucher_number === current.voucher_number) return
    const { company, fields } = interpretBarcode(form.voucher_number, companies)
    if (company) {
      setForm((f) => ({
        ...f,
        voucher_number: fields.voucher_number || f.voucher_number,
        company_id: f.company_id || company.id,
        amount: f.amount === '' && fields.amount != null ? fields.amount : f.amount,
        donor_account: f.donor_account || fields.donor_account || '',
        expiry_date: f.expiry_date || fields.expiry_date || '',
      }))
    }
  }

  async function checkDuplicate(number) {
    if (!number) return false
    const { count } = await supabase
      .from('vouchers')
      .select('id', { count: 'exact', head: true })
      .eq('voucher_number', number)
      .neq('id', current.id)
      .is('deleted_at', null)
    return (count ?? 0) > 0
  }

  async function save(patch) {
    setBusy(true)
    setError(null)
    try {
      const { data, error } = await supabase
        .from('vouchers')
        .update({ ...patch, validated_by: session.user.id, validated_at: new Date().toISOString() })
        .eq('id', current.id)
        .select()
        .single()
      if (error) throw error
      const list = vouchers.map((v) => (v.id === data.id ? data : v))
      setVouchers(list)
      const next = nextPendingAfter(list, index)
      if (next) go(next)
      else navigate(`/batches/${id}`)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  async function submitValid(e) {
    e.preventDefault()
    if (busy || !EDITABLE.includes(current.status)) return
    const values = {
      voucher_number: form.voucher_number.trim(),
      company_id: form.company_id || null,
      amount: form.amount === '' ? null : Number(form.amount),
      donor_account: form.donor_account.trim() || null,
      expiry_date: form.expiry_date || null,
    }
    const missing = missingFields(values)
    if (missing.length) {
      setError(`Please fill in: ${missing.join(', ')}.`)
      return
    }
    const duplicate = await checkDuplicate(values.voucher_number)
    const { status, reason } = decideStatus({
      company: companyById[values.company_id],
      expiry_date: values.expiry_date,
      receivedDate: batch.received_date,
    })
    setWarning(status === 'not_valid'
      ? `Previous voucher ${values.voucher_number} saved as NOT VALID: ${reason}`
      : null)
    await save({ ...values, status, status_reason: reason, possible_duplicate: duplicate })
  }

  async function submitNotValid() {
    setWarning(null)
    await save({
      voucher_number: form.voucher_number.trim() || null,
      company_id: form.company_id || null,
      amount: form.amount === '' ? null : Number(form.amount),
      donor_account: form.donor_account.trim() || null,
      expiry_date: form.expiry_date || null,
      status: 'not_valid',
      status_reason: reason,
    })
  }

  if (error && !batch) return <ErrorBox error={error} />
  if (!batch || !form) {
    return vouchers.length === 0 && batch
      ? <p className="muted">No vouchers in this batch. <Link to={`/batches/${id}`}>Back to batch</Link></p>
      : <div className="muted">Loading…</div>
  }

  const locked = !EDITABLE.includes(current.status)
  const selectedCompany = companyById[form.company_id]

  return (
    <div className="validate">
      <div className="validate-head">
        <div>
          <div className="crumbs"><Link to="/batches">Batches</Link> / <Link to={`/batches/${id}`}>#{batch.batch_no}</Link> / Validate</div>
          <strong>{batch.collector_reference}</strong> · {collectorLabel(batch.collectors)} · dropped off {date(batch.received_date)}
        </div>
        <div className="progress-box">
          <div><strong>{done}</strong> of {vouchers.length} validated · valid total <strong>{money(validTotal)}</strong></div>
          <div className="bar"><div style={{ width: `${vouchers.length ? (done / vouchers.length) * 100 : 0}%` }} /></div>
        </div>
      </div>

      <div className="validate-body">
        <div className={`image-pane ${zoom ? 'zoom' : ''}`} onClick={() => setZoom(!zoom)} title="Click to zoom">
          {imageUrl ? <img src={imageUrl} alt="Voucher" /> : <div className="muted">Loading image…</div>}
        </div>

        <form className="field-pane" onSubmit={submitValid}>
          <div className="row between">
            <span className="muted">Voucher {index + 1} of {vouchers.length}</span>
            <StatusPill status={current.status} />
          </div>
          {!current.barcode_read && <div className="alert warn">Barcode couldn't be read — type the voucher number.</div>}
          {current.possible_duplicate && <div className="alert error">This voucher number already exists — possible duplicate.</div>}
          {current.prefilled && current.status === 'pending' && <div className="alert ok">Filled in from the barcode — check and press Enter.</div>}
          {current.status_reason && <div className="alert warn">{current.status_reason}</div>}
          {locked && <div className="alert warn">This voucher has been {current.status.replace('_', ' ')} and can no longer be edited here.</div>}

          <fieldset disabled={locked || busy}>
            <label>Voucher number
              <input ref={numberRef} className="mono" value={form.voucher_number}
                onChange={(e) => update('voucher_number', e.target.value)} onBlur={onNumberBlur} />
            </label>
            <label>Company
              <select ref={companyRef} value={form.company_id} onChange={(e) => update('company_id', e.target.value)}>
                <option value="">— choose —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.accepted ? '' : ' (no longer accepted)'}</option>
                ))}
              </select>
            </label>
            <label>Amount (£)
              <input ref={amountRef} type="number" step="0.01" min="0" inputMode="decimal" value={form.amount}
                onChange={(e) => update('amount', e.target.value)} />
            </label>
            <label>Donor account number <span className="muted">(if shown)</span>
              <input className="mono" value={form.donor_account} onChange={(e) => update('donor_account', e.target.value)} />
            </label>
            {suggestion && form.donor_account === suggestion.account && (
              <div className="alert info small">
                Suggested from voucher {suggestion.from}
                {Number(suggestion.distance) === 0 ? ' (same voucher seen before)' : ` (${suggestion.distance} away)`} — please check it against the voucher.
              </div>
            )}
            <label>Expiry date <span className="muted">(if shown)</span>
              <input type="date" value={form.expiry_date} onChange={(e) => update('expiry_date', e.target.value)} />
            </label>
            {selectedCompany && selectedCompany.accepted === false && (
              <div className="alert warn">{selectedCompany.name} is marked as no longer accepted.</div>
            )}
            {form.expiry_date && form.expiry_date < batch.received_date && (
              <div className="alert warn">Expired before the drop-off date — will be saved as not valid.</div>
            )}

            <ErrorBox error={error} />
            {warning && <div className="alert warn">{warning}</div>}

            <button className="btn primary full big" type="submit">{busy ? 'Saving…' : 'Save & next  (Enter)'}</button>

            {!rejecting ? (
              <button type="button" className="btn full" onClick={() => setRejecting(true)}>Mark not valid…</button>
            ) : (
              <div className="reject-box">
                <label>Reason
                  <select value={reason} onChange={(e) => setReason(e.target.value)}>
                    {NOT_VALID_REASONS.map((r) => <option key={r}>{r}</option>)}
                  </select>
                </label>
                <div className="actions">
                  <button type="button" className="btn" onClick={() => setRejecting(false)}>Cancel</button>
                  <button type="button" className="btn danger" onClick={submitNotValid}>Save as not valid</button>
                </div>
              </div>
            )}
          </fieldset>

          <div className="row between nav-row">
            <button type="button" className="btn" disabled={index <= 0} onClick={() => go(vouchers[index - 1]?.id)}>← Previous</button>
            <button type="button" className="btn" disabled={index >= vouchers.length - 1} onClick={() => go(vouchers[index + 1]?.id)}>Next →</button>
          </div>

          {current.barcode_raw && <div className="muted small">Barcode read: <span className="mono">{current.barcode_raw}</span></div>}
          {current.file_name && <div className="muted small">File: {current.file_name}</div>}

          {history.length > 0 && (
            <details className="history">
              <summary>History</summary>
              <ul>
                {history.map((h, i) => <li key={i}>{dateTime(h.changed_at)} — {h.action}</li>)}
              </ul>
            </details>
          )}
        </form>
      </div>
    </div>
  )
}
