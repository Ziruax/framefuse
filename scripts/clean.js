// Cross-platform clean script — removes .next, out, dist directories
// Handles locked files on Windows (EBUSY/EPERM) by retrying with delays
const fs = require('fs')
const path = require('path')

const dirs = ['.next', 'out', 'dist']

function forceRemove(dir) {
  const fullPath = path.join(process.cwd(), dir)
  if (!fs.existsSync(fullPath)) {
    console.log(`Skip ${dir} (not found)`)
    return
  }

  // Try up to 3 times with 500ms delay between attempts
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.rmSync(fullPath, { recursive: true, force: true })
      console.log(`Removed ${dir}`)
      return
    } catch (e) {
      if (attempt < 3) {
        console.log(`Attempt ${attempt} for ${dir} failed (${e.code}), retrying...`)
        // Synchronous sleep 500ms
        const start = Date.now()
        while (Date.now() - start < 500) { /* spin */ }
      } else {
        console.log(`Could not remove ${dir}: ${e.message}`)
        // On Windows, try renaming instead
        if (process.platform === 'win32') {
          try {
            const backup = fullPath + '_old_' + Date.now()
            fs.renameSync(fullPath, backup)
            console.log(`Renamed ${dir} to ${path.basename(backup)} (will be cleaned later)`)
            // Try to remove the renamed dir
            try { fs.rmSync(backup, { recursive: true, force: true }) } catch { /* ignore */ }
          } catch {
            console.log(`Could not rename ${dir} either. Please close FrameFuse.exe and try again.`)
          }
        }
      }
    }
  }
}

console.log('Cleaning build directories...')
dirs.forEach(forceRemove)
console.log('Done.')
