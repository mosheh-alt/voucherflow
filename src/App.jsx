import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import VoucherSearch from './components/VoucherSearch.jsx'
import Submissions from './pages/Submissions.jsx'
import { useAuth } from './auth.jsx'
import { ROLE_LABELS } from './lib/format.js'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Batches from './pages/Batches.jsx'
import BatchDetail from './pages/BatchDetail.jsx'
import Validate from './pages/Validate.jsx'
import Collectors from './pages/Collectors.jsx'
import Companies from './pages/Companies.jsx'
import Users from './pages/Users.jsx'
import Reports from './pages/Reports.jsx'
import AiReading from './pages/AiReading.jsx'
import Pool from './pages/Pool.jsx'

export default function App() {
  const { session, profile, loading, can, signOut } = useAuth()

  if (loading) return <div className="center-page muted">Loading…</div>
  if (!session) return <Login />
  if (!profile || !profile.active) {
    return (
      <div className="center-page">
        <div className="card narrow">
          <h2>Account not active</h2>
          <p>Your login works, but your account hasn't been activated. Ask an admin to activate it.</p>
          <button className="btn" onClick={signOut}>Sign out</button>
        </div>
      </div>
    )
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">VoucherFlow</div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/batches">Batches</NavLink>
          <NavLink to="/vouchers">Voucher pool</NavLink>
          <NavLink to="/collectors">Collectors</NavLink>
          <NavLink to="/submissions">Submissions</NavLink>
          <NavLink to="/search">Find</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          <div className="nav-group">Settings</div>
          <NavLink to="/companies">Companies</NavLink>
          <NavLink to="/ai">AI reading</NavLink>
          {can('admin') && <NavLink to="/users">Users</NavLink>}
        </nav>
        <div className="me">
          <div className="me-name">{profile.full_name || profile.email}</div>
          <div className="me-role">{ROLE_LABELS[profile.role]}</div>
          <button className="btn-link" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/batches" element={<Batches />} />
          <Route path="/batches/:id" element={<BatchDetail />} />
          <Route path="/batches/:id/validate" element={<Validate />} />
          <Route path="/collectors" element={<Collectors />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/users" element={can('admin') ? <Users /> : <Navigate to="/" />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/search" element={<><div className="page-head"><h1>Find vouchers</h1></div><VoucherSearch /></>} />
          <Route path="/ai" element={<AiReading />} />
          <Route path="/vouchers" element={<Pool />} />
          <Route path="/submissions" element={<Submissions />} />
          <Route path="/submissions/:id" element={<Submissions />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  )
}
