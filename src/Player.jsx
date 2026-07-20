import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import Art from './Art.jsx'
import { Icon, fmtDur } from './lib.jsx'

// bottom transport bar; streams the current track into an <audio> element
const Player = forwardRef(function Player({ track, onNext, onPrev, onError, onArtClick }, ref) {
  const audio = useRef(null)
  const [url, setUrl] = useState(null)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)

  useEffect(() => {
    if (!track) { setUrl(null); return }
    let alive = true
    setLoading(true); setUrl(null); setCur(0); setDur(0)
    window.crate.trackUrl({ path: track.path, size: track.size }).then((res) => {
      if (!alive) return
      setLoading(false)
      if (res.ok && res.data) setUrl(res.data)
      else onError && onError(res.error || 'Could not load track')
    })
    return () => { alive = false }
  }, [track && track.path])

  useEffect(() => {
    if (url && audio.current) {
      audio.current.play().catch(() => {})
    }
  }, [url])

  const toggle = () => {
    const a = audio.current
    if (!a) return
    if (a.paused) a.play().catch(() => {}); else a.pause()
  }
  useImperativeHandle(ref, () => ({ toggle }), [])

  const seek = (e) => {
    const a = audio.current
    if (!a || !dur) return
    const rail = e.currentTarget.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (e.clientX - rail.left) / rail.width))
    a.currentTime = pct * dur
    setCur(a.currentTime)
  }

  if (!track) return null
  const pct = dur ? (cur / dur) * 100 : 0

  return (
    <div className="player">
      <audio
        ref={audio}
        src={url || undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCur(e.target.currentTime)}
        onLoadedMetadata={(e) => setDur(e.target.duration || 0)}
        onEnded={() => onNext && onNext()}
        onError={() => url && onError && onError('Playback error')}
      />
      <div className="pcover clickable" onClick={() => onArtClick && onArtClick(track)} title="Show album"><Art path={track.artPath || track.path} eager /></div>
      <div className="pmeta">
        <div className="pt">{track.title}</div>
        <div className="pa">{track.artist}</div>
      </div>

      <button className="ctrl small" onClick={onPrev} title="Previous"><Icon.prev /></button>
      <button className="ctrl" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
        {loading ? <span className="spinner" /> : playing ? <Icon.pause /> : <Icon.play />}
      </button>
      <button className="ctrl small" onClick={onNext} title="Next"><Icon.next /></button>

      <div className="scrub">
        <span className="time">{fmtDur(cur * 1000)}</span>
        <div className="track-rail" onClick={seek}>
          <div className="fill" style={{ width: pct + '%' }} />
          <div className="knob" style={{ left: pct + '%' }} />
        </div>
        <span className="time r">{fmtDur((dur || track.durationMs / 1000) * 1000)}</span>
      </div>
    </div>
  )
})

export default Player
