import { useEffect, useRef, useState } from 'react'
import { cachedUrl, pictureError, pictureUrl, watchPicture } from '../lib/imageUrls.js'

const RETRY_AFTER = [0, 2000, 8000, 30000]

// A voucher picture from storage that keeps working however long the page stays open:
// its link is renewed before it expires, and if it ever fails to load it fetches a new one
// and tries again (then keeps trying whenever the computer wakes or comes back online).
// fallback: another picture to show if this one can't be loaded (e.g. the original when the small copy fails)
export default function StoredImage({ path, fallback, className = '', alt = 'Voucher', title, onClick, ...rest }) {
  const [url, setUrl] = useState(() => cachedUrl(path))
  const [failed, setFailed] = useState(false)
  const tries = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    tries.current = 0
    setFailed(false)
    setUrl(cachedUrl(path))
    if (!path) return undefined
    pictureUrl(path).then((u) => { if (alive.current) { if (u) setUrl(u); else retry() } })
    const stop = watchPicture(path, (u) => { if (alive.current) { setUrl(u); setFailed(false); tries.current = 0 } })
    return () => { alive.current = false; stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  function retry() {
    if (tries.current >= RETRY_AFTER.length) { setFailed(true); return }
    const wait = RETRY_AFTER[tries.current++]
    setTimeout(() => {
      if (!alive.current) return
      pictureUrl(path, true).then((u) => { if (!alive.current) return; if (u) setUrl(u); else retry() })
    }, wait)
  }

  if (!path) return <div className={className} />
  if (failed && fallback && fallback !== path) {
    return <StoredImage path={fallback} className={className} alt={alt} title={title} onClick={onClick} {...rest} />
  }
  if (!url || failed) {
    const why = failed ? (pictureError(path) || (url ? 'The picture link did not open' : null)) : null
    return (
      <div className={`${className} img-missing`} title="Click to load the picture again"
        onClick={(e) => { e.stopPropagation(); tries.current = 0; setFailed(false); retry() }}>
        {failed ? <>↻ Picture didn’t load — click to retry{why && <span className="img-why">{why}</span>}</> : 'Loading…'}
      </div>
    )
  }
  return <img src={url} className={className} alt={alt} title={title} onClick={onClick} loading="lazy" onError={retry} {...rest} />
}
