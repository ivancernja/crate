'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg)

contextBridge.exposeInMainWorld('crate', {
  connect: () => invoke('connect'),
  devices: () => invoke('devices'),
  goWireless: () => invoke('go-wireless'),
  status: () => invoke('status'),
  list: () => invoke('list'),
  storage: () => invoke('storage'),
  art: (remotePath) => invoke('art', remotePath),
  albumInfo: (opts) => invoke('album-info', opts),
  saveToMac: (opts) => invoke('save-to-mac', opts),
  saveAlbumsToMac: (opts) => invoke('save-albums-to-mac', opts),
  onSaveProgress: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('save-progress', h)
    return () => ipcRenderer.off('save-progress', h)
  },
  setCoverFile: (opts) => invoke('set-cover-file', opts),
  fetchCover: (opts) => invoke('fetch-cover', opts),
  getSettings: () => invoke('get-settings'),
  setSettings: (patch) => invoke('set-settings', patch),
  chooseWatchFolder: () => invoke('choose-watch-folder'),
  clearWatchFolder: () => invoke('clear-watch-folder'),
  onWatchPushed: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('watch-pushed', h)
    return () => ipcRenderer.off('watch-pushed', h)
  },
  resolveArtists: (items) => invoke('resolve-artists', items),
  trackDurations: (paths) => invoke('track-durations', paths),
  onDuration: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('duration', h)
    return () => ipcRenderer.off('duration', h)
  },
  openUrl: (url) => invoke('open-external', url),
  openLocalNetworkSettings: () => invoke('open-local-network-settings'),
  trackUrl: (track) => invoke('track-url', track),
  add: (localPaths) => invoke('add', localPaths),
  addDialog: () => invoke('add-dialog'),
  onAddProgress: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('add-progress', h)
    return () => ipcRenderer.off('add-progress', h)
  },
  remove: (remotePaths) => invoke('delete', remotePaths),
  undoDelete: (id) => invoke('undo-delete', id),
  // Electron 33 removed File.path, so resolve dropped files to real paths here
  pathFor: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return null }
  },
})
