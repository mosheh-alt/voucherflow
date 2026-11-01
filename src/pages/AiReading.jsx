import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { aiEnabled, setAiEnabled } from '../lib/ai.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox } from '../components.jsx'

const FIELDS = [
  ['company', 'Company'],
  ['number', 'Voucher no.'],
  ['account', 'Account no.'],
  ['amount', 'Amount'],
  ['date', 'Date'],
]

function Pct({ read, correct }) {
  if (!read) return <span className="muted">—</span>
  const p = Math.round((correct / read) * 100)
  const cls = p >= 98 ? 'ok-text' : p >= 90 ? 'warn-text' : 'bad-text'
  return (
    <>
      <strong className={cls}>{p}%</strong>
      <div className="muted small">{correct} of {read}</div>
    </>
  )
}

export default function AiReading() {
  const { can } = useAuth()
  const [on, setOn] = useState(null)
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    aiEnabled().then(setOn).catch((e) => setError(e))
    supabase.from('ai_accuracy').select('*').then(({ data, error }) => {
      if (error) setError(error)
      else setRows(data || [])
    })
  }, [])

  async function toggle() {
    try {
      await setAiEnabled(!on)
      setOn(!on)
    } catch (e) {
      setError(e)
    }
  }

  const total = rows.reduce((t, r) => t + Number(r.vouchers), 0)

  return (
    <>
      <div className="page-head"><h1>AI reading</h1></div>
      <ErrorBox error={error} />

      <div className="card">
        <div className="row between">
          <div>
            <strong>Read vouchers with AI (Claude)</strong>
            <div className="muted small">
              When on, every uploaded voucher is also read by AI, which fills in only the boxes that are still empty
              (shown in purple, marked "AI – check"). Barcode data always takes priority, and nothing is validated until you press ✓.
            </div>
          </div>
          {on === null ? <span className="muted">…</span> : can('admin') ? (
            <button className={`btn ${on ? 'danger' : 'primary'}`} onClick={toggle}>{on ? 'Switch off' : 'Switch on'}</button>
          ) : <strong>{on ? 'On' : 'Off'}</strong>}
        </div>
      </div>

      <h2>Accuracy</h2>
      <p className="muted small">
        For every validated voucher the AI read: how often what it read matched what was confirmed.
        {total ? ` Based on ${total} voucher(s).` : ''}
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th><th className="num">Vouchers</th>
              {FIELDS.map(([, label]) => <th key={label} className="num">{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.company}>
                <td><strong>{r.company}</strong></td>
                <td className="num">{r.vouchers}</td>
                {FIELDS.map(([k]) => (
                  <td key={k} className="num"><Pct read={Number(r[`${k}_read`])} correct={Number(r[`${k}_correct`])} /></td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={2 + FIELDS.length} className="muted">No figures yet — they appear once vouchers read by AI have been validated.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
