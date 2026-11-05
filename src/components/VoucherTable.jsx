import { useState } from 'react'
import VoucherRow from './VoucherRow.jsx'
import DuplicateCompare from './DuplicateCompare.jsx'
import RemoveDialog from './RemoveDialog.jsx'
import { useAuth } from '../auth.jsx'

// Vouchers from many batches in one table (pool, search), with the same in-row options as
// the batch page: change any box, validate (✓ / Enter), compare duplicates, remove.
//   rows: vouchers (with batches(batch_no, received_date));  onRowUpdated(row): a row was saved
//   selected: Set of ids;  onSelect(id), onSelectAll(checked)
//   onChanged(message): something was removed / a duplicate resolved — reload the list
export default function VoucherTable({ rows, companies, companyById, thumbs, selected, onSelect, onSelectAll, onRowUpdated, onChanged, onImageError, empty, loading }) {
  const { can } = useAuth()
  const [zoomedId, setZoomedId] = useState(null)
  const [dupFor, setDupFor] = useState(null)
  const [removeRows, setRemoveRows] = useState(null)

  return (
    <>
      <div className="table-wrap">
        <table className="table entry-table pool-table">
          <thead>
            <tr>
              <th><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                onChange={(e) => onSelectAll(e.target.checked)} /></th>
              <th>Picture</th><th>Collector ref</th><th>Voucher no.</th><th>Account no.</th><th>Company</th>
              <th className="num">Amount</th><th>Date on voucher</th><th>Status</th><th>Batch</th><th className="action-cell"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <VoucherRow
                key={v.id}
                v={v}
                showBatch
                companies={companies}
                companyById={companyById}
                preview={thumbs?.[v.id]}
                expanded={zoomedId === v.id}
                onToggleImage={(id) => setZoomedId((z) => (z === id ? null : id))}
                onUpdated={(data) => onRowUpdated({ ...v, ...data })}
                onNext={() => setZoomedId(null)}
                canEdit={can('admin', 'batch_entry', 'reconciler')}
                selected={selected.has(v.id)}
                onSelect={onSelect}
                onShowDuplicate={setDupFor}
                onRemove={() => setRemoveRows([v])}
                onImageError={onImageError}
              />
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={11} className="muted">{empty || 'No vouchers here.'}</td></tr>}
            {loading && <tr><td colSpan={11} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
      </div>

      {dupFor && (
        <DuplicateCompare voucher={dupFor} companyById={companyById} onClose={() => setDupFor(null)}
          onChanged={async (msg) => { setDupFor(null); await onChanged(msg) }} />
      )}
      {removeRows && (
        <RemoveDialog vouchers={removeRows} onClose={() => setRemoveRows(null)}
          onDone={async (msg) => { setRemoveRows(null); await onChanged(msg) }} />
      )}
    </>
  )
}

// Lets a page open the remove window for several selected vouchers.
export { RemoveDialog }
