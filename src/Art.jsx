import React, { useEffect, useRef, useState } from 'react'

// process-wide memo so art is fetched from the phone at most once per path
const cache = new Map() // path -> url | null
const inflight = new Map()

function load(path) {
  if (cache.has(path)) return Promise.resolve(cache.get(path))
  if (inflight.has(path)) return inflight.get(path)
  const p = window.crate.art(path).then((res) => {
    const url = res.ok ? res.data : null
    cache.set(path, url)
    inflight.delete(path)
    return url
  }).catch(() => { cache.set(path, null); inflight.delete(path); return null })
  inflight.set(path, p)
  return p
}

// drop a path from the session cache so it re-fetches after the cover changes
export function bustArt(path) { cache.delete(path); inflight.delete(path) }

// lazy-loads embedded album art when the cover scrolls into view
export default function Art({ path, fallback, className, eager }) {
  const cached = cache.has(path)
  const [url, setUrl] = useState(() => cache.get(path) ?? null)
  const [seen, setSeen] = useState(!!eager || cached)
  const [loaded, setLoaded] = useState(cached && cache.get(path) != null)
  const ref = useRef(null)

  useEffect(() => {
    if (eager || cached || !ref.current) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) { setSeen(true); io.disconnect() }
    }, { rootMargin: '300px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [eager, cached])

  useEffect(() => {
    if (!seen || !path) return
    let alive = true
    if (cache.has(path)) { setUrl(cache.get(path)); return }
    load(path).then((u) => { if (alive) setUrl(u) })
    return () => { alive = false }
  }, [seen, path])

  // missing art: a letter placeholder, no shimmer
  if (url === null && (cache.get(path) === null)) {
    return (
      <div ref={ref} className="art art-empty">
        <span className="art-glyph">{fallback || '♪'}</span>
      </div>
    )
  }

  return (
    <div ref={ref} className={`art ${loaded ? 'is-loaded' : 'is-loading'}`}>
      {!loaded && <span className="art-skeleton" />}
      {url && (
        <img
          src={url}
          className={className}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
        />
      )}
    </div>
  )
}
