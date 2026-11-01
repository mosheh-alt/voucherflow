import { useState } from 'react'
import { REMOVABLE, removeVoucher } from '../lib/duplicates.js'
import { useAuth } from '../auth.jsx'
import { Modal } from '../components.jsx'

// Asks for a reason and removes vouchers (kept in the history; an admin can restore them).
//   vouchers: the full voucher rows to remove;  onDone(message): after removing
export default function RemoveDialog({ vouchers, onClose, onDone }) {
  const { session } = useAuth()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const n = vouchers.length

  async function confirm() {
    setBusy(true)
    const ids = vouchers.filter((x) => REMOVABLE.includes(x.status)).map((x) => x.id)
    const skipped = n - ids.length
    try {
      for (const id of ids) await removeVoucher(id, reason.trim() || 'Removed by user', session.user.id)
      await onDone(`${ids.length} voucher(s) removed.` + (skipped ? ` ${skipped} already sent and left in place.` : '') +
        ' An admin can restore them from "Show removed vouchers" at the bottom of their batch.')
    } catch (e) {
      await onDone(e.message || String(e))
    }
  }

  return (
    <Modal title={n === 1 ? 'Remove voucher' : `Remove ${n} vouchers`} onClose={onClose}>
      <p>The voucher{n === 1 ? '' : 's'} will disappear from the batch, the pool, totals and reports.
        {' '}{n === 1 ? 'It is' : 'They are'} kept in the history and an admin can restore {n === 1 ? 'it' : 'them'}.</p>
      <label>Reason
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">— choose or leave blank —</option>
          <option>Duplicate</option>
          <option>Blank or unreadable scan</option>
          <option>Scanned twice</option>
          <option>Not a voucher</option>
          <option>Returned to collector</option>
          <option>Wrong batch</option>
        </select>
      </label>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy} onClick={confirm}>{busy ? 'Removing…' : 'Remove'}</button>
      </div>
    </Modal>
  )
}
