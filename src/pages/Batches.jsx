import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { collectorLabel, date, today } from '../lib/format.js'
import { setPendingFiles } from '../lib/pending.js'
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
      .select('id, batch_no, collector_reference, received_date, status, created_at, collectors(name, email), vouchers(count)')
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
              <td>{collectorLabel(b.collectors)}</td>
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
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [received, setReceived] = useState(today())
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef(null)

  useEffect(() => {
    supabase.from('collectors').select('id, reference, name, email, active').order('reference')
      .then(({ data }) => setCollectors(data || []))
  }, [])

  const ref = reference.trim().toLowerCase()
  const match = useMemo(() => collectors.find((c) => c.reference.toLowerCase() === ref), [collectors, ref])

  // Search by reference, name or email while typing.
  const suggestions = useMemo(() => {
    if (!ref || match) return []
    return collectors
      .filter((c) => `${c.reference} ${c.name || ''} ${c.email || ''}`.toLowerCase().includes(ref))
      .slice(0, 6)
  }, [collectors, ref, match])

  // When an existing collector is found, show their saved email.
  useEffect(() => {
    if (match) {
      setEmail(match.email || '')
      setName(match.name || '')
    }
  }, [match])

  function pickFiles(list) {
    const imgs = Array.from(list).filter((f) => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
    setFiles(imgs)
    if (imgs.length < list.length) setError(`${list.length - imgs.length} file(s) skipped — only JPG and PNG images.`)
    else setError(null)
  }

  async function create(e) {
    e.preventDefault()
    setError(null)
    const refValue = reference.trim()
    const emailValue = email.trim()
    if (!refValue) return setError('Enter the collector reference number.')
    if (match && !match.active) return setError('This collector is marked inactive.')
    if (!match && !emailValue) return setError('New collector: enter their email address.')
    setBusy(true)
    try {
      let collector = match
      if (!collector) {
        const { data, error } = await supabase
          .from('collectors')
          .insert({ reference: refValue, email: emailValue, name: name.trim() })
          .select()
          .single()
        if (error) throw error
        collector = data
      } else if (emailValue !== (match.email || '') || name.trim() !== (match.name || '')) {
        // Email or name changed for an existing collector: save it for next time.
        const { error } = await supabase
          .from('collectors')
          .update({ email: emailValue || null, name: name.trim() })
          .eq('id', match.id)
        if (error) throw error
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
      setPendingFiles(batch.id, files)
      navigate(`/batches/${batch.id}`)
    } catch (err) {
      setError(err.code === '23505' ? 'That collector reference already exists.' : err)
      setBusy(false)
    }
  }

  return (
    <Modal title="New batch" onClose={onClose}>
      <form onSubmit={create}>
        <label>Collector reference number *
          <input value={reference} onChange={(e) => setReference(e.target.value)} autoFocus placeholder="Type the number, or search by name / email" autoComplete="off" />
        </label>
        {suggestions.length > 0 && (
          <div className="suggest">
            {suggestions.map((c) => (
              <button type="button" key={c.id} onClick={() => setReference(c.reference)}>
                <span className="mono">{c.reference}</span> <span className="muted">{collectorLabel(c)}</span>
              </button>
            ))}
          </div>
        )}
        {reference.trim() && (
          match
            ? <div className="alert ok">Existing collector found{match.name ? <>: <strong>{match.name}</strong></> : ''}</div>
            : <div className="alert info">New collector — enter their email and it will be saved for next time.</div>
        )}
        {reference.trim() && (
          <>
            <label>Collector email {match ? '' : '*'}
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            </label>
            <label>Collector name <span className="muted">(optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </>
        )}
        <label>Drop-off date
          <input type="date" value={received} onChange={(e) => setReceived(e.target.value)} required />
        </label>
        <label>Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>
        <div className="upload-pick">
          <button type="button" className="btn" onClick={() => fileInput.current?.click()}>Choose voucher images from PC…</button>
          <span className="muted small">{files.length ? `${files.length} image(s) selected — uploaded when the batch is created` : 'Optional — you can also add them on the batch page'}</span>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden
            onChange={(e) => { pickFiles(e.target.files); e.target.value = '' }} />
        </div>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : files.length ? 'Create batch & upload' : 'Create batch'}</button>
        </div>
      </form>
    </Modal>
  )
}
