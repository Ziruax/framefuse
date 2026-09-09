// Cross-platform pre-build step: downloads the Windows ffmpeg.exe binary
// from the ffmpeg-static GitHub release and places it at
//   node_modules/ffmpeg-static/ffmpeg.exe
//
// PROBLEM: The ffmpeg-static npm package's install.js only downloads the
// binary for the HOST platform (Linux when building on Linux, macOS when
// building on macOS, etc.). When you cross-build a Windows .exe on Linux,
// the bundled ffmpeg binary is a Linux ELF — Windows can't execute it
// (ENOENT error in the user's installed app).
//
// FIX: This script explicitly downloads the Windows ffmpeg.exe binary
// from the same GitHub release that ffmpeg-static uses, and saves it
// alongside the host's ffmpeg binary. The Electron main process checks
// for ffmpeg.exe on Windows and ffmpeg on Linux/macOS.
//
// Run automatically before `electron-builder` via the `electron:build`
// npm script. Also runnable manually: `node scripts/fetch-windows-ffmpeg.js`.

const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const RELEASE_TAG = "b6.1.1"; // matches ffmpeg-static@5.3.0
const DOWNLOAD_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE_TAG}/ffmpeg-win32-x64.gz`;
const DEST_DIR = path.join(
  process.cwd(),
  "node_modules",
  "ffmpeg-static",
);
const DEST_FILE = path.join(DEST_DIR, "ffmpeg.exe");

function downloadAndGunzip(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath + ".gz");
    const get = (u, redirectsLeft = 5) =>
      https
        .get(u, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (redirectsLeft <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            get(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              // Gunzip in place.
              const gz = fs.readFileSync(destPath + ".gz");
              const out = zlib.gunzipSync(gz);
              fs.writeFileSync(destPath, out);
              fs.unlinkSync(destPath + ".gz");
              resolve(out.length);
            });
          });
        })
        .on("error", reject);
    get(url);
  });
}

async function main() {
  if (!fs.existsSync(DEST_DIR)) {
    console.log(`[fetch-windows-ffmpeg] Skip — ${DEST_DIR} not found (ffmpeg-static not installed)`);
    return;
  }
  if (fs.existsSync(DEST_FILE)) {
    const stat = fs.statSync(DEST_FILE);
    if (stat.size > 10_000_000) {
      console.log(`[fetch-windows-ffmpeg] Already exists (${Math.round(stat.size / 1024 / 1024)} MB), skipping`);
      return;
    }
  }
  console.log(`[fetch-windows-ffmpeg] Downloading Windows ffmpeg.exe from ${DOWNLOAD_URL}`);
  try {
    const size = await downloadAndGunzip(DOWNLOAD_URL, DEST_FILE);
    // Make it executable (in case the build runs on Windows too).
    fs.chmodSync(DEST_FILE, 0o755);
    console.log(`[fetch-windows-ffmpeg] Done. ffmpeg.exe saved (${Math.round(size / 1024 / 1024)} MB) to ${path.relative(process.cwd(), DEST_FILE)}`);
  } catch (err) {
    console.error(`[fetch-windows-ffmpeg] FAILED: ${err.message}`);
    console.error(`[fetch-windows-ffmpeg] The Windows .exe build will fail to run FFmpeg.`);
    process.exit(1);
  }
}

main();
