import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabase.js'
import { STATUS_LABELS, STATUS_ORDER, collectorLabel, date, money, today } from '../lib/format.js'
import { downloadCSV } from '../lib/csv.js'
import { ErrorBox } from '../components.jsx'

function monthStart() {
  return today().slice(0, 8) + '01'
}

export default function Reports() {
  const [collectors, setCollectors] = useState([])
  const [companies, setCompanies] = useState([])
  const [collectorId, setCollectorId] = useState('')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.from('collectors').select('id, reference, name, email').order('reference').then(({ data }) => setCollectors(data || []))
    supabase.from('companies').select('id, name').then(({ data }) => setCompanies(data || []))
  }, [])

  const companyName = useMemo(() => Object.fromEntries(companies.map((c) => [c.id, c.name])), [companies])
  const collectorById = useMemo(() => Object.fromEntries(collectors.map((c) => [c.id, c])), [collectors])

  async function run(e) {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const data = await fetchAll(() => {
        let q = supabase
          .from('vouchers')
          .select('id, voucher_number, company_id, amount, status, status_reason, collector_id, collector_reference, batch_id, batches!inner(batch_no, received_date)')
          .is('deleted_at', null)
          .gte('batches.received_date', from)
          .lte('batches.received_date', to)
          .order('created_at')
        if (collectorId) q = q.eq('collector_id', collectorId)
        return q
      })
      setRows(data)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // One summary line per collector.
  const summary = useMemo(() => {
    if (!rows) return []
    const map = new Map()
    for (const v of rows) {
      if (!map.has(v.collector_id)) {
        map.set(v.collector_id, { collector_id: v.collector_id, reference: v.collector_reference, handedIn: 0, counted: 0, countedTotal: 0, s: {} })
      }
      const r = map.get(v.collector_id)
      r.handedIn++
      if (!r.s[v.status]) r.s[v.status] = { n: 0, total: 0 }
      r.s[v.status].n++
      r.s[v.status].total += Number(v.amount || 0)
      if (!['not_valid', 'cancelled'].includes(v.status)) {
        r.counted++
        r.countedTotal += Number(v.amount || 0)
      }
    }
    return [...map.values()].sort((a, b) => a.reference.localeCompare(b.reference))
  }, [rows])

  const cols = STATUS_ORDER.filter((s) => s !== 'cancelled')

  function exportSummary() {
    downloadCSV(`collector-report_${from}_${to}.csv`, [
      { label: 'Collector reference', value: 'reference' },
      { label: 'Collector name', value: (r) => collectorLabel(collectorById[r.collector_id]) },
      { label: 'Vouchers handed in', value: 'handedIn' },
      { label: 'Counted (excl. not valid)', value: 'counted' },
      { label: 'Counted total £', value: (r) => r.countedTotal.toFixed(2) },
      ...cols.flatMap((s) => [
        { label: `${STATUS_LABELS[s]} (count)`, value: (r) => r.s[s]?.n || 0 },
        { label: `${STATUS_LABELS[s]} £`, value: (r) => (r.s[s]?.total || 0).toFixed(2) },
      ]),
    ], summary)
  }

  function exportDetail() {
    downloadCSV(`collector-vouchers_${from}_${to}.csv`, [
      { label: 'Collector reference', value: 'collector_reference' },
      { label: 'Collector name', value: (r) => collectorLabel(collectorById[r.collector_id]) },
      { label: 'Batch', value: (r) => r.batches?.batch_no },
      { label: 'Drop-off date', value: (r) => r.batches?.received_date },
      { label: 'Voucher number', value: 'voucher_number' },
      { label: 'Company', value: (r) => companyName[r.company_id] || '' },
      { label: 'Amount £', value: (r) => (r.amount == null ? '' : Number(r.amount).toFixed(2)) },
      { label: 'Status', value: (r) => STATUS_LABELS[r.status] },
      { label: 'Reason', value: 'status_reason' },
    ], rows || [])
  }

  return (
    <>
      <div className="page-head"><h1>Collector report</h1></div>
      <form className="filters" onSubmit={run}>
        <label>Collector
          <select value={collectorId} onChange={(e) => setCollectorId(e.target.value)}>
            <option value="">All collectors</option>
            {collectors.map((c) => <option key={c.id} value={c.id}>{c.reference} · {collectorLabel(c)}</option>)}
          </select>
        </label>
        <label>Drop-off from<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>to<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn primary" disabled={busy}>{busy ? 'Loading…' : 'Show report'}</button>
      </form>
      <ErrorBox error={error} />

      {rows && (
        <>
          <div className="row gap">
            <span className="muted">{rows.length} vouchers · {date(from)} – {date(to)}</span>
            <span className="spacer" />
            <button className="btn" onClick={exportSummary} disabled={!summary.length}>Export summary (CSV)</button>
            <button className="btn" onClick={exportDetail} disabled={!rows.length}>Export voucher list (CSV)</button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Collector</th><th className="num">Handed in</th><th className="num">Counted</th><th className="num">Counted £</th>
                  {cols.map((s) => <th key={s} className="num">{STATUS_LABELS[s]}</th>)}
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.collector_id}>
                    <td><strong>{r.reference}</strong> · {collectorLabel(collectorById[r.collector_id])}</td>
                    <td className="num">{r.handedIn}</td>
                    <td className="num">{r.counted}</td>
                    <td className="num">{money(r.countedTotal)}</td>
                    {cols.map((s) => (
                      <td key={s} className="num">
                        {r.s[s] ? <>{r.s[s].n}<div className="muted small">{money(r.s[s].total)}</div></> : <span className="muted">0</span>}
                      </td>
                    ))}
                  </tr>
                ))}
                {summary.length === 0 && <tr><td colSpan={4 + cols.length} className="muted">No vouchers in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted small">Emailing the report as a PDF to the collector comes in the next version.</p>
        </>
      )}
    </>
  )
}
