#!/usr/bin/env node
// download the official platform-tools adb into vendor/adb/adb for bundling; runs before packaging
import fs from 'fs'
import path from 'path'
import https from 'https'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'vendor', 'adb', 'adb')
const URL = 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip'

if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
  console.log('adb already present at vendor/adb/adb — skipping')
  process.exit(0)
}

const tmpZip = path.join(root, 'vendor', '_pt.zip')
fs.mkdirSync(path.dirname(dest), { recursive: true })

console.log('downloading platform-tools…')
await new Promise((resolve, reject) => {
  const go = (url) => https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location) }
    if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode))
    const f = fs.createWriteStream(tmpZip)
    res.pipe(f)
    f.on('finish', () => f.close(resolve))
  }).on('error', reject)
  go(URL)
})

execSync(`unzip -oq "${tmpZip}" "platform-tools/adb" -d "${path.join(root, 'vendor')}"`)
fs.copyFileSync(path.join(root, 'vendor', 'platform-tools', 'adb'), dest)
fs.chmodSync(dest, 0o755)
fs.rmSync(tmpZip, { force: true })
fs.rmSync(path.join(root, 'vendor', 'platform-tools'), { recursive: true, force: true })
console.log('adb ready at vendor/adb/adb')
