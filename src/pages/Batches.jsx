import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { date, today } from '../lib/format.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Modal } from '../components.jsx'

const BATCH_STATUS = { open: 'Open', validated: 'Validated', closed: 'Closed' }

export default function Batches() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const [batches, setBatches] = useState([])
  const [filter, setFilter] = useState('open')
  const [error, setError] = useState(null)
  const showNew = params.get('new') === '1'

  useEffect(() => {
    let q = supabase
      .from('batches')
      .select('id, batch_no, collector_reference, received_date, status, created_at, collectors(name), vouchers(count)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200)
    if (filter !== 'all') q = q.eq('status', filter)
    q.then(({ data, error }) => {
      if (error) setError(error)
      else setBatches(data)
    })
  }, [filter])

  return (
    <>
      <div className="page-head">
        <h1>Batches</h1>
        {can('admin', 'batch_entry') && (
          <button className="btn primary" onClick={() => setParams({ new: '1' })}>New batch</button>
        )}
      </div>
      <div className="tabs">
        {['open', 'validated', 'closed', 'all'].map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : BATCH_STATUS[f]}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />
      <table className="table">
        <thead>
          <tr><th>Batch</th><th>Collector ref</th><th>Collector</th><th>Received</th><th>Status</th><th className="num">Vouchers</th></tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td><Link to={`/batches/${b.id}`}>#{b.batch_no}</Link></td>
              <td>{b.collector_reference}</td>
              <td>{b.collectors?.name}</td>
              <td>{date(b.received_date)}</td>
              <td>{BATCH_STATUS[b.status]}</td>
              <td className="num">{b.vouchers?.[0]?.count ?? 0}</td>
            </tr>
          ))}
          {batches.length === 0 && (
            <tr><td colSpan={6} className="muted">No batches here yet.</td></tr>
          )}
        </tbody>
      </table>
      {showNew && <NewBatch onClose={() => setParams({})} />}
    </>
  )
}

function NewBatch({ onClose }) {
  const navigate = useNavigate()
  const [collectors, setCollectors] = useState([])
  const [reference, setReference] = useState('')
  const [newName, setNewName] = useState('')
  const [received, setReceived] = useState(today())
  const [notes, setNotes] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.from('collectors').select('id, reference, name, active').order('reference').then(({ data }) => setCollectors(data || []))
  }, [])

  const match = useMemo(
    () => collectors.find((c) => c.reference.toLowerCase() === reference.trim().toLowerCase()),
    [collectors, reference]
  )

  async function create(e) {
    e.preventDefault()
    setError(null)
    const ref = reference.trim()
    if (!ref) return setError('Enter the collector reference number.')
    if (match && !match.active) return setError('This collector is marked inactive.')
    if (!match && !newName.trim()) return setError('New collector: enter their name.')
    setBusy(true)
    try {
      let collector = match
      if (!collector) {
        const { data, error } = await supabase
          .from('collectors')
          .insert({ reference: ref, name: newName.trim() })
          .select()
          .single()
        if (error) throw error
        collector = data
      }
      const { data: batch, error } = await supabase
        .from('batches')
        .insert({
          collector_id: collector.id,
          collector_reference: collector.reference,
          received_date: received,
          notes: notes.trim() || null,
        })
        .select()
        .single()
      if (error) throw error
      navigate(`/batches/${batch.id}`)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Modal title="New batch" onClose={onClose}>
      <form onSubmit={create}>
        <label>Collector reference number *
          <input
            list="collector-refs"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            autoFocus
            placeholder="e.g. C1042"
          />
          <datalist id="collector-refs">
            {collectors.map((c) => <option key={c.id} value={c.reference}>{c.name}</option>)}
          </datalist>
        </label>
        {reference.trim() && (match ? (
          <div className="alert ok">Collector: <strong>{match.name}</strong></div>
        ) : (
          <label>New collector — name *
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Collector's full name" />
          </label>
        ))}
        <label>Drop-off date
          <input type="date" value={received} onChange={(e) => setReceived(e.target.value)} required />
        </label>
        <label>Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create batch'}</button>
        </div>
      </form>
    </Modal>
  )
}
