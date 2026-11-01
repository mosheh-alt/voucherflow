import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase, fetchAll, signedUrls } from '../lib/supabase.js'
import { METHOD_LABELS, STATUS_LABELS, date, money, today } from '../lib/format.js'
import { downloadCSV } from '../lib/csv.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Modal, StatusPill } from '../components.jsx'

// The tabs of the pool: which statuses each one shows.
const VIEWS = {
  ready: { label: 'Ready to send', statuses: ['valid'] },
  post_dated: { label: 'Post-dated', statuses: ['post_dated'] },
  sent: { label: 'Sent', statuses: ['sent'] },
  received: { label: 'Received', statuses: ['received_success', 'received_pending'] },
  rejected: { label: 'Rejected', statuses: ['rejected'] },
  paid: { label: 'Paid', statuses: ['paid'] },
  not_valid: { label: 'Not valid', statuses: ['not_valid'] },
  all: { label: 'All validated', statuses: ['valid', 'post_dated', 'sent', 'received_success', 'received_pending', 'rejected', 'paid', 'not_valid'] },
}

const PAGE = 100
const COLUMNS = 'id, batch_id, collector_reference, image_path, voucher_number, donor_account, company_id, amount, expiry_date, date_text, status, status_reason, urgent, send_by, hold_until, sent_at, sent_method, sent_reference, received_at, paid_at, batches(batch_no, received_date)'

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export default function Pool() {
  const { session, can } = useAuth()
  const [params, setParams] = useSearchParams()
  const view = VIEWS[params.get('view')] ? params.get('view') : 'ready'
  const companyFilter = params.get('company') || ''
  const [collector, setCollector] = useState(params.get('collector') || '')
  const [search, setSearch] = useState('')
  const [companies, setCompanies] = useState([])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [thumbs, setThumbs] = useState({})
  const [bigId, setBigId] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [action, setAction] = useState(null) // 'sent' | 'received' | 'rejected' | 'paid' | 'back'
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    supabase.from('companies').select('id, name, submission_method, report_email').order('name').then(({ data }) => setCompanies(data || []))
  }, [])
  const companyById = useMemo(() => Object.fromEntries(companies.map((c) => [c.id, c])), [companies])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAll(() => {
        let q = supabase.from('vouchers').select(COLUMNS).is('deleted_at', null).in('status', VIEWS[view].statuses)
        if (companyFilter) q = q.eq('company_id', companyFilter)
        if (collector.trim()) q = q.ilike('collector_reference', `%${collector.trim()}%`)
        return q.order('company_id').order('created_at')
      })
      setRows(data)
      setPage(0)
      setSelected(new Set())
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [view, companyFilter, collector])

  useEffect(() => { load() }, [load])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => `${r.voucher_number || ''} ${r.donor_account || ''}`.toLowerCase().includes(q))
  }, [rows, search])

  const pageRows = shown.slice(page * PAGE, page * PAGE + PAGE)
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))

  useEffect(() => {
    signedUrls(pageRows.map((r) => r.image_path)).then(setThumbs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, shown])

  // Totals per company for everything matching the filters.
  const perCompany = useMemo(() => {
    const m = new Map()
    for (const r of shown) {
      const k = r.company_id || 'none'
      if (!m.has(k)) m.set(k, { id: k, count: 0, total: 0, urgent: 0 })
      const e = m.get(k)
      e.count++
      e.total += Number(r.amount || 0)
      if (r.urgent) e.urgent++
    }
    return [...m.values()].sort((a, b) => (companyById[a.id]?.name || '').localeCompare(companyById[b.id]?.name || ''))
  }, [shown, companyById])

  const grand = perCompany.reduce((t, c) => ({ count: t.count + c.count, total: t.total + c.total }), { count: 0, total: 0 })
  const selectedRows = shown.filter((r) => selected.has(r.id))
  const selectedTotal = selectedRows.reduce((t, r) => t + Number(r.amount || 0), 0)

  function setFilter(key, value) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next)
  }

  function toggle(id) {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  async function applyStatus(ids, patch) {
    for (const part of chunks(ids, 200)) {
      const { error } = await supabase.from('vouchers').update(patch).in('id', part)
      if (error) throw error
    }
  }

  function exportCSV() {
    downloadCSV(`vouchers_${view}_${today()}.csv`, [
      { label: 'Company', value: (r) => companyById[r.company_id]?.name || '' },
      { label: 'Collector ref', value: 'collector_reference' },
      { label: 'Batch', value: (r) => r.batches?.batch_no },
      { label: 'Voucher no.', value: 'voucher_number' },
      { label: 'Account no.', value: 'donor_account' },
      { label: 'Amount £', value: (r) => (r.amount == null ? '' : Number(r.amount).toFixed(2)) },
      { label: 'Date on voucher', value: 'expiry_date' },
      { label: 'Status', value: (r) => STATUS_LABELS[r.status] },
      { label: 'Reason / note', value: 'status_reason' },
      { label: 'Sent', value: (r) => (r.sent_at ? r.sent_at.slice(0, 10) : '') },
      { label: 'Sent by', value: (r) => METHOD_LABELS[r.sent_method] || r.sent_method || '' },
      { label: 'Sent reference', value: 'sent_reference' },
    ], selectedRows.length ? selectedRows : shown)
  }

  const canAct = can('admin', 'reconciler', 'batch_entry')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Voucher pool</h1>
          <div className="muted">All validated vouchers from every batch, in one place — send, receive and track them here.</div>
        </div>
        <button className="btn" onClick={exportCSV} disabled={!shown.length}>Export CSV{selectedRows.length ? ` (${selectedRows.length} selected)` : ''}</button>
      </div>

      <div className="tabs wrap">
        {Object.entries(VIEWS).map(([k, v]) => (
          <button key={k} className={view === k ? 'active' : ''} onClick={() => setFilter('view', k === 'ready' ? '' : k)}>{v.label}</button>
        ))}
      </div>

      <div className="filters">
        <label>Company
          <select value={companyFilter} onChange={(e) => setFilter('company', e.target.value)}>
            <option value="">All companies</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Collector ref
          <input value={collector} onChange={(e) => setCollector(e.target.value)} onBlur={() => setFilter('collector', collector.trim())}
            onKeyDown={(e) => e.key === 'Enter' && setFilter('collector', collector.trim())} placeholder="Any" />
        </label>
        <label>Voucher / account no.
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder="Search" />
        </label>
      </div>

      <ErrorBox error={error} />
      {notice && <div className="alert ok">{notice}</div>}

      {perCompany.length > 0 && (
        <div className="company-totals">
          {perCompany.map((c) => (
            <button key={c.id} className={`company-chip ${companyFilter === c.id ? 'active' : ''}`}
              onClick={() => setFilter('company', companyFilter === c.id ? '' : c.id === 'none' ? '' : c.id)}>
              <strong>{companyById[c.id]?.name || 'No company'}</strong>
              <span>{c.count} · {money(c.total)}</span>
              {c.urgent > 0 && <span className="flag bad">{c.urgent} urgent</span>}
            </button>
          ))}
          <div className="company-chip total"><strong>Total</strong><span>{grand.count} · {money(grand.total)}</span></div>
        </div>
      )}

      {canAct && (
        <div className="action-bar">
          <span><strong>{selectedRows.length}</strong> selected · {money(selectedTotal)}</span>
          <button className="btn" onClick={() => setSelected(new Set(shown.map((r) => r.id)))} disabled={!shown.length}>Select all {shown.length}</button>
          <button className="btn" onClick={() => setSelected(new Set())} disabled={!selected.size}>Clear</button>
          <span className="spacer" />
          {['ready', 'post_dated', 'all'].includes(view) && <button className="btn primary" disabled={!selected.size} onClick={() => setAction('sent')}>Mark as sent…</button>}
          {['sent', 'received', 'all'].includes(view) && <button className="btn" disabled={!selected.size} onClick={() => setAction('received')}>Mark received…</button>}
          {['sent', 'received', 'all'].includes(view) && <button className="btn" disabled={!selected.size} onClick={() => setAction('rejected')}>Mark rejected…</button>}
          {['sent', 'received', 'all'].includes(view) && <button className="btn" disabled={!selected.size} onClick={() => setAction('paid')}>Mark paid…</button>}
          {can('admin') && view !== 'ready' && <button className="btn" disabled={!selected.size} onClick={() => setAction('back')}>Move back…</button>}
        </div>
      )}

      <div className="table-wrap">
        <table className="table entry-table pool-table">
          <thead>
            <tr>
              <th><input type="checkbox" checked={pageRows.length > 0 && pageRows.every((r) => selected.has(r.id))}
                onChange={(e) => setSelected((s) => { const n = new Set(s); pageRows.forEach((r) => (e.target.checked ? n.add(r.id) : n.delete(r.id))); return n })} /></th>
              <th>Picture</th><th>Collector ref</th><th>Voucher no.</th><th>Account no.</th><th>Company</th>
              <th className="num">Amount</th><th>Date on voucher</th><th>Status</th><th>Batch</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr key={r.id} className={selected.has(r.id) ? 'row-selected' : ''}>
                <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td>
                  {thumbs[r.image_path]
                    ? <img className={`thumb zoomable ${bigId === r.id ? 'thumb-big' : ''}`} src={thumbs[r.image_path]} alt="Voucher" loading="lazy"
                        onClick={() => setBigId(bigId === r.id ? null : r.id)} title="Click to enlarge" />
                    : <div className="thumb" />}
                </td>
                <td className="mono"><strong>{r.collector_reference}</strong></td>
                <td className="mono">{r.voucher_number || '—'}</td>
                <td className="mono">{r.donor_account || '—'}</td>
                <td>{companyById[r.company_id]?.name || '—'}</td>
                <td className="num">{money(r.amount)}</td>
                <td>{date(r.expiry_date)}{r.date_text && <div className="small muted" dir="auto">{r.date_text}</div>}</td>
                <td>
                  <StatusPill status={r.status} />
                  {r.urgent && ['valid', 'post_dated'].includes(r.status) && <div><span className="flag bad">Urgent – send by {date(r.send_by)}</span></div>}
                  {r.status === 'post_dated' && r.hold_until && <div className="small warn-text">Can be sent from {date(r.hold_until)}</div>}
                  {r.status_reason && !r.urgent && r.status !== 'post_dated' && <div className="small muted">{r.status_reason}</div>}
                  {r.sent_at && <div className="small muted">Sent {date(r.sent_at)}{r.sent_reference ? ` · ref ${r.sent_reference}` : ''}</div>}
                  {r.paid_at && <div className="small muted">Paid {date(r.paid_at)}</div>}
                </td>
                <td><Link to={`/batches/${r.batch_id}`}>#{r.batches?.batch_no}</Link><div className="small muted">{date(r.batches?.received_date)}</div></td>
              </tr>
            ))}
            {!loading && pageRows.length === 0 && <tr><td colSpan={10} className="muted">No vouchers here.</td></tr>}
            {loading && <tr><td colSpan={10} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="row gap">
          <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>← Previous</button>
          <span className="muted">Page {page + 1} of {pages}</span>
          <button className="btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      )}

      {action && (
        <ActionForm
          action={action}
          rows={selectedRows}
          companyById={companyById}
          onClose={() => setAction(null)}
          onDone={async (message) => { setAction(null); setNotice(message); await load() }}
          apply={applyStatus}
          userId={session.user.id}
        />
      )}
    </>
  )
}

