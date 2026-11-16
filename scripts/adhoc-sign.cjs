// electron-builder afterPack hook (macOS): ad-hoc sign the finished app.
//
// Without an Apple Developer ID, electron-builder skips signing, and the app keeps only
// Electron's original signature, which no longer matches once the app is renamed and our
// files are added. Apple Silicon Macs refuse to open such an app ("can't be opened").
// An ad-hoc signature is free and valid; people still confirm the first launch, because
// the app isn't notarised by Apple (see README / the message in the reply).
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const MACHO = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'])
function isMachO (file) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4)
    fs.readSync(fd, buf, 0, 4, 0)
    fs.closeSync(fd)
    return MACHO.has(buf.toString('hex'))
  } catch {
    return false
  }
}

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && isMachO(p)) out.push(p)
  }
  return out
}

const sign = target => execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], { stdio: 'pipe' })

module.exports = async function afterPack ({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName !== 'darwin') return
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  // loose binaries inside resources first (ffmpeg, native modules), then the whole bundle
  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked')
  const loose = fs.existsSync(unpacked) ? walk(unpacked) : []
  for (const bin of loose) sign(bin)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'pipe' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
  console.log(`  • ad-hoc signed  app=${path.basename(app)} binaries=${loose.length}`)
}
