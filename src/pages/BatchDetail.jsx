import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase, fetchAll, signedUrls } from '../lib/supabase.js'
import { readBarcode } from '../lib/barcode.js'
import { interpretBarcode } from '../lib/rules.js'
import { collectorLabel, date, money } from '../lib/format.js'
import { takePendingFiles } from '../lib/pending.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Stat, StatusPill } from '../components.jsx'

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp']

export default function BatchDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const [batch, setBatch] = useState(null)
  const [vouchers, setVouchers] = useState([])
  const [companies, setCompanies] = useState([])
  const [companiesLoaded, setCompaniesLoaded] = useState(false)
  const [thumbs, setThumbs] = useState({})
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null) // { done, total, current }
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef(null)

  const load = useCallback(async () => {
    try {
      const { data: b, error: be } = await supabase
        .from('batches')
        .select('*, collectors(name, email)')
        .eq('id', id)
        .single()
      if (be) throw be
      setBatch(b)
      const rows = await fetchAll(() =>
        supabase.from('vouchers').select('*').eq('batch_id', id).is('deleted_at', null).order('created_at')
      )
      setVouchers(rows)
      setThumbs(await signedUrls(rows.map((v) => v.image_path)))
    } catch (e) {
      setError(e)
    }
  }, [id])

  useEffect(() => {
    load()
    supabase.from('companies').select('*').eq('active', true).order('name').then(({ data }) => {
      setCompanies(data || [])
      setCompaniesLoaded(true)
    })
  }, [load])

  const companyName = useMemo(() => Object.fromEntries(companies.map((c) => [c.id, c.name])), [companies])

  const summary = useMemo(() => {
    const s = { total: vouchers.length, pending: 0, valid: 0, validTotal: 0, notValid: 0, noBarcode: 0, duplicates: 0 }
    for (const v of vouchers) {
      if (v.status === 'pending') s.pending++
      if (v.status === 'not_valid') s.notValid++
      if (v.status !== 'pending' && v.status !== 'not_valid' && v.status !== 'cancelled') {
        s.valid++
        s.validTotal += Number(v.amount || 0)
      }
      if (!v.barcode_read) s.noBarcode++
      if (v.possible_duplicate) s.duplicates++
    }
    return s
  }, [vouchers])

  async function processFiles(fileList) {
    const files = Array.from(fileList).filter((f) => ACCEPTED.includes(f.type))
    const skipped = fileList.length - files.length
    if (!files.length) {
      setError('Please choose image files (JPG or PNG).')
      return
    }
    setError(skipped ? `${skipped} file(s) skipped — only JPG and PNG images can be uploaded.` : null)
    setProgress({ done: 0, total: files.length, current: '' })
    const seen = new Set(vouchers.map((v) => v.voucher_number).filter(Boolean))
    const failures = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setProgress({ done: i, total: files.length, current: file.name })
      try {
        const barcode = await readBarcode(file)
        const { company, fields, prefilled } = interpretBarcode(barcode, companies)

        let duplicate = false
        if (fields.voucher_number) {
          if (seen.has(fields.voucher_number)) duplicate = true
          else {
            const { count } = await supabase
              .from('vouchers')
              .select('id', { count: 'exact', head: true })
              .eq('voucher_number', fields.voucher_number)
              .is('deleted_at', null)
            duplicate = (count ?? 0) > 0
          }
          seen.add(fields.voucher_number)
        }

        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
        const path = `${batch.id}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage.from('vouchers').upload(path, file, { contentType: file.type })
        if (upErr) throw upErr

        const { error: insErr } = await supabase.from('vouchers').insert({
          batch_id: batch.id,
          collector_id: batch.collector_id,
          collector_reference: batch.collector_reference,
          image_path: path,
          file_name: file.name,
          barcode_raw: barcode,
          barcode_read: Boolean(barcode),
          voucher_number: fields.voucher_number,
          company_id: company?.id ?? null,
          amount: fields.amount,
          donor_account: fields.donor_account,
          expiry_date: fields.expiry_date,
          prefilled,
          possible_duplicate: duplicate,
        })
        if (insErr) throw insErr
      } catch (e) {
        failures.push(`${file.name}: ${e.message || e}`)
      }
    }
    setProgress(null)
    if (failures.length) setError(`${failures.length} file(s) failed:\n${failures.join('\n')}`)
    await load()
  }

  // Files chosen in the New batch form start uploading as soon as the page is ready.
  useEffect(() => {
    if (!batch || !companiesLoaded || progress) return
    const files = takePendingFiles(batch.id)
    if (files) processFiles(files)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id, companiesLoaded])

  async function setBatchStatus(status) {
    const { error } = await supabase.from('batches').update({ status }).eq('id', batch.id)
    if (error) setError(error)
    else setBatch({ ...batch, status })
  }

  if (!batch) return <div className="muted">{error ? <ErrorBox error={error} /> : 'Loading…'}</div>

  const canUpload = can('admin', 'batch_entry') && batch.status === 'open'

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs"><Link to="/batches">Batches</Link> / #{batch.batch_no}</div>
          <h1>Batch #{batch.batch_no}</h1>
          <div className="muted">
            Collector <strong>{batch.collector_reference}</strong> · {collectorLabel(batch.collectors)} · dropped off {date(batch.received_date)}
          </div>
        </div>
        <div className="head-actions">
          {summary.pending > 0 && (
            <button className="btn primary" onClick={() => navigate(`/batches/${batch.id}/validate`)}>
              Validate ({summary.pending})
            </button>
          )}
          {batch.status === 'open' && summary.total > 0 && summary.pending === 0 && (
            <button className="btn primary" onClick={() => setBatchStatus('validated')}>Mark batch validated</button>
          )}
          {batch.status === 'validated' && can('admin') && (
            <button className="btn" onClick={() => setBatchStatus('open')}>Reopen</button>
          )}
        </div>
      </div>

      <div className="stats">
        <Stat label="Vouchers" value={summary.total} />
        <Stat label="To validate" value={summary.pending} />
        <Stat label="Valid" value={summary.valid} sub={money(summary.validTotal)} />
        <Stat label="Not valid" value={summary.notValid} />
        <Stat label="No barcode read" value={summary.noBarcode} />
        <Stat label="Possible duplicates" value={summary.duplicates} />
      </div>

      {canUpload && (
        <div
          className={`dropzone ${dragging ? 'over' : ''} ${progress ? 'busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (!progress) processFiles(e.dataTransfer.files) }}
          onClick={() => !progress && fileInput.current?.click()}
        >
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED.join(',')}
            multiple
            hidden
            onChange={(e) => { processFiles(e.target.files); e.target.value = '' }}
          />
          {progress ? (
            <>
              <div><strong>Processing {progress.done + 1} of {progress.total}</strong> — reading barcode and uploading</div>
              <div className="bar"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
              <div className="muted small">{progress.current}</div>
            </>
          ) : (
            <>
              <button type="button" className="btn primary">Upload voucher images from PC</button>
              <div className="muted small" style={{ marginTop: 8 }}>or drag and drop them here · JPG or PNG, one image per voucher · you can select hundreds at once</div>
            </>
          )}
        </div>
      )}

      <ErrorBox error={error} />

      <table className="table">
        <thead>
          <tr>
            <th></th><th>Voucher no.</th><th>Company</th><th className="num">Amount</th>
            <th>Expiry</th><th>Status</th><th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {vouchers.map((v) => (
            <tr key={v.id} className="clickable" onClick={() => navigate(`/batches/${batch.id}/validate?v=${v.id}`)}>
              <td>{thumbs[v.image_path] ? <img className="thumb" src={thumbs[v.image_path]} alt="" /> : <div className="thumb" />}</td>
              <td className="mono">{v.voucher_number || <span className="muted">—</span>}</td>
              <td>{companyName[v.company_id] || <span className="muted">—</span>}</td>
              <td className="num">{money(v.amount)}</td>
              <td>{date(v.expiry_date)}</td>
              <td><StatusPill status={v.status} />{v.status_reason && <div className="muted small">{v.status_reason}</div>}</td>
              <td className="flags">
                {!v.barcode_read && <span className="flag warn">No barcode</span>}
                {v.possible_duplicate && <span className="flag bad">Duplicate?</span>}
                {v.prefilled && v.status === 'pending' && <span className="flag info">Prefilled</span>}
              </td>
            </tr>
          ))}
          {vouchers.length === 0 && (
            <tr><td colSpan={7} className="muted">No vouchers yet. Upload the scanned images above.</td></tr>
          )}
        </tbody>
      </table>
    </>
  )
}