// The window that opens for "Mark as sent", "Mark received", etc.
function ActionForm({ action, rows, companyById, onClose, onDone, apply, userId }) {
  const companiesInSel = [...new Set(rows.map((r) => r.company_id))]
  const firstCompany = companyById[companiesInSel[0]]
  const [method, setMethod] = useState(firstCompany?.submission_method || 'physical')
  const [reference, setReference] = useState('')
  const [when, setWhen] = useState(today())
  const [result, setResult] = useState('received_success')
  const [reason, setReason] = useState('')
  const [backTo, setBackTo] = useState('valid')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const total = rows.reduce((t, r) => t + Number(r.amount || 0), 0)

  // Post-dated vouchers can't be sent before their date.
  const tooEarly = action === 'sent' ? rows.filter((r) => r.status === 'post_dated' && r.hold_until && r.hold_until > today()) : []
  const wrongStatus = action === 'sent' ? rows.filter((r) => !['valid', 'post_dated'].includes(r.status)) : []

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const stamp = new Date(`${when}T12:00:00`).toISOString()
      let ids = rows.map((r) => r.id)
      let patch
      let message
      if (action === 'sent') {
        ids = rows.filter((r) => !tooEarly.includes(r) && !wrongStatus.includes(r)).map((r) => r.id)
        patch = { status: 'sent', sent_at: stamp, sent_method: method, sent_reference: reference.trim() || null, sent_by: userId }
        message = `${ids.length} voucher(s) marked as sent.`
      } else if (action === 'received') {
        patch = { status: result, received_at: stamp, status_reason: result === 'received_pending' ? (reason.trim() || 'Pending at company') : null }
        message = `${ids.length} voucher(s) marked ${result === 'received_success' ? 'received – success' : 'received – pending'}.`
      } else if (action === 'rejected') {
        patch = { status: 'rejected', received_at: stamp, status_reason: reason.trim() || 'No reason given' }
        message = `${ids.length} voucher(s) marked rejected.`
      } else if (action === 'paid') {
        patch = { status: 'paid', paid_at: stamp }
        message = `${ids.length} voucher(s) marked paid.`
      } else {
        patch = { status: backTo }
        if (backTo === 'valid') Object.assign(patch, { sent_at: null, sent_method: null, sent_reference: null, received_at: null, paid_at: null })
        message = `${ids.length} voucher(s) moved back to ${STATUS_LABELS[backTo]}.`
      }
      if (!ids.length) throw new Error('None of the selected vouchers can be changed this way.')
      await apply(ids, patch)
      await onDone(message)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  const titles = { sent: 'Mark as sent', received: 'Mark as received', rejected: 'Mark as rejected', paid: 'Mark as paid', back: 'Move back' }

  return (
    <Modal title={titles[action]} onClose={onClose}>
      <form onSubmit={save}>
        <p><strong>{rows.length}</strong> voucher(s), total <strong>{money(total)}</strong>
          {companiesInSel.length === 1 ? <> · {firstCompany?.name || 'No company'}</> : <> · {companiesInSel.length} companies</>}</p>

        {action === 'sent' && (
          <>
            {companiesInSel.length > 1 && <div className="alert warn">You've selected vouchers from several companies. Usually each company is sent separately.</div>}
            {tooEarly.length > 0 && <div className="alert warn">{tooEarly.length} post-dated voucher(s) can't be sent yet and will be left out.</div>}
            {wrongStatus.length > 0 && <div className="alert warn">{wrongStatus.length} voucher(s) aren't ready to send and will be left out.</div>}
            <label>How it was sent
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>Reference <span className="muted">(upload confirmation, tracking no., who received it…)</span>
              <input value={reference} onChange={(e) => setReference(e.target.value)} />
            </label>
            <label>Date sent<input type="date" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
            <p className="muted small">The automatic report email to the company comes in the next step of the build.</p>
          </>
        )}

        {action === 'received' && (
          <>
            <label>Result from the company
              <select value={result} onChange={(e) => setResult(e.target.value)}>
                <option value="received_success">Success — approved for payment</option>
                <option value="received_pending">Pending — still being processed</option>
              </select>
            </label>
            {result === 'received_pending' && <label>Note<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" /></label>}
            <label>Date<input type="date" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          </>
        )}

        {action === 'rejected' && (
          <>
            <label>Reason given by the company
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Insufficient funds" autoFocus />
            </label>
            <label>Date<input type="date" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          </>
        )}

        {action === 'paid' && <label>Date paid<input type="date" value={when} onChange={(e) => setWhen(e.target.value)} /></label>}

        {action === 'back' && (
          <label>Move back to
            <select value={backTo} onChange={(e) => setBackTo(e.target.value)}>
              <option value="valid">Ready to send (valid)</option>
              <option value="sent">Sent</option>
              <option value="received_success">Received – success</option>
            </select>
          </label>
        )}

        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</button>
        </div>
        <p className="muted small">Every change is recorded in each voucher's history.</p>
      </form>
    </Modal>
  )
}

