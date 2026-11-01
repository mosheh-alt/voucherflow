import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase, fetchAll } from '../lib/supabase.js'
import { collectorLabel, date, money } from '../lib/format.js'
import { ErrorBox } from '../components.jsx'
import VoucherEditor from '../components/VoucherEditor.jsx'

export default function Validate() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [batch, setBatch] = useState(null)
  const [vouchers, setVouchers] = useState([])
  const [companies, setCompanies] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const [{ data: b, error: be }, rows, { data: cs }] = await Promise.all([
          supabase.from('batches').select('*, collectors(name, email)').eq('id', id).single(),
          fetchAll(() => supabase.from('vouchers').select('*').eq('batch_id', id).is('deleted_at', null).order('created_at')),
          supabase.from('companies').select('*').eq('active', true).order('name'),
        ])
        if (be) throw be
        setBatch(b)
        setVouchers(rows)
        setCompanies(cs || [])
      } catch (e) {
        setError(e)
      }
    }
    load()
  }, [id])

  const currentId = params.get('v') || vouchers.find((v) => v.status === 'pending')?.id || vouchers[0]?.id
  const done = vouchers.filter((v) => v.status !== 'pending').length
  const validTotal = vouchers
    .filter((v) => !['pending', 'not_valid', 'cancelled'].includes(v.status))
    .reduce((s, v) => s + Number(v.amount || 0), 0)

  if (error && !batch) return <ErrorBox error={error} />
  if (!batch) return <div className="muted">Loading…</div>
  if (!vouchers.length) return <p className="muted">No vouchers in this batch. <Link to={`/batches/${id}`}>Back to batch</Link></p>

  return (
    <div className="validate">
      <div className="validate-head">
        <div>
          <div className="crumbs"><Link to="/batches">Batches</Link> / <Link to={`/batches/${id}`}>#{batch.batch_no}</Link> / Validate</div>
          <strong>{batch.collector_reference}</strong> · {collectorLabel(batch.collectors)} · dropped off {date(batch.received_date)}
        </div>
        <div className="progress-box">
          <div><strong>{done}</strong> of {vouchers.length} validated · valid total <strong>{money(validTotal)}</strong></div>
          <div className="bar"><div style={{ width: `${(done / vouchers.length) * 100}%` }} /></div>
        </div>
      </div>
      <VoucherEditor
        batch={batch}
        vouchers={vouchers}
        companies={companies}
        currentId={currentId}
        onGo={(v) => setParams({ v })}
        onSaved={setVouchers}
        onFinished={() => navigate(`/batches/${id}`)}
      />
    </div>
  )
}
