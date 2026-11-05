import { useEffect, useState } from 'react'
import StoredImage from './StoredImage.jsx'
import { FIELD_LABELS, companyKnowledge } from '../lib/aiLearning.js'

const COLOURS = { voucher_number: '#2563eb', account_number: '#9333ea', amount: '#16a34a', date: '#ea580c' }
const KINDS = {
  digits: 'misread character', leading_zero: 'leading zero', missing_digit: 'missed character', extra_digit: 'extra character',
  wrong_place: 'wrong box', day_month: 'day/month swapped', not_on_voucher: 'not on voucher', different: 'different value', missed: 'left blank (missed)', company: 'wrong company',
}

// What the AI has learned about one company's vouchers: where each detail is, the patterns,
// and the lessons from corrections people made.
export default function LearnedPanel({ companyId }) {
  const [k, setK] = useState(null)
  const [picture, setPicture] = useState(null)

  useEffect(() => {
    companyKnowledge(companyId).then(async (know) => {
      setK(know || false)
      const sample = know?.examples?.[0]
      if (sample) setPicture(sample.thumb_path || sample.image_path)
    })
  }, [companyId])

  if (k === null) return <p className="muted small">Loading what the AI has learned…</p>
  if (!k || !k.checked) return <p className="muted small">Nothing learned yet — it starts once vouchers of this company are validated.</p>

  const fields = Object.keys(FIELD_LABELS)
  return (
    <div className="learned">
      <p className="small">
        Learned from <strong>{k.checked}</strong> checked voucher(s){k.checked >= 300 ? ' (latest 300)' : ''} ·{' '}
        <strong>{k.corrections.length}</strong> AI correction(s) · <strong>{k.barcodeMistakes.length}</strong> barcode correction(s)
      </p>

      <div className="learned-grid">
        <div>
          <div className="small muted">Where each detail is (learned)</div>
          {picture ? (
            <div className="layout-pic">
              <StoredImage path={picture} alt="Example voucher" />
              {fields.filter((f) => k.layout[f]).map((f) => {
                const [l, t, w, h] = k.layout[f]
                return (
                  <div key={f} className="layout-box" style={{ left: `${l * 100}%`, top: `${t * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, borderColor: COLOURS[f] }}>
                    <span style={{ background: COLOURS[f] }}>{FIELD_LABELS[f]}</span>
                  </div>
                )
              })}
            </div>
          ) : <div className="muted small">No picture yet.</div>}
          <ul className="small plain">
            {fields.map((f) => (
              <li key={f}>
                <span className="dot" style={{ background: COLOURS[f] }} /> {FIELD_LABELS[f]}:{' '}
                {k.layout[f] ? <strong>learned{k.layoutSource?.[f] === 'marked' ? ` (marked by people on ${k.layoutCount[f]} voucher${k.layoutCount[f] === 1 ? '' : 's'})` : ''}</strong> : <span className="muted">learning ({k.layoutCount[f] || 0} of 3 readings needed — or mark it once with 📍 on a voucher)</span>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="small muted">What the AI is told before reading</div>
          {k.facts ? <ul className="small">{k.facts.split('; ').map((f, i) => <li key={i}>{f}</li>)}</ul> : <p className="muted small">No patterns yet.</p>}
          {k.barcodeMistakes.length > 0 && (
            <div className="alert warn small">
              People corrected the barcode's value {k.barcodeMistakes.length} time(s) — the barcode rule may need checking
              (e.g. {k.barcodeMistakes.slice(0, 2).map((c) => `${FIELD_LABELS[c.field]} ${c.wrong_value} → ${c.right_value ?? 'deleted'}`).join('; ')}).
            </div>
          )}
        </div>
      </div>

      {k.corrections.length > 0 && (
        <details>
          <summary className="small">Latest corrections ({Math.min(20, k.corrections.length)})</summary>
          <table className="table small">
            <thead><tr><th>Field</th><th>AI read</th><th>Confirmed</th><th>Mistake</th></tr></thead>
            <tbody>
              {k.corrections.slice(0, 20).map((c, i) => (
                <tr key={i}>
                  <td>{FIELD_LABELS[c.field] || c.field}</td>
                  <td className="mono bad-text">{c.wrong_value ?? <span className="muted">(blank)</span>}</td>
                  <td className="mono">{c.right_value ?? <span className="muted">(none)</span>}</td>
                  <td>{KINDS[c.kind] || c.kind}{c.detail ? ` · ${c.detail}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}
