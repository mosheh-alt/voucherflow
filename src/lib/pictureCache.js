// Fast voucher pictures: every picture is downloaded once and then kept on this computer.
//
// Voucher pictures never change once uploaded, so after the first download they're kept in the
// browser's own picture store (Cache Storage) under their storage path. Opening a batch again —
// tomorrow, next week — shows them instantly from the computer, with no download and no expiring
// links. Only pictures not seen before are downloaded, a few at a time, nearest first.
import { pictureError, pictureUrl } from './imageUrls.js'

const STORE = 'voucherflow-pictures-v1'
const MAX_PARALLEL = 6
const MAX_IN_MEMORY = 500 // picture handles kept ready in this page

const ready = new Map() // path → object URL (most recently used last)
const loading = new Map() // path → promise
let running = 0
const queue = []

const canStore = typeof caches !== 'undefined' && typeof window !== 'undefined' && window.isSecureContext
const keyOf = (path) => `/picture/${encodeURIComponent(path)}`

async function openStore() {
  return canStore ? caches.open(STORE) : null
}

async function fromStore(path) {
  try {
    const store = await openStore()
    const hit = store && (await store.match(keyOf(path)))
    return hit ? await hit.blob() : null
  } catch {
    return null
  }
}

// Keeps a picture on this computer (also used right after uploading, so new batches show instantly).
export async function keepPicture(path, blob) {
  if (!path || !blob) return
  try {
    const store = await openStore()
    if (store) await store.put(keyOf(path), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } }))
  } catch {
    /* storage full or not allowed — it will simply be downloaded again next time */
  }
}

function slot() {
  if (running < MAX_PARALLEL) { running++; return Promise.resolve() }
  return new Promise((resolve) => queue.push(resolve))
}
function release() {
  const next = queue.shift()
  if (next) next()
  else running--
}

function remember(path, url) {
  ready.delete(path)
  ready.set(path, url)
  if (ready.size > MAX_IN_MEMORY) {
    const [oldPath, oldUrl] = ready.entries().next().value
    ready.delete(oldPath)
    setTimeout(() => URL.revokeObjectURL(oldUrl), 60000) // give anything still showing it time
  }
}

async function download(path) {
  await slot()
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const link = await pictureUrl(path, attempt > 0)
      if (!link) throw new Error(pictureError(path) || 'No link for this picture')
      const res = await fetch(link)
      if (res.ok) return await res.blob()
      if (attempt === 1) throw new Error(`Picture download failed (${res.status})`)
    }
    return null
  } finally {
    release()
  }
}

// Returns a URL to show the picture: instant if already on this computer, otherwise downloaded once.
export function pictureFor(path, { fresh = false } = {}) {
  if (!path) return Promise.resolve(null)
  if (!fresh && ready.has(path)) {
    const url = ready.get(path)
    remember(path, url)
    return Promise.resolve(url)
  }
  if (loading.has(path)) return loading.get(path)
  const job = (async () => {
    let blob = fresh ? null : await fromStore(path)
    if (!blob) {
      blob = await download(path)
      if (blob) keepPicture(path, blob)
    }
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    remember(path, url)
    return url
  })().finally(() => loading.delete(path))
  loading.set(path, job)
  return job
}

export function pictureReadyNow(path) {
  return (path && ready.get(path)) || null
}

export const pictureStoreAvailable = canStore
