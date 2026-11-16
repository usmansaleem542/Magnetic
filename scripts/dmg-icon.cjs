// electron-builder afterAllArtifactBuild hook: give the .dmg file itself the app icon in
// Finder (electron-builder only sets the icon of the mounted volume). macOS-only; it's a
// Finder custom icon, so it survives copying and AirDrop but not most web uploads.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const ICON = path.join(__dirname, '..', 'build', 'icon.png')

function setFileIcon (file, icon) {
  const script = `ObjC.import('AppKit');
    const img = $.NSImage.alloc.initWithContentsOfFile(${JSON.stringify(icon)});
    $.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, ${JSON.stringify(file)}, 0)`
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script]).toString().trim() === 'true'
}

module.exports = async function afterAllArtifactBuild (result) {
  if (process.platform !== 'darwin') return []
  for (const file of result.artifactPaths || []) {
    if (!file.endsWith('.dmg')) continue
    try {
      console.log(`  • dmg icon ${setFileIcon(file, ICON) ? 'set' : 'not set'}  file=${path.basename(file)}`)
    } catch (err) {
      console.warn(`  • dmg icon failed  ${err.message}`)
    }
  }
  return []
}

if (require.main === module) {
  // node scripts/dmg-icon.cjs <file.dmg>  — apply to an existing build
  for (const f of process.argv.slice(2)) console.log(f, setFileIcon(path.resolve(f), ICON))
}
