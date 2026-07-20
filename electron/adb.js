'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// prefer the bundled adb (packaged, then repo-local), else env override, brew, PATH
function resolveAdb() {
  const candidates = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'adb', 'adb'))
  candidates.push(path.join(__dirname, '..', 'vendor', 'adb', 'adb'))
  if (process.env.CRATE_ADB) candidates.push(process.env.CRATE_ADB)
  candidates.push('/opt/homebrew/bin/adb', '/usr/local/bin/adb')
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return 'adb'
}
const ADB = resolveAdb()

// private port so we run our own adb server; the default 5037 daemon detaches to
// launchd and macOS won't attribute its local-network access to Crate
const ADB_PORT = process.env.CRATE_ADB_PORT || '5539'

const CACHE_DIR = path.join(os.tmpdir(), 'crate-cache')
fs.mkdirSync(CACHE_DIR, { recursive: true })

const MUSIC_ROOT = '/sdcard/Music'

function adbRaw(args, { input, timeout = 30000, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ADB, ['-P', ADB_PORT, ...args], { windowsHide: true })
    const out = []
    const err = []
    let outLen = 0
    let done = false
    const finish = (fn, val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn(val)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(reject, new Error(`adb ${args[0]} timed out after ${timeout}ms`))
    }, timeout)

    child.stdout.on('data', (d) => {
      outLen += d.length
      if (outLen > maxBuffer) {
        child.kill('SIGKILL')
        finish(reject, new Error('adb output exceeded buffer'))
        return
      }
      out.push(d)
    })
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => finish(reject, e))
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8')
      if (code !== 0) {
        finish(reject, new Error(stderr.trim() || `adb exited ${code}`))
      } else {
        finish(resolve, { stdout: Buffer.concat(out), stderr })
      }
    })
    if (input != null) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

async function adb(args, opts) {
  const { stdout } = await adbRaw(args, opts)
  return stdout.toString('utf8')
}

// stream a device file straight to a local path, no temp on phone
function pullStream(serial, remotePath, destPath, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    // path as its own argv element; protocol v2 passes it verbatim to cat, not shell-quoted
    const child = spawn(ADB, ['-P', ADB_PORT, '-s', serial, 'exec-out', 'cat', remotePath], { windowsHide: true })
    const ws = fs.createWriteStream(destPath)
    const err = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('pull timed out'))
    }, timeout)
    child.stdout.pipe(ws)
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', reject)
    ws.on('error', reject)
    ws.on('finish', () => {
      clearTimeout(timer)
      resolve(destPath)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        clearTimeout(timer)
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || `exec-out exited ${code}`))
      }
    })
  })
}


async function pair(host, port, code) {
  const target = `${host}:${port}`
  try {
    const out = await adb(['pair', target, String(code)], { timeout: 20000 })
    if (/Successfully paired/i.test(out)) return { ok: true, target }
    // some adb builds want the code on stdin instead of as an arg
    const out2 = await adb(['pair', target], { input: `${code}\n`, timeout: 20000 })
    if (/Successfully paired/i.test(out2)) return { ok: true, target }
    throw new Error(out2.trim() || out.trim() || 'pairing failed')
  } catch (e) {
    throw new Error(`Pairing failed: ${e.message}`)
  }
}

