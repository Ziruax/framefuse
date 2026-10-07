const path = require("path");
const fs = require("fs");
const engine = require("/home/z/my-project/rust-engine/framefuse-engine.linux-x64.node");
const timeline = {
  version: 1, width: 640, height: 360, fps: 30, sampleRate: 48000, audioChannels: 2,
  crf: 23, quality: "social", audioKbps: 128, backgroundColor: "#000000",
  totalMs: 4174800, normalizeAudio: false, fonts: {},
  segments: [{ id: "s", path: path.join(__dirname, "test10s.mp4"), mediaType: "video", startMs: 0, endMs: 4174800, durationMs: 4174800, trimInMs: 0, sourceDurationMs: 10000, speed: 1, track: 0, volume: 0.5, opacity: 1, hasAudio: true, loopSrc: true }],
  music: null, extraAudio: [{ path: path.join(__dirname, "vo69min.mp3"), startMs: 0, volume: 1, loopSrc: false }],
  texts: [], watermark: null, captions: null, kinetic: null,
};
const OUT = path.join(__dirname, "poll-out.mp4");
fs.existsSync(OUT) && fs.unlinkSync(OUT);
let peak = 0;
const timer = setInterval(() => {
  try {
    const roll = fs.readFileSync("/proc/self/smaps_rollup", "utf8");
    const pd = /Private_Dirty:\s+(\d+) kB/.exec(roll);
    if (pd) peak = Math.max(peak, parseInt(pd[1], 10) / 1024);
  } catch {}
}, 500);
const t0 = Date.now();
engine.exportVideo(JSON.stringify(timeline), OUT, "", (e, p) => { if (e || !p) return; })
  .then((r) => { clearInterval(timer); console.log("DONE", r.durationMs + "ms", "peakPrivateDirty=" + peak.toFixed(0) + "MB", "wall=" + (Date.now()-t0) + "ms"); })
  .catch((e) => { clearInterval(timer); console.error("ERR", e.message); });
