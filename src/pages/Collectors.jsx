import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../auth.jsx'
import { ErrorBox, Modal } from '../components.jsx'

const EMPTY = { reference: '', name: '', email: '', phone: '', notes: '', active: true }

export default function Collectors() {
  const { can } = useAuth()
  const [rows, setRows] = useState([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState(null)

  function load() {
    supabase.from('collectors').select('*').order('reference').then(({ data, error }) => {
      if (error) setError(error)
      else setRows(data)
    })
  }
  useEffect(load, [])

  const q = search.trim().toLowerCase()
  const shown = q ? rows.filter((r) => `${r.reference} ${r.name} ${r.email || ''}`.toLowerCase().includes(q)) : rows
  const canEdit = can('admin', 'batch_entry')

  return (
    <>
      <div className="page-head">
        <h1>Collectors</h1>
        {canEdit && <button className="btn primary" onClick={() => setEditing(EMPTY)}>Add collector</button>}
      </div>
      <input className="search" placeholder="Search reference, name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ErrorBox error={error} />
      <table className="table">
        <thead><tr><th>Reference</th><th>Name</th><th>Email</th><th>Phone</th><th>Status</th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className={canEdit ? 'clickable' : ''} onClick={() => canEdit && setEditing(r)}>
              <td className="mono">{r.reference}</td>
              <td>{r.name}</td>
              <td>{r.email || '—'}</td>
              <td>{r.phone || '—'}</td>
              <td>{r.active ? 'Active' : <span className="muted">Inactive</span>}</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={5} className="muted">No collectors found.</td></tr>}
        </tbody>
      </table>
      {editing && (
        <CollectorForm
          initial={editing}
          isAdmin={can('admin')}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </>
  )
}

function CollectorForm({ initial, isAdmin, onClose, onSaved }) {
  const [f, setF] = useState(initial)
  const [error, setError] = useState(null)
  const isNew = !initial.id
  const set = (k, v) => setF({ ...f, [k]: v })

  async function save(e) {
    e.preventDefault()
    const row = {
      reference: f.reference.trim(),
      name: f.name.trim(),
      email: f.email?.trim() || null,
      phone: f.phone?.trim() || null,
      notes: f.notes?.trim() || null,
      active: f.active,
    }
    if (!row.reference) return setError('Reference number is required.')
    const { error } = isNew
      ? await supabase.from('collectors').insert(row)
      : await supabase.from('collectors').update(row).eq('id', initial.id)
    if (error) setError(error.code === '23505' ? 'That reference number is already used.' : error)
    else onSaved()
  }

  return (
    <Modal title={isNew ? 'Add collector' : `Collector ${initial.reference}`} onClose={onClose}>
      <form onSubmit={save}>
        <label>Reference number *
          <input value={f.reference} onChange={(e) => set('reference', e.target.value)} disabled={!isNew && !isAdmin} autoFocus={isNew} />
        </label>
        {!isNew && !isAdmin && <div className="muted small">Only an admin can change a reference number.</div>}
        <label>Name <span className="muted">(optional)</span><input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>Email (for reports and receipts)<input type="email" value={f.email || ''} onChange={(e) => set('email', e.target.value)} /></label>
        <label>Phone<input value={f.phone || ''} onChange={(e) => set('phone', e.target.value)} /></label>
        <label>Notes<input value={f.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Active</label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  )
}