async function discover() {
  try {
    const out = await adb(['mdns', 'services'], { timeout: 8000 })
    for (const line of out.split('\n')) {
      if (line.includes('_adb-tls-connect._tcp')) {
        const m = line.match(/([0-9.]+)\s+(\d+)\s*$/)
        if (m) return `${m[1]}:${m[2]}`
      }
    }
  } catch { /* mdns not available; caller falls back to saved endpoint */ }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startServer() {
  await adb(['start-server'], { timeout: 15000 }).catch(() => {})
}

async function connect(endpoint) {
  const out = await adb(['connect', endpoint], { timeout: 15000 })
  if (/connected to|already connected/i.test(out)) return endpoint
  // macOS Local Network Privacy blocks adb's LAN sockets before it's granted
  if (/no route to host/i.test(out)) { const e = new Error('LOCAL_NETWORK_BLOCKED'); throw e }
  throw new Error(out.trim() || `could not connect to ${endpoint}`)
}

async function phoneWifiIp(serial) {
  const out = await adb(['-s', serial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], { timeout: 10000 }).catch(() => '')
  const m = out.match(/inet (\d+\.\d+\.\d+\.\d+)/)
  return m ? m[1] : null
}

// flip a USB phone's adbd to TCP then connect over WiFi; lasts until reboot
async function enableWireless(usbSerial) {
  const existing = (await onlineSerials()).find((s) => /:\d+$/.test(s))
  if (existing) return { endpoint: existing }

  const ip = await phoneWifiIp(usbSerial)
  if (!ip) throw new Error('Your phone is not on WiFi. Connect it to the same network as this Mac.')
  await adb(['-s', usbSerial, 'tcpip', '5555'], { timeout: 15000 })
  await sleep(2500) // adbd restarts
  const endpoint = `${ip}:5555`
  let lastErr
  for (let i = 0; i < 6; i++) {
    try {
      await connect(endpoint)
      if ((await onlineSerials()).includes(endpoint)) return { endpoint }
    } catch (e) {
      lastErr = e
      if (e.message === 'LOCAL_NETWORK_BLOCKED') throw e
    }
    await sleep(1500)
  }
  throw new Error(lastErr ? lastErr.message : `Could not reach the phone at ${endpoint}`)
}

async function listDevices() {
  const out = await adb(['devices', '-l'])
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const serial = l.split(/\s+/)[0]
      const state = /\bunauthorized\b/.test(l) ? 'unauthorized' : /\bdevice\b/.test(l) ? 'device' : 'offline'
      const model = (l.match(/model:(\S+)/) || [])[1] || null
      const transport = /:\d+$/.test(serial) ? 'wifi' : 'usb'
      return { serial, state, model: model ? model.replace(/_/g, ' ') : null, transport }
    })
}

async function storage(serial) {
  const out = await adb(['-s', serial, 'exec-out', 'df', '-k', '/sdcard'], { timeout: 15000 }).catch(() => '')
  const lines = out.trim().split('\n').filter(Boolean)
  const data = lines[lines.length - 1]
  if (!data) return null
  const cols = data.trim().split(/\s+/)
  const nums = cols.filter((c) => /^\d+$/.test(c))
  if (nums.length < 3) return null
  const total = parseInt(nums[0], 10) * 1024
  const used = parseInt(nums[1], 10) * 1024
  const free = parseInt(nums[2], 10) * 1024
  return total ? { total, used, free } : null
}

async function onlineSerials() {
  const out = await adb(['devices'])
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => /\tdevice$/.test(l))
    .map((l) => l.split('\t')[0])
}

// try in order: already-connected, saved endpoint, mDNS, USB. retries transient
// WiFi-doze failures. caller must start the managed adb server first (main.js)
async function ensureConnected(savedEndpoint) {
  let serials = await onlineSerials()
  const wifiUp = serials.find((s) => /:\d+$/.test(s))
  if (wifiUp) return { serial: wifiUp, endpoint: wifiUp }

  // retry the saved endpoint a few times: the WiFi radio often drops the first
  // packet while dozing. remember a macOS block but keep going, USB still works
  let blocked = false
  if (savedEndpoint) {
    for (let i = 0; i < 5; i++) {
      try { await connect(savedEndpoint) }
      catch (e) { if (e.message === 'LOCAL_NETWORK_BLOCKED') { blocked = true; break } }
      serials = await onlineSerials()
      if (serials.includes(savedEndpoint)) return { serial: savedEndpoint, endpoint: savedEndpoint }
      await sleep(600)
    }
  }

  const found = await discover()
  if (found) {
    try { await connect(found) } catch { /* fall through */ }
    serials = await onlineSerials()
    if (serials.includes(found)) return { serial: found, endpoint: found }
  }

  serials = await onlineSerials()
  if (serials.length) return { serial: serials[0], endpoint: null }

  throw new Error(blocked ? 'LOCAL_NETWORK_BLOCKED' : 'NO_DEVICE')
}

// Prefer a wifi (ip:port) serial over a usb one.
function preferWifi(serials) {
  return serials.find((s) => /:\d+$/.test(s)) || serials[0]
}

