import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { AuthProvider } from './auth.jsx'
import { configured } from './lib/supabase.js'
import './styles.css'

function NotConfigured() {
  return (
    <div className="center-page">
      <div className="card narrow">
        <h1>VoucherFlow</h1>
        <p>
          The app isn't connected to its database yet. In Cloudflare, add the environment
          variables <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then
          redeploy.
        </p>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {configured ? (
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    ) : (
      <NotConfigured />
    )}
  </React.StrictMode>
)
