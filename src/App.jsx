import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Art, { bustArt } from './Art.jsx'
import Setup from './Setup.jsx'
import Player from './Player.jsx'
import { Icon, Eq, fmtDur, fmtCount, fmtSize, groupAlbums } from './lib.jsx'

export default function App() {
  const [phase, setPhase] = useState('checking') // checking | setup | connecting | ready | error
  const [connError, setConnError] = useState('')
  const [transport, setTransport] = useState(null) // 'usb' | 'wifi'
  const [permGate, setPermGate] = useState(false)
  const [goingWireless, setGoingWireless] = useState(false)
  const [tracks, setTracks] = useState([])
  const [loadingLib, setLoadingLib] = useState(false)
  const [query, setQuery] = useState('')
  const [view, setView] = useState(() => localStorage.getItem('crate.view') || 'grid')
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('crate.sort') || 'artist')
  const [browse, setBrowse] = useState('albums') // albums | artists | songs | stats
  const [storage, setStorage] = useState(null)
  const [openAlbum, setOpenAlbum] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [queue, setQueue] = useState([])
  const [qIndex, setQIndex] = useState(-1)
  const [dropping, setDropping] = useState(false)
  const [busyMsg, setBusyMsg] = useState('')
  const [progress, setProgress] = useState(null) // { done, total }
  const [toasts, setToasts] = useState([])
  const [ctx, setCtx] = useState(null) // { x, y, album }
  const [showSettings, setShowSettings] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selAlbums, setSelAlbums] = useState(() => new Set())
  const [artistFills, setArtistFills] = useState({}) // album name -> looked-up artist
  const [durationFills, setDurationFills] = useState({}) // path -> computed ms
  const dragDepth = useRef(0)
  const attemptedArtists = useRef(new Set())
  const attemptedDur = useRef(new Set())
  const playerRef = useRef(null)
  const queueRef = useRef([])

  useEffect(() => { localStorage.setItem('crate.view', view) }, [view])
  useEffect(() => { localStorage.setItem('crate.sort', sortBy) }, [sortBy])

  useEffect(() => {
    return window.crate.onAddProgress(({ done, total }) => {
      setProgress({ done, total })
      setBusyMsg(done >= total ? 'Almost done…' : `Copying to your device`)
    })
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(input|textarea)$/i.test(e.target.tagName)
      if (e.key === 'Escape') { setCtx(null); setShowSettings(false); setPermGate(false); setOpenAlbum(null); setSelectMode(false); setSelAlbums(new Set()); return }
      if (e.key === '/' && !typing) { e.preventDefault(); document.querySelector('.search input')?.focus(); return }
      if (typing) return
      if (e.key === ' ') { e.preventDefault(); playerRef.current && playerRef.current.toggle() }
      else if (e.key === 'ArrowRight') { setQIndex((i) => (i >= 0 && i + 1 < queueRef.current.length ? i + 1 : i)) }
      else if (e.key === 'ArrowLeft') { setQIndex((i) => (i > 0 ? i - 1 : i)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    return window.crate.onDuration(({ path, ms }) =>
      setDurationFills((prev) => (prev[path] ? prev : { ...prev, [path]: ms })))
  }, [])

  useEffect(() => {
    return window.crate.onSaveProgress(({ done, total }) => {
      setProgress({ done, total }); setBusyMsg('Saving to your Mac')
    })
  }, [])

  const dismissToast = useCallback((id) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 220)
  }, [])

  const toast = useCallback((text, kind, action, ttl = 3200) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, text, kind, action }])
    setTimeout(() => setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x))), ttl)
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl + 220)
  }, [])

  const refreshLibrary = useCallback(async () => {
    setLoadingLib(true)
    const res = await window.crate.list()
    setLoadingLib(false)
    if (res.ok) setTracks(res.data)
    else toast(res.error || 'Could not read library', 'err')
  }, [toast])

  const attemptConnect = useCallback(async (attempt = 0) => {
    setPhase('connecting')
    setConnError('')
    const res = await window.crate.connect()
    if (res.ok) {
      setTransport(res.data.transport)
      setPhase('ready')
      refreshLibrary()
      return
    }
    if (res.error === 'NO_DEVICE') { setPhase('setup'); return }
    if (res.error === 'LOCAL_NETWORK_BLOCKED') { setPhase('blocked'); return }
    // set up before but unreachable now: offer to reconnect, don't restart setup
    if (res.error === 'DEVICE_UNREACHABLE') { setConnError('Crate lost the connection to your device.'); setPhase('error'); return }
    // quietly retry a transient WiFi-doze failure before showing an error
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 900))
      return attemptConnect(attempt + 1)
    }
    setConnError(res.error)
    setPhase('error')
  }, [refreshLibrary])

  useEffect(() => { attemptConnect() }, [attemptConnect])

  useEffect(() => {
    if (phase === 'ready' && !localStorage.getItem('crate.tips')) {
      localStorage.setItem('crate.tips', '1')
      setTimeout(() => toast('Tip: right-click an album to save, select, or delete. Space plays or pauses.', undefined, undefined, 8000), 1400)
    }
  }, [phase, toast])

  // look up artists online for inferred albums that carry no artist anywhere
  useEffect(() => {
    const need = new Map()
    for (const t of tracks) {
      if (t.inferred && t.artist === 'Unknown Artist' && t.album && t.album !== 'Unknown Album'
          && !attemptedArtists.current.has(t.album)) {
        need.set(t.album, t.year || null)
      }
    }
    if (!need.size) return
    const items = [...need].map(([album, year]) => ({ key: album, album, year }))
    items.forEach((i) => attemptedArtists.current.add(i.key))
    window.crate.resolveArtists(items).then((res) => {
      if (res.ok && res.data && Object.keys(res.data).length) {
        setArtistFills((prev) => ({ ...prev, ...res.data }))
      }
    })
  }, [tracks])

  useEffect(() => {
    const missing = tracks.filter((t) => !t.durationMs && !attemptedDur.current.has(t.path)).map((t) => t.path)
    if (!missing.length) return
    missing.forEach((p) => attemptedDur.current.add(p))
    window.crate.trackDurations(missing)
  }, [tracks])

  const effectiveTracks = useMemo(() => {
    if (!Object.keys(artistFills).length && !Object.keys(durationFills).length) return tracks
    return tracks.map((t) => {
      let n = t
      if (t.artist === 'Unknown Artist' && artistFills[t.album]) n = { ...n, artist: artistFills[t.album] }
      if (!t.durationMs && durationFills[t.path]) n = { ...n, durationMs: durationFills[t.path] }
      return n
    })
  }, [tracks, artistFills, durationFills])

  const albums = useMemo(() => groupAlbums(effectiveTracks), [effectiveTracks])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = !q ? albums : albums.filter((a) =>
      a.album.toLowerCase().includes(q) ||
      a.artist.toLowerCase().includes(q) ||
      a.tracks.some((t) => t.title.toLowerCase().includes(q))
    )
    const s = [...base]
    if (sortBy === 'album') s.sort((a, b) => a.album.localeCompare(b.album))
    else if (sortBy === 'tracks') s.sort((a, b) => b.tracks.length - a.tracks.length)
    else s.sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album))
    return s
  }, [albums, query, sortBy])

  const openAlbumLive = useMemo(
    () => (openAlbum ? albums.find((a) => a.key === openAlbum.key) || null : null),
    [albums, openAlbum]
  )

  const artists = useMemo(() => {
    const q = query.trim().toLowerCase()
    const m = new Map()
    for (const a of albums) {
      let x = m.get(a.artist)
      if (!x) { x = { artist: a.artist, albums: [], tracks: 0, artPath: a.artPath }; m.set(a.artist, x) }
      x.albums.push(a); x.tracks += a.tracks.length
    }
    let list = [...m.values()]
    if (q) list = list.filter((x) => x.artist.toLowerCase().includes(q))
    return list.sort((p, r) => p.artist.localeCompare(r.artist))
  }, [albums, query])

  const songs = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = effectiveTracks
    if (q) list = list.filter((t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q))
    return [...list].sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || (a.track || 0) - (b.track || 0))
  }, [effectiveTracks, query])

  const stats = useMemo(() => {
    const totalSize = effectiveTracks.reduce((s, t) => s + (t.size || 0), 0)
    const totalMs = effectiveTracks.reduce((s, t) => s + (t.durationMs || 0), 0)
    // count by album-artist so feat. variants don't fragment the ranking
    const byArtist = {}
    const artPathByArtist = {}
    for (const a of albums) {
      if (a.artist && a.artist !== 'Unknown Artist' && a.artist !== 'Various Artists') {
        byArtist[a.artist] = (byArtist[a.artist] || 0) + a.tracks.length
        if (!artPathByArtist[a.artist]) artPathByArtist[a.artist] = a.artPath
      }
    }
    const byDecade = {}
    for (const t of effectiveTracks) if (t.year) { const d = Math.floor(t.year / 10) * 10; byDecade[d] = (byDecade[d] || 0) + 1 }
    const topArtists = Object.entries(byArtist).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([name, n]) => ({ name, n, artPath: artPathByArtist[name] }))
    const decades = Object.entries(byDecade).map(([d, n]) => [parseInt(d, 10), n]).sort((a, b) => a[0] - b[0])
    return { totalSize, totalMs, topArtists, decades }
  }, [effectiveTracks, albums])

  useEffect(() => { if (browse === 'stats') window.crate.storage().then((r) => { if (r.ok) setStorage(r.data) }) }, [browse])

  const current = qIndex >= 0 && qIndex < queue.length ? queue[qIndex] : null
  useEffect(() => { queueRef.current = queue }, [queue])
  const playFrom = (list, idx) => { setQueue(list); setQIndex(idx) }
  const next = () => setQIndex((i) => (i + 1 < queue.length ? i + 1 : i))
  const prev = () => setQIndex((i) => (i > 0 ? i - 1 : i))
  const shuffle = (list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]] } return a }
  const openCurrentAlbum = () => {
    if (!current) return
    const a = albums.find((al) => al.tracks.some((t) => t.path === current.path))
    if (a) setOpenAlbum(a)
  }

  // Android scans freshly-pushed files lazily (slow for big FLACs), so re-poll
  // a few times to avoid showing a half-scanned "Unknown Album" snapshot
  const settleLibrary = useCallback(async () => {
    let prev = null, stable = 0
    for (const wait of [1000, 2000, 2500, 3500, 5000, 6000]) {
      await new Promise((r) => setTimeout(r, wait))
      const res = await window.crate.list()
      if (!res.ok) continue
      setTracks(res.data)
      const unknown = res.data.filter((t) => t.album === 'Unknown Album' || !t.durationMs).length
      const sig = res.data.length + ':' + unknown
      if (sig === prev) { if (++stable >= 2) break } else stable = 0
      prev = sig
    }
  }, [])

  // Refresh does a deep rescan: MediaStore (what Crate reads) lags behind files
  // added by other apps, so scan the device for anything it hasn't indexed yet
  const rescanLibrary = useCallback(async () => {
    setBusyMsg('Scanning your device for new music…'); setProgress(null)
    const res = await window.crate.rescan()
    setBusyMsg('')
    if (!res.ok) { toast(res.error || 'Rescan failed', 'err'); return }
    if (res.data.scanned > 0) { toast(`Found ${fmtCount(res.data.scanned, 'new track')}, indexing…`); settleLibrary() }
    else { refreshLibrary() }
  }, [toast, settleLibrary, refreshLibrary])

  useEffect(() => window.crate.onWatchPushed(({ added }) => {
    if (added) { toast(`Auto-added ${fmtCount(added, 'track')} from your watched folder`); settleLibrary() }
  }), [settleLibrary, toast])

  const announceAdd = (res) => {
    if (!res.ok) { toast(res.error || 'Add failed', 'err'); return }
    const { added, found } = res.data
    if (added > 0) { toast(`Added ${fmtCount(added, 'track')}, indexing…`); settleLibrary() }
    else if (found === 0) toast('No audio files in that drop', 'err')
    else toast('Nothing to add', 'err')
  }

  const doAdd = async (paths) => {
    if (!paths.length) return
    setBusyMsg('Reading files…'); setProgress(null)
    const res = await window.crate.add(paths)
    setBusyMsg(''); setProgress(null)
    announceAdd(res)
  }

  const addViaDialog = async () => {
    setBusyMsg('Reading files…'); setProgress(null)
    const res = await window.crate.addDialog()
    setBusyMsg(''); setProgress(null)
    announceAdd(res)
  }

  const goWireless = async () => {
    setGoingWireless(true)
    const res = await window.crate.goWireless()
    setGoingWireless(false)
    if (res.ok) { setTransport('wifi'); toast('Connected wirelessly. You can unplug the cable now.') }
    else if (res.error === 'LOCAL_NETWORK_BLOCKED') setPermGate(true)
    else toast(res.error || 'Could not switch to wireless', 'err')
  }

  const toggleSelect = (path) => {
    setSelected((s) => {
      const n = new Set(s)
      n.has(path) ? n.delete(path) : n.add(path)
      return n
    })
  }

  const removePaths = async (paths, label) => {
    if (!paths.length) return
    setBusyMsg(`Deleting ${label}…`)
    const res = await window.crate.remove(paths)
    setBusyMsg('')
    if (!res.ok) { toast(res.error || 'Delete failed', 'err'); return }
    setTimeout(refreshLibrary, 700)
    const undoId = res.data.undoId
    toast(`Deleted ${label}`, undefined, {
      label: 'Undo',
      fn: async () => {
        const u = await window.crate.undoDelete(undoId)
        if (u.ok && u.data) { toast(`Restored ${label}`); setTimeout(refreshLibrary, 700) }
      },
    }, 10000)
  }

  const deleteSelected = async () => {
    const paths = [...selected]
    if (!paths.length) return
    if (!window.confirm(`Delete ${fmtCount(paths.length, 'track')} from your device? This removes the file${paths.length > 1 ? 's' : ''} for good.`)) return
    setSelected(new Set())
    await removePaths(paths, fmtCount(paths.length, 'track'))
  }

  const enterSelect = (album) =>{ setSelectMode(true); setSelAlbums(new Set([album.key])) }
  const exitSelect = () => { setSelectMode(false); setSelAlbums(new Set()) }
  const toggleAlbumSel = (key) => setSelAlbums((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const onAlbumClick = (a) => { if (selectMode) toggleAlbumSel(a.key); else setOpenAlbum(a) }
  const selectedAlbums = () => albums.filter((a) => selAlbums.has(a.key))
  const bulkDelete = async () => {
    const sel = selectedAlbums()
    const paths = sel.flatMap((a) => a.tracks.map((t) => t.path))
    if (!paths.length) return
    if (!window.confirm(`Delete ${fmtCount(sel.length, 'album')} (${fmtCount(paths.length, 'track')}) from your device?`)) return
    exitSelect()
    await removePaths(paths, fmtCount(sel.length, 'album'))
  }
  const bulkSave = async () => {
    const sel = selectedAlbums()
    if (!sel.length) return
    const payload = sel.map((a) => ({ name: a.album, paths: a.tracks.map((t) => t.path) }))
    exitSelect()
    setBusyMsg('Saving to your Mac…'); setProgress(null)
    const res = await window.crate.saveAlbumsToMac({ albums: payload })
    setBusyMsg(''); setProgress(null)
    if (res.ok && res.data.saved) toast(`Saved ${fmtCount(res.data.saved, 'track')} to your Mac`)
    else if (!res.ok) toast(res.error || 'Save failed', 'err')
  }

  const saveAlbum = async (album) => {
    setBusyMsg('Saving to your Mac…'); setProgress(null)
    const res = await window.crate.saveToMac({ paths: album.tracks.map((t) => t.path), albumName: album.album })
    setBusyMsg(''); setProgress(null)
    if (res.ok && res.data.saved) toast(`Saved ${fmtCount(res.data.saved, 'track')} to your Mac`)
    else if (!res.ok) toast(res.error || 'Save failed', 'err')
  }

  const [artNonce, setArtNonce] = useState(0)
  const changeCover = async (album) => {
    const res = await window.crate.setCoverFile({ trackPath: album.artPath })
    if (res.ok && res.data.changed) { bustArt(album.artPath); toast('Cover updated'); setArtNonce((n) => n + 1); setTimeout(refreshLibrary, 300) }
    else if (!res.ok) toast(res.error || 'Could not set cover', 'err')
  }
  const findCover = async (album) => {
    setBusyMsg('Searching for cover art…'); setProgress(null)
    const res = await window.crate.fetchCover({ trackPath: album.artPath, artist: album.artist, album: album.album, year: album.tracks[0] && album.tracks[0].year })
    setBusyMsg('')
    if (res.ok && res.data.changed) { bustArt(album.artPath); toast('Cover found and set'); setArtNonce((n) => n + 1); setTimeout(refreshLibrary, 300) }
    else if (res.ok) toast('No cover found online. Use “Change cover” to set one.', 'err')
    else toast(res.error || 'Cover search failed', 'err')
  }

  const deleteAlbum = async (album) => {
    if (!album) return
    if (!window.confirm(`Delete the whole album “${album.album}” (${fmtCount(album.tracks.length, 'track')}) from your device? This is permanent.`)) return
    if (openAlbum && openAlbum.key === album.key) setOpenAlbum(null)
    await removePaths(album.tracks.map((t) => t.path), `“${album.album}”`)
  }

  const openCtx = (e, album) => {
    e.preventDefault(); e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, album })
  }
  useEffect(() => {
    if (!ctx) return
    const close = () => setCtx(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [ctx])

  useEffect(() => {
    const onEnter = (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return
      e.preventDefault(); dragDepth.current++; setDropping(true)
    }
    const onOver = (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault() }
    const onLeave = (e) => {
      e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDropping(false)
    }
    const onDrop = (e) => {
      e.preventDefault(); dragDepth.current = 0; setDropping(false)
      // pass everything through; main walks folders and keeps only audio + covers
      const paths = [...e.dataTransfer.files].map((f) => window.crate.pathFor(f)).filter(Boolean)
      if (paths.length) doAdd(paths)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, []) // eslint-disable-line

  if (phase === 'checking' || phase === 'connecting') {
    return (
      <div className="app">
        <TitleBar connected={false} />
        <div className="center-stage">
          <div style={{ textAlign: 'center', color: 'var(--ink-dim)' }}>
            <span className="spinner" style={{ width: 22, height: 22 }} />
            <div style={{ marginTop: 14 }}>Looking for your device on the network…</div>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'setup') {
    return (
      <div className="app">
        <TitleBar connected={false} />
        <div className="main"><Setup onConnected={attemptConnect} /></div>
      </div>
    )
  }

  if (phase === 'blocked') {
    return (
      <div className="app">
        <TitleBar connected={false} />
        <div className="center-stage">
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>One quick macOS permission</h2>
            <p className="lede">macOS is blocking Crate from reaching your device over WiFi. Turn Crate on under Local Network and it will connect.</p>
            <ol className="steps">
              <li><span className="n">1</span><div>Open <b>System Settings</b>, then <b>Privacy &amp; Security</b>, then <b>Local Network</b>.</div></li>
              <li><span className="n">2</span><div>Switch <b>Crate</b> on in the list.</div></li>
              <li><span className="n">3</span><div>Come back here and press Try again.</div></li>
            </ol>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn accent" onClick={() => window.crate.openLocalNetworkSettings()}>Open Local Network settings</button>
              <button className="btn" onClick={() => attemptConnect()}>Try again</button>
            </div>
            <p className="msg info" style={{ marginTop: 12 }}>Plugging in a USB cable also connects right away.</p>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="app">
        <TitleBar connected={false} />
        <div className="center-stage">
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Can’t reach your device</h2>
            <p className="lede">{connError || 'The connection dropped.'} Check that your device is awake and on the same WiFi as this Mac. If it has restarted since you set it up, plug the cable in once and Crate will turn wireless back on.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn accent" onClick={() => attemptConnect()}>Try again</button>
              <button className="btn" onClick={() => setPhase('setup')}>Set up again</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar
        connected transport={transport} goingWireless={goingWireless} onGoWireless={goWireless}
        query={query} onQuery={setQuery} onAdd={addViaDialog} onRefresh={rescanLibrary}
        onSettings={() => setShowSettings(true)}
      />

      <div className="main">
        <div className="content">
          <div className="section-head">
            <nav className="browse-nav">
              {[['albums', 'Albums'], ['artists', 'Artists'], ['songs', 'Songs'], ['stats', 'Stats']].map(([m, label]) => (
                <button key={m} className={browse === m ? 'on' : ''} onClick={() => setBrowse(m)}>{label}</button>
              ))}
            </nav>
            <span className="count">
              {loadingLib ? 'scanning…'
                : browse === 'artists' ? `${artists.length} artists`
                : browse === 'songs' ? `${songs.length} songs`
                : browse === 'stats' ? ''
                : `${albums.length} albums · ${tracks.length} tracks`}
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            {browse === 'albums' && (
              <div className="section-tools">
                <select className="sortsel" value={sortBy} onChange={(e) => setSortBy(e.target.value)} title="Sort">
                  <option value="artist">Artist</option>
                  <option value="album">Album</option>
                  <option value="tracks">Most tracks</option>
                </select>
                <div className="seg">
                  <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="Card view"><Icon.grid /></button>
                  <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="List view"><Icon.rows /></button>
                </div>
              </div>
            )}
          </div>

          {browse === 'albums' && (
            filtered.length === 0 && !loadingLib ? (
              <div className="empty">
                <div className="big">{query ? 'Nothing matches' : 'No music yet'}</div>
                <div>{query ? 'Try another search.' : 'Drag FLAC files or folders anywhere to send them to your device.'}</div>
              </div>
            ) : view === 'grid' ? (
              <div className="grid">
                {filtered.map((a) => (
                  <div key={a.key} className={`album ${selectMode && selAlbums.has(a.key) ? 'sel' : ''}`} onClick={() => onAlbumClick(a)} onContextMenu={(e) => openCtx(e, a)}>
                    <div className="cover">
                      <Art path={a.artPath} fallback={a.album[0] || '♪'} />
                      {selectMode
                        ? <span className={`sel-check ${selAlbums.has(a.key) ? 'on' : ''}`}>{selAlbums.has(a.key) && <Icon.check />}</span>
                        : (
                          <div className="play-hint" onClick={(e) => { e.stopPropagation(); playFrom(a.tracks, 0) }}>
                            <span className="glyph"><Icon.play /></span>
                          </div>
                        )}
                    </div>
                    <div className="meta">
                      <div className="name">{a.album}</div>
                      <div className="by">{a.artist}</div>
                      <div className="sub">{fmtCount(a.tracks.length, 'track')} · {fmtDur(a.totalMs)}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="list">
                <div className="list-headrow">
                  <span></span><span>Album</span><span>Artist</span><span className="r">Tracks</span><span className="r">Length</span>
                </div>
                {filtered.map((a) => (
                  <div key={a.key} className={`lrow ${selectMode && selAlbums.has(a.key) ? 'sel' : ''}`} onClick={() => onAlbumClick(a)} onContextMenu={(e) => openCtx(e, a)}>
                    <div className="lthumb">
                      <Art path={a.artPath} fallback={a.album[0] || '♪'} />
                      {selectMode && <span className={`sel-check ${selAlbums.has(a.key) ? 'on' : ''}`}>{selAlbums.has(a.key) && <Icon.check />}</span>}
                    </div>
                    <span className="lname">{a.album}</span>
                    <span className="lby">{a.artist}</span>
                    <span className="lnum r">{a.tracks.length}</span>
                    <span className="ldur r">{fmtDur(a.totalMs)}</span>
                  </div>
                ))}
              </div>
            )
          )}

          {browse === 'artists' && (
            <div className="grid">
              {artists.map((x) => (
                <div key={x.artist} className="album" onClick={() => { setQuery(x.artist); setBrowse('albums') }}>
                  <div className="cover">
                    <Art path={x.artPath} fallback={x.artist[0] || '♪'} />
                  </div>
                  <div className="meta">
                    <div className="name">{x.artist}</div>
                    <div className="sub">{fmtCount(x.albums.length, 'album')} · {fmtCount(x.tracks, 'track')}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {browse === 'songs' && (
            <div className="songlist">
              {songs.map((t, i) => {
                const isPlaying = current && current.path === t.path
                return (
                  <div key={t.path} className={`srow ${isPlaying ? 'playing' : ''}`} onClick={() => playFrom(songs, i)}>
                    <span className="sidx">{isPlaying ? <Eq /> : i + 1}</span>
                    <div className="sthumb"><Art path={t.path} fallback={(t.title || '♪')[0]} /></div>
                    <div className="sinfo">
                      <div className="st">{t.title}</div>
                      <div className="sa">{t.artist} · {t.album}</div>
                    </div>
                    <span className="sdur">{fmtDur(t.durationMs)}</span>
                  </div>
                )
              })}
            </div>
          )}

          {browse === 'stats' && (
            <div className="stats">
              <div className="stats-hero">
                <Stat n={albums.length} label="albums" />
                <span className="stats-div" />
                <Stat n={tracks.length} label="tracks" />
                <span className="stats-div" />
                <Stat n={fmtSize(stats.totalSize)} label="of music" />
                <span className="stats-div" />
                <Stat n={`${Math.floor(stats.totalMs / 3600000)}h ${Math.round((stats.totalMs % 3600000) / 60000)}m`} label="listening" />
              </div>

              <div className="stats-grid">
                {storage && (() => {
                  const music = Math.min(stats.totalSize, storage.used)
                  const other = Math.max(0, storage.used - music)
                  const pct = (b) => (b / storage.total) * 100 + '%'
                  return (
                    <div className="panel">
                      <div className="stat-h">Device storage</div>
                      <div className="storage-stack">
                        <div className="seg music" style={{ width: pct(music) }} />
                        <div className="seg other" style={{ width: pct(other) }} />
                        <div className="seg free" />
                      </div>
                      <div className="storage-key">
                        <span><i className="dotk music" /> Your music {fmtSize(music)}</span>
                        <span><i className="dotk other" /> Other {fmtSize(other)}</span>
                        <span><i className="dotk free" /> Free {fmtSize(storage.free)}</span>
                      </div>
                    </div>
                  )
                })()}

                {stats.decades.length > 0 && (
                  <div className="panel">
                    <div className="stat-h">By decade</div>
                    {stats.decades.map(([d, n]) => {
                      const max = Math.max(...stats.decades.map((x) => x[1]))
                      return (
                        <div className="bar-row" key={d}>
                          <span className="bar-label">{d}s</span>
                          <div className="bar"><div className="bar-fill" style={{ width: (n / max) * 100 + '%' }} /></div>
                          <span className="bar-n">{n}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {stats.topArtists.length > 0 && (
                <div className="panel">
                  <div className="stat-h">Most tracks by artist</div>
                  <div className="topartists">
                    {stats.topArtists.map((x, i) => (
                      <div className="ta-row" key={x.name}>
                        <span className="ta-rank">{i + 1}</span>
                        <div className="ta-art"><Art path={x.artPath} fallback={x.name[0]} /></div>
                        <span className="ta-name">{x.name}</span>
                        <div className="bar"><div className="bar-fill" style={{ width: (x.n / stats.topArtists[0].n) * 100 + '%' }} /></div>
                        <span className="ta-n">{x.n}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <AlbumDrawer
        album={openAlbumLive}
        onClose={() => setOpenAlbum(null)}
        onPlay={(idx) => playFrom(openAlbumLive.tracks, idx)}
        onShuffle={() => playFrom(shuffle(openAlbumLive.tracks), 0)}
        onDelete={() => deleteAlbum(openAlbumLive)}
        onSave={() => saveAlbum(openAlbumLive)}
        onChangeCover={() => changeCover(openAlbumLive)}
        onFindCover={() => findCover(openAlbumLive)}
        artNonce={artNonce}
        current={current}
        selected={selected}
        onToggleSelect={toggleSelect}
      />

      {ctx && (
        <ContextMenu
          x={ctx.x} y={ctx.y}
          onPlay={() => { playFrom(ctx.album.tracks, 0); setCtx(null) }}
          onShuffle={() => { const a = ctx.album; setCtx(null); playFrom(shuffle(a.tracks), 0) }}
          onDetails={() => { setOpenAlbum(ctx.album); setCtx(null) }}
          onSelect={() => { const a = ctx.album; setCtx(null); enterSelect(a) }}
          onSave={() => { const a = ctx.album; setCtx(null); saveAlbum(a) }}
          onDelete={() => { const a = ctx.album; setCtx(null); deleteAlbum(a) }}
        />
      )}

      {selectMode && (
        <div className="selectbar" style={{ bottom: current ? 88 : 20 }}>
          <span className="selectbar-count">{selAlbums.size ? fmtCount(selAlbums.size, 'album') + ' selected' : 'Select albums'}</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={bulkSave} disabled={!selAlbums.size}><Icon.download /> Save to Mac</button>
          <button className="btn danger" onClick={bulkDelete} disabled={!selAlbums.size}><Icon.trash /> Delete</button>
          <button className="btn accent" onClick={exitSelect}>Done</button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="toasts" style={{ bottom: current ? 152 : 84 }}>
          <div className="toast">
            {fmtCount(selected.size, 'track')} selected
            <button className="btn danger" style={{ padding: '3px 9px' }} onClick={deleteSelected}><Icon.trash /> Delete</button>
            <button className="iconbtn" onClick={() => setSelected(new Set())}><Icon.x /></button>
          </div>
        </div>
      )}

      <div className="toasts">
        {busyMsg && (
          <div className="toast busy">
            <div className="busy-row">
              <span className="spinner" />
              <span>{busyMsg}{progress && progress.total > 1 ? ` · ${progress.done}/${progress.total}` : ''}</span>
            </div>
            <div className={`mini-progress ${progress ? '' : 'indeterminate'}`}>
              <div className="fill" style={progress ? { width: (progress.done / Math.max(1, progress.total)) * 100 + '%' } : undefined} />
            </div>
          </div>
        )}
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind || ''} ${t.leaving ? 'leaving' : ''}`}>
            {t.text}
            {t.action && <button className="toast-action" onClick={() => { t.action.fn(); dismissToast(t.id) }}>{t.action.label}</button>}
          </div>
        ))}
      </div>

      <Player ref={playerRef} track={current} onNext={next} onPrev={prev} onError={(m) => toast(m, 'err')} onArtClick={openCurrentAlbum} />

      <div className={`drop-veil ${dropping ? 'show' : ''}`}>
        <div className="box">
          <div className="big">Drop to add</div>
          <div className="small">Files land on your device and show up in Poweramp</div>
        </div>
      </div>

      {permGate && <PermissionGate onClose={() => setPermGate(false)} onRetry={() => { setPermGate(false); goWireless() }} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} toast={toast} onReSetup={() => { setShowSettings(false); setPhase('setup') }} />}
    </div>
  )
}

// turn a device path into something readable: internal aliases and the SD volume id
function prettyRoot(p) {
  if (!p) return ''
  if (p.startsWith('/storage/emulated/0')) return 'Internal storage' + p.slice('/storage/emulated/0'.length)
  if (p.startsWith('/sdcard')) return 'Internal storage' + p.slice('/sdcard'.length)
  const m = p.match(/^\/storage\/[^/]+(.*)$/)
  if (m) return 'SD card' + m[1]
  return p
}

function Settings({ onClose, toast, onReSetup }) {
  const [root, setRoot] = useState('')
  const [saved, setSaved] = useState('')
  const [auto, setAuto] = useState(false)
  const [watch, setWatch] = useState(null)
  const [manual, setManual] = useState(false)
  const [picking, setPicking] = useState(false)
  useEffect(() => { window.crate.getSettings().then((r) => { if (r.ok) { setRoot(r.data.musicRoot); setSaved(r.data.musicRoot); setAuto(r.data.musicRootAuto); setWatch(r.data.watchFolder) } }) }, [])
  const chooseWatch = async () => { const r = await window.crate.chooseWatchFolder(); if (r.ok) { setWatch(r.data.watchFolder); if (r.data.watchFolder) toast('Watching for new music') } }
  const clearWatch = async () => { const r = await window.crate.clearWatchFolder(); if (r.ok) setWatch(null) }
  const save = async () => {
    const r = await window.crate.setSettings({ musicRoot: root })
    if (r.ok) { setSaved(r.data.musicRoot); setRoot(r.data.musicRoot); toast('Settings saved'); onClose() }
    else toast(r.error || 'Could not save', 'err')
  }
  return (
    <>
      {picking && <FolderPicker start={root} onClose={() => setPicking(false)} onPick={(p) => { setRoot(p); setAuto(false); setPicking(false) }} />}
      <div className="drawer-scrim open" onClick={onClose} />
      <div className="center-stage" style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={onClose}>
        <div className="card" onClick={(e) => e.stopPropagation()}>
          <h2>Settings</h2>
          <div className="field">
            <label>Music folder on device</label>
            <div className="folder-pick">
              <div className="folder-cur">
                <span className="folder-cur-ic"><Icon.folder /></span>
                <span className="folder-cur-path" title={root}>{prettyRoot(root) || '/sdcard/Music'}</span>
                {auto && root === saved && <span className="folder-auto">auto</span>}
              </div>
              <button className="btn" onClick={() => setPicking(true)}>Change…</button>
            </div>
            <span className="field-hint">
              Where new music lands. Crate picks a sensible spot for your device, and players with an SD card default to it.{' '}
              <button className="linklike" onClick={() => setManual((m) => !m)}>{manual ? 'Hide manual path' : 'Or set the path manually'}</button>
            </span>
            {manual && (
              <input style={{ marginTop: 8 }} value={root} onChange={(e) => { setRoot(e.target.value); setAuto(false) }} placeholder="/sdcard/Music" spellCheck={false} />
            )}
          </div>
          <div className="settings-sep" />
          <div className="setting-row">
            <div style={{ minWidth: 0 }}>
              <div className="setting-row-title">Watch a folder</div>
              <div className="setting-row-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {watch ? `Auto-adds new music from ${watch.split('/').pop()}` : 'Anything you drop in it auto-syncs to your device.'}
              </div>
            </div>
            {watch
              ? <button className="btn" onClick={clearWatch}>Turn off</button>
              : <button className="btn" onClick={chooseWatch}>Choose…</button>}
          </div>
          <div className="settings-sep" />
          <div className="setting-row">
            <div>
              <div className="setting-row-title">Connect a different device</div>
              <div className="setting-row-sub">Run the setup wizard again.</div>
            </div>
            <button className="btn" onClick={onReSetup}>Set up</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <button className="btn accent" onClick={save} disabled={!root.trim().startsWith('/') || root === saved}>Save</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </>
  )
}

// browse the phone's storage to pick where music goes: volumes first (Internal,
// SD card), then drill into folders. null dir = the volume list
function FolderPicker({ start, onClose, onPick }) {
  const [dir, setDir] = useState(null)
  const [vols, setVols] = useState([])
  const [dirs, setDirs] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true); setErr('')
    const load = dir == null
      ? window.crate.listVolumes().then((r) => { if (alive) setVols(r.ok ? r.data : []) })
      : window.crate.listDirs(dir).then((r) => { if (alive) { if (r.ok) setDirs(r.data); else setErr(r.error || 'Could not read that folder') } })
    load.finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [dir])

  const up = () => {
    if (dir == null) return
    const parent = dir.replace(/\/[^/]+$/, '')
    const atVolRoot = /^\/storage\/[^/]+$/.test(dir) || dir === '/sdcard' || dir === '/storage/emulated/0'
    setDir(atVolRoot || !parent ? null : parent)
  }

  return (
    <>
      <div className="drawer-scrim open" style={{ zIndex: 40 }} onClick={onClose} />
      <div className="center-stage" style={{ position: 'fixed', inset: 0, zIndex: 41 }} onClick={onClose}>
        <div className="card fpick" onClick={(e) => e.stopPropagation()}>
          <h2>Choose music folder</h2>
          <div className="fpick-crumb">
            <button className="linklike" onClick={() => setDir(null)}>Storage</button>
            {dir != null && <><span className="fpick-sep">›</span><span className="fpick-here" title={dir}>{prettyRoot(dir)}</span></>}
          </div>
          <div className="fpick-list">
            {loading ? (
              <div className="fpick-empty"><span className="spinner" /> Reading…</div>
            ) : err ? (
              <div className="fpick-empty">{err}</div>
            ) : dir == null ? (
              vols.map((v) => (
                <button key={v.path} className="fpick-row" onClick={() => setDir(v.path)}>
                  <span className="fpick-ic"><Icon.folder /></span>
                  <span className="fpick-name">{v.label}</span>
                  <span className="fpick-go"><Icon.chevron /></span>
                </button>
              ))
            ) : dirs.length === 0 ? (
              <div className="fpick-empty">No sub-folders here. You can still use this folder.</div>
            ) : (
              dirs.map((d) => (
                <button key={d.path} className="fpick-row" onClick={() => setDir(d.path)}>
                  <span className="fpick-ic"><Icon.folder /></span>
                  <span className="fpick-name">{d.name}</span>
                  <span className="fpick-go"><Icon.chevron /></span>
                </button>
              ))
            )}
          </div>
          <div className="fpick-actions">
            {dir != null && <button className="btn" onClick={up}>Up</button>}
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn accent" disabled={dir == null} onClick={() => onPick(dir)}>Use this folder</button>
          </div>
        </div>
      </div>
    </>
  )
}

function Stat({ n, label }) {
  return <div className="stat"><div className="stat-n">{n}</div><div className="stat-l">{label}</div></div>
}

function ContextMenu({ x, y, onPlay, onShuffle, onDetails, onSelect, onSave, onDelete }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 8),
      top: Math.min(y, window.innerHeight - r.height - 8),
    })
  }, [x, y])
  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
      <button className="ctx-item" onClick={onPlay}><span className="cglyph"><Icon.play /></span>Play album</button>
      <button className="ctx-item" onClick={onShuffle}><span className="cglyph"><Icon.shuffle /></span>Shuffle</button>
      <button className="ctx-item" onClick={onDetails}><span className="cglyph"><Icon.info /></span>Album details</button>
      <button className="ctx-item" onClick={onSelect}><span className="cglyph"><Icon.check /></span>Select</button>
      <button className="ctx-item" onClick={onSave}><span className="cglyph"><Icon.download /></span>Save to Mac</button>
      <div className="ctx-sep" />
      <button className="ctx-item danger" onClick={onDelete}><span className="cglyph"><Icon.trash /></span>Delete from device</button>
    </div>
  )
}

function PermissionGate({ onClose, onRetry }) {
  return (
    <>
      <div className="drawer-scrim open" onClick={onClose} />
      <div className="center-stage" style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={onClose}>
        <div className="card">
          <h2>One macOS permission</h2>
          <p className="lede">macOS is blocking Crate from reaching your device over the network. Grant it once and wireless works from then on.</p>
          <ol className="steps">
            <li><span className="n">1</span><div>Open <b>System Settings → Privacy &amp; Security → Local Network</b>.</div></li>
            <li><span className="n">2</span><div>Turn <b>Crate</b> on in the list.</div></li>
            <li><span className="n">3</span><div>Come back and try again. Your cable can stay plugged in until it works.</div></li>
          </ol>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn accent" onClick={onRetry}>Try wireless again</button>
            <button className="btn" onClick={onClose}>Later</button>
          </div>
        </div>
      </div>
    </>
  )
}

function TitleBar({ connected, transport, goingWireless, onGoWireless, query, onQuery, onAdd, onRefresh, onSettings }) {
  const label = !connected ? 'Offline' : transport === 'wifi' ? 'Wireless' : 'USB'
  return (
    <div className="titlebar">
      <span className="wordmark">Crate</span>
      <span className="spacer" />
      {connected && (
        <div className="search">
          <Icon.search />
          <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search albums, artists, tracks" />
        </div>
      )}
      <span className="pill" title={connected ? `Connected over ${label}` : 'Not connected'}>
        <span className={`dot ${connected ? 'on' : 'off'}`} />{label}
      </span>
      {connected && transport === 'usb' && (
        <button className="btn" onClick={onGoWireless} disabled={goingWireless} title="Switch to WiFi and unplug the cable">
          {goingWireless ? <><span className="spinner" /> Switching…</> : 'Go wireless'}
        </button>
      )}
      {connected && (
        <>
          <span className="tb-sep" />
          <button className="btn icon" onClick={onRefresh} title="Scan device for new music"><Icon.refresh /></button>
          <button className="btn icon" onClick={onSettings} title="Settings"><Icon.gear /></button>
          <button className="btn accent" onClick={onAdd}><Icon.plus /> Add music</button>
        </>
      )}
    </div>
  )
}

function AlbumInfo({ artist, album }) {
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true); setInfo(null)
    window.crate.albumInfo({ artist, album }).then((res) => {
      if (!alive) return
      setLoading(false)
      setInfo(res.ok ? res.data : null)
    })
    return () => { alive = false }
  }, [artist, album])

  const facts = []
  if (info && info.year) facts.push(<span key="y" className="yr">{info.year}</span>)
  if (info && info.type && info.type !== 'Album') facts.push(<span key="t">· {info.type}</span>)

  return (
    <div className="hero-meta">
      {facts.length > 0 && <div className="facts">{facts}</div>}
      {info && info.genres && info.genres.length > 0 && (
        <div className="genres">{info.genres.map((g) => <span key={g} className="chip">{g}</span>)}</div>
      )}
      <div className="blurb-wrap">
        {loading ? (
          <div className="blurb-loading"><span className="spinner" /> reading up on this one…</div>
        ) : info && info.summary ? (
          <div className="blurb">
            {info.summary}{' '}
            {info.url && <span className="more" onClick={() => window.crate.openUrl(info.url)}>Wikipedia ↗</span>}
          </div>
        ) : (
          <div className="blurb-empty">No story found for this album.</div>
        )}
      </div>
    </div>
  )
}

function AlbumDrawer({ album, onClose, onPlay, onShuffle, onDelete, onSave, onChangeCover, onFindCover, artNonce, current, selected, onToggleSelect }) {
  return (
    <>
      <div className={`drawer-scrim ${album ? 'open' : ''}`} onClick={onClose} />
      <div className={`drawer ${album ? 'open' : ''}`}>
        {album && (
          <>
            <div className="drawer-head">
              <h2>{album.album}</h2>
              <div className="by">{album.artist}</div>
              <div className="albumhero">
                <div className="cover-lg">
                  <Art path={album.artPath} eager fallback={album.album[0]} key={album.key + '-' + artNonce} />
                  <div className="cover-actions">
                    <button title="Set cover from a file" onClick={onChangeCover}><Icon.plus /></button>
                    <button title="Find cover online" onClick={onFindCover}><Icon.search /></button>
                  </div>
                </div>
                <AlbumInfo artist={album.artist} album={album.album} key={album.key} />
              </div>
              <div className="drawer-actions">
                <button className="btn accent" onClick={() => onPlay(0)}><Icon.play /> Play</button>
                <button className="btn" onClick={onShuffle} title="Shuffle"><Icon.shuffle /></button>
                <button className="btn" onClick={onSave} title="Save to your Mac"><Icon.download /></button>
                <button className="btn danger" onClick={onDelete} title="Delete album"><Icon.trash /></button>
                <span style={{ flex: 1 }} />
                <button className="btn" onClick={onClose}><Icon.x /></button>
              </div>
            </div>
            <div className="tracklist">
              {album.tracks.map((t, i) => {
                const isPlaying = current && current.path === t.path
                const isSel = selected.has(t.path)
                return (
                  <div key={t.path} className={`trow ${isPlaying ? 'playing' : ''} ${isSel ? 'checked' : ''}`}>
                    <button className="idx iconbtn" style={{ width: 22 }} onClick={() => onPlay(i)}>
                      {isPlaying ? <Eq /> : (t.track || i + 1)}
                    </button>
                    <div className="tp" onClick={() => onPlay(i)}>
                      <div className="tt">{t.title}</div>
                      <div className="ta">{t.artist}</div>
                    </div>
                    <span className="td">{fmtDur(t.durationMs)}</span>
                    <button className="tcheck" onClick={() => onToggleSelect(t.path)}>
                      <span className={`checkbox ${isSel ? 'on' : ''}`}>{isSel && <Icon.check />}</span>
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </>
  )
}
