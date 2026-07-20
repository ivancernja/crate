'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const FILE = path.join(app.getPath('userData'), 'crate.json')
const DEFAULTS = { endpoint: null, lastConnectedAt: null, musicRoot: '/sdcard/Music', watchFolder: null }

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function write(patch) {
  const next = { ...read(), ...patch }
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2))
  return next
}

module.exports = { read, write, FILE }