const COLUMNS = ['_id', 'title', 'artist', 'album', 'album_id', 'track', 'duration', '_data', '_size', 'year']
const KEY_RE = new RegExp(`(?:^Row: \\d+ |, )(${COLUMNS.join('|')})=`, 'g')

// content query values can contain commas, so split on the known key tokens
function parseRows(text) {
  const rows = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith('Row:')) continue
    const rec = {}
    const marks = []
    let m
    KEY_RE.lastIndex = 0
    while ((m = KEY_RE.exec(raw)) !== null) {
      marks.push({ key: m[1], valStart: m.index + m[0].length })
    }
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length
        ? raw.lastIndexOf(', ' + marks[i + 1].key + '=', marks[i + 1].valStart)
        : raw.length
      rec[marks[i].key] = raw.slice(marks[i].valStart, end)
    }
    if (rec._data) rows.push(rec)
  }
  return rows
}

const AUDIO_EXT = /\.(flac|mp3|m4a|aac|ogg|opus|wav|alac|aiff?)$/i

async function listTracks(serial) {
  // no on-device --where clause: its shell quoting varies across Android builds
  const out = await adb([
    '-s', serial, 'shell', 'content', 'query',
    '--uri', 'content://media/external/audio/media',
    '--projection', COLUMNS.join(':'),
  ], { timeout: 60000, maxBuffer: 128 * 1024 * 1024 })

  return parseRows(out)
    .filter((r) => r._data && r._data.startsWith('/') && AUDIO_EXT.test(r._data))
    .map((r) => {
      const artist = clean(r.artist)
      const album = clean(r.album)
      const title = clean(r.title)
      // recover fields from folder+name for untagged files so they don't all collapse into "Unknown Album"
      const inferred = (!artist || !album) ? inferFromPath(r._data) : null
      return {
        id: r._id,
        title: title || (inferred && inferred.title) || basename(r._data),
        artist: artist || (inferred && inferred.artist) || 'Unknown Artist',
        album: album || (inferred && inferred.album) || 'Unknown Album',
        albumId: r.album_id || '',
        track: parseInt(r.track, 10) || (inferred && inferred.track) || 0,
        durationMs: parseInt(r.duration, 10) || 0,
        size: parseInt(r._size, 10) || 0,
        path: r._data,
        year: parseInt(r.year, 10) || (inferred && inferred.year && parseInt(inferred.year, 10)) || null,
        inferred: !!(inferred && (inferred.artist || inferred.album)),
      }
    })
}

function clean(v) {
  if (v == null) return ''
  const t = v.trim()
  return t === 'NULL' || t === '<null>' ? '' : t
}
function basename(p) {
  return p.split('/').pop().replace(/\.[^.]+$/, '')
}

const { inferFromPath } = require('./tagger')

const mm = () => import('music-metadata')

async function getArt(serial, remotePath) {
  const key = crypto.createHash('sha1').update(serial + remotePath).digest('hex')
  const hit = fs.readdirSync(CACHE_DIR).find((f) => f.startsWith('art-' + key))
  if (hit) return path.join(CACHE_DIR, hit)

  // a cover the user explicitly set (.crate-cover.*) always wins
  const override = await pullFolderImage(serial, remotePath, key, /(^|\/)\.crate-cover\.[a-z0-9]+$/i)
  if (override) return override

  // embedded picture: grab the first ~2.5MB where FLAC/ID3 art lives
  const { stdout } = await adbRaw(
    ['-s', serial, 'exec-out', 'dd', 'if=' + remotePath, 'bs=65536', 'count=40'],
    { timeout: 45000, maxBuffer: 8 * 1024 * 1024 }
  )
  if (stdout.length) {
    const { parseBuffer } = await mm()
    let pic
    try {
      const meta = await parseBuffer(stdout, { path: remotePath }, { duration: false })
      pic = meta.common.picture && meta.common.picture[0]
    } catch { /* header truncated or no art */ }
    if (pic && pic.data) {
      const outExt = pic.format && pic.format.includes('png') ? 'png' : 'jpg'
      const dest = path.join(CACHE_DIR, `art-${key}.${outExt}`)
      fs.writeFileSync(dest, Buffer.from(pic.data))
      return dest
    }
  }

  // fall back to a cover image in the album folder (cover/folder/front.jpg, or any image)
  const folderArt = await folderCover(serial, remotePath, key)
  if (folderArt) return folderArt
  return null
}

