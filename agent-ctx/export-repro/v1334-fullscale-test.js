// agent-ctx/export-repro/v1334-fullscale-test.js — the user's EXACT scenario
// at FULL SCALE through the REAL v1.33.4 code (runFfmpeg +
// measureLoudnessAsync sliced verbatim from electron/main.js):
//   10s 360p30 loop source → -stream_loop -1 render with burned ASS captions
//   (690s rendered, concat-listed 6× to the full 4140s = 1h9m) → 1h9m music
//   track → loudness measure (LIVE band 95.5→96) → concat -c copy + amix
//   audio graph mux at the FULL 4140s scale (band 97→99.7) → +faststart
//   finalize (message-driven label + 1Hz crawl 99.7→99.97) → 100% only at
//   the true end → output probed at 4140s.
// argv shapes are PRODUCTION-shaped: NO -loglevel/-nostats flags on any
// progress-tracked child (verified: -loglevel error suppresses the periodic
// stats lines that drive every band; the real builders carry no such flag).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

const ROOT = path.join(__dirname, "..", "..");
const FFMPEG = "/usr/bin/ffmpeg";
const TOTAL_SEC = 4140; // 1h9m — the user's timeline
const RENDER_SEC = 690; // rendered once, concat 6× → 4140s (wall-clock sane)
const W = 640, H = 360, FPS = 30, VBPS = "1200k";

const src = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
const rStart = src.indexOf("function runFfmpeg(args, totalSec, onTime, opts)");
const rEnd = src.indexOf("async function verifyExportOutputAsync", rStart);
const runFfmpegSrc = src.slice(rStart, rEnd);
const mStart = src.indexOf("function measureLoudnessAsync(p, win, timeoutMs, onTime)");
const mEnd = src.indexOf("ipcMain.handle(\"cancel-export\"", mStart);
const measureSrc = src.slice(mStart, mEnd);

// real duration probe (the production probeMediaAsync shape matters: the
// measure's progress denominator comes from it — a 0-duration stub kills
// the live ticks, which is exactly what the first harness run exposed).
function probeDur(p) {
  return new Promise((resolve) => {
    const pr = spawn(FFMPEG, ["-hide_banner", "-i", p], { stdio: ["ignore", "pipe", "pipe"] });
    let s = "";
    pr.stderr.on("data", (d) => { s += d.toString(); });
    pr.on("exit", () => {
      const m = s.match(/Duration: (\d+):(\d+):(\d+)\.(\d+)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0);
    });
  });
}

const activeProcs = new Set();
const stubs = {
  fs, path, os, spawn, ffmpegPath: FFMPEG, activeProcs, tempDir: null,
  loudnessCacheKey: () => null, loadLoudnessDisk: () => {}, pruneLoudnessDisk: () => {},
  scheduleLoudnessDiskSave: () => {}, flushLoudnessDisk: () => {},
  loudnessDisk: { entries: {} }, loudnessCacheStats: { hits: 0, misses: 0 },
  probeMediaAsync: (p) => probeDur(p).then((d) => ({ durationMs: d * 1000 })),
  console,
};
const factory = new Function(...Object.keys(stubs),
  runFfmpegSrc + "\n" + measureSrc + "\nreturn { runFfmpeg, measureLoudnessAsync };");
const { runFfmpeg, measureLoudnessAsync } = factory(...Object.values(stubs));

