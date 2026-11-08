import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, fetchAll } from '../lib/supabase.js'
import { date, money } from '../lib/format.js'

// Money we expect in the bank, per company: vouchers prepared in a submission (not sent yet),
// and vouchers sent but not paid yet.
export default function ExpectedDeposits() {
  const [rows, setRows] = useState(null)
  const [problem, setProblem] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const [{ data: companies }, { data: subs, error }] = await Promise.all([
          supabase.from('companies').select('id, name'),
          supabase.from('submissions').select('id, submission_no, company_id, status, created_at, sent_at').in('status', ['draft', 'sent']),
        ])
        if (error) throw error
        const vouchers = await fetchAll(() => supabase.from('vouchers').select('submission_id, company_id, amount, status')
          .not('submission_id', 'is', null).is('deleted_at', null)
          .in('status', ['valid', 'sent', 'received_success', 'received_pending']))
        const name = Object.fromEntries((companies || []).map((c) => [c.id, c.name]))
        const subById = Object.fromEntries((subs || []).map((s) => [s.id, s]))
        const m = new Map()
        for (const v of vouchers) {
          const s = subById[v.submission_id]
          if (!s) continue
          if (!m.has(v.company_id)) m.set(v.company_id, { id: v.company_id, name: name[v.company_id] || '—', prepared: 0, preparedN: 0, sent: 0, sentN: 0, subs: new Set(), oldest: null })
          const e = m.get(v.company_id)
          e.subs.add(s.id)
          if (v.status === 'valid') { e.prepared += Number(v.amount || 0); e.preparedN++ }
          else {
            e.sent += Number(v.amount || 0); e.sentN++
            if (s.sent_at && (!e.oldest || s.sent_at < e.oldest)) e.oldest = s.sent_at
          }
        }
        setRows([...m.values()].sort((a, b) => a.name.localeCompare(b.name)))
      } catch (e) {
        setProblem(/submissions/.test(e.message || '') ? 'Run database update 019 (submissions) in Supabase to see this.' : (e.message || String(e)))
      }
    })()
  }, [])

  const t = (rows || []).reduce((x, r) => ({ prepared: x.prepared + r.prepared, sent: x.sent + r.sent }), { prepared: 0, sent: 0 })
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Expected in the bank</h2>
      <p className="muted small">From submissions: prepared (not sent yet) and sent but not yet paid. Paid vouchers drop off automatically.</p>
      {problem && <div className="alert warn">{problem}</div>}
      {rows && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Company</th><th className="num">Prepared, not sent</th><th className="num">Sent, waiting for payment</th><th>Sent since</th><th className="num">Total expected</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong><div className="small"><Link to="/submissions">{r.subs.size} submission(s)</Link></div></td>
                  <td className="num">{r.preparedN ? <>{money(r.prepared)}<div className="small muted">{r.preparedN} vouchers</div></> : '—'}</td>
                  <td className="num">{r.sentN ? <>{money(r.sent)}<div className="small muted">{r.sentN} vouchers</div></> : '—'}</td>
                  <td>{r.oldest ? date(r.oldest) : '—'}</td>
                  <td className="num"><strong>{money(r.prepared + r.sent)}</strong></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="muted">Nothing expected yet — prepare a submission in Voucher management.</td></tr>}
              {rows.length > 0 && <tr><td><strong>Total</strong></td><td className="num"><strong>{money(t.prepared)}</strong></td><td className="num"><strong>{money(t.sent)}</strong></td><td /><td className="num"><strong>{money(t.prepared + t.sent)}</strong></td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {!rows && !problem && <p className="muted small">Loading…</p>}
    </div>
  )
}
