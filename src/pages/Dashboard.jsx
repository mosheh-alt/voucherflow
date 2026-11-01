import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { STATUS_LABELS, STATUS_ORDER, collectorLabel, date } from '../lib/format.js'
import { ErrorBox, Stat } from '../components.jsx'

export default function Dashboard() {
  const [counts, setCounts] = useState({})
  const [batches, setBatches] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const results = await Promise.all(
          STATUS_ORDER.map((s) =>
            supabase.from('vouchers').select('id', { count: 'exact', head: true }).eq('status', s).is('deleted_at', null)
          )
        )
        const c = {}
        STATUS_ORDER.forEach((s, i) => { c[s] = results[i].count ?? 0 })
        setCounts(c)
        const { data, error } = await supabase
          .from('batches')
          .select('id, batch_no, collector_reference, received_date, status, collectors(name, email), vouchers(count)')
          .is('deleted_at', null)
          .eq('status', 'open')
          .order('created_at', { ascending: false })
          .limit(10)
        if (error) throw error
        setBatches(data)
      } catch (e) {
        setError(e)
      }
    }
    load()
  }, [])

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <Link className="btn primary" to="/batches?new=1">New batch</Link>
      </div>
      <ErrorBox error={error} />
      <div className="stats">
        {STATUS_ORDER.filter((s) => s !== 'cancelled').map((s) => (
          <Stat key={s} label={STATUS_LABELS[s]} value={counts[s] ?? '…'} />
        ))}
      </div>
      <h2>Open batches</h2>
      {batches.length === 0 ? (
        <p className="muted">No open batches.</p>
      ) : (
        <table className="table">
          <thead><tr><th>Batch</th><th>Collector</th><th>Received</th><th className="num">Vouchers</th></tr></thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td><Link to={`/batches/${b.id}`}>#{b.batch_no}</Link></td>
                <td>{b.collector_reference} · {collectorLabel(b.collectors)}</td>
                <td>{date(b.received_date)}</td>
                <td className="num">{b.vouchers?.[0]?.count ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
