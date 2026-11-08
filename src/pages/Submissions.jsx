import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { METHOD_LABELS, date, money, today } from '../lib/format.js'
import { downloadCSV } from '../lib/csv.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Modal } from '../components.jsx'
import {
  SUBMISSION_STATUS, addonVersion, buildUploadJob, cancelSubmission, confirmResultHandled, downloadPictures,
  listenForAddonResults, loadSubmission, markSubmissionSent, removeFromSubmission, sendJobToAddon,
} from '../lib/submissions.js'

// List of submissions, or one submission when an id is in the address.
export default function Submissions() {
  const { id } = useParams()
  return id ? <SubmissionDetail id={id} /> : <SubmissionList />
}

function SubmissionList() {
  const [rows, setRows] = useState(null)
  const [companies, setCompanies] = useState({})
  const [error, setError] = useState(null)

  useEffect(() => {
    supabase.from('companies').select('id, name').then(({ data }) => setCompanies(Object.fromEntries((data || []).map((c) => [c.id, c.name]))))
    supabase.from('submissions').select('*').order('created_at', { ascending: false }).limit(200).then(({ data, error }) => {
      if (error) setError(/submissions/.test(error.message || '') ? 'Run database update 019 (submissions) in Supabase first.' : error)
      else setRows(data || [])
    })
  }, [])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Submissions</h1>
          <div className="muted">Each submission is one send of vouchers to one company. Create them from Voucher management: select vouchers → <em>Prepare submission</em>.</div>
        </div>
        <Link className="btn" to="/vouchers">Go to voucher management</Link>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>#</th><th>Company</th><th>How</th><th className="num">Vouchers</th><th className="num">Total</th><th>Status</th><th>Created</th><th>Sent</th></tr></thead>
          <tbody>
            {(rows || []).map((s) => (
              <tr key={s.id}>
                <td><Link to={`/submissions/${s.id}`}><strong>#{s.submission_no}</strong></Link></td>
                <td>{companies[s.company_id] || '—'}</td>
                <td>{METHOD_LABELS[s.method] || s.method}</td>
                <td className="num">{s.voucher_count}</td>
                <td className="num">{money(s.total)}</td>
                <td><span className={`flag ${s.status === 'sent' ? 'ok-flag' : s.status === 'cancelled' ? '' : 'warn'}`}>{SUBMISSION_STATUS[s.status] || s.status}</span></td>
                <td>{date(s.created_at)}</td>
                <td>{s.sent_at ? date(s.sent_at) : '—'}{s.reference ? <div className="small muted">ref {s.reference}</div> : null}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan={8} className="muted">No submissions yet.</td></tr>}
            {!rows && !error && <tr><td colSpan={8} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

function SubmissionDetail({ id }) {
  const { session, can } = useAuth()
  const [sub, setSub] = useState(null)
  const [vouchers, setVouchers] = useState([])
  const [company, setCompany] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(null)
  const [sending, setSending] = useState(false)
  const [addon, setAddon] = useState(addonVersion())

  const load = useCallback(async () => {
    try {
      const r = await loadSubmission(id)
      setSub(r.submission)
      setVouchers(r.vouchers)
      const { data: c } = await supabase.from('companies').select('*').eq('id', r.submission.company_id).single()
      setCompany(c)
    } catch (e) {
      setError(e)
    }
  }, [id])
  useEffect(() => { load() }, [load])

  // The add-on may load a moment after the page.
  useEffect(() => {
    const t = setInterval(() => setAddon(addonVersion()), 1000)
    return () => clearInterval(t)
  }, [])

  // When the add-on reports the portal upload as submitted, mark the submission as sent.
  useEffect(() => {
    if (!sub || sub.status === 'sent') return undefined
    return listenForAddonResults(async (result) => {
      if (result?.id !== sub.id || !result.submitted) return
      try {
        await markSubmissionSent(sub, { reference: result.reference || `AAC portal upload ${today()}`, method: 'portal', userId: session.user.id })
        confirmResultHandled(sub.id)
        setNotice(`The add-on uploaded ${result.uploaded} picture(s) and you submitted them on the portal — submission #${sub.submission_no} is now marked as sent.`)
        await load()
      } catch (e) {
        setError(e)
      }
    })
  }, [sub, session, load])

  const total = useMemo(() => vouchers.reduce((t, v) => t + Number(v.amount || 0), 0), [vouchers])
  if (!sub) return <div className="muted">{error ? <ErrorBox error={error} /> : 'Loading…'}</div>
  const open = sub.status === 'draft'
  const canAct = can('admin', 'reconciler', 'batch_entry')

  async function startAddonUpload() {
    setError(null)
    setBusy('Preparing the upload…')
    try {
      const job = await buildUploadJob(sub, company, vouchers)
      sendJobToAddon(job)
      setNotice(`Sent to the add-on: ${job.count} picture(s). A new tab opens on the ${company?.name || 'company'} portal — log in if asked, then follow the VoucherFlow box in the corner.`)
    } catch (e) {
      setError(e)
    }
    setBusy(null)
  }

  async function savePictures() {
    setError(null)
    try {
      const n = await downloadPictures(vouchers, (d, t) => setBusy(`Saving pictures ${d} of ${t}…`))
      setBusy(null)
      if (n) setNotice(`${n} picture(s) saved, named by voucher number — drag them into the portal's upload box.`)
    } catch (e) {
      setBusy(null)
      setError(e)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs"><Link to="/submissions">Submissions</Link> / #{sub.submission_no}</div>
          <h1>Submission #{sub.submission_no} · {company?.name}</h1>
          <div className="muted">
            {sub.voucher_count} voucher(s) · <strong>{money(sub.total)}</strong> · {METHOD_LABELS[sub.method] || sub.method} ·{' '}
            <span className={`flag ${sub.status === 'sent' ? 'ok-flag' : 'warn'}`}>{SUBMISSION_STATUS[sub.status]}</span>
            {sub.sent_at && <> · sent {date(sub.sent_at)}{sub.reference ? ` · ref ${sub.reference}` : ''}</>}
          </div>
        </div>
      </div>
      <ErrorBox error={error} />
      {notice && <div className="alert ok">{notice}</div>}
      {busy && <div className="alert">{busy}</div>}

      {open && canAct && (
        <div className="card">
          <strong>Send it</strong>
          <ol className="send-steps">
            <li>
              <strong>Automatic upload with the VoucherFlow add-on</strong>{' '}
              {addon ? <span className="flag ok-flag">add-on installed (v{addon})</span> : <span className="flag warn">add-on not found in this browser</span>}
              <div className="muted small">Opens the portal, adds all the pictures, waits until each one is uploaded, clicks Continue — and stops before Submit for you to check and submit.</div>
              <button className="btn primary" disabled={!addon || Boolean(busy) || !vouchers.length} onClick={startAddonUpload}>Upload with the add-on</button>
            </li>
            <li>
              <strong>Or by hand:</strong> save the pictures, then drag them into the portal's upload box.
              <div className="row gap" style={{ marginTop: 6 }}>
                <button className="btn" disabled={Boolean(busy) || !vouchers.length} onClick={savePictures}>Save pictures to a folder</button>
                {company?.portal_url && <a className="btn" href={company.portal_url} target="_blank" rel="noreferrer">Open the portal</a>}
              </div>
            </li>
            <li>
              When you've submitted on the portal, <button className="btn-link" onClick={() => setSending(true)}>mark this submission as sent</button>{' '}
              <span className="muted small">(done for you automatically when the add-on is used).</span>
            </li>
          </ol>
          <button className="btn danger small-btn" onClick={async () => {
            if (!window.confirm('Cancel this submission? Its vouchers go back to "Ready to send".')) return
            try { await cancelSubmission(sub); await load() } catch (e) { setError(e) }
          }}>Cancel submission</button>
        </div>
      )}

      <SubmissionReport sub={sub} company={company} vouchers={vouchers} />

      <h2>Vouchers in this submission</h2>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Voucher no.</th><th>Account no.</th><th className="num">Amount</th><th>Date</th><th>Collector</th><th>Status</th><th /></tr></thead>
          <tbody>
            {vouchers.map((v) => (
              <tr key={v.id}>
                <td className="mono">{v.voucher_number}</td>
                <td className="mono">{v.donor_account || '—'}</td>
                <td className="num">{money(v.amount)}</td>
                <td>{date(v.expiry_date)}</td>
                <td className="mono">{v.collector_reference}</td>
                <td>{v.status}</td>
                <td>{open && canAct && <button className="btn small-btn" onClick={async () => { try { await removeFromSubmission(sub.id, v.id); await load() } catch (e) { setError(e) } }}>Take out</button>}</td>
              </tr>
            ))}
            <tr><td colSpan={2}><strong>Total</strong></td><td className="num"><strong>{money(total)}</strong></td><td colSpan={4} /></tr>
          </tbody>
        </table>
      </div>

      {sending && <SentForm sub={sub} onClose={() => setSending(false)} onDone={async () => { setSending(false); setNotice('Marked as sent.'); await load() }} userId={session.user.id} />}
    </>
  )
}

function SentForm({ sub, onClose, onDone, userId }) {
  const [reference, setReference] = useState('')
  const [method, setMethod] = useState(sub.method || 'portal')
  const [when, setWhen] = useState(today())
  const [error, setError] = useState(null)
  return (
    <Modal title={`Mark submission #${sub.submission_no} as sent`} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault()
        try { await markSubmissionSent(sub, { reference: reference.trim(), method, userId, when }); await onDone() } catch (err) { setError(err) }
      }}>
        <label>How it was sent
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Reference from the company <span className="muted">(optional)</span><input value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        <label>Date sent<input type="date" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Mark as sent</button>
        </div>
      </form>
    </Modal>
  )
}

// The report for one submission: what is being sent, the total, and what to expect in the bank.
// Printable (or "Save as PDF" from the print window) and downloadable as CSV.
function SubmissionReport({ sub, company, vouchers }) {
  const total = vouchers.reduce((t, v) => t + Number(v.amount || 0), 0)
  const byAmount = Object.entries(vouchers.reduce((m, v) => { const k = Number(v.amount || 0).toFixed(2); m[k] = (m[k] || 0) + 1; return m }, {}))
    .sort((a, b) => Number(b[0]) - Number(a[0]))
  const sentOn = sub.sent_at ? date(sub.sent_at) : null
  function exportCSV() {
    downloadCSV(`submission-${sub.submission_no}_${(company?.name || 'company').replace(/\W+/g, '-')}.csv`, [
      { label: 'Submission', value: () => sub.submission_no },
      { label: 'Company', value: () => company?.name || '' },
      { label: 'Voucher no.', value: 'voucher_number' },
      { label: 'Account no.', value: 'donor_account' },
      { label: 'Amount £', value: (v) => (v.amount == null ? '' : Number(v.amount).toFixed(2)) },
      { label: 'Date on voucher', value: 'expiry_date' },
      { label: 'Collector ref', value: 'collector_reference' },
    ], vouchers)
  }
  return (
    <div className="card print-area submission-report">
      <div className="row between no-print">
        <strong>Report</strong>
        <div className="row gap">
          <button className="btn" onClick={exportCSV}>Export CSV</button>
          <button className="btn primary" onClick={() => window.print()}>Print / save as PDF</button>
        </div>
      </div>
      <h2 style={{ marginTop: 8 }}>{company?.name} — submission #{sub.submission_no}</h2>
      <table className="report-facts">
        <tbody>
          <tr><td>Prepared</td><td>{date(sub.created_at)}</td></tr>
          <tr><td>How it's sent</td><td>{METHOD_LABELS[sub.method] || sub.method}</td></tr>
          <tr><td>Status</td><td>{SUBMISSION_STATUS[sub.status]}{sentOn ? ` on ${sentOn}` : ''}{sub.reference ? ` · ref ${sub.reference}` : ''}</td></tr>
          <tr><td>Vouchers</td><td><strong>{vouchers.length}</strong></td></tr>
          <tr className="big"><td>Expected in the bank</td><td><strong>{money(total)}</strong> from {company?.name}</td></tr>
        </tbody>
      </table>
      {byAmount.length > 1 && (
        <p className="small muted">By amount: {byAmount.map(([a, n]) => `${n} × £${a}`).join(' · ')}</p>
      )}
      <table className="table report-list">
        <thead><tr><th>#</th><th>Voucher no.</th><th>Account no.</th><th>Date on voucher</th><th>Collector</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {vouchers.map((v, i) => (
            <tr key={v.id}><td>{i + 1}</td><td className="mono">{v.voucher_number}</td><td className="mono">{v.donor_account || ''}</td><td>{date(v.expiry_date)}</td><td className="mono">{v.collector_reference}</td><td className="num">{money(v.amount)}</td></tr>
          ))}
          <tr><td colSpan={5}><strong>Total ({vouchers.length} vouchers)</strong></td><td className="num"><strong>{money(total)}</strong></td></tr>
        </tbody>
      </table>
    </div>
  )
}
