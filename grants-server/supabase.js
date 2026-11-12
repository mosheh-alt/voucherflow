/* =====================================================================
   Toirem Grants – server-side access to Supabase (runs in Cloudflare Pages Functions only).
   Uses the SECRET key, which never reaches the browser. All grants tables live in the
   "grants" schema, so every request names that schema.
   ===================================================================== */

export function createDb(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SECRET_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in Cloudflare.');
  const auth = { apikey: key, Authorization: 'Bearer ' + key };

  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const headers = { ...auth, 'Accept-Profile': 'grants', 'Content-Profile': 'grants', 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(base + '/rest/v1/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error('Database: ' + ((data && (data.message || data.hint)) || res.status));
    return data;
  }

  return {
    /** GET rows. query is a PostgREST query string, e.g. "applications?select=*&id=eq.x" */
    select: (query) => rest(query),
    one: async (query) => { const r = await rest(query); return Array.isArray(r) ? r[0] || null : r; },
    insert: (table, rows, { returning = true } = {}) =>
      rest(table, { method: 'POST', body: rows, prefer: returning ? 'return=representation' : 'return=minimal' }),
    update: (table, filter, patch) => rest(table + '?' + filter, { method: 'PATCH', body: patch, prefer: 'return=representation' }),

    /** Upload a File/Blob to the private "grant-files" bucket. */
    async upload(path, file) {
      const res = await fetch(base + '/storage/v1/object/grant-files/' + encodePath(path), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' },
        body: file,
      });
      if (!res.ok) throw new Error('Upload failed: ' + (await res.text()).slice(0, 200));
    },
    /** A download link that works for a few minutes (office only). */
    async signedUrl(path, seconds = 300) {
      const res = await fetch(base + '/storage/v1/object/sign/grant-files/' + encodePath(path), {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: seconds }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.signedURL) return null;
      return base + '/storage/v1' + j.signedURL;
    },
    /** Who is signed in? Checks the browser's sign-in token with Supabase. */
    async userFromToken(token) {
      if (!token) return null;
      const res = await fetch(base + '/auth/v1/user', { headers: { apikey: key, Authorization: 'Bearer ' + token } });
      if (!res.ok) return null;
      return res.json();
    },
  };
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/* ---------- one-time links: only a hash of the token is stored ---------- */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token || '')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- files ---------- */
export const FILE_KINDS = ['bank_proof', 'invoice', 'breakdown_proof', 'receipt', 'bank_confirmation'];
const OK_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export function checkFile(f, label) {
  if (!f || typeof f === 'string') return 'Upload ' + label + '.';
  if (f.size > 10 * 1024 * 1024) return label[0].toUpperCase() + label.slice(1) + ' must be under 10 MB.';
  if (!OK_TYPES.includes(f.type)) return label[0].toUpperCase() + label.slice(1) + ' must be a PDF, JPG or PNG.';
  return null;
}

/** Store an uploaded file and record it. Returns the new files row id. */
export async function storeFile(db, applicationId, kind, file) {
  const safe = String(file.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120);
  const path = applicationId + '/' + kind + '/' + crypto.randomUUID() + '-' + safe;
  await db.upload(path, file);
  const [row] = await db.insert('files', [{ application_id: applicationId, kind, storage_path: path, original_name: file.name || safe }]);
  return row.id;
}
