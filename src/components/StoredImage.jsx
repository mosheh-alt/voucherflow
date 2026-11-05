import { useEffect, useRef, useState } from 'react'
import { pictureError } from '../lib/imageUrls.js'
import { pictureFor, pictureReadyNow } from '../lib/pictureCache.js'

const RETRY_AFTER = [0, 2000, 8000, 30000]

// A voucher picture. Shown instantly when it's already on this computer; otherwise downloaded
// once (only when it scrolls near the screen) and kept for next time. If loading fails it tries
// again with a fresh link, and finally offers "click to retry".
//   fallback: another picture to show if this one can't be loaded (e.g. the original when the small copy fails)
//   preview: tiny picture from the database, shown at once while the sharp one comes
//   sharp: false = the preview is enough at this size (small rows) — nothing is downloaded
export default function StoredImage({ path, fallback, preview, sharp = true, className = '', alt = 'Voucher', title, onClick, ...rest }) {
  const [url, setUrl] = useState(() => pictureReadyNow(path))
  const [failed, setFailed] = useState(false)
  const [near, setNear] = useState(() => Boolean(pictureReadyNow(path)))
  const [why, setWhy] = useState(null)
  const holder = useRef(null)
  const tries = useRef(0)
  const alive = useRef(true)

  // Only start loading when the picture is on (or close to) the screen.
  useEffect(() => {
    if (near || !holder.current) return undefined
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return undefined }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect() }
    }, { rootMargin: '800px 0px' })
    io.observe(holder.current)
    return () => io.disconnect()
  }, [near, path])

  useEffect(() => {
    alive.current = true
    tries.current = 0
    setFailed(false)
    setWhy(null)
    setUrl(pictureReadyNow(path))
    if (!path || !near || (preview && !sharp)) return undefined
    load(false)
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, near, sharp])

  function load(fresh) {
    pictureFor(path, { fresh })
      .then((u) => { if (!alive.current) return; if (u) setUrl(u); else retry('No picture') })
      .catch((e) => { if (alive.current) retry(e.message) })
  }

  function retry(reason) {
    if (reason) setWhy(reason)
    if (tries.current >= RETRY_AFTER.length) { setFailed(true); return }
    const wait = RETRY_AFTER[tries.current++]
    setTimeout(() => { if (alive.current) load(tries.current > 1) }, wait) // first retry from this computer, then a fresh download
  }

  if (!path) return <div className={className} />
  if (failed && fallback && fallback !== path) {
    return <StoredImage path={fallback} preview={preview} sharp={sharp} className={className} alt={alt} title={title} onClick={onClick} {...rest} />
  }
  // Preview first: shows straight away; swapped for the sharp picture when it arrives.
  if (preview && (!url || failed || !sharp)) {
    return <img ref={holder} src={preview} className={`${className} img-preview`} alt={alt} title={title} onClick={onClick} {...rest} />
  }
  if (!url || failed) {
    const reason = failed ? (why || pictureError(path) || 'The picture did not open') : null
    return (
      <div ref={holder} className={`${className} img-missing`} title="Click to load the picture again"
        onClick={(e) => { e.stopPropagation(); tries.current = 0; setFailed(false); setNear(true); load(true) }}>
        {failed ? <>↻ Picture didn’t load — click to retry<span className="img-why">{reason}</span></> : <span className="img-loading" />}
      </div>
    )
  }
  return <img src={url} className={className} alt={alt} title={title} onClick={onClick} decoding="async"
    onError={() => retry('The picture file could not be shown')} {...rest} />
}
