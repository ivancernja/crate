'use strict'

// recover artist/album/track/title for untagged files from their folder and file names
const QUALITY =/\b(flac|mp3|alac|aac|wav|web|vinyl|cd\d?|cdrip|24bit|16bit|16-44|24-44|24-96|24-192|96khz|192khz|remaster(ed)?|deluxe|expanded|mono|stereo|explicit)\b/i

function cleanAlbum(folder) {
  let s = folder
  s = s.replace(/^\s*(va|various\s+artists?)\s*[-–—_]\s*/i, '')     // "VA - " comp prefix
  s = s.replace(/^\s*[\(\[]?(19|20)\d{2}[\)\]]?\s*[-–—._]\s*/, '') // leading "1984 - "
  s = s.replace(/\s*[\(\[]\s*(19|20)\d{2}\s*[\)\]]/g, ' ')          // "(2019)"
  s = s.replace(/\s*[\[\(][^\])]*\]|\s*[\[\(][^\])]*\)/g, (m) => (QUALITY.test(m) ? ' ' : m)) // "[FLAC 16-44]"
  s = s.replace(/\s*[-–—]\s*(FLAC|MP3|WEB|VINYL).*$/i, '')
  s = s.replace(/\s{2,}/g, ' ').trim()
  return s
}

function yearFrom(folder) {
  const m = folder.match(/(19|20)\d{2}/)
  return m ? m[0] : null
}

function splitDash(s) {
  return s.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean)
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function inferFromPath(fullPath, folderAlbum) {
  const segs = fullPath.split('/')
  const file = segs.pop()
  const folder = folderAlbum || segs.pop() || ''
  const album = cleanAlbum(folder)
  const year = yearFrom(folder)

  let base = file.replace(/\.[^.]+$/, '')
  // pull a leading track number: "01 ", "01 - ", "1-01 " (disc-track), "0001 Title"
  let track = null
  let tm = base.match(/^\s*(?:\d{1,2}\s*[-.]\s*)?(\d{1,4})\s*[-.)\s]+/)
  if (tm) { track = parseInt(tm[1], 10); base = base.slice(tm[0].length) }

  let parts = splitDash(base)
  // drop a part that's just a track number, capturing it if we don't have one yet
  parts = parts.filter((p) => {
    const t = p.match(/^(?:cd|disc)?\s*(\d{1,2})[-.]?(\d{1,3})?$/i)
    if (!t) return true
    const num = t[2] != null ? t[2] : t[1]
    if (track == null || track === 0) track = parseInt(num, 10)
    return false
  })
  // drop a part repeating the album name, but only if artist+title survive (3+
  // parts); else a band named after its album (Kids See Ghosts) loses its artist
  if (album && parts.length >= 3) parts = parts.filter((p) => normalize(p) !== normalize(album))

  let artist = null, title = null
  if (parts.length >= 2) { artist = parts[0]; title = parts.slice(1).join(' - ') }
  else if (parts.length === 1) { title = parts[0] }

  // no artist from the filename but folder looks like "Artist - Album"? split it
  let finalAlbum = album
  if (!artist && album) {
    const fparts = splitDash(album)
    if (fparts.length === 2) { artist = fparts[0]; finalAlbum = fparts[1] }
  }

  // strip "feat." so tracks group under the same artist
  if (artist) artist = artist.replace(/\s*(feat\.?|featuring|ft\.?|with)\s+.*$/i, '').trim()

  // strip a glued disc/track prefix from the title ("CD1-01 Kad odem", "01. ")
  if (title) {
    title = title.replace(/^\s*(?:cd|disc)\s*\d+\s*[-.\s]\s*\d*\s*[-.\s]*/i, '')
    title = title.replace(/^\s*\d{1,3}\s*[-.]\s*/, '')
    title = title.trim()
  }

  return {
    artist: artist || null,
    album: finalAlbum || null,
    title: title || base,
    track: track || 0,
    year,
  }
}

module.exports = { inferFromPath, cleanAlbum }
