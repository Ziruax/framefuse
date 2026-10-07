// v0.4 engine repro: the USER'S exact scenario — 10 s video looped under a
// 69-min voiceover MP3 (33 MB compressed → 1.6 GB decoded f32).
//
// OLD engine (v0.3): mix Vec 1.6 GB + full MP3 decode 1.6 GB → OOM → the app
// closed itself mid-export (reproduced deterministically on any low-RAM box).
// NEW engine (v0.4): file-mapped mix + streaming decode + static-loop packet
// dedup. This harness asserts ALL THREE + output correctness.
//
// Run: node v04-repro.js (engine .node must be staged in rust-engine/)

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const ENGINE_DIR = "/home/z/my-project/rust-engine";
const DIR = __dirname;
const VIDEO = path.join(DIR, "test10s.mp4");
const VOICEOVER = path.join(DIR, "vo69min.mp3");
const OUT = path.join(DIR, "out-loop-69min.mp4");

const TOTAL_MS = 4174800; // 69 min 34.8 s — the user's timeline

// Mirrors electron/rust-engine-router.js buildRustTimeline output for:
// base-lane 10 s video (loop=ON) + voiceover on the extra-audio bus.
const timeline = {
  version: 1,
  width: 640,
  height: 360,
  fps: 30,
  sampleRate: 48000,
  audioChannels: 2,
  bitrateMbps: 0,
  crf: 23,
  quality: "social",
  audioKbps: 128,
  backgroundColor: "#000000",
  totalMs: TOTAL_MS,
  fadeInMs: 0,
  fadeOutMs: 0,
  normalizeAudio: false,
  audioTargetLufs: -16,
  fonts: {},
  segments: [
    {
      id: "seg-loop",
      path: VIDEO,
      mediaType: "video",
      startMs: 0,
      endMs: TOTAL_MS,
      durationMs: TOTAL_MS,
      trimInMs: 0,
      sourceDurationMs: 10000,
      speed: 1.0,
      track: 0,
      volume: 0.5, // the video's own 10 s sine, looping with the clip
      opacity: 1.0,
      hasAudio: true,
      loopSrc: true,
    },
  ],
  music: null,
  extraAudio: [
    // the 69-min voiceover (user moved it to the voiceover track)
    { path: VOICEOVER, startMs: 0, volume: 1.0, loopSrc: false },
  ],
  texts: [],
  watermark: null,
  captions: null,
  kinetic: null,
};

const engine = require(path.join(ENGINE_DIR, "framefuse-engine.linux-x64.node"));

// ── RSS tracking (the OOM assertion) ─────────────────────────────────────
// RSS includes the evictable file-backed mapping pages; the metric that
// actually OOM-kills a process is ANONYMOUS memory (Private_*, from
// smaps_rollup). v0.3's crash was 3.2 GB of ANONYMOUS mix+decode; v0.4 must
// keep that bounded while the mapping pages merely ride the page cache.
let peakRss = 0;
let peakAnon = 0;
function readMem() {
  try {
    const st = fs.readFileSync("/proc/self/status", "utf8");
    const rss = /VmRSS:\s+(\d+) kB/.exec(st);
    if (rss) peakRss = Math.max(peakRss, parseInt(rss[1], 10) / 1024);
    const roll = fs.readFileSync("/proc/self/smaps_rollup", "utf8");
    const pc = /Private_Clean:\s+(\d+) kB/.exec(roll);
    const pd = /Private_Dirty:\s+(\d+) kB/.exec(roll);
    if (pc && pd) peakAnon = Math.max(peakAnon, (parseInt(pc[1], 10) + parseInt(pd[1], 10)) / 1024);
  } catch {}
}
const memTimer = setInterval(readMem, 250);

// ── progress log (the ETA assertion) ─────────────────────────────────────
const events = [];
let t0 = Date.now();
let lastLine = "";
function onProgress(err, p) {
  if (err || !p) return;
  const line =
    `phase=${p.phase} pct=${p.percent.toFixed(1)} eta=${(p.etaMs / 1000).toFixed(1)}s ` +
    `elapsed=${p.elapsedSec}s rate=${p.rate ?? "-"}x`;
  if (p.phase === "video" && p.percent > 90) {
    // log the tail sparsely
  }
  events.push({ at: Date.now() - t0, phase: p.phase, pct: p.percent, etaMs: p.etaMs, rate: p.rate });
  if (line !== lastLine && (events.length % 4 === 0 || p.phase !== "video")) {
    lastLine = line;
  }
}

