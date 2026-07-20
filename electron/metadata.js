'use strict'

// album context (year, genres, blurb) from MusicBrainz + Wikipedia, cached to disk
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const CACHE_DIR = path.join(os.tmpdir(), 'crate-cache')
fs.mkdirSync(CACHE_DIR, { recursive: true })

const UA = 'Crate/0.1 ( https://github.com/ivan/crate )'

function getJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(getJSON(new URL(res.headers.location, url).toString(), headers))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(12000, () => req.destroy(new Error('timeout')))
  })
}

// MusicBrainz asks for <=1 req/sec, so serialise calls through a queue
let mbChain = Promise.resolve()
function mb(url) {
  const run = () => getJSON(url)
  const p = mbChain.then(run, run)
  mbChain = p.then(() => sleep(1100), () => sleep(1100))
  return p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function q(s) { return encodeURIComponent(String(s).replace(/"/g, '')) }

async function wikiSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`
  const j = await getJSON(url).catch(() => null)
  if (!j || j.type === 'disambiguation' || !j.extract) return null
  return { summary: j.extract, url: j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page }
}

async function resolveWiki(relations) {
  if (!relations) return null
  const wp = relations.find((r) => r.type === 'wikipedia' && r.url)
  if (wp) {
    const title = decodeURIComponent(wp.url.resource.split('/wiki/')[1] || '').replace(/_/g, ' ')
    if (title) { const s = await wikiSummary(title); if (s) return s }
  }
  const wd = relations.find((r) => r.type === 'wikidata' && r.url)
  if (wd) {
    const qid = wd.url.resource.split('/').pop()
    const ent = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`).catch(() => null)
    const title = ent && ent.entities && ent.entities[qid] && ent.entities[qid].sitelinks &&
      ent.entities[qid].sitelinks.enwiki && ent.entities[qid].sitelinks.enwiki.title
    if (title) { const s = await wikiSummary(title); if (s) return s }
  }
  return null
}

async function albumInfo(artist, album) {
  const key = crypto.createHash('sha1').update(`v2:${artist}::${album}`).digest('hex')
  const cacheFile = path.join(CACHE_DIR, `meta-${key}.json`)
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch { /* miss */ }

  const result = { year: null, genres: [], type: null, summary: null, url: null, found: false }
  try {
    const search = await mb(
      `https://musicbrainz.org/ws/2/release-group/?query=artist:"${q(artist)}" AND releasegroup:"${q(album)}"&fmt=json&limit=3`
    )
    const groups = search['release-groups'] || []
    // prefer a full Album over a Single/EP with the same name
    const rg = groups.find((g) => g['primary-type'] === 'Album') || groups[0]
    if (rg) {
      result.found = true
      result.year = (rg['first-release-date'] || '').slice(0, 4) || null
      result.type = rg['primary-type'] || null
      const detail = await mb(`https://musicbrainz.org/ws/2/release-group/${rg.id}?inc=url-rels+genres+tags&fmt=json`).catch(() => null)
      const tagsrc = (detail && (detail.genres || detail.tags)) || rg.tags || []
      result.genres = tagsrc
        .slice()
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, 3)
        .map((t) => t.name)
      if (detail) {
        const wiki = await resolveWiki(detail.relations)
        if (wiki) { result.summary = wiki.summary; result.url = wiki.url }
      }
    }
  } catch { /* network or no match; return what we have */ }

  // fallback: search Wikipedia, accept the first hit whose title and summary look album-related
  if (!result.summary) {
    try {
      const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      const na = norm(album)
      const sr = await getJSON(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q(album + ' ' + artist + ' album')}&format=json&srlimit=5`
      )
      const hits = (sr && sr.query && sr.query.search) || []
      for (const hit of hits) {
        const nt = norm(hit.title.replace(/\s*\(.*?\)\s*$/, ''))
        if (!(nt === na || nt.includes(na) || na.includes(nt))) continue
        const s = await wikiSummary(hit.title)
        if (s && (s.summary.toLowerCase().includes('album') || s.summary.toLowerCase().includes(artist.toLowerCase().split(' ')[0]))) {
          result.summary = s.summary; result.url = s.url; break
        }
      }
    } catch { /* ignore */ }
  }

  try { fs.writeFileSync(cacheFile, JSON.stringify(result)) } catch { /* ignore */ }
  return result
}

function getBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) return reject(new Error('too many redirects'))
        return resolve(getBuffer(new URL(res.headers.location, url).toString(), redirects - 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject).setTimeout(25000, function () { this.destroy(new Error('timeout')) })
  })
}

// front cover art via MusicBrainz then Cover Art Archive; Buffer or null
async function fetchCover(artist, album, year) {
  try {
    const query = `releasegroup:"${q(album)}" AND artist:"${q(artist)}"`
    const search = await mb(`https://musicbrainz.org/ws/2/release-group/?query=${query}&fmt=json&limit=5`)
    const groups = search['release-groups'] || []
    const rg = groups.find((g) => g['primary-type'] === 'Album') || groups[0]
    if (!rg) return null
    // 500px then 250px; skip the full-res original, it can be 10MB+
    let buf = await getBuffer(`https://coverartarchive.org/release-group/${rg.id}/front-500`).catch(() => null)
    if (!buf || buf.length < 1000) buf = await getBuffer(`https://coverartarchive.org/release-group/${rg.id}/front-250`).catch(() => null)
    return buf && buf.length > 1000 ? buf : null
  } catch { return null }
}

// resolve an album's artist from its name (+ year) when files carry no artist tag
async function albumArtist(album, year) {
  const key = crypto.createHash('sha1').update(`artist:${album}:${year || ''}`).digest('hex')
  const cacheFile = path.join(CACHE_DIR, `meta-artist-${key}.json`)
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).artist } catch { /* miss */ }

  let artist = null
  try {
    const query = year
      ? `releasegroup:"${q(album)}" AND firstreleasedate:${year}`
      : `releasegroup:"${q(album)}"`
    const search = await mb(`https://musicbrainz.org/ws/2/release-group/?query=${query}&fmt=json&limit=5`)
    const groups = search['release-groups'] || []
    const rg = groups.find((g) => g['primary-type'] === 'Album') || groups[0]
    if (rg && rg['artist-credit']) {
      artist = rg['artist-credit'].map((a) => a.name + (a.joinphrase || '')).join('').trim() || null
      if (/^various artists$/i.test(artist || '')) artist = null
    }
  } catch { /* network/no match */ }

  try { fs.writeFileSync(cacheFile, JSON.stringify({ artist })) } catch { /* ignore */ }
  return artist
}

module.exports = { albumInfo, albumArtist, fetchCover }
