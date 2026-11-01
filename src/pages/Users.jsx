import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { ROLE_LABELS, date } from '../lib/format.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox } from '../components.jsx'

export default function Users() {
  const { session } = useAuth()
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)

  function load() {
    supabase.from('profiles').select('*').order('created_at').then(({ data, error }) => {
      if (error) setError(error)
      else setRows(data)
    })
  }
  useEffect(load, [])

  async function change(row, patch) {
    setError(null)
    if (row.id === session.user.id && (patch.role && patch.role !== 'admin' || patch.active === false)) {
      setError("You can't remove your own admin access.")
      return
    }
    const { error } = await supabase.from('profiles').update(patch).eq('id', row.id)
    if (error) setError(error)
    else {
      setRows(rows.map((r) => (r.id === row.id ? { ...r, ...patch } : r)))
      setSaved(row.id)
      setTimeout(() => setSaved(null), 1500)
    }
  }

  return (
    <>
      <div className="page-head"><h1>Users</h1></div>
      <div className="alert info">
        <strong>Adding a new user:</strong> in Supabase, open <em>Authentication → Users → Add user → Create new user</em>,
        enter their email and a temporary password, and tick <em>Auto Confirm User</em>. They then appear here as
        <em> Batch entry</em>; change their role below if needed.
      </div>
      <ErrorBox error={error} />
      <table className="table">
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Active</th><th>Added</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.email}</td>
              <td>
                <input className="inline" defaultValue={r.full_name || ''} placeholder="Add name"
                  onBlur={(e) => e.target.value !== (r.full_name || '') && change(r, { full_name: e.target.value.trim() || null })} />
              </td>
              <td>
                <select value={r.role} onChange={(e) => change(r, { role: e.target.value })}>
                  {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </td>
              <td><input type="checkbox" checked={r.active} onChange={(e) => change(r, { active: e.target.checked })} /></td>
              <td>{date(r.created_at)}</td>
              <td className="ok-text">{saved === r.id ? 'Saved' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>What each role can do</h3>
      <ul className="muted">
        <li><strong>Batch entry:</strong> create batches, upload vouchers, validate, add collectors.</li>
        <li><strong>Reconciler:</strong> view everything; sending and reconciliation tools arrive in the next version.</li>
        <li><strong>Admin:</strong> everything, plus companies, users and corrections such as collector references.</li>
      </ul>
    </>
  )
}
