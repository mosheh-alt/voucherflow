import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase, fetchAll, signedUrls, storeThumbnail } from '../lib/supabase.js'
import { readBarcode } from '../lib/barcode.js'
import { interpretBarcode } from '../lib/rules.js'
import { collectorLabel, date, money } from '../lib/format.js'
import { takePendingFiles } from '../lib/pending.js'
import { reextract, reextractPatch } from '../lib/reextract.js'
import { aiEnabled, aiHealthCached, aiReadMany } from '../lib/ai.js'
import { suggestCompany, historyPatch } from '../lib/companyGuess.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Modal, Stat, StatusPill } from '../components.jsx'
import VoucherRow from '../components/VoucherRow.jsx'
import DuplicateCompare from '../components/DuplicateCompare.jsx'
import { FILTERS, passesFilter, voucherMatches } from '../lib/search.js'
import { REMOVABLE, duplicateFields, findDuplicate, removeVoucher, restoreVoucher } from '../lib/duplicates.js'

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp']

export default function BatchDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { can, session } = useAuth()
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
  const [dupFor, setDupFor] = useState(null) // voucher whose duplicate comparison is open
  const [removeIds, setRemoveIds] = useState(null) // vouchers waiting for "remove" confirmation
  const [removeReason, setRemoveReason] = useState('')
  const [removed, setRemoved] = useState([])
  const [showRemoved, setShowRemoved] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
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
      const { data: gone } = await supabase.from('vouchers')
        .select('id, voucher_number, company_id, amount, deleted_at, deleted_reason')
        .eq('batch_id', id).not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
      setRemoved(gone || [])
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

  // Is the AI function working and up to date? (Shown as a banner if not.)
  const [aiHealth, setAiHealth] = useState(null)
  useEffect(() => { if (aiOn) aiHealthCached().then(setAiHealth) }, [aiOn])

  // Vouchers the AI couldn't read earlier (e.g. it was busy) are retried automatically, once per visit.
  const retried = useRef(false)
  useEffect(() => {
    if (retried.current || !aiOn || !aiHealth?.ok || !companiesLoaded || progress) return
    const failed = vouchers.filter((v) => v.status === 'pending' && v.ai_data?.error &&
      Date.now() - new Date(v.ai_data.failed_at || 0).getTime() > 60 * 1000)
    if (!failed.length) return
    retried.current = true
    ;(async () => {
      const { updated } = await runAi(failed.map((voucher) => ({ voucher })), 'Retrying AI reading')
      setError(`The AI had failed on ${failed.length} voucher(s) earlier — retried automatically: ${updated} now read.`)
      await load()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOn, aiHealth, companiesLoaded, vouchers])

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
    // Voucher numbers met so far in this upload: number → [{ id, company_id }]
    const seen = new Map()
    const failures = []
    const aiItems = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setProgress({ done: i, total: files.length, current: file.name })
      try {
        const barcode = await readBarcode(file)
        const { company, fields, prefilled } = interpretBarcode(barcode, companies.filter((c) => c.active !== false))

        // Same number and same company as a voucher already in the system (or earlier in this upload)?
        let duplicateOf = null
        if (fields.voucher_number) {
          const earlier = (seen.get(fields.voucher_number) || []).find((o) => !company || !o.company_id || o.company_id === company.id)
          duplicateOf = earlier ? earlier.id : await findDuplicate({ voucher_number: fields.voucher_number, company_id: company?.id })
        }

        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
        const path = `${batch.id}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage.from('vouchers').upload(path, file, { contentType: file.type })
        if (upErr) throw upErr

        // Plain-number voucher with no company rule: ask the number history.
        let hist = null
        if (!company && fields.voucher_number) hist = historyPatch({}, await suggestCompany(fields.voucher_number))
        const thumbPath = await storeThumbnail(batch.id, file)
        const newRow = {
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
          ...duplicateFields(duplicateOf),
          ...(hist || {}),
          ...(thumbPath ? { thumb_path: thumbPath } : {}),
        }
        let { data: inserted, error: insErr } = await supabase.from('vouchers').insert(newRow).select().single()
        if (insErr && /thumb_path/.test(insErr.message || '')) {
          // Database update 13 not run yet: save without the small picture.
          delete newRow.thumb_path
          ;({ data: inserted, error: insErr } = await supabase.from('vouchers').insert(newRow).select().single())
        }
        if (insErr) throw insErr
        aiItems.push({ voucher: inserted, blob: file })
        if (inserted.voucher_number) seen.set(inserted.voucher_number, [...(seen.get(inserted.voucher_number) || []), { id: inserted.id, company_id: inserted.company_id }])
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
    const next = order.find((x) => x.status === 'pending' && x.id !== fromId && rowRefs.current[x.id])
    if (next) setTimeout(() => rowRefs.current[next.id]?.focus(), 30)
  }

  // Sets the same company on all selected vouchers that can still be edited.
  // Removes vouchers from the batch (kept in history; an admin can restore them).
  async function confirmRemove() {
    const ids = vouchers.filter((x) => removeIds.includes(x.id) && REMOVABLE.includes(x.status)).map((x) => x.id)
    const skipped = removeIds.length - ids.length
    try {
      for (const id of ids) await removeVoucher(id, removeReason.trim() || 'Removed by user', session.user.id)
      setError(`${ids.length} voucher(s) removed.` + (skipped ? ` ${skipped} already sent and left in place.` : '') + ' They can be restored from "Show removed vouchers" at the bottom.')
    } catch (e) {
      setError(e)
    }
    setRemoveIds(null)
    setRemoveReason('')
    setSelectedIds(new Set())
    await load()
  }

  // If picture links have expired (page open for hours), fetch fresh ones once.
  const refreshing = useRef(false)
  async function refreshPictures() {
    if (refreshing.current) return
    refreshing.current = true
    // Pictures now renew their own links (StoredImage); nothing to do here.
    refreshing.current = false
  }

  // Older vouchers were stored only full-size; this makes small copies so the page loads quickly.
  async function makeSmallPictures() {
    setRecheckOpen(false)
    const todo = vouchers.filter((x) => !x.thumb_path && x.image_path)
    let made = 0
    for (let i = 0; i < todo.length; i++) {
      setProgress({ done: i, total: todo.length, current: '', label: 'Making small pictures' })
      try {
        const { data: blob } = await supabase.storage.from('vouchers').download(todo[i].image_path)
        if (!blob) continue
        const path = await storeThumbnail(batch.id, blob)
        if (!path) continue
        const { error } = await supabase.from('vouchers').update({ thumb_path: path }).eq('id', todo[i].id)
        if (error) { setError(error); break }
        made++
      } catch { /* skip this one */ }
    }
    setProgress(null)
    setError(`Small pictures made for ${made} of ${todo.length} voucher(s).`)
    await load()
  }

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

  const shownVouchers = (search.trim() || filter)
    ? vouchers.filter((v) => passesFilter(v, filter) && voucherMatches(v, search, companyById))
    : vouchers

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
                  {vouchers.some((x) => !x.thumb_path) && (
                    <button onClick={makeSmallPictures}>
                      <strong>Make pictures load faster</strong>
                      <span className="muted small">Creates small copies of this batch's pictures (one-off)</span>
                    </button>
                  )}
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

      {aiOn && aiHealth && !aiHealth.ok && (
        <div className="alert warn">
          {aiHealth.problem === 'outdated'
            ? <>The AI reading function in Supabase is out of date{aiHealth.version ? ` (version ${aiHealth.version})` : ''}, so AI reading may fail. Update it: Supabase → Edge Functions → read-voucher → Code → paste the latest <code>index.ts</code> from GitHub → Deploy. (Details on the AI reading page.)</>
            : <>AI reading isn't working right now: {aiHealth.problem}</>}
        </div>
      )}
      <ErrorBox error={error} />

      {vouchers.length > 0 && (
        <p className="muted small">
          Type straight into the rows. Vouchers still to do are shown large next to their boxes; once validated they shrink back. Click any picture to enlarge it. Press <strong>Enter</strong> (or ✓) to validate a voucher and jump to the next one.
        </p>
      )}
      {vouchers.length > 0 && (
        <div className="filters search-bar">
          <label className="grow">Search this batch
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Voucher no., account no., company, amount, status…" />
          </label>
          <label>Category
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {Object.entries(FILTERS).map(([k, label]) => {
                const n = k ? vouchers.filter((v) => passesFilter(v, k)).length : vouchers.length
                return (k && !n) ? null : <option key={k} value={k}>{label} ({n})</option>
              })}
            </select>
          </label>
          {(search || filter) && (
            <span className="muted">{shownVouchers.length} of {vouchers.length} shown
              {' '}<button className="btn-link" onClick={() => { setSearch(''); setFilter('') }}>Show all</button></span>
          )}
        </div>
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
          <button className="btn danger" onClick={() => setRemoveIds([...selectedIds])}>Remove selected…</button>
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
              <th>Date on voucher</th><th>Status</th><th className="action-cell"></th>
            </tr>
          </thead>
          <tbody>
            {shownVouchers.map((v) => (
              <VoucherRow
                key={v.id}
                ref={(el) => { rowRefs.current[v.id] = el }}
                v={v}
                batch={batch}
                companies={companies}
                companyById={companyById}
                thumb={thumbs[v.thumb_path || v.image_path]}
                expanded={zoomedId === v.id}
                onToggleImage={(id) => setZoomedId((z) => (z === id ? null : id))}
                onUpdated={onRowUpdated}
                onNext={focusNextPending}
                canEdit={can('admin', 'batch_entry', 'reconciler')}
                selected={selectedIds.has(v.id)}
                onShowDuplicate={setDupFor}
                onRemove={(id) => setRemoveIds([id])}
                onImageError={refreshPictures}
                onSelect={(id) => setSelectedIds((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })}
              />
            ))}
            {vouchers.length === 0 && (
              <tr><td colSpan={9} className="muted">No vouchers yet. Upload the scanned images above.</td></tr>
            )}
            {vouchers.length > 0 && shownVouchers.length === 0 && (
              <tr><td colSpan={9} className="muted">No vouchers in this batch match your search.</td></tr>
            )}
          </tbody>
        </table>
      </div>


      {removed.length > 0 && (
        <div className="removed-box">
          <button className="btn-link" onClick={() => setShowRemoved(!showRemoved)}>
            {showRemoved ? 'Hide' : 'Show'} {removed.length} removed voucher(s)
          </button>
          {showRemoved && (
            <table className="table">
              <thead><tr><th>Voucher no.</th><th>Company</th><th className="num">Amount</th><th>Reason</th><th>Removed</th><th></th></tr></thead>
              <tbody>
                {removed.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.voucher_number || '—'}</td>
                    <td>{companyName[r.company_id] || '—'}</td>
                    <td className="num">{money(r.amount)}</td>
                    <td className="small">{r.deleted_reason || '—'}</td>
                    <td>{date(r.deleted_at)}</td>
                    <td>{can('admin') && <button className="btn small-btn" onClick={async () => {
                      try { await restoreVoucher(r.id); setError('Voucher restored.'); await load() } catch (e) { setError(e) }
                    }}>Restore</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {dupFor && (
        <DuplicateCompare
          voucher={dupFor}
          companyById={companyById}
          onClose={() => setDupFor(null)}
          onChanged={async (msg) => { setDupFor(null); setError(msg); await load() }}
        />
      )}
      {removeIds && (
        <Modal title={removeIds.length === 1 ? 'Remove voucher' : `Remove ${removeIds.length} vouchers`} onClose={() => setRemoveIds(null)}>
          <p>The voucher{removeIds.length === 1 ? '' : 's'} will disappear from the batch, the pool, totals and reports.
            {' '}{removeIds.length === 1 ? 'It is' : 'They are'} kept in the history and an admin can restore {removeIds.length === 1 ? 'it' : 'them'}.</p>
          <label>Reason
            <select value={removeReason} onChange={(e) => setRemoveReason(e.target.value)}>
              <option value="">— choose or leave blank —</option>
              <option>Blank or unreadable scan</option>
              <option>Scanned twice</option>
              <option>Not a voucher</option>
              <option>Returned to collector</option>
              <option>Wrong batch</option>
            </select>
          </label>
          <div className="actions">
            <button className="btn" onClick={() => setRemoveIds(null)}>Cancel</button>
            <button className="btn danger" onClick={confirmRemove}>Remove</button>
          </div>
        </Modal>
      )}
    </>
  )
}
