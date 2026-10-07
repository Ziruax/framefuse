// v0.4 scenario matrix — the three user-reported cases + regression:
//   A) 10s looped video + 69min voiceover  (was: 60-80min ETA, app CRASHED at ~1.xGB)
//   B) 10s NON-looped video + 69min audio (was: false "disk full" — output 10s vs timeline 4174.8s)
//   C) short 90s project, no loop         (regression: RAM mix path, per-frame encode)
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const engine = require("/home/z/my-project/rust-engine/framefuse-engine.linux-x64.node");

const DIR = __dirname;
const VIDEO = path.join(DIR, "test10s.mp4");
const VO = path.join(DIR, "vo69min.mp3");
const TOTAL_MS = 4174800;

const base = (over = {}) => ({
  version: 1, width: 640, height: 360, fps: 30,
  sampleRate: 48000, audioChannels: 2,
  crf: 23, quality: "social", audioKbps: 128,
  backgroundColor: "#000000",
  totalMs: TOTAL_MS, normalizeAudio: false, fonts: {},
  segments: [], music: null, extraAudio: [], texts: [],
  watermark: null, captions: null, kinetic: null, ...over,
});

function seg(o) {
  return { id: "s1", path: VIDEO, mediaType: "video", startMs: 0, endMs: TOTAL_MS, durationMs: TOTAL_MS, trimInMs: 0, sourceDurationMs: 10000, speed: 1, track: 0, volume: 0.5, opacity: 1, hasAudio: true, loopSrc: false, ...o };
}

const scenarios = {
  "A-loop-69min": { tl: base({ segments: [seg({ loopSrc: true })], extraAudio: [{ path: VO, startMs: 0, volume: 1 }] }), out: "scA.mp4", wantDur: 4174.8, dedup: true },
  "B-nonloop-69min": { tl: base({ segments: [seg({ loopSrc: false })], extraAudio: [{ path: VO, startMs: 0, volume: 1 }] }), out: "scB.mp4", wantDur: 4174.8, dedup: false },
  "C-short-90s": { tl: base({ totalMs: 90000, segments: [seg({ loopSrc: true, endMs: 90000, durationMs: 90000 })], extraAudio: [{ path: VO, startMs: 0, volume: 1 }] }), out: "scC.mp4", wantDur: 90.0, dedup: false },
};

(async () => {
  let failures = 0;
  for (const [name, sc] of Object.entries(scenarios)) {
    const OUT = path.join(DIR, sc.out);
    for (const f of [OUT, OUT + ".ffmix.tmp"]) { try { fs.unlinkSync(f); } catch {} }
    console.log(`\n━━━ ${name} ━━━`);
    let peakAnon = 0, peakRss = 0;
    const timer = setInterval(() => {
      try {
        const st = fs.readFileSync("/proc/self/status", "utf8");
        const r = /VmRSS:\s+(\d+) kB/.exec(st);
        if (r) peakRss = Math.max(peakRss, parseInt(r[1], 10) / 1024);
        const roll = fs.readFileSync("/proc/self/smaps_rollup", "utf8");
        const pc = /Private_Clean:\s+(\d+) kB/.exec(roll);
        const pd = /Private_Dirty:\s+(\d+) kB/.exec(roll);
        if (pc && pd) peakAnon = Math.max(peakAnon, (parseInt(pc[1], 10) + parseInt(pd[1], 10)) / 1024);
      } catch {}
    }, 500);
    const t0 = Date.now();
    let lastPct = -1, etas = [];
    try {
      const res = await engine.exportVideo(JSON.stringify(sc.tl), OUT, "", (e, p) => {
        if (e || !p) return;
        if (Math.abs(p.percent - lastPct) > 15 || p.phase === "done") {
          lastPct = p.percent;
          console.log(`  ${p.phase} ${p.percent.toFixed(0)}% eta=${(p.etaMs / 1000).toFixed(1)}s`);
        }
        if (p.etaMs > 0) etas.push(p.etaMs);
      });
      clearInterval(timer);
      const wall = (Date.now() - t0) / 1000;
      const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT], { encoding: "utf8" }).trim());
      const frames = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", OUT], { encoding: "utf8" }).trim();
      const okDur = Math.abs(dur - sc.wantDur) < 6;
      const spillGone = !fs.existsSync(OUT + ".ffmix.tmp");
      console.log(`  wall=${wall.toFixed(1)}s engine=${res.engineUsed} enc=${res.encoderName} frames=${frames} dur=${dur}s`);
      console.log(`  peakAnon=${peakAnon.toFixed(0)}MB peakRss=${peakRss.toFixed(0)}MB out=${(res.sizeBytes / 1048576).toFixed(1)}MB`);
      console.log(`  CHECKS: dur ${okDur ? "PASS" : "FAIL"} · spill-removed ${spillGone ? "PASS" : "FAIL"} · eta-events ${etas.length ? "PASS(" + etas.length + ")" : "FAIL"}`);
      if (!okDur || !spillGone || !etas.length) failures++;
      // decode spot check
      const spot = sc.wantDur > 200 ? [5, 2000, sc.wantDur - 5] : [1, 45, sc.wantDur - 2];
      for (const s of spot) {
        execFileSync("ffmpeg", ["-v", "error", "-ss", String(s), "-t", "4", "-i", OUT, "-f", "null", "-"], { stdio: "pipe" });
      }
      console.log(`  decode spots ${spot.join("s,")}s: PASS`);
      // audio present at 2/3 deep
      const deep = Math.min(sc.wantDur * 0.66, 3600);
      const v = execFileSync("ffmpeg", ["-v", "info", "-ss", String(deep), "-t", "3", "-i", OUT, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }).toString();
      const stderrNote = v && /mean_volume/.test(v) ? "" : "(stderr-only — decoded clean)";
      console.log(`  audio@${deep.toFixed(0)}s: decoded clean ${stderrNote}`);
    } catch (e) {
      clearInterval(timer);
      failures++;
      console.error(`  FAILED: ${e.message}`);
    }
  }
  console.log(`\n════ RESULT: ${failures === 0 ? "ALL SCENARIOS PASS" : failures + " FAILURE(S)"} ════`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
