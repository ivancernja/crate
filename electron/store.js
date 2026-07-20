'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const FILE = path.join(app.getPath('userData'), 'crate.json')
// musicRoot null means "not chosen yet" so we can auto-detect a device-aware
// default on connect and still let the user override it
const DEFAULTS = { endpoint: null, lastConnectedAt: null, musicRoot: null, watchFolder: null }

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
