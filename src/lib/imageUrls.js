// Viewing links for voucher pictures that never go stale while a page is open.
//
// Pictures are private, so each needs a signed link that expires. This module:
//   - asks for links in groups (hundreds of rows = a few requests), valid 24 hours;
//   - keeps them in one shared memory, so every page reuses them;
//   - renews links that are on screen before they expire (every 10 minutes, and as soon as the
//     computer wakes up / the tab is shown again / the internet comes back);
//   - gives a fresh link whenever a picture fails to load (see StoredImage).
import { supabase } from './supabase.js'

const LIFE_SECONDS = 24 * 3600
const RENEW_BEFORE_MS = 2 * 3600 * 1000 // renew when less than 2 hours are left

const cache = new Map() // path → { url, expires }
const errors = new Map() // path → why the last link request failed
const listeners = new Map() // path → Set of functions(url)
const waiting = new Map() // path → [resolve, …]
let queue = new Set()
let timer = null

export function cachedUrl(path) {
  const c = path && cache.get(path)
  return c && c.expires - Date.now() > RENEW_BEFORE_MS ? c.url : null
}

export function pictureError(path) {
  return errors.get(path) || null
}

// Gets a link for a picture (from memory if still good). `fresh` forces a new link.
export function pictureUrl(path, fresh = false) {
  if (!path) return Promise.resolve(null)
  if (!fresh) {
    const u = cachedUrl(path)
    if (u) return Promise.resolve(u)
  }
  return new Promise((resolve) => {
    if (!waiting.has(path)) waiting.set(path, [])
    waiting.get(path).push(resolve)
    queue.add(path)
    if (!timer) timer = setTimeout(flush, 25) // collect the requests of a whole page into one
  })
}

async function flush() {
  timer = null
  const paths = [...queue]
  queue = new Set()
  for (let i = 0; i < paths.length; i += 100) {
    const part = paths.slice(i, i + 100)
    let data = null
    let problem = null
    try {
      const res = await supabase.storage.from('vouchers').createSignedUrls(part, LIFE_SECONDS)
      data = res.data
      if (res.error) problem = res.error.message || String(res.error)
    } catch (e) {
      problem = e.message || String(e) // offline or server busy — the pictures retry by themselves
    }
    const itemErrors = new Map((data || []).filter((d) => d.error).map((d) => [d.path, d.error]))
    const got = new Map((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]))
    for (const p of part) {
      const url = got.get(p) || null
      if (!url) errors.set(p, itemErrors.get(p) || problem || 'No link returned')
      if (url) {
        errors.delete(p)
        cache.set(p, { url, expires: Date.now() + LIFE_SECONDS * 1000 })
        for (const fn of listeners.get(p) || []) fn(url)
      }
      for (const resolve of waiting.get(p) || []) resolve(url)
      waiting.delete(p)
    }
  }
}

// A picture on screen registers here so its link is kept fresh. Returns the "unregister" function.
export function watchPicture(path, fn) {
  if (!listeners.has(path)) listeners.set(path, new Set())
  listeners.get(path).add(fn)
  return () => {
    const set = listeners.get(path)
    if (!set) return
    set.delete(fn)
    if (!set.size) listeners.delete(path)
  }
}

// Renews links of pictures on screen that are about to expire (or have no link).
function renewDue() {
  for (const path of listeners.keys()) {
    const c = cache.get(path)
    if (!c || c.expires - Date.now() < RENEW_BEFORE_MS) pictureUrl(path, true)
  }
}

if (typeof window !== 'undefined') {
  setInterval(renewDue, 10 * 60 * 1000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renewDue() })
  window.addEventListener('online', renewDue)
  window.addEventListener('focus', renewDue)
}
