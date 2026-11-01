import { STATUS_LABELS } from './lib/format.js'

export function StatusPill({ status }) {
  return <span className={`pill s-${status}`}>{STATUS_LABELS[status] || status}</span>
}

export function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-link" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function ErrorBox({ error }) {
  if (!error) return null
  return <div className="alert error">{typeof error === 'string' ? error : error.message}</div>
}

export function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