async function folderCover(serial, remotePath, key) {
  return pullFolderImage(serial, remotePath, key, null)
}

// find an image in the album folder and cache it. use `find` not `ls`: it emits
// raw unescaped paths so names with spaces read correctly
async function pullFolderImage(serial, remotePath, key, match) {
  const dir = remotePath.replace(/\/[^/]+$/, '')
  const out = await adb(['-s', serial, 'exec-out', 'find', dir, '-maxdepth', '1', '-type', 'f'], { timeout: 15000 }).catch(() => '')
  const files = out.split('\n').map((s) => s.trim()).filter(Boolean)
  const base = (f) => f.slice(f.lastIndexOf('/') + 1)
  let pick
  if (match) {
    pick = files.find((f) => match.test(f))
  } else {
    const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !/\.crate-cover\./i.test(f))
    pick = images.find((f) => /^(cover|folder|front|album|albumart)\.[a-z]+$/i.test(base(f))) ||
      images.find((f) => /(cover|folder|front)/i.test(base(f))) ||
      images[0]
  }
  if (!pick) return null
  const outExt = /\.png$/i.test(pick) ? 'png' : /\.webp$/i.test(pick) ? 'webp' : 'jpg'
  const dest = path.join(CACHE_DIR, `art-${key}.${outExt}`)
  try {
    const { stdout } = await adbRaw(['-s', serial, 'exec-out', 'cat', pick], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
    if (!stdout.length) return null
    fs.writeFileSync(dest, stdout)
    return dest
  } catch { return null }
}

// read duration from the FLAC header (first ~128KB) when MediaStore didn't index it
async function trackDuration(serial, remotePath) {
  const key = crypto.createHash('sha1').update(serial + remotePath).digest('hex')
  const cf = path.join(CACHE_DIR, `dur-${key}`)
  try { const v = parseInt(fs.readFileSync(cf, 'utf8'), 10); if (v > 0) return v } catch { /* miss */ }

  const { stdout } = await adbRaw(
    ['-s', serial, 'exec-out', 'dd', 'if=' + remotePath, 'bs=65536', 'count=2'],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
  ).catch(() => ({ stdout: Buffer.alloc(0) }))
  if (!stdout.length) return 0
  const { parseBuffer } = await mm()
  let ms = 0
  try {
    const meta = await parseBuffer(stdout, { path: remotePath }, { duration: true })
    ms = Math.round((meta.format.duration || 0) * 1000)
  } catch { /* unparseable header */ }
  if (ms > 0) { try { fs.writeFileSync(cf, String(ms)) } catch { /* ignore */ } }
  return ms
}

async function cacheTrack(serial, remotePath, size) {
  const key = crypto.createHash('sha1').update(serial + remotePath).digest('hex')
  const ext = (remotePath.match(/\.[^.]+$/) || ['.bin'])[0]
  const dest = path.join(CACHE_DIR, `track-${key}${ext}`)
  if (fs.existsSync(dest) && (!size || fs.statSync(dest).size === size)) return dest
  await pullStream(serial, remotePath, dest)
  return dest
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i

function walkLocal(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walkLocal(full, out)
    else out.push(full)
  }
  return out
}

// turn dropped files/folders into a push plan: keep only audio + cover images,
// folders keep their name as the album folder
function planPush(localPaths) {
  const items = []
  const seen = new Set()
  const consider = (local, rel) => {
    const keep = AUDIO_EXT.test(local) || IMAGE_EXT.test(local)
    if (!keep || seen.has(local)) return
    seen.add(local)
    items.push({ local, rel, audio: AUDIO_EXT.test(local) })
  }
  for (const p of localPaths) {
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (st.isDirectory()) {
      const parent = path.dirname(p)
      for (const f of walkLocal(p)) consider(f, path.relative(parent, f))
    } else {
      consider(p, path.basename(p))
    }
  }
  return items
}

