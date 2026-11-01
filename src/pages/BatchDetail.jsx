import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase, fetchAll, signedUrls } from '../lib/supabase.js'
import { readBarcode } from '../lib/barcode.js'
import { interpretBarcode } from '../lib/rules.js'
import { collectorLabel, date, money } from '../lib/format.js'
import { takePendingFiles } from '../lib/pending.js'
import { reextract, reextractPatch } from '../lib/reextract.js'
import { aiEnabled, aiReadMany } from '../lib/ai.js'
import { suggestCompany, historyPatch } from '../lib/companyGuess.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Stat, StatusPill } from '../components.jsx'
import VoucherRow from '../components/VoucherRow.jsx'

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
  const [recheckOpen, setRecheckOpen] = useState(false)
  const [aiOn, setAiOn] = useState(false)
  const [zoomedId, setZoomedId] = useState(null) // voucher whose picture is shown enlarged under its row
  const rowRefs = useRef({})
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkCompany, setBulkCompany] = useState('')
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
    supabase.from('companies').select('*').order('name').then(({ data, error }) => {
      if (error) setError(error)
      // Barcode matching uses active companies only; the list keeps inactive ones so their names still show.
      setCompanies(data || [])
      setCompaniesLoaded(true)
    })
  }, [load])

  useEffect(() => { aiEnabled().then(setAiOn).catch(() => setAiOn(false)) }, [])

  // Lets the AI fill empty boxes on the given vouchers (a few at a time).
  async function runAi(items, label = 'AI reading') {
    if (!items.length) return { updated: 0, failures: [] }
    setProgress({ done: 0, total: items.length, current: '', label })
    const result = await aiReadMany(items, companies, (d, t) => setProgress({ done: Math.min(d, t - 1), total: t, current: '', label }))
    setProgress(null)
    return result
  }

  async function aiReadPending() {
    setRecheckOpen(false)
    const todo = vouchers.filter((v) => v.status === 'pending' &&
      (!v.company_id || !v.voucher_number || !v.donor_account || v.amount == null || !v.expiry_date))
    if (!todo.length) { setError('No pending vouchers with empty boxes.'); return }
    setError(null)
    const { updated, failures } = await runAi(todo.map((voucher) => ({ voucher })))
    setError(`AI reading finished: ${updated} of ${todo.length} voucher(s) read.` +
      (failures.length ? `\n${failures.length} failed — first error: ${failures[0]}` : ''))
    await load()
  }

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
    const aiItems = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setProgress({ done: i, total: files.length, current: file.name })
      try {
        const barcode = await readBarcode(file)
        const { company, fields, prefilled } = interpretBarcode(barcode, companies.filter((c) => c.active !== false))

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

        // Plain-number voucher with no company rule: ask the number history.
        let hist = null
        if (!company && fields.voucher_number) hist = historyPatch({}, await suggestCompany(fields.voucher_number))
        const { data: inserted, error: insErr } = await supabase.from('vouchers').insert({
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
          ...(hist || {}),
        }).select().single()
        if (insErr) throw insErr
        aiItems.push({ voucher: inserted, blob: file })
      } catch (e) {
        failures.push(`${file.name}: ${e.message || e}`)
      }
    }
    setProgress(null)
    // Then the AI fills what the barcode couldn't (only when switched on).
    let aiNote = ''
    const aiNow = aiOn || (await aiEnabled().catch(() => false))
    if (aiNow && aiItems.length) {
      await load()
      const { updated, failures: aiFail } = await runAi(aiItems)
      aiNote = `AI read ${updated} of ${aiItems.length} voucher(s).` + (aiFail.length ? ` ${aiFail.length} failed — first error: ${aiFail[0]}` : '')
    }
    const msgs = []
    if (failures.length) msgs.push(`${failures.length} file(s) failed:\n${failures.join('\n')}`)
    if (aiNote) msgs.push(aiNote)
    if (msgs.length) setError(msgs.join('\n'))
    await load()
  }

  // Re-extracts barcode data for pending vouchers: 'missing' = only those without barcode or company,
  // 'all' = every pending voucher (barcode data replaces what's there; validated vouchers are not touched).
  async function recheck(mode) {
    setRecheckOpen(false)
    const todo = vouchers.filter((v) => v.status === 'pending' && (mode === 'all' || !v.barcode_read || !v.company_id))
    if (!todo.length) {
      setError('No pending vouchers to re-read.')
      return
    }
    setError(null)
    let updated = 0
    let noBarcode = 0
    for (let i = 0; i < todo.length; i++) {
      const v = todo[i]
      setProgress({ done: i, total: todo.length, current: v.file_name || '', label: 'Re-reading' })
      try {
        const patch = reextractPatch(await reextract(v, companies.filter((c) => c.active !== false)))
        if (!patch) { noBarcode++; continue }
        const { error } = await supabase.from('vouchers').update(patch).eq('id', v.id)
        if (!error) updated++
      } catch {
        /* leave this voucher for manual entry */
      }
    }
    setProgress(null)
    setError(`Re-read finished: ${updated} of ${todo.length} voucher(s) updated` + (noBarcode ? `, ${noBarcode} still without a readable barcode.` : '.'))
    await load()
  }

  // Files chosen in the New batch form start uploading as soon as the page is ready.
  useEffect(() => {
    if (!batch || !companiesLoaded || progress) return
    const files = takePendingFiles(batch.id)
    if (files) processFiles(files)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id, companiesLoaded])

  const companyById = useMemo(() => Object.fromEntries(companies.map((c) => [c.id, c])), [companies])

  function onRowUpdated(updated) {
    setVouchers((list) => list.map((x) => (x.id === updated.id ? updated : x)))
  }

  // After a voucher is validated, move to the next pending one below it (or the first one above).
  function focusNextPending(fromId) {
    setZoomedId((z) => (z === fromId ? null : z)) // the validated voucher shrinks back
    const i = vouchers.findIndex((x) => x.id === fromId)
    const order = [...vouchers.slice(i + 1), ...vouchers.slice(0, Math.max(i, 0))]
    const next = order.find((x) => x.status === 'pending' && x.id !== fromId)
    if (next) setTimeout(() => rowRefs.current[next.id]?.focus(), 30)
  }

  // Sets the same company on all selected vouchers that can still be edited.
  async function setCompanyForSelected() {
    const ids = vouchers.filter((x) => selectedIds.has(x.id) && ['pending', 'valid', 'post_dated', 'not_valid'].includes(x.status)).map((x) => x.id)
    if (!ids.length || !bulkCompany) return
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase.from('vouchers').update({ company_id: bulkCompany }).in('id', ids.slice(i, i + 200))
      if (error) { setError(error); return }
    }
    setError(`Company set on ${ids.length} voucher(s).`)
    setSelectedIds(new Set())
    setBulkCompany('')
    await load()
  }

  function startValidating() {
    const first = vouchers.find((x) => x.status === 'pending')
    if (first) rowRefs.current[first.id]?.focus()
  }

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
          {can('admin', 'batch_entry') && summary.pending > 0 && (
            <div className="menu-wrap">
              <button className="btn" disabled={Boolean(progress)} onClick={() => setRecheckOpen(!recheckOpen)}>Re-read barcodes ▾</button>
              {recheckOpen && (
                <div className="menu">
                  <button onClick={() => recheck('missing')}>
                    <strong>Only vouchers missing data</strong>
                    <span className="muted small">No barcode or no company yet</span>
                  </button>
                  <button onClick={() => recheck('all')}>
                    <strong>All pending vouchers</strong>
                    <span className="muted small">Re-reads every image; barcode data replaces current values</span>
                  </button>
                  {aiOn && (
                    <button onClick={aiReadPending}>
                      <strong>Read with AI</strong>
                      <span className="muted small">AI fills empty boxes on pending vouchers (you still check each one)</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {summary.pending > 0 && (
            <button className="btn primary" onClick={startValidating}>
              Start entering ({summary.pending} to do)
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
              <div><strong>{progress.label || 'Processing'} {progress.done + 1} of {progress.total}</strong> — reading barcodes</div>
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

      {progress && !canUpload && (
        <div className="card progress-card">
          <strong>{progress.label || 'Processing'} {progress.done + 1} of {progress.total}</strong>
          <div className="bar"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
        </div>
      )}

      <ErrorBox error={error} />

      {vouchers.length > 0 && (
        <p className="muted small">
          Type straight into the rows. Vouchers still to do are shown large next to their boxes; once validated they shrink back. Click any picture to enlarge it. Press <strong>Enter</strong> (or ✓) to validate a voucher and jump to the next one.
        </p>
      )}
      {selectedIds.size > 0 && (
        <div className="action-bar">
          <span><strong>{selectedIds.size}</strong> selected</span>
          <label className="inline-label">Set company
            <select value={bulkCompany} onChange={(e) => setBulkCompany(e.target.value)}>
              <option value="">— choose —</option>
              {companies.filter((c) => c.active !== false).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <button className="btn primary" disabled={!bulkCompany} onClick={setCompanyForSelected}>Apply to selected</button>
          <button className="btn" onClick={() => setSelectedIds(new Set())}>Clear selection</button>
        </div>
      )}
      <div className="table-wrap">
        <table className="table entry-table">
          <thead>
            <tr>
              <th><input type="checkbox" aria-label="Select all"
                checked={vouchers.length > 0 && vouchers.filter((x) => x.status === 'pending').every((x) => selectedIds.has(x.id)) && selectedIds.size > 0}
                onChange={(e) => setSelectedIds(e.target.checked ? new Set(vouchers.filter((x) => x.status === 'pending').map((x) => x.id)) : new Set())} /></th>
              <th>Picture</th><th>Voucher no.</th><th>Account no.</th><th>Company</th><th className="num">Amount</th>
              <th>Date on voucher</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {vouchers.map((v) => (
              <VoucherRow
                key={v.id}
                ref={(el) => { rowRefs.current[v.id] = el }}
                v={v}
                batch={batch}
                companies={companies}
                companyById={companyById}
                thumb={thumbs[v.image_path]}
                expanded={zoomedId === v.id}
                onToggleImage={(id) => setZoomedId((z) => (z === id ? null : id))}
                onUpdated={onRowUpdated}
                onNext={focusNextPending}
                canEdit={can('admin', 'batch_entry', 'reconciler')}
                selected={selectedIds.has(v.id)}
                onSelect={(id) => setSelectedIds((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })}
              />
            ))}
            {vouchers.length === 0 && (
              <tr><td colSpan={9} className="muted">No vouchers yet. Upload the scanned images above.</td></tr>
            )}
          </tbody>
        </table>
      </div>

    </>
  )
}