// ── progress recorder (mirrors the two-step handler's band mapping) ──
const bands = { pool: [], measure: [], mux: [], finalize: [], done: [] };
let exportPhase = "prepare";
const t0 = Date.now();
function sendProgress(kind, percent, sec) {
  bands[kind].push({ at: Math.round((Date.now() - t0) / 100) / 10, pct: Math.round(percent * 100) / 100, sec });
  if (process.env.VERBOSE) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${kind.padEnd(8)} ${percent.toFixed(2)}%  (t=${sec != null ? sec.toFixed(1) : "?"}s, phase=${exportPhase})`);
}

const work = fs.mkdtempSync(path.join("/tmp", "fffull-"));
console.log(`[harness] workdir ${work} · timeline ${TOTAL_SEC}s (${(TOTAL_SEC / 60).toFixed(0)} min) · ${W}x${H}@${FPS} · video ${VBPS}`);

async function gen(tag, args) {
  const genT = Date.now();
  await runFfmpeg(args, 0, null, { stallMs: 120000 });
  console.log(`[gen] ${tag} in ${((Date.now() - genT) / 1000).toFixed(1)}s`);
}

(async () => {
  // ── media generation ──
  const loopSrc = path.join(work, "loop10s.mp4");
  await gen("10s loop source", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25", "-an", "-y", loopSrc]);
  const music = path.join(work, "music69.m4a");
  await gen("69-min music track", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${TOTAL_SEC},tremolo=f=2:d=0.3`, "-c:a", "aac", "-b:a", "160k", "-y", music]);
  // ASS captions spread across the hour
  const ass = path.join(work, "captions.ass");
  {
    const cues = [];
    const ts = (sec) => {
      const h = String(Math.floor(sec / 3600)).padStart(1, "0");
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
      const ss = String(Math.floor(sec % 60)).padStart(2, "0");
      const cs = String(Math.round((sec % 1) * 100)).padStart(2, "0");
      return `${h}:${m}:${ss}.${cs}`;
    };
    for (let s = 0; s < TOTAL_SEC; s += 30) {
      cues.push(`Dialogue: 0,${ts(s)},${ts(s + 4)},Default,,0,0,0,,v1.33.4 full-scale caption @ ${s}s`);
    }
    fs.writeFileSync(ass, `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Alignment, MarginV
Style: Default,Arial,42,&H00FFFFFF,2,40

[Events]
Format: Layer, Start, End, Style, Text
${cues.join("\n")}
`, "utf-8");
  }

  // ── STEP 1: the loop render (-stream_loop -1, captions burned) ──
  // production shape: NO -loglevel flag (stats lines drive the 0→95% band).
  const clip = path.join(work, "clip_0000.mp4");
  {
    const stepT = Date.now();
    let ticks = 0;
    const esc = ass.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    await runFfmpeg(
      ["-hide_banner",
       "-stream_loop", "-1", "-i", loopSrc,
       "-t", String(RENDER_SEC),
       "-vf", `subtitles=filename='${esc}',scale=${W}:${H},setpts=PTS-STARTPTS`,
       "-r", String(FPS), "-c:v", "libx264", "-preset", "ultrafast",
       "-b:v", VBPS, "-maxrate", VBPS, "-bufsize", "2400k",
       "-an", "-y", clip],
      RENDER_SEC,
      (sec) => { ticks++; sendProgress("pool", 95 * Math.min(1, sec / RENDER_SEC), sec); },
      { stallMs: 300000 },
    );
    const sizeMB = fs.statSync(clip).size / 1024 ** 2;
    console.log(`[step1] loop render DONE in ${((Date.now() - stepT) / 1000).toFixed(1)}s · ${ticks} ticks · clip ${sizeMB.toFixed(0)} MB`);
    if (ticks < 2) throw new Error(`POOL BAND FROZE — ${ticks} ticks (argv shape must match production: no -loglevel flag)`);
  }

  // concat 6× → the full 4140s timeline
  const concatList = path.join(work, "concat.txt");
  fs.writeFileSync(concatList, Array(6).fill(`file '${clip.replace(/'/g, "'\\''")}'`).join("\n"), "utf-8");

  // ── STEP 2: loudness measure of the music (LIVE band 95.5→96) ──
  const probe = await probeDur(music);
  console.log(`[step2] music duration probe: ${probe}s`);
  {
    const stepT = Date.now();
    let ticks = 0;
    const m = await measureLoudnessAsync(music, null, Math.max(90000, Math.min(600000, 90000 + TOTAL_SEC * 40)), (sec) => {
      ticks++;
      sendProgress("measure", 95.5 + 0.5 * Math.min(1, sec / Math.max(0.01, probe || TOTAL_SEC)), sec);
    });
    console.log(`[step2] loudness measure DONE in ${((Date.now() - stepT) / 1000).toFixed(1)}s · ${ticks} LIVE ticks · i=${m ? m.i : "null"}`);
    if (ticks < 2) throw new Error(`MEASURE BAND FROZE — ${ticks} live ticks (the v1.33.4 fix regressed)`);
    if (!m || !Number.isFinite(m.i)) throw new Error("measure returned null — fast path lost");
  }

  // ── STEP 3: the final mux (concat -c copy + music graph + faststart) ──
  const out = path.join(work, "export.mp4");
  const expectedOutBytes = 6 * fs.statSync(clip).size + (192 * 1000 / 8) * TOTAL_SEC;
  const skipFaststart = expectedOutBytes > 1.5 * 1024 ** 3;
  console.log(`[step3] expected ≈ ${(expectedOutBytes / 1024 ** 3).toFixed(2)} GB → faststart ${skipFaststart ? "SKIPPED (>1.5GB gate)" : "RUNS (finalize band + crawl)"}`);
  {
    const stepT = Date.now();
    const gainDb = -16 - (-23.12); // static-gain fast-path shape (measured i)
    const af = [
      `volume=${gainDb.toFixed(2)}dB`,
      `apad=whole_dur=${TOTAL_SEC}`,
      "alimiter=limit=0.97:level=false",
    ].join(",");
    let finalizeFired = 0, crawlTicks = 0;
    exportPhase = "mux";
    await runFfmpeg(
      ["-f", "concat", "-safe", "0", "-i", concatList,
       "-i", music,
       "-c:v", "copy",
       "-map", "0:v:0", "-map", "1:a:0",
       "-af", af,
       "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
       "-shortest",
       ...(skipFaststart ? [] : ["-movflags", "+faststart"]),
       "-y", out],
      TOTAL_SEC,
      (sec) => {
        const pct = (0.97 + 0.027 * Math.min(1, sec / TOTAL_SEC)) * 100;
        sendProgress("mux", pct, sec);
      },
      {
        onFinalize: () => { finalizeFired++; exportPhase = "finalize"; sendProgress("finalize", 99.7, TOTAL_SEC); },
        onFinalizeProgress: (f) => { crawlTicks++; sendProgress("finalize", 99.7 + 0.27 * Math.min(0.95, f), TOTAL_SEC); },
        finalizeEstimateMs: Math.max(15000, Math.min(600000, (expectedOutBytes / (25 * 1024 * 1024)) * 2500)),
        finalizeMs: skipFaststart ? 90000 : Math.max(150000, Math.min(600000, 60000 + (expectedOutBytes / (25 * 1024 * 1024)) * 2500)),
        noFinalizeOnTotal: skipFaststart,
      },
    );
    exportPhase = "done";
    sendProgress("done", 100, TOTAL_SEC);
    console.log(`[step3] mux DONE in ${((Date.now() - stepT) / 1000).toFixed(1)}s · finalize x${finalizeFired} · crawl x${crawlTicks} · out ${(fs.statSync(out).size / 1024 ** 3).toFixed(2)} GB`);
    if (!skipFaststart && finalizeFired !== 1) throw new Error("faststart ran but the finalize label never fired");
    if (skipFaststart && finalizeFired !== 0) throw new Error("faststart skipped but finalize fired (noise label)");
    for (const b of [...bands.mux, ...bands.measure, ...bands.finalize]) {
      if (b.pct >= 99.999) throw new Error(`100% appeared DURING WORK (${b.kind} @ ${b.at}s)`);
    }
    if (bands.mux.length < 5) throw new Error("mux band barely ticked — check stats parsing");
  }

  // ── verify the output ──
  const durOut = await probeDur(out);
  console.log(`[verify] output duration ${durOut}s (want ~${TOTAL_SEC})`);
  if (Math.abs(durOut - TOTAL_SEC) > 6) throw new Error(`output duration ${durOut} != ${TOTAL_SEC}`);

  // ── band report ──
  const report = Object.entries(bands).map(([k, arr]) => {
    if (arr.length === 0) return `${k}: 0 ticks`;
    const first = arr[0], last = arr[arr.length - 1];
    return `${k}: ${arr.length} ticks ${first.pct}%→${last.pct}% over ${first.at}s→${last.at}s wall`;
  });
  console.log("\n── PROGRESS BAND REPORT ──\n  " + report.join("\n  "));
  console.log(`\nFULL-SCALE v1.33.4 EXPORT: PASSED in ${((Date.now() - t0) / 60000).toFixed(1)} min (all bands live, 100% only at the end, output verified)`);
})().catch((e) => { console.error("\nFULL-SCALE FAILED:", e.message); process.exit(1); });