async function pushPaths(serial, localPaths, onProgress, root = MUSIC_ROOT) {
  const items = planPush(localPaths)
  const audioItems = items.filter((i) => i.audio)
  if (audioItems.length === 0) return { added: 0, images: 0, found: 0 }

  const madeDirs = new Set()
  const touchedFiles = []
  let added = 0, images = 0
  let done = 0
  for (const it of items) {
    const rel = it.rel.split(path.sep).join('/')
    const remotePath = `${root}/${rel}`
    const remoteDir = remotePath.replace(/\/[^/]+$/, '')
    if (remoteDir !== root && !madeDirs.has(remoteDir)) {
      await adb(['-s', serial, 'exec-out', 'mkdir', '-p', remoteDir], { timeout: 20000 }).catch(() => {})
      madeDirs.add(remoteDir)
    }
    try {
      await adb(['-s', serial, 'push', it.local, remotePath], { timeout: 600000 })
      if (it.audio) { added++; touchedFiles.push(remotePath) } else images++
    } catch { /* skip a file that failed, keep going */ }
    if (onProgress) onProgress(++done, items.length)
  }

  for (const f of touchedFiles) await mediaScan(serial, f)
  await powerampReload(serial)
  return { added, images, found: audioItems.length }
}

async function setCover(serial, trackPath, localImage) {
  const dir = trackPath.replace(/\/[^/]+$/, '')
  // write a Crate override (wins in Crate) plus a plain cover.jpg for other players
  await adb(['-s', serial, 'push', localImage, `${dir}/.crate-cover.jpg`], { timeout: 120000 })
  await adb(['-s', serial, 'push', localImage, `${dir}/cover.jpg`], { timeout: 120000 }).catch(() => {})
  const key = crypto.createHash('sha1').update(serial + trackPath).digest('hex')
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (f.startsWith('art-' + key)) { try { fs.rmSync(path.join(CACHE_DIR, f), { force: true }) } catch { /* ignore */ } }
  }
  return `${dir}/.crate-cover.jpg`
}

const TRASH = '/sdcard/.crate-trash'

// move files into a hidden trash folder so a delete can be undone
async function softDelete(serial, remotePaths) {
  await adb(['-s', serial, 'exec-out', 'mkdir', '-p', TRASH], { timeout: 15000 }).catch(() => {})
  const items = []
  for (const rp of remotePaths) {
    const ext = (rp.match(/\.[^./]+$/) || [''])[0]
    const trashed = `${TRASH}/${crypto.createHash('sha1').update(rp).digest('hex')}${ext}`
    try {
      await adb(['-s', serial, 'exec-out', 'mv', rp, trashed], { timeout: 30000 })
      items.push({ original: rp, trashed })
      await mediaScan(serial, rp)
    } catch { /* skip a file that failed to move */ }
  }
  await powerampReload(serial)
  return items
}

async function restoreDeleted(serial, items) {
  for (const it of items) {
    try { await adb(['-s', serial, 'exec-out', 'mv', it.trashed, it.original]); await mediaScan(serial, it.original) } catch { /* ignore */ }
  }
  await powerampReload(serial)
}

async function purgeDeleted(serial, items) {
  for (const it of items) await adb(['-s', serial, 'exec-out', 'rm', '-f', it.trashed], { timeout: 20000 }).catch(() => {})
}

// nudge Android's media scanner about one changed path
async function mediaScan(serial, remotePath) {
  await adb([
    '-s', serial, 'shell', 'am', 'broadcast',
    '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d', `file://${remotePath}`,
  ], { timeout: 20000 }).catch(() => {})
}

// ask Poweramp to reload (no-op if it isn't installed)
async function powerampReload(serial) {
  await adb([
    '-s', serial, 'shell', 'am', 'broadcast',
    '-a', 'com.maxmpz.audioplayer.ACTION_RELOAD_DATA',
    '-n', 'com.maxmpz.audioplayer/.scanner.ScannerReceiver',
    '--es', 'fast', 'true',
  ], { timeout: 20000 }).catch(() => {})
}

module.exports = {
  ADB,
  ADB_PORT,
  CACHE_DIR,
  MUSIC_ROOT,
  startServer,
  pair,
  discover,
  connect,
  enableWireless,
  listDevices,
  storage,
  phoneWifiIp,
  ensureConnected,
  onlineSerials,
  listTracks,
  getArt,
  cacheTrack,
  pullStream,
  trackDuration,
  setCover,
  planPush,
  pushPaths,
  softDelete,
  restoreDeleted,
  purgeDeleted,
}