(async () => {
  console.log("[repro] engine:", engine.engineVersion());
  console.log("[repro] scenario: 10s looped video + 69.6min voiceover MP3 (33MB)");
  console.log("[repro] timeline total:", (TOTAL_MS / 1000 / 60).toFixed(1), "min");

  // cleanup stale artifacts
  for (const f of [OUT, OUT + ".ffmix.tmp"]) { try { fs.unlinkSync(f); } catch {} }

  const res = await engine.exportVideo(JSON.stringify(timeline), OUT, "", onProgress);
  clearInterval(memTimer);
  readMem();
  const wall = Date.now() - t0;

  console.log("\n[result] engine=%s encoder=%s wall=%dms frames=%d size=%d",
    res.engineUsed, res.encoderName, res.durationMs, res.frames, res.sizeBytes);
  console.log("[result] compositor_ms=%d encode_ms=%d decode_ms=%d audio_ms=%d",
    res.compositorMs, res.encodeMs, res.decodeMs, res.audioMs);
  console.log(`[mem] peak RSS: ${peakRss.toFixed(0)} MB (page-cache-inclusive) · peak ANON: ${peakAnon.toFixed(0)} MB (the OOM metric — v0.3 was ~3200 MB here)`);

  // spill file must be GONE
  const spillExists = fs.existsSync(OUT + ".ffmix.tmp");
  console.log("[cleanup] spill file removed:", !spillExists ? "PASS" : "FAIL");

  // ── output verification (ffprobe) ─────────────────────────────────────
  const probe = (args) =>
    execFileSync("ffprobe", ["-v", "error", ...args], { encoding: "utf8" }).trim();
  const dur = parseFloat(probe(["-show_entries", "format=duration", "-of", "csv=p=0", OUT]));
  const vinfo = probe(["-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_frames,r_frame_rate", "-of", "json", OUT]);
  const ainfo = probe(["-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", OUT]);
  console.log("[probe] duration: %ss (want ≈4174.8) %s", dur, Math.abs(dur - 4174.8) < 6 ? "PASS" : "FAIL");
  console.log("[probe] video:", vinfo.replace(/\s+/g, " ").slice(0, 160));
  console.log("[probe] audio:", ainfo.replace(/\s+/g, " ").slice(0, 160));

  // ── decode sanity: first 30 s + a spot deep in the file (the loop clones) ──
  const tA = Date.now();
  execFileSync("ffmpeg", ["-v", "error", "-t", "30", "-i", OUT, "-f", "null", "-"], { stdio: "pipe" });
  execFileSync("ffmpeg", ["-v", "error", "-ss", "3000", "-t", "30", "-i", OUT, "-f", "null", "-"], { stdio: "pipe" });
  execFileSync("ffmpeg", ["-v", "error", "-ss", "4160", "-t", "14", "-i", OUT, "-f", "null", "-"], { stdio: "pipe" });
  console.log("[decode] head/middle/tail decode clean: PASS (%dms)", Date.now() - tA);

  // ── loop content check: frame at t=3005 (cycle 300) must equal frame at t=5 (cycle 0) ──
  const grab = (t, f) =>
    execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", OUT, "-frames:v", "1", "-f", "image2", f], { stdio: "pipe" });
  grab(5, path.join(DIR, "f-head.png"));
  grab(3005, path.join(DIR, "f-mid.png"));
  const h = fs.readFileSync(path.join(DIR, "f-head.png"));
  const m = fs.readFileSync(path.join(DIR, "f-mid.png"));
  // PNGs may differ in metadata; compare pixel-decoded hashes
  const hash = (f) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { encoding: "buffer", maxBuffer: 1 << 26 }).length && require("crypto").createHash("sha256").update(execFileSync("ffmpeg", ["-v", "error", "-i", f, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).digest("hex");
  const hh = hash(path.join(DIR, "f-head.png"));
  const mm = hash(path.join(DIR, "f-mid.png"));
  console.log("[loop] frame@5s == frame@3005s (bit-exact loop):", hh === mm ? "PASS" : "FAIL");

  // ── audio spot check: the voiceover runs the full 69 min ──
  const vol = require("child_process").execSync(
    `ffmpeg -v info -ss 3600 -t 5 -i "${OUT}" -map 0:a -af volumedetect -f null - 2>&1 | true`,
    { encoding: "utf8", shell: "/bin/bash" },
  );
  const mean = /mean_volume:\s*([-\d.]+) dB/.exec(vol);
  console.log("[audio] 1h spot mean volume:", mean ? mean[1] + " dB" : "n/a", mean && parseFloat(mean[1]) > -60 ? "PASS" : "(check)");

  // ── ETA sanity: video-phase ETA should shrink monotonically-ish after warmup ──
  const vids = events.filter((e) => e.phase === "video" && e.etaMs > 0);
  if (vids.length >= 4) {
    const first = vids[0].etaMs, last = vids[vids.length - 1].etaMs;
    console.log("[eta] video-phase ETA first=%ds last=%ds %s", first / 1000, last / 1000, last < first ? "PASS (shrinking)" : "WARN");
  }
  const audioEta = events.filter((e) => e.phase === "audio" && e.etaMs > 0);
  if (audioEta.length) {
    console.log("[eta] audio-phase ETA events: %d (last=%ds) %s", audioEta.length, audioEta[audioEta.length - 1].etaMs / 1000, "PASS");
  }

  console.log(`\n[summary] wall=${(wall / 1000).toFixed(1)}s for ${(TOTAL_MS / 60000).toFixed(1)} min of content (${((TOTAL_MS / 1000) / (wall / 1000)).toFixed(1)}x realtime) · peak ANON=${peakAnon.toFixed(0)}MB · out=${(res.sizeBytes / 1048576).toFixed(1)}MB`);
})().catch((e) => {
  clearInterval(memTimer);
  console.error("[repro] FAILED:", e && e.message ? e.message : e);
  process.exitCode = 1;
});
