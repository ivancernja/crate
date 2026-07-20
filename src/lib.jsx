import React from 'react'

export function fmtDur(ms) {
  if (!ms || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

export function fmtCount(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`
}

export function fmtSize(bytes) {
  if (!bytes) return '0 MB'
  const gb = bytes / 1e9
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

export function groupAlbums(tracks) {
  const map = new Map()
  for (const t of tracks) {
    // one album = one MediaStore album_id, else one folder; folder grouping keeps
    // untagged compilations together even when every track has a different artist
    const folder = t.path.slice(0, t.path.lastIndexOf('/'))
    const key = t.albumId ? 'id:' + t.albumId : 'dir:' + folder
    let a = map.get(key)
    if (!a) {
      a = { key, album: t.album, artist: t.artist, albumId: t.albumId, tracks: [], _artists: new Set() }
      map.set(key, a)
    }
    a.tracks.push(t)
    if (t.artist && t.artist !== 'Unknown Artist') a._artists.add(t.artist)
  }
  const albums = [...map.values()]
  for (const a of albums) {
    a.tracks.sort((x, y) => (x.track || 999) - (y.track || 999) || x.title.localeCompare(y.title))
    a.artPath = a.tracks[0] && a.tracks[0].path
    a.totalMs = a.tracks.reduce((s, t) => s + (t.durationMs || 0), 0)
    a.artist = a._artists.size === 1 ? [...a._artists][0]
      : a._artists.size > 1 ? 'Various Artists'
      : 'Unknown Artist'
    a.compilation = a._artists.size > 1
    delete a._artists
  }
  albums.sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album))
  return albums
}

export function Eq() {
  return <span className="eq" aria-hidden="true"><i /><i /><i /></span>
}

export const Icon = {
  search: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
    </svg>
  ),
  plus: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  play: (p) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M7 4.5v15l13-7.5z" /></svg>
  ),
  pause: (p) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
  ),
  next: (p) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M6 5v14l9-7zM16 5h2.5v14H16z" /></svg>
  ),
  prev: (p) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M18 5v14l-9-7zM8 5H5.5v14H8z" /></svg>
  ),
  trash: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  ),
  check: (p) => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="m5 12 5 5 9-11" />
    </svg>
  ),
  x: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  grid: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </svg>
  ),
  rows: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}>
      <rect x="3" y="4" width="18" height="4" rx="1.5" /><rect x="3" y="10" width="18" height="4" rx="1.5" /><rect x="3" y="16" width="18" height="4" rx="1.5" />
    </svg>
  ),
  download: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  ),
  shuffle: (p) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
    </svg>
  ),
  link: (p) => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M14 4h6v6M20 4l-9 9M9 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-4" />
    </svg>
  ),
  gear: (p) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  info: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" />
    </svg>
  ),
  refresh: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
    </svg>
  ),
}
