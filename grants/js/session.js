/* =====================================================================
   Toirem Grants – sign-in. Uses the same Supabase login and the same saved
   session as the donations app, so signing in to one signs you in to both.
   ===================================================================== */
const SESSION_KEY = 'toirem.session.v1';
const cfg = window.TOIREM_CONFIG || {};
const base = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
const key = cfg.supabaseKey;

let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
const save = (s) => { session = s; try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch (e) { /* private window */ } };
const keep = (j) => save({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, email: j.user && j.user.email });

async function authCall(path, body) {
  const res = await fetch(base + '/auth/v1/' + path, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = j.error_description || j.msg || j.message || j.error || 'Sign-in failed';
    throw new Error(/invalid login|invalid grant|credentials/i.test(m) ? 'Email or password is not right.' : /refresh token/i.test(m) ? 'Please sign in again.' : m);
  }
  return j;
}

let refreshing = null;
export async function token() {
  if (!session) return null;
  if (Date.now() < session.expires_at - 60000) return session.access_token;
  if (!refreshing) refreshing = authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
    .then(keep).catch(() => save(null)).finally(() => { refreshing = null; });
  await refreshing;
  return session ? session.access_token : null;
}
export const signedIn = () => !!session;
export const email = () => session && session.email;
export async function signIn(em, password) { keep(await authCall('token?grant_type=password', { email: String(em).trim(), password })); }
export function signOut() { save(null); }
export async function authHeader() { const t = await token(); return t ? { Authorization: 'Bearer ' + t } : {}; }
