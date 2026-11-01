import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, signedUrls } from '../lib/supabase.js'
import { FILTERS, passesFilter, searchFilters, voucherMatches } from '../lib/search.js'
import { money } from '../lib/format.js'
import { ErrorBox } from '../components.jsx'
import VoucherTable from './VoucherTable.jsx'
import RemoveDialog from './RemoveDialog.jsx'
import { REMOVABLE } from '../lib/duplicates.js'

const LIMIT = 300

// Searches every voucher in every batch, with all the in-row options.
export default function VoucherSearch() {
  const [companies, setCompanies] = useState([])
  const [text, setText] = useState('')
  const [filter, setFilter] = useState('')
  const [company, setCompany] = useState('')
  const [rows, setRows] = useState(null)
  const [thumbs, setThumbs] = useState({})
  const [selected, setSelected] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [removing, setRemoving] = useState(false)
  const lastRefresh = useRef(0)

  useEffect(() => {
    supabase.from('companies').select('*').order('name').then(({ data }) => setCompanies(data || []))
  }, [])
  const companyById = useMemo(() => Object.fromEntries(companies.map((c) => [c.id, c])), [companies])

  async function run(e) {
    e?.preventDefault()
    if (!text.trim() && !filter && !company) { setError('Type something to search for, or pick a category or company.'); return }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      let q = supabase.from('vouchers').select('*, batches(batch_no, received_date)').is('deleted_at', null)
      for (const f of searchFilters(text, companies)) q = q.or(f)
      if (company) q = q.eq('company_id', company)
      if (filter === 'duplicates') q = q.eq('possible_duplicate', true)
      else if (filter === 'urgent') q = q.eq('urgent', true)
      else if (filter === 'received') q = q.in('status', ['received_success', 'received_pending'])
      else if (filter) q = q.eq('status', filter)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(LIMIT)
      if (error) throw error
      const found = (data || []).filter((v) => voucherMatches(v, text, companyById) && passesFilter(v, filter))
      setRows(found)
      setSelected(new Set())
      setThumbs(await signedUrls(found.map((v) => v.thumb_path || v.image_path)))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const selectedRows = (rows || []).filter((r) => selected.has(r.id))
  const total = (rows || []).reduce((t, r) => t + Number(r.amount || 0), 0)

  return (
    <div className="card search-card">
      <h2>Find vouchers</h2>
      <form className="filters" onSubmit={run}>
        <label className="grow">Search
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} autoFocus
            placeholder="Voucher no., account no., company, amount (e.g. 18), collector ref, #batch…" />
        </label>
        <label>Category
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Company
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All companies</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      <p className="muted small">Searches every batch. Several words narrow it down, e.g. <em>aac 18</em> = AAC vouchers for £18.</p>
      <ErrorBox error={error} />
      {notice && <div className="alert ok">{notice}</div>}

      {rows && (
        <>
          <div className="row gap">
            <span className="muted">{rows.length}{rows.length >= LIMIT ? '+' : ''} found · {money(total)}
              {rows.length >= LIMIT && ' — showing the newest; narrow your search to see the rest'}</span>
            <span className="spacer" />
            {selectedRows.some((r) => REMOVABLE.includes(r.status)) && (
              <button className="btn danger" onClick={() => setRemoving(true)}>Remove selected ({selectedRows.length})…</button>
            )}
          </div>
          <VoucherTable
            rows={rows}
            companies={companies}
            companyById={companyById}
            thumbs={thumbs}
            selected={selected}
            onSelect={(id) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })}
            onSelectAll={(checked) => setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set())}
            onRowUpdated={(row) => setRows((list) => list.map((x) => (x.id === row.id ? row : x)))}
            onChanged={async (msg) => { await run(); setNotice(msg) }}
            onImageError={() => {
              if (Date.now() - lastRefresh.current < 60000) return
              lastRefresh.current = Date.now()
              signedUrls(rows.map((v) => v.thumb_path || v.image_path)).then(setThumbs)
            }}
            empty="No vouchers match."
          />
        </>
      )}
      {removing && (
        <RemoveDialog vouchers={selectedRows} onClose={() => setRemoving(false)}
          onDone={async (msg) => { setRemoving(false); await run(); setNotice(msg) }} />
      )}
    </div>
  )
}
