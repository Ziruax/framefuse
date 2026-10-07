const path = require("path");
const fs = require("fs");
const engine = require("/home/z/my-project/rust-engine/framefuse-engine.linux-x64.node");
const tl = {
  version: 1, width: 640, height: 360, fps: 30, sampleRate: 48000, audioChannels: 2,
  crf: 23, quality: "social", audioKbps: 128, backgroundColor: "#000000",
  totalMs: 90000, normalizeAudio: false, fonts: {},
  segments: [{ id: "s", path: path.join(__dirname, "test10s.mp4"), mediaType: "video", startMs: 0, endMs: 90000, durationMs: 90000, trimInMs: 0, sourceDurationMs: 10000, speed: 1, track: 0, volume: 0.5, opacity: 1, hasAudio: true, loopSrc: true }],
  music: null, extraAudio: [{ path: path.join(__dirname, "vo69min.mp3"), startMs: 0, volume: 1 }],
  texts: [], watermark: null, captions: null, kinetic: null,
};
const OUT = path.join(__dirname, "diag-out.mp4");
engine.exportVideo(JSON.stringify(tl), OUT, "", () => {}).then((r) => {
  // dump top VMAs by Rss AFTER completion (leak check)
  const smaps = fs.readFileSync("/proc/self/smaps", "utf8").split("\n");
  let cur = null; const vm = [];
  for (const line of smaps) {
    const h = /^([0-9a-f]+)-[0-9a-f]+ (\S+) +(\S+) +\S+ \S+ \S+ *\d* *(.*)$/.exec(line);
    if (h) { cur = { range: h[1], perm: h[2], size: parseInt(h[3], 10) / 1024, name: (h[4] || "anon").slice(0, 60), rss: 0, pd: 0, pc: 0 }; vm.push(cur); }
    if (cur) {
      let m = /^Rss:\s+(\d+)/.exec(line); if (m) cur.rss = parseInt(m[1], 10) / 1024;
      m = /^Private_Dirty:\s+(\d+)/.exec(line); if (m) cur.pd = parseInt(m[1], 10) / 1024;
      m = /^Private_Clean:\s+(\d+)/.exec(line); if (m) cur.pc = parseInt(m[1], 10) / 1024;
    }
  }
  vm.sort((a, b) => (b.rss) - (a.rss));
  console.log("AFTER-COMPLETION top resident VMAs:");
  for (const v of vm.slice(0, 10)) console.log(`  rss=${v.rss.toFixed(0)}MB pd=${v.pd.toFixed(0)} pc=${v.pc.toFixed(0)} ${v.perm} ${v.name}`);
  const tot = vm.reduce((a, v) => a + v.rss, 0);
  console.log("total rss:", (tot / 1024).toFixed(2), "GB");
  process.exit(0);
}).catch((e) => { console.error("ERR", e.message); process.exit(1); });
