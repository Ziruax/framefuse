// Watch the output dir during a -movflags +faststart remux to discover
// the temp file the moov-atom rewrite uses (for live finalize progress).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = "/tmp/fs-test";
const out = path.join(dir, "out.mp4");
try { fs.unlinkSync(out); } catch (_) {}

const t0 = Date.now();
const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path.join(dir, "src.mp4"), "-c", "copy", "-movflags", "+faststart", "-y", out], { stdio: ["ignore", "pipe", "pipe"] });
let err = "";
proc.stderr.on("data", (d) => { err += d.toString(); });

const seen = {};
const timer = setInterval(() => {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const n of names) {
    if (n === "watch.js" || n === "src.mp4") continue;
    let size = -1;
    try { size = fs.statSync(path.join(dir, n)).size; } catch (_) {}
    if (!seen[n] || seen[n].size !== size) {
      seen[n] = { size, at: Date.now() - t0 };
      console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${n} -> ${size} bytes`);
    }
  }
}, 5);

proc.on("exit", (code) => {
  clearInterval(timer);
  setTimeout(() => {
    let final = -1;
    try { final = fs.statSync(out).size; } catch (_) {}
    console.log(`exit code ${code} after ${((Date.now() - t0) / 1000).toFixed(2)}s — final out.mp4 ${final} bytes`);
    console.log("stderr:", err.trim() || "(none)");
    console.log("dir now:", fs.readdirSync(dir).join(", "));
  }, 300);
});
