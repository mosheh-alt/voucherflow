import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { interpretBarcode, isValidPattern } from '../lib/rules.js'
import { METHOD_LABELS, money, date } from '../lib/format.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Modal } from '../components.jsx'

const EMPTY = {
  name: '', submission_method: 'physical', report_email: '', portal_url: '', address: '',
  barcode_pattern: '', amount_divisor: 100, expiry_format: 'YYMMDD', accepted: true, active: true, notes: '',
}

export default function Companies() {
  const { can } = useAuth()
  const isAdmin = can('admin')
  const [rows, setRows] = useState([])
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState(null)

  function load() {
    supabase.from('companies').select('*').order('name').then(({ data, error }) => {
      if (error) setError(error)
      else setRows(data)
    })
  }
  useEffect(load, [])

  return (
    <>
      <div className="page-head">
        <h1>Voucher companies</h1>
        {isAdmin && <button className="btn primary" onClick={() => setEditing(EMPTY)}>Add company</button>}
      </div>
      <ErrorBox error={error} />
      <table className="table">
        <thead><tr><th>Name</th><th>Sending</th><th>Report email</th><th>Barcode rule</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={isAdmin ? 'clickable' : ''} onClick={() => isAdmin && setEditing(r)}>
              <td><strong>{r.name}</strong></td>
              <td>{METHOD_LABELS[r.submission_method]}</td>
              <td>{r.report_email || '—'}</td>
              <td>{r.barcode_pattern ? <span className="flag info">Set</span> : <span className="muted">—</span>}</td>
              <td>
                {!r.active ? <span className="muted">Inactive</span>
                  : r.accepted ? 'Accepted' : <span className="flag bad">No longer accepted</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted">No companies yet.{isAdmin && ' Click "Add company" to start.'}</td></tr>}
        </tbody>
      </table>
      {editing && <CompanyForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </>
  )
}

function CompanyForm({ initial, onClose, onSaved }) {
  const [f, setF] = useState({ ...EMPTY, ...initial })
  const [error, setError] = useState(null)
  const [testBarcode, setTestBarcode] = useState('')
  const isNew = !initial.id
  const set = (k, v) => setF({ ...f, [k]: v })

  const test = testBarcode.trim()
    ? interpretBarcode(testBarcode.trim(), [{ ...f, active: true }])
    : null

  async function save(e) {
    e.preventDefault()
    if (!f.name.trim()) return setError('Name is required.')
    if (!isValidPattern(f.barcode_pattern)) return setError('The barcode rule is not a valid pattern.')
    const row = {
      name: f.name.trim(),
      submission_method: f.submission_method,
      report_email: f.report_email?.trim() || null,
      portal_url: f.portal_url?.trim() || null,
      address: f.address?.trim() || null,
      barcode_pattern: f.barcode_pattern?.trim() || null,
      amount_divisor: Number(f.amount_divisor) || 1,
      expiry_format: f.expiry_format,
      accepted: f.accepted,
      active: f.active,
      notes: f.notes?.trim() || null,
    }
    const { error } = isNew
      ? await supabase.from('companies').insert(row)
      : await supabase.from('companies').update(row).eq('id', initial.id)
    if (error) setError(error.code === '23505' ? 'A company with this name already exists.' : error)
    else onSaved()
  }

  return (
    <Modal title={isNew ? 'Add company' : f.name} onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="grid2">
          <label>Name *<input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus={isNew} /></label>
          <label>How vouchers are sent
            <select value={f.submission_method} onChange={(e) => set('submission_method', e.target.value)}>
              {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Report email<input type="email" value={f.report_email || ''} onChange={(e) => set('report_email', e.target.value)} /></label>
          <label>Portal link<input value={f.portal_url || ''} onChange={(e) => set('portal_url', e.target.value)} placeholder="https://" /></label>
        </div>
        <label>Office address (for physical drop-off)<input value={f.address || ''} onChange={(e) => set('address', e.target.value)} /></label>

        <h3>Barcode rule</h3>
        <p className="muted small">
          A pattern that recognises this company's barcodes. For barcodes holding more data, name the parts:
          <code>(?&lt;voucher&gt;…)</code> <code>(?&lt;amount&gt;…)</code> <code>(?&lt;account&gt;…)</code> <code>(?&lt;expiry&gt;…)</code>.
          Example: <code>{'(?<voucher>\\d{8})(?<amount>\\d{5})(?<expiry>\\d{6})'}</code>. Use the test box to check it.
        </p>
        <label>Pattern<input className="mono" value={f.barcode_pattern || ''} onChange={(e) => set('barcode_pattern', e.target.value)} /></label>
        <div className="grid2">
          <label>Amount in barcode is in
            <select value={f.amount_divisor} onChange={(e) => set('amount_divisor', e.target.value)}>
              <option value={100}>Pence (00500 = £5.00)</option>
              <option value={1}>Pounds (5 = £5.00)</option>
            </select>
          </label>
          <label>Expiry date format in barcode
            <select value={f.expiry_format} onChange={(e) => set('expiry_format', e.target.value)}>
              {['YYMMDD', 'DDMMYY', 'YYYYMMDD', 'DDMMYYYY', 'MMYY'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
        </div>
        <label>Test a barcode<input className="mono" value={testBarcode} onChange={(e) => setTestBarcode(e.target.value)} placeholder="Paste or type a real barcode value" /></label>
        {test && (
          test.company ? (
            <div className="alert ok">
              Matches. Voucher no. <strong className="mono">{test.fields.voucher_number}</strong>
              {test.fields.amount != null && <> · amount <strong>{money(test.fields.amount)}</strong></>}
              {test.fields.donor_account && <> · account <strong>{test.fields.donor_account}</strong></>}
              {test.fields.expiry_date && <> · expiry <strong>{date(test.fields.expiry_date)}</strong></>}
            </div>
          ) : <div className="alert warn">Doesn't match this pattern.</div>
        )}

        <h3>Validity</h3>
        <label className="check"><input type="checkbox" checked={f.accepted} onChange={(e) => set('accepted', e.target.checked)} /> Vouchers from this company are accepted</label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Active (shown in lists)</label>
        <label>Notes<input value={f.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  )
}
