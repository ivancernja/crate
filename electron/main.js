'use strict'

const { app, BrowserWindow, ipcMain, protocol, dialog, shell } = require('electron')
const { spawn } = require('child_process')
const net = require('net')
const http = require('http')
const path = require('path')
const fs = require('fs')
const adb = require('./adb')
const store = require('./store')
const metadata = require('./metadata')

let serial = null
let transport = null // 'usb' | 'wifi'
let autoRoot = null // device-aware default music folder, until the user sets one

// where new music lands: the user's choice, else the auto-detected default
function currentRoot() {
  return store.read().musicRoot || autoRoot || adb.MUSIC_ROOT
}

// localhost HTTP server that pipes track bytes straight off the phone with `dd`,
// so playback starts fast instead of downloading the whole FLAC first. Range
// requests seek with dd skip=, then we trim the partial leading block.
let streamPort = 0
function contentType(p) {
  const ext = (p.match(/\.([^.]+)$/) || [])[1]
  return {
    flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/mp4',
    alac: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
    aif: 'audio/aiff', aiff: 'audio/aiff',
  }[(ext || '').toLowerCase()] || 'application/octet-stream'
}
function startStreamServer() {
  const server = http.createServer((req, res) => {
    let child = null
    try {
      if (!serial) { res.writeHead(503); return res.end() }
      const u = new URL(req.url, 'http://127.0.0.1')
      const p = Buffer.from(u.searchParams.get('p') || '', 'base64').toString('utf8')
      const size = parseInt(u.searchParams.get('s') || '0', 10)
      if (!p) { res.writeHead(400); return res.end() }

      const BS = 65536
      let start = 0, end = size ? size - 1 : 0
      const range = req.headers.range
      if (range && size) {
        const m = /bytes=(\d+)-(\d*)/.exec(range)
        if (m) { start = parseInt(m[1], 10); if (m[2]) end = parseInt(m[2], 10) }
      }
      const wantLen = size ? end - start + 1 : null
      const blockStart = Math.floor(start / BS)
      let toSkip = start - blockStart * BS

      const headers = { 'Content-Type': contentType(p), 'Accept-Ranges': 'bytes' }
      if (size) { headers['Content-Length'] = String(wantLen); if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}` }
      res.writeHead(range && size ? 206 : 200, headers)
      if (req.method === 'HEAD') return res.end()

      child = spawn(adb.ADB, ['-P', adb.ADB_PORT, '-s', serial, 'exec-out', 'dd', 'if=' + p, `bs=${BS}`, `skip=${blockStart}`], { windowsHide: true })
      let sent = 0
      child.stdout.on('data', (buf) => {
        if (toSkip > 0) { const d = Math.min(toSkip, buf.length); toSkip -= d; buf = buf.subarray(d); if (!buf.length) return }
        if (wantLen != null) { const remain = wantLen - sent; if (remain <= 0) return; if (buf.length > remain) buf = buf.subarray(0, remain) }
        sent += buf.length
        if (!res.write(buf)) { child.stdout.pause(); res.once('drain', () => child.stdout.resume()) }
        if (wantLen != null && sent >= wantLen) { try { child.kill('SIGKILL') } catch {} res.end() }
      })
      child.stdout.on('end', () => { try { res.end() } catch {} })
      child.on('error', () => { try { res.end() } catch {} })
      req.on('close', () => { if (child) try { child.kill('SIGKILL') } catch {} })
    } catch { try { res.writeHead(500); res.end() } catch {} ; if (child) try { child.kill('SIGKILL') } catch {} }
  })
  server.listen(0, '127.0.0.1', () => { streamPort = server.address().port })
}

// resolves once the managed adb server is listening, so the first connect
// doesn't race startup. probe with a raw socket so we don't spawn a competing daemon
let markServerReady
const serverReady = new Promise((r) => { markServerReady = r })
function probeServer(retries) {
  const sock = net.connect(Number(adb.ADB_PORT), '127.0.0.1')
  sock.once('connect', () => { sock.destroy(); markServerReady(true) })
  sock.once('error', () => { sock.destroy(); if (retries > 0) setTimeout(() => probeServer(retries - 1), 150) })
}

const DEV = process.env.CRATE_DEV === '1'
let win = null

// run adb's server in nodaemon mode as a real child: the normal server double-forks
// to launchd, which breaks macOS attribution so Crate never appears in Local Network
let adbServer = null
function startManagedAdbServer() {
  if (adbServer) return
  adbServer = spawn(adb.ADB, ['-P', adb.ADB_PORT, 'nodaemon', 'server'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  adbServer.on('exit', () => {
    adbServer = null
    if (!app.isQuitting) setTimeout(startManagedAdbServer, 500) // resurrect if it dies
  })
  probeServer(60)
}

app.on('before-quit', () => {
  app.isQuitting = true
  if (adbServer) { try { adbServer.kill() } catch {} }
})

// must run before app 'ready'; makes crate:// secure and streamable so <audio> can seek
protocol.registerSchemesAsPrivileged([
  { scheme: 'crate', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: false } },
])

// serve cached art/tracks to the renderer without file:// access
function registerSchemes() {
  protocol.registerFileProtocol('crate', (request, cb) => {
    const rel = decodeURIComponent(request.url.replace('crate://file/', ''))
    // only ever serve out of the cache dir
    const resolved = path.resolve(rel)
    if (resolved.startsWith(adb.CACHE_DIR)) cb({ path: resolved })
    else cb({ error: -6 })
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#121316',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 19 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (DEV) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(() => {
  registerSchemes()
  startManagedAdbServer()
  startStreamServer()
  startWatch()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// push anything new that lands in a chosen Mac folder
let watcher = null
let watchTimer = null
let watchSeen = new Set() // top-level entries present when watching started

function stopWatch() {
  if (watcher) { try { watcher.close() } catch {} watcher = null }
  clearTimeout(watchTimer)
}
function startWatch() {
  stopWatch()
  const { watchFolder } = store.read()
  if (!watchFolder) return
  try {
    watchSeen = new Set(fs.readdirSync(watchFolder)) // ignore what's already there
    watcher = fs.watch(watchFolder, {}, () => { clearTimeout(watchTimer); watchTimer = setTimeout(scanWatch, 2500) })
  } catch { /* folder gone */ }
}
async function scanWatch() {
  const { watchFolder } = store.read()
  if (!watchFolder || !serial) return
  let entries
  try { entries = fs.readdirSync(watchFolder) } catch { return }
  const fresh = entries.filter((e) => !e.startsWith('.') && !watchSeen.has(e))
  if (!fresh.length) return
  fresh.forEach((e) => watchSeen.add(e))
  const paths = fresh.map((e) => path.join(watchFolder, e))
  try {
    const res = await adb.pushPaths(serial, paths, null, currentRoot())
    if (res.added && win && !win.isDestroyed()) win.webContents.send('watch-pushed', { added: res.added })
  } catch { /* ignore */ }
}

// IPC wrappers over adb.js. everything returns { ok, data } or { ok:false, error }
function ok(data) { return { ok: true, data } }
function fail(e) { return { ok: false, error: e && e.message ? e.message : String(e) } }
const toUrl = (p) => (p ? 'crate://file/' + encodeURIComponent(p) : null)

// a wireless transport can drop mid-session (the phone dozes, the SD radio sleeps,
// or the endpoint changes), after which every command fails with "device not found".
// run adb work through here: on a dropped-transport error, reconnect once and retry
const DROPPED = /device .*not found|no devices\/emulators|device offline|connection reset|broken pipe|closed|protocol fault|failed to (get feature set|read)/i
async function withDevice(fn) {
  if (!serial) throw new Error('NO_DEVICE')
  try {
    return await fn(serial)
  } catch (e) {
    if (!DROPPED.test(e && e.message ? e.message : '')) throw e
    const { serial: s, endpoint } = await adb.ensureConnected(store.read().endpoint)
    serial = s
    transport = /:\d+$/.test(s) ? 'wifi' : 'usb'
    if (endpoint) store.write({ endpoint, lastConnectedAt: Date.now() })
    return await fn(serial)
  }
}

ipcMain.handle('connect', async () => {
  try {
    // don't race the managed adb server still coming up on launch
    await Promise.race([serverReady, new Promise((r) => setTimeout(r, 8000))])
    const saved = store.read().endpoint
    let { serial: s, endpoint } = await adb.ensureConnected(saved)
    transport = /:\d+$/.test(s) ? 'wifi' : 'usb'

    // landed on USB but we've gone wireless before (phone likely rebooted and
    // dropped tcpip): silently flip back to wireless now the cable is in
    if (transport === 'usb' && saved) {
      try {
        const res = await adb.enableWireless(s)
        s = res.endpoint
        endpoint = res.endpoint
        transport = 'wifi'
      } catch { /* stay on USB; user can hit Go wireless */ }
    }

    serial = s
    if (endpoint) store.write({ endpoint, lastConnectedAt: Date.now() })
    // pick a sensible music folder for this device (SD card on DAPs) until the
    // user sets one; best-effort, so a slow probe never blocks connecting
    if (!store.read().musicRoot) adb.defaultMusicRoot(s).then((r) => { autoRoot = r }).catch(() => {})
    return ok({ serial: s, endpoint, transport })
  } catch (e) {
    // was set up before but can't be reached now (dropped WiFi, phone rebooted):
    // ask to reconnect rather than dropping back to first-time setup
    if (e && e.message === 'NO_DEVICE' && store.read().endpoint) return fail(new Error('DEVICE_UNREACHABLE'))
    return fail(e)
  }
})

ipcMain.handle('devices', async () => {
  try { return ok(await adb.listDevices()) } catch (e) { return fail(e) }
})

ipcMain.handle('go-wireless', async () => {
  try {
    const devs = await adb.listDevices()
    const usb = devs.find((d) => d.transport === 'usb' && d.state === 'device')
    if (!usb) throw new Error('Plug your device in with a USB cable first.')
    const { endpoint } = await adb.enableWireless(usb.serial)
    serial = endpoint
    transport = 'wifi'
    store.write({ endpoint, lastConnectedAt: Date.now() })
    return ok({ endpoint })
  } catch (e) {
    return fail(e)
  }
})

ipcMain.handle('status', async () => {
  try {
    const serials = await adb.onlineSerials()
    return ok({ connected: serials.length > 0, serial, transport, endpoint: store.read().endpoint })
  } catch (e) {
    return fail(e)
  }
})

ipcMain.handle('storage', async () => {
  try { return ok(await withDevice((s) => adb.storage(s))) } catch (e) { return fail(e) }
})

ipcMain.handle('list', async () => {
  try { return ok(await withDevice((s) => adb.listTracks(s))) } catch (e) { return fail(e) }
})

ipcMain.handle('rescan', async () => {
  try {
    return ok(await withDevice((s) => adb.scanNewMusic(s, (done, total) => {
      if (win && !win.isDestroyed()) win.webContents.send('scan-progress', { done, total })
    })))
  } catch (e) { return fail(e) }
})

ipcMain.handle('art', async (_e, remotePath) => {
  try { return ok(toUrl(await withDevice((s) => adb.getArt(s, remotePath)))) } catch (e) { return fail(e) }
})

ipcMain.handle('list-volumes', async () => {
  try { return ok(await withDevice((s) => adb.listVolumes(s))) } catch (e) { return fail(e) }
})

ipcMain.handle('list-dirs', async (_e, dir) => {
  try { return ok(await withDevice((s) => adb.listDirs(s, dir || '/sdcard'))) } catch (e) { return fail(e) }
})

ipcMain.handle('track-url', async (_e, { path: remotePath, size }) => {
  try {
    if (!serial) throw new Error('NO_DEVICE')
    if (!streamPort) throw new Error('Player not ready')
    const q = `p=${encodeURIComponent(Buffer.from(remotePath, 'utf8').toString('base64'))}&s=${size || 0}`
    return ok(`http://127.0.0.1:${streamPort}/t?${q}`)
  } catch (e) {
    return fail(e)
  }
})

// small concurrency so a big batch doesn't stall the connection
ipcMain.handle('track-durations', async (_e, paths) => {
  try {
    if (!serial) throw new Error('NO_DEVICE')
    const out = {}
    const queue = [...(paths || [])]
    const worker = async () => {
      while (queue.length) {
        const p = queue.shift()
        const ms = await adb.trackDuration(serial, p).catch(() => 0)
        if (ms > 0) { out[p] = ms; if (win && !win.isDestroyed()) win.webContents.send('duration', { path: p, ms }) }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    return ok(out)
  } catch (e) { return fail(e) }
})

ipcMain.handle('resolve-artists', async (_e, items) => {
  try {
    const out = {}
    for (const it of items || []) {
      const artist = await metadata.albumArtist(it.album, it.year)
      if (artist) out[it.key] = artist
    }
    return ok(out)
  } catch (e) { return fail(e) }
})

ipcMain.handle('open-local-network-settings', async () => {
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork')
    return ok(true)
  } catch (e) { return fail(e) }
})

ipcMain.handle('save-to-mac', async (_e, { paths, albumName }) => {
  try {
    if (!serial) throw new Error('NO_DEVICE')
    const res = await dialog.showOpenDialog(win, {
      title: 'Save music to your Mac', properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled) return ok({ saved: 0 })
    let dest = res.filePaths[0]
    if (albumName) { dest = path.join(dest, albumName.replace(/[/:]+/g, '_')); fs.mkdirSync(dest, { recursive: true }) }
    let saved = 0
    for (let i = 0; i < paths.length; i++) {
      const name = paths[i].split('/').pop()
      try { await adb.pullStream(serial, paths[i], path.join(dest, name)); saved++ } catch { /* skip */ }
      if (win && !win.isDestroyed()) win.webContents.send('save-progress', { done: i + 1, total: paths.length })
    }
    shell.showItemInFolder(dest)
    return ok({ saved, dest })
  } catch (e) { return fail(e) }
})

ipcMain.handle('save-albums-to-mac', async (_e, { albums }) => {
  try {
    if (!serial) throw new Error('NO_DEVICE')
    const res = await dialog.showOpenDialog(win, { title: 'Save music to your Mac', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled) return ok({ saved: 0 })
    const root = res.filePaths[0]
    const total = albums.reduce((n, a) => n + a.paths.length, 0)
    let saved = 0
    for (const a of albums || []) {
      const dir = path.join(root, (a.name || 'Album').replace(/[/:]+/g, '_'))
      fs.mkdirSync(dir, { recursive: true })
      for (const rp of a.paths) {
        try { await adb.pullStream(serial, rp, path.join(dir, rp.split('/').pop())); saved++ } catch { /* skip */ }
        if (win && !win.isDestroyed()) win.webContents.send('save-progress', { done: saved, total })
      }
    }
    shell.showItemInFolder(root)
    return ok({ saved })
  } catch (e) { return fail(e) }
})

ipcMain.handle('set-cover-file', async (_e, { trackPath }) => {
  try {
    if (!serial) throw new Error('NO_DEVICE')
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose album cover', properties: ['openFile'],
      filters: [{ name: 'Image', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    })
    if (res.canceled) return ok({ changed: false })
    await adb.setCover(serial, trackPath, res.filePaths[0])
    return ok({ changed: true })
  } catch (e) { return fail(e) }
})

ipcMain.handle('fetch-cover', async (_e, { trackPath, artist, album, year }) => {
  try {
    if (!serial) throw new Error('NO_DEVICE')
    const buf = await metadata.fetchCover(artist, album, year)
    if (!buf) return ok({ changed: false, found: false })
    const tmp = path.join(require('os').tmpdir(), `crate-cover-${Date.now()}.jpg`)
    fs.writeFileSync(tmp, buf)
    await adb.setCover(serial, trackPath, tmp)
    fs.rmSync(tmp, { force: true })
    return ok({ changed: true, found: true })
  } catch (e) { return fail(e) }
})

ipcMain.handle('open-external', async (_e, url) => {
  try { if (/^https?:\/\//.test(url)) await shell.openExternal(url); return ok(true) } catch (e) { return fail(e) }
})

ipcMain.handle('album-info', async (_e, { artist, album }) => {
  try { return ok(await metadata.albumInfo(artist, album)) } catch (e) { return fail(e) }
})

ipcMain.handle('get-settings', async () => {
  const s = store.read()
  return ok({ musicRoot: currentRoot(), musicRootAuto: !s.musicRoot, watchFolder: s.watchFolder })
})
ipcMain.handle('set-settings', async (_e, patch) => {
  const clean = {}
  if (typeof patch.musicRoot === 'string' && patch.musicRoot.trim().startsWith('/')) {
    clean.musicRoot = patch.musicRoot.trim().replace(/\/+$/, '')
  }
  store.write(clean)
  return ok({ musicRoot: currentRoot(), musicRootAuto: !store.read().musicRoot, watchFolder: store.read().watchFolder })
})

ipcMain.handle('choose-watch-folder', async () => {
  try {
    const res = await dialog.showOpenDialog(win, { title: 'Watch a folder for new music', properties: ['openDirectory'] })
    if (res.canceled) return ok({ watchFolder: store.read().watchFolder })
    const s = store.write({ watchFolder: res.filePaths[0] })
    startWatch()
    return ok({ watchFolder: s.watchFolder })
  } catch (e) { return fail(e) }
})
ipcMain.handle('clear-watch-folder', async () => {
  store.write({ watchFolder: null })
  stopWatch()
  return ok({ watchFolder: null })
})

ipcMain.handle('add', async (_e, localPaths) => {
  try {
    const res = await withDevice((s) => adb.pushPaths(s, localPaths, (done, total) => {
      if (win && !win.isDestroyed()) win.webContents.send('add-progress', { done, total })
    }, currentRoot()))
    return ok(res)
  } catch (e) {
    return fail(e)
  }
})

ipcMain.handle('add-dialog', async () => {
  try {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add music to your device',
      message: 'Pick audio files or whole album folders',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    })
    if (res.canceled) return ok({ added: 0, found: 0 })
    const out = await withDevice((s) => adb.pushPaths(s, res.filePaths, (done, total) => {
      if (win && !win.isDestroyed()) win.webContents.send('add-progress', { done, total })
    }, currentRoot()))
    return ok(out)
  } catch (e) {
    return fail(e)
  }
})

const pendingDeletes = {} // undoId -> { items, timer }
let delSeq = 0

ipcMain.handle('delete', async (_e, remotePaths) => {
  try {
    const items = await withDevice((s) => adb.softDelete(s, remotePaths))
    const id = String(++delSeq)
    // purge from the phone's trash once the undo window passes
    const timer = setTimeout(() => { adb.purgeDeleted(serial, items).catch(() => {}); delete pendingDeletes[id] }, 12000)
    pendingDeletes[id] = { items, timer }
    return ok({ undoId: id, count: items.length })
  } catch (e) {
    return fail(e)
  }
})

ipcMain.handle('undo-delete', async (_e, id) => {
  try {
    const pd = pendingDeletes[id]
    if (!pd) return ok(false)
    clearTimeout(pd.timer)
    delete pendingDeletes[id]
    await adb.restoreDeleted(serial, pd.items)
    return ok(true)
  } catch (e) {
    return fail(e)
  }
})
