import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { AI_FUNCTION_VERSION, aiEnabled, aiHealth, aiReadMany, aiSettings, aiTest, setAiEnabled, setAiSetting } from '../lib/ai.js'
import { companyKnowledge, forgetKnowledge } from '../lib/aiLearning.js'
import { money } from '../lib/format.js'
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

  const [settings, setSettings] = useState(null)
  useEffect(() => { aiSettings().then(setSettings).catch(() => setSettings({ firstModel: 'fast', learning: true })) }, [])

  async function changeSetting(key, value, local) {
    try {
      await setAiSetting(key, value)
      setSettings((s) => ({ ...s, ...local }))
      forgetKnowledge()
    } catch (e) {
      setError(e)
    }
  }

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

      <AiHealthCard />

      {settings && (
        <div className="card">
          <strong>How the AI reads</strong>
          <div className="grid2" style={{ marginTop: 8 }}>
            <label>First reading with
              <select value={settings.firstModel} disabled={!can('admin')}
                onChange={(e) => changeSetting('ai_model', e.target.value, { firstModel: e.target.value })}>
                <option value="fast">Quick model (Claude Haiku) — cheapest; stronger model only when needed</option>
                <option value="strong">Strong model (Claude Sonnet) — best at handwriting, costs more</option>
              </select>
            </label>
            <label>Learning from checked vouchers
              <select value={settings.learning ? 'on' : 'off'} disabled={!can('admin')}
                onChange={(e) => changeSetting('ai_learning', e.target.value === 'on', { learning: e.target.value === 'on' })}>
                <option value="on">On — shows the AI examples you've corrected (recommended)</option>
                <option value="off">Off</option>
              </select>
            </label>
          </div>
          <p className="muted small">
            With learning on, before reading a voucher the AI is shown up to 3 vouchers of the same company that people
            have already checked — mistakes it made before come first — and told the patterns found in them
            (number lengths, usual amounts, Hebrew dates). Answers that don't fit get a second reading with the strong
            model, and anything still doubtful is marked <span className="flag warn">AI unsure</span> in orange.
            Every voucher you correct and validate teaches the next reading.
          </p>
        </div>
      )}

      <AiTestBench />

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

const METHODS = [
  { key: 'fast', label: 'Quick model, no learning (the old way)', strong: false, learning: false },
  { key: 'fast_learn', label: 'Quick model + learning', strong: false, learning: true },
  { key: 'strong_learn', label: 'Strong model + learning', strong: true, learning: true },
  { key: 'strong', label: 'Strong model, no learning', strong: true, learning: false },
]

