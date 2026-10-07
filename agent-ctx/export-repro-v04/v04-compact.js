// v0.4 compact matrix (sandbox-friendly sizes, same code paths):
//   D) loop 10s video + 40min VO → LoopCycle dedup + SPILL mix (460MB) + STREAMING decode
//   E) NON-loop 10s video + 20min VO → StaticTail dedup + SPILL (230MB) — the false-disk-full case
//   F) 2×5s segments, no loop, exact total → NO dedup (per-frame regression)
const path = require("path");
const fs = require("fs");
const { execFileSync, spawnSync } = require("child_process");
const engine = require("/home/z/my-project/rust-engine/framefuse-engine.linux-x64.node");

const DIR = __dirname;
const VIDEO = path.join(DIR, "test10s.mp4");
const VO40 = path.join(DIR, "vo40min.mp3");
const VO20 = path.join(DIR, "vo20min.mp3");

function seg(o) {
  return { id: "s", path: VIDEO, mediaType: "video", startMs: 0, endMs: 2400000, durationMs: 2400000, trimInMs: 0, sourceDurationMs: 10000, speed: 1, track: 0, volume: 0.5, opacity: 1, hasAudio: true, loopSrc: false, ...o };
}
const base = (over = {}) => ({
  version: 1, width: 640, height: 360, fps: 30, sampleRate: 48000, audioChannels: 2,
  crf: 23, quality: "social", audioKbps: 128, backgroundColor: "#000000",
  totalMs: 2400000, normalizeAudio: false, fonts: {},
  segments: [], music: null, extraAudio: [], texts: [], watermark: null, captions: null, kinetic: null, ...over,
});

const scenarios = {
  "D-loop-40min": { tl: base({ segments: [seg({ loopSrc: true })], extraAudio: [{ path: VO40, startMs: 0, volume: 1 }] }), out: "scD.mp4", wantDur: 2400, wantFrames: 72000 },
  "E-nonloop-20min": { tl: base({ totalMs: 1200000, segments: [seg({ loopSrc: false, endMs: 1200000, durationMs: 1200000 })], extraAudio: [{ path: VO20, startMs: 0, volume: 1 }] }), out: "scE.mp4", wantDur: 1200, wantFrames: 36000 },
  "F-nodedup-10s": { tl: base({ totalMs: 10000, segments: [seg({ startMs: 0, endMs: 5000, durationMs: 5000 }), seg({ id: "s2", startMs: 5000, endMs: 10000, durationMs: 5000 })], extraAudio: [] }), out: "scF.mp4", wantDur: 10, wantFrames: 300 },
};

(async () => {
  let failures = 0;
  for (const [name, sc] of Object.entries(scenarios)) {
    const OUT = path.join(DIR, sc.out);
    for (const f of [OUT, OUT + ".ffmix.tmp"]) { try { fs.unlinkSync(f); } catch {} }
    console.log(`\n━━━ ${name} ━━━`);
    let peakAnon = 0;
    const timer = setInterval(() => {
      try {
        const roll = fs.readFileSync("/proc/self/smaps_rollup", "utf8");
        const pc = /Private_Clean:\s+(\d+) kB/.exec(roll);
        const pd = /Private_Dirty:\s+(\d+) kB/.exec(roll);
        if (pc && pd) peakAnon = Math.max(peakAnon, (parseInt(pc[1], 10) + parseInt(pd[1], 10)) / 1024);
      } catch {}
    }, 700);
    const t0 = Date.now();
    let lastPct = -1, etaCount = 0;
    try {
      const res = await engine.exportVideo(JSON.stringify(sc.tl), OUT, "", (e, p) => {
        if (e || !p) return;
        if (Math.abs(p.percent - lastPct) > 20 || p.phase === "done") {
          lastPct = p.percent;
          console.log(`  ${p.phase} ${p.percent.toFixed(0)}%${p.etaMs ? " eta=" + (p.etaMs / 1000).toFixed(1) + "s" : ""}`);
        }
        if (p.etaMs > 0) etaCount++;
      });
      clearInterval(timer);
      const wall = (Date.now() - t0) / 1000;
      const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT], { encoding: "utf8" }).trim());
      const frames = parseInt(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", OUT], { encoding: "utf8" }).trim() || "0", 10);
      const spillGone = !fs.existsSync(OUT + ".ffmix.tmp");
      const ok = Math.abs(dur - sc.wantDur) < 4 && frames === sc.wantFrames && spillGone;
      console.log(`  wall=${wall.toFixed(1)}s enc=${res.encoderName} frames=${frames}/${sc.wantFrames} dur=${dur}/${sc.wantDur}s out=${(res.sizeBytes / 1048576).toFixed(1)}MB peakAnon=${peakAnon.toFixed(0)}MB`);
      console.log(`  CHECKS: ${ok ? "PASS" : "FAIL"} (spill-removed: ${spillGone}, eta-events: ${etaCount})`);
      if (!ok) failures++;
      const spot = sc.wantDur > 60 ? [3, sc.wantDur / 2, sc.wantDur - 3] : [1, sc.wantDur - 1];
      for (const s of spot) execFileSync("ffmpeg", ["-v", "error", "-ss", String(s), "-t", "3", "-i", OUT, "-f", "null", "-"], { stdio: "pipe" });
      const vol = spawnSync("ffmpeg", ["-v", "info", "-ss", String(sc.wantDur / 2), "-t", "3", "-i", OUT, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
      const mean = vol.stderr && /mean_volume:\s*([-\d.]+) dB/.exec(vol.stderr);
      console.log(`  decode spots ok; audio@${(sc.wantDur / 2).toFixed(0)}s: ${mean ? mean[1] + "dB" : "no-audio(decoded-clean)"}`);
    } catch (e) {
      clearInterval(timer);
      failures++;
      console.error(`  FAILED: ${e.message}`);
    }
  }
  console.log(`\n════ RESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} ════`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
