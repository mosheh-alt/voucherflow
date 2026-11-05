import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import StoredImage from './StoredImage.jsx'
import { REMOVABLE, numberVariants, removeVoucher } from '../lib/duplicates.js'
import { date, money } from '../lib/format.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Modal, StatusPill } from '../components.jsx'

const COLS = 'id, batch_id, collector_reference, image_path, voucher_number, donor_account, company_id, amount, expiry_date, status, created_at, deleted_at, batches(batch_no, received_date)'

// Side-by-side view of a voucher and the voucher it seems to duplicate, with options to
// remove one of them or confirm they're different.
export default function DuplicateCompare({ voucher, companyById, onClose, onChanged }) {
  const { session } = useAuth()
  const [pair, setPair] = useState(null) // [thisOne, otherOne]
  const [urls, setUrls] = useState({})
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        let otherId = voucher.duplicate_of
        // Older vouchers were flagged before the link was stored: look the match up now.
        if (!otherId) {
          const { data } = await supabase.from('vouchers').select('id, company_id').in('voucher_number', numberVariants(voucher.voucher_number))
            .neq('id', voucher.id).is('deleted_at', null).order('created_at').limit(20)
          otherId = (data || []).find((o) => !voucher.company_id || !o.company_id || o.company_id === voucher.company_id)?.id
        }
        const ids = [voucher.id, otherId].filter(Boolean)
        const { data: rows, error } = await supabase.from('vouchers').select(COLS).in('id', ids)
        if (error) throw error
        const thisOne = rows.find((r) => r.id === voucher.id)
        const other = rows.find((r) => r.id === otherId) || null
        setPair([thisOne, other])
      } catch (e) {
        setError(e)
      }
    }
    load()
  }, [voucher])

  async function remove(target, keep) {
    if (!REMOVABLE.includes(target.status)) {
      setError(`That voucher is already ${target.status.replace('_', ' ')} and can't be removed here.`)
      return
    }
    setBusy(true)
    try {
      await removeVoucher(target.id, `Removed as duplicate of voucher ${keep?.voucher_number || ''} (batch #${keep?.batches?.batch_no ?? '?'})`, session.user.id)
      if (keep) await supabase.from('vouchers').update({ possible_duplicate: false, duplicate_of: null }).eq('id', keep.id)
      await onChanged(`Duplicate removed. It's kept in the voucher history and can be restored.`)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  async function notDuplicate() {
    setBusy(true)
    try {
      const { error } = await supabase.from('vouchers').update({ possible_duplicate: false, duplicate_of: null }).eq('id', voucher.id)
      if (error) throw error
      await onChanged('Marked as not a duplicate.')
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  function Card({ v, title }) {
    if (!v) return <div className="dup-card muted">The matching voucher could no longer be found (it may have been removed).</div>
    return (
      <div className="dup-card">
        <div className="row between"><strong>{title}</strong><StatusPill status={v.status} /></div>
        <StoredImage path={v.image_path} />
        <table className="dup-facts">
          <tbody>
            <tr><th>Voucher no.</th><td className="mono">{v.voucher_number}</td></tr>
            <tr><th>Company</th><td>{companyById[v.company_id]?.name || '—'}</td></tr>
            <tr><th>Amount</th><td>{money(v.amount)}</td></tr>
            <tr><th>Account no.</th><td className="mono">{v.donor_account || '—'}</td></tr>
            <tr><th>Collector</th><td className="mono">{v.collector_reference}</td></tr>
            <tr><th>Batch</th><td><Link to={`/batches/${v.batch_id}`} onClick={onClose}>#{v.batches?.batch_no}</Link> · dropped off {date(v.batches?.received_date)}</td></tr>
            <tr><th>Uploaded</th><td>{date(v.created_at)}</td></tr>
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <Modal title="Possible duplicate" onClose={onClose} wide>
      <ErrorBox error={error} />
      {!pair ? <p className="muted">Loading…</p> : (
        <>
          <p className="muted small">Compare the two vouchers. If they're the same voucher scanned twice, remove one of them.</p>
          <div className="dup-grid">
            <Card v={pair[0]} title="This voucher" />
            <Card v={pair[1]} title="Matches this voucher" />
          </div>
          <div className="actions wrap">
            <button className="btn" disabled={busy} onClick={notDuplicate}>Not a duplicate</button>
            {pair[1] && <button className="btn danger" disabled={busy} onClick={() => remove(pair[1], pair[0])}>Remove the other one</button>}
            <button className="btn danger" disabled={busy} onClick={() => remove(pair[0], pair[1])}>Remove this one</button>
          </div>
        </>
      )}
    </Modal>
  )
}