// Tries the AI on vouchers people have already checked and scores each method.
function AiTestBench() {
  const [companies, setCompanies] = useState([])
  const [companyId, setCompanyId] = useState('')
  const [count, setCount] = useState(10)
  const [picked, setPicked] = useState(['fast', 'fast_learn', 'strong_learn'])
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [known, setKnown] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    supabase.from('companies').select('*').order('name').then(({ data }) => setCompanies(data || []))
  }, [])
  useEffect(() => {
    setKnown(null)
    if (companyId) companyKnowledge(companyId).then(setKnown)
  }, [companyId])

  async function run() {
    const company = companies.find((c) => c.id === companyId)
    if (!company) return setError('Choose a company.')
    setError(null)
    setResult(null)
    setProgress({ done: 0, total: count * picked.length })
    try {
      const r = await aiTest({
        company, companies, count,
        methods: METHODS.filter((m) => picked.includes(m.key)),
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setResult(r)
    } catch (e) {
      setError(e)
    }
    setProgress(null)
  }

  const fieldKeys = ['voucher_number', 'account_number', 'amount', 'date']

  return (
    <div className="card">
      <strong>Test the AI on vouchers you've already checked</strong>
      <p className="muted small">
        Picks checked vouchers at random, lets the AI read them again with each method, and compares the answers with
        the confirmed values. Nothing is changed. Each voucher read by each method is one AI request.
      </p>
      <div className="filters">
        <label>Company
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">— choose —</option>
            {companies.filter((c) => c.active !== false).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Vouchers
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[5, 10, 20, 40].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={!companyId || !picked.length || Boolean(progress)} onClick={run}>
          {progress ? `Testing ${progress.done} of ${progress.total}…` : 'Run test'}
        </button>
      </div>
      <div className="method-pick">
        {METHODS.map((m) => (
          <label key={m.key} className="check">
            <input type="checkbox" checked={picked.includes(m.key)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, m.key] : picked.filter((k) => k !== m.key))} />
            {m.label}
          </label>
        ))}
      </div>
      {known && (
        <p className="small">
          Learned so far for this company: <strong>{known.checked}</strong> checked voucher(s){known.checked >= 300 ? ' (latest 300 used)' : ''},
          {' '}<strong>{known.corrections.length}</strong> AI correction(s) recorded, {known.examples.length ? `${Math.min(3, known.examples.length)} example(s) ready` : 'no examples yet'}.
          {known.facts && <><br /><span className="muted">What it's told: {known.facts}.</span></>}
        </p>
      )}
      <ErrorBox error={error} />

      {result && (
        <>
          <p className="small">Tested on <strong>{result.tested}</strong> voucher(s). <span className="ok-text">Right</span> · <span className="bad-text">wrong</span> · left blank.</p>
          <div className="table-wrap">
            <table className="table test-results">
              <thead>
                <tr><th>Method</th>{fieldKeys.map((k) => <th key={k} className="num">{({ voucher_number: 'Voucher no.', account_number: 'Account no.', amount: 'Amount', date: 'Date' })[k]}</th>)}<th className="num">Overall</th></tr>
              </thead>
              <tbody>
                {result.results.map((r) => {
                  const all = Object.values(r.fields).reduce((t, f) => ({ right: t.right + f.right, n: t.n + f.right + f.wrong + f.blank }), { right: 0, n: 0 })
                  return (
                    <tr key={r.key}>
                      <td><strong>{r.label}</strong>{r.failed > 0 && <div className="bad-text small">{r.failed} failed: {r.error}</div>}</td>
                      {fieldKeys.map((k) => {
                        const f = r.fields[k]
                        if (!f) return <td key={k} className="num muted">—</td>
                        const n = f.right + f.wrong + f.blank
                        const p = Math.round((f.right / n) * 100)
                        return (
                          <td key={k} className="num">
                            <strong className={p >= 98 ? 'ok-text' : p >= 90 ? 'warn-text' : 'bad-text'}>{p}%</strong>
                            <div className="small muted">{f.right} · <span className={f.wrong ? 'bad-text' : ''}>{f.wrong}</span> · {f.blank}</div>
                          </td>
                        )
                      })}
                      <td className="num"><strong>{all.n ? Math.round((all.right / all.n) * 100) : 0}%</strong></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {result.results.some((r) => r.mistakes.length) && (
            <details>
              <summary>Show the mistakes</summary>
              <table className="table">
                <thead><tr><th>Method</th><th>Voucher</th><th>Field</th><th>AI read</th><th>Confirmed</th></tr></thead>
                <tbody>
                  {result.results.flatMap((r) => r.mistakes.map((m, i) => (
                    <tr key={`${r.key}-${i}`}>
                      <td className="small">{r.label}</td>
                      <td className="mono"><a href={`/batches/${m.batchId}`}>{m.number}</a></td>
                      <td>{m.field}</td>
                      <td className="mono bad-text">{m.field === 'Amount' ? money(m.got) : String(m.got)}</td>
                      <td className="mono">{m.field === 'Amount' ? money(m.want) : String(m.want)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </div>
  )
}

// Is the AI working? Function version, AI key, and vouchers it couldn't read (with a retry).
function AiHealthCard() {
  const [health, setHealth] = useState(null)
  const [failed, setFailed] = useState(null)
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)

  async function check() {
    setHealth(null)
    setHealth(await aiHealth())
    const { data } = await supabase.from('vouchers').select('id, batch_id, image_path, company_id, company_hint, voucher_number, donor_account, amount, expiry_date, barcode_read, barcode_raw, ai_data, status')
      .eq('status', 'pending').is('deleted_at', null).not('ai_data->>error', 'is', null).limit(500)
    setFailed(data || [])
  }
  useEffect(() => { check() }, [])

  async function retryAll() {
    setNote(null)
    const { data: companies } = await supabase.from('companies').select('*')
    setBusy({ done: 0, total: failed.length })
    const { updated, failures } = await aiReadMany(failed.map((voucher) => ({ voucher })), companies || [], (done, total) => setBusy({ done, total }))
    setBusy(null)
    setNote(`${updated} of ${failed.length} read.` + (failures.length ? ` Still failing: ${failures[0]}` : ''))
    check()
  }

  const reasons = {}
  for (const v of failed || []) {
    const r = String(v.ai_data?.error || 'Unknown').replace(/\(\d+\)$/, '').slice(0, 120)
    reasons[r] = (reasons[r] || 0) + 1
  }

  return (
    <div className="card">
      <div className="row between">
        <strong>Health check</strong>
        <button className="btn" onClick={check}>Check again</button>
      </div>
      {!health ? <p className="muted small">Checking…</p> : health.ok ? (
        <p className="ok-text">✓ The AI function is working and up to date (version {health.version}).</p>
      ) : health.problem === 'outdated' ? (
        <div className="alert warn">
          The AI function in Supabase is out of date{health.version ? ` (version ${health.version}, needs ${AI_FUNCTION_VERSION})` : ''}.
          To update: open <a href="https://github.com/mosheh-alt/voucherflow/blob/main/supabase/functions/read-voucher/index.ts" target="_blank" rel="noreferrer">index.ts on GitHub</a> →
          copy → Supabase → Edge Functions → read-voucher → Code → Ctrl+A, Ctrl+V → Deploy. Then click "Check again".
        </div>
      ) : <div className="alert bad">The AI function isn't working: {health.problem}</div>}

      {failed && (failed.length === 0
        ? <p className="muted small">No pending vouchers waiting on a failed AI reading.</p>
        : (
          <>
            <p className="small"><strong>{failed.length}</strong> pending voucher(s) the AI couldn't read:</p>
            <ul className="small">{Object.entries(reasons).map(([r, n]) => <li key={r}>{n} × {r}</li>)}</ul>
            <button className="btn primary" disabled={Boolean(busy) || !health?.ok} onClick={retryAll}>
              {busy ? `Reading ${busy.done} of ${busy.total}…` : `Retry all ${failed.length}`}
            </button>
          </>
        ))}
      {note && <p className="small">{note}</p>}
    </div>
  )
}
