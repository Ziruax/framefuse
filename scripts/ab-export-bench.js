#!/usr/bin/env node
/**
 * scripts/ab-export-bench.js — FrameFuse real-hardware export A/B protocol (GPU-Shift).
 *
 * Find ffmpeg (resources/ffmpeg/ffmpeg.exe → resources/ffmpeg/ffmpeg → PATH), generate
 * fixtures + bench-plan.json (ABSOLUTE paths) into --media-dir, then spawn the real app
 * per round — `npx electron electron/main.js` from the repo root, or a packaged --exe —
 * with FRAMEFUSE_BENCH=1, FRAMEFUSE_LOAD_STATIC=1, FRAMEFUSE_BENCH_PLAN/_OUT/_KEEP_OPEN.
 * The app's main process reads the plan, feeds the media to the renderer, the renderer
 * times TWO exports (FFmpeg with the encoder forced onto NVENC first, then WebCodecs
 * GPU), writes the results JSON to FRAMEFUSE_BENCH_OUT and quits; this script validates
 * it, prints the A/B table + speedup headline (or failure summary), per-round + medians
 * (--rounds N), and verifies every "ok" run really produced its bench-*.mp4.
 *
 * Results shape (optionals tolerated): {ok, appVersion, platform, startedAt,
 * runs:[{engine:"ffmpeg-smart"|"webcodecs-gpu", label, ok, wallMs, elapsedSec, size,
 * path, framesEncoded, encoder, gpuFrameRenderMs, jsCompositorOverheadMs,
 * gpuDecodeWaitMs, softwareFallback, workerRuntime, audioSkipped, error}]}
 *
 * Exit codes: 0 both ok · 1 usage/unexpected · 2 no ffmpeg · 3 fixture failed · 4 no
 * static build (npm run build / --exe) · 5 20-min round timeout (app killed) · 6 bad
 * results JSON · 7 app died without results · 8 a bench run failed. Headless/VM
 * software runs prove nothing about NVENC/QSV/AMF ASIC speed — run on real Windows GPU
 * hardware.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const IS_WIN = process.platform === "win32";
const ROUND_TIMEOUT_MS = 20 * 60 * 1000;
const APP_CMD = "npx electron electron/main.js";
const ENGINES = ["ffmpeg-smart", "webcodecs-gpu"];

function fail(code, msg) { console.error("\n[bench] FATAL (exit " + code + "): " + msg); process.exit(code); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statSize = (p) => { try { return fs.statSync(p).size; } catch (e) { return undefined; } };

// ── usage / CLI ──────────────────────────────────────────────────────
const USAGE = [
  "FrameFuse A/B export bench — real-hardware GPU (WebCodecs) vs FFmpeg (forced NVENC)",
  "Usage: node scripts/ab-export-bench.js [flags]",
  "",
  "  --duration <sec>     timeline duration in seconds               (default 60)",
  "  --fps <n>            export fps                                  (default 30)",
  "  --resolution <id>    480p / 720p / 1080p                         (default 1080p)",
  "  --aspect <a>         16:9 / 9:16 / 1:1 / 4:5                     (default 16:9)",
  "  --quality <id>       social / high / ultra                       (default social)",
  "  --force-encoder <id> nvenc / qsv / amf / none (JSON null)        (default nvenc)",
  "  --out <file>         results JSON path (written by the app)      (default ./bench-results.json)",
  "  --media-dir <dir>    fixture media directory                     (default ./.bench-media)",
  "  --output-dir <dir>   where the app writes bench-*.mp4            (default ./.bench-out)",
  "  --exe <path>         packaged FrameFuse.exe instead of npx electron",
  "  --reuse-media        skip fixture generation for existing files (>1KB)",
  "  --rounds <n>         repeat the A/B pair N times, report medians (default 1)",
  "  --keep-app-open      debug: leave the app running after the bench (no auto-quit)",
  "  --help               print this help",
].join("\n");

function usage(code, err) {
  if (err) console.error("ERROR: " + err + "\n");
  console.log(USAGE);
  process.exit(code);
}

function parseArgs(argv) {
  const a = { duration: 60, fps: 30, resolution: "1080p", aspect: "16:9", quality: "social",
    forceEncoder: "nvenc", out: "./bench-results.json", mediaDir: "./.bench-media",
    outputDir: "./.bench-out", exe: null, reuseMedia: false, rounds: 1, keepAppOpen: false };
  const NUM = { "--duration": "duration", "--fps": "fps", "--rounds": "rounds" };
  const STR = { "--resolution": "resolution", "--aspect": "aspect", "--quality": "quality", "--force-encoder": "forceEncoder",
    "--out": "out", "--media-dir": "mediaDir", "--output-dir": "outputDir", "--exe": "exe" };
  const BOOL = { "--reuse-media": "reuseMedia", "--keep-app-open": "keepAppOpen" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--help" || f === "-h") usage(0);
    const key = NUM[f] || STR[f] || BOOL[f];
    if (!key) usage(1, "unknown flag: " + f);
    if (BOOL[f]) { a[key] = true; continue; }
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) usage(1, "missing value for " + f);
    const v = argv[++i];
    if (NUM[f]) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) usage(1, f + " expects a positive number (got " + v + ")");
      a[key] = Math.round(n);
    } else a[key] = v;
  }
  a.forceEncoder = String(a.forceEncoder).toLowerCase();
  a.rounds = Math.max(1, a.rounds);
  return a;
}

// ── ffmpeg discovery (for fixtures) ──────────────────────────────────
function resolveFFmpeg() {
  const dir = path.join(ROOT, "resources", "ffmpeg");
  for (const c of [path.join(dir, "ffmpeg.exe"), path.join(dir, "ffmpeg")]) if (fs.existsSync(c)) return c;
  const probe = spawnSync("ffmpeg", ["-version"], { timeout: 15000 }); // PATH lookup
  return !probe.error && probe.status === 0 ? "ffmpeg" : null;
}

// ── fixture generation ───────────────────────────────────────────────
function runFF(FF, args, label) {
  console.log("  $ " + [FF].concat(args).join(" "));
  const r = spawnSync(FF, args, { timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    console.error("  ffmpeg failed for " + label + (r.error ? " — " + r.error.message : " — exit " + r.status));
    if (r.stderr) console.error(String(r.stderr).trim().split("\n").slice(-8).join("\n"));
    fail(3, "fixture generation failed for " + label);
  }
}

function genFixtures(FF, a, mediaDir) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const fresh = (f) => { // regenerate unless --reuse-media and the file is >1KB
    const s = statSize(path.join(mediaDir, f));
    return !a.reuseMedia || s === undefined || s <= 1024; };
  console.log("[bench] fixtures → " + mediaDir + (a.reuseMedia ? " (--reuse-media)" : ""));
  // 12s · 1920x1080 · 30fps · libx264 veryfast 6M yuv420p + silent stereo 48k AAC.
  // testsrc2/smptebars self-terminate via duration=; mandelbrot/gradients have no
  // duration option (verified on ffmpeg 7) so they are capped with input-side -t 12.
  const clips = [
    ["clip1.mp4", "testsrc2=size=1920x1080:rate=30:duration=12", 0],
    ["clip2.mp4", "smptebars=size=1920x1080:rate=30:duration=12", 0],
    ["clip3.mp4", "mandelbrot=size=1920x1080:rate=30", 1],
    ["clip4.mp4", "gradients=size=1920x1080:rate=30", 1]];
  const enc = ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast",
    "-b:v", "6M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest"];
  const anull = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
  for (const [name, src, capT] of clips) {
    if (!fresh(name)) { console.log("  reuse " + name); continue; }
    runFF(FF, ["-y", "-hide_banner", "-loglevel", "error"].concat(capT ? ["-t", "12"] : [],
      ["-f", "lavfi", "-i", src], anull, enc, [path.join(mediaDir, name)]), name);
  }
  if (fresh("kb1.png")) runFF(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "gradients=size=1920x1080:rate=30", "-frames:v", "1", path.join(mediaDir, "kb1.png")], "kb1.png");
  if (fresh("music.wav")) runFF(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000", "-ac", "2", "-t", String(a.duration),
    path.join(mediaDir, "music.wav")], "music.wav");
}

// ── bench plan ───────────────────────────────────────────────────────
function writePlan(a, mediaDir, outputDir, planPath) {
  const plan = { outputDir: outputDir, durationSec: a.duration, fps: a.fps,
    resolution: a.resolution, aspect: a.aspect, quality: a.quality, captions: false,
    forceEncoder: a.forceEncoder === "none" ? null : a.forceEncoder,
    media: ["clip1.mp4", "clip2.mp4", "clip3.mp4", "clip4.mp4"].map((f) => ({ path: path.join(mediaDir, f), kind: "video" }))
      .concat([{ path: path.join(mediaDir, "kb1.png"), kind: "image" },
        { path: path.join(mediaDir, "music.wav"), kind: "audio" }]) };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  console.log("[bench] plan → " + planPath);
}

// ── app spawn + one A/B round ────────────────────────────────────────
function pipePrefixed(stream, log) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim()) log("[bench-app] " + line);
      nl = buf.indexOf("\n");
    }
  });
  stream.on("end", () => { if (buf.trim()) log("[bench-app] " + buf.replace(/\r?\n$/, "")); });
}

function spawnApp(a, planPath, outPath) {
  const env = Object.assign({}, process.env, { FRAMEFUSE_BENCH: "1", FRAMEFUSE_LOAD_STATIC: "1",
    FRAMEFUSE_BENCH_OUT: outPath, FRAMEFUSE_BENCH_PLAN: planPath,
    FRAMEFUSE_BENCH_KEEP_OPEN: a.keepAppOpen ? "1" : "0" });
  const stdio = ["ignore", "pipe", "pipe"];
  if (a.exe) {
    console.log("[bench] spawn: " + a.exe);
    return spawn(a.exe, [], { cwd: path.dirname(a.exe), env, stdio });
  }
  console.log("[bench] spawn: " + APP_CMD + "  (cwd " + ROOT + ")");
  if (IS_WIN) return spawn(process.env.comspec || "cmd.exe", ["/d", "/s", "/c", APP_CMD], { cwd: ROOT, env, stdio }); // npx = .cmd shim
  return spawn("npx", ["electron", "electron/main.js"], { cwd: ROOT, env, stdio, detached: true });
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 15000 });
    else process.kill(-child.pid, "SIGKILL"); // detached → child is a group leader
  } catch (e) { try { child.kill("SIGKILL"); } catch (e2) {} }
}

async function runRound(idx, a, planPath, outPath) {
  try { fs.unlinkSync(outPath); } catch (e) {} // "file appeared" == THIS round's results
  const child = spawnApp(a, planPath, outPath);
  pipePrefixed(child.stdout, console.log);
  pipePrefixed(child.stderr, console.error);
  let exited = false, exitCode = null, exitSignal = null, exitAt = 0, sawFile = false;
  child.on("exit", (c, s) => { exited = true; exitCode = c; exitSignal = s; exitAt = Date.now(); });
  child.on("error", (e) => { exited = true; exitCode = "spawn-error: " + e.message; exitAt = Date.now(); });
  const t0 = Date.now();
  for (;;) {
    await sleep(500);
    if (!sawFile && fs.existsSync(outPath)) {
      sawFile = true;
      console.log("[bench] round " + idx + ": results JSON after " + ((Date.now() - t0) / 1000).toFixed(0) + "s");
    }
    if (sawFile && (exited || a.keepAppOpen)) {
      if (a.keepAppOpen && !exited) console.log("[bench] --keep-app-open: app left running (pid " + child.pid + ")");
      return;
    }
    if (exited && !sawFile && Date.now() - exitAt > 2000) {
      killTree(child);
      fail(7, "round " + idx + ": app exited (code " + exitCode + (exitSignal ? ", signal " + exitSignal : "") +
        ") without writing " + outPath + " — is electron installed and the build loadable?");
    }
    if (Date.now() - t0 > ROUND_TIMEOUT_MS) {
      killTree(child);
      fail(5, "round " + idx + ": 20-minute timeout exceeded — app killed (check Task Manager / ps for strays)");
    }
  }
}

// ── results validation + report ──────────────────────────────────────
function readResults(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { fail(6, "results JSON unreadable at " + file + ": " + e.message); }
  const problems = [];
  if (!doc || typeof doc !== "object") problems.push("not a JSON object");
  if (doc && !Array.isArray(doc.runs)) problems.push("runs[] array missing");
  if (doc && Array.isArray(doc.runs)) {
    if (!doc.runs.length) problems.push("runs[] is empty");
    doc.runs.forEach((r, i) => {
      if (!r || typeof r !== "object") { problems.push("runs[" + i + "] is not an object"); return; }
      if (!ENGINES.includes(r.engine)) problems.push("runs[" + i + "].engine must be ffmpeg-smart|webcodecs-gpu");
      if (typeof r.ok !== "boolean") problems.push("runs[" + i + "].ok (boolean) missing");
      else if (r.ok && (typeof r.wallMs !== "number" || !isFinite(r.wallMs))) problems.push("runs[" + i + "].wallMs missing on a successful run");
    });
  }
  if (problems.length) fail(6, "results JSON at " + file + " violates the protocol shape:\n  - " + problems.join("\n  - "));
  return doc;
}

const COLS = ["engine", "wall s", "rt x", "MB", "frames", "gpu ms/f", "js ms/f", "dec ms/f", "flags"];
const RIGHT = [false, true, true, true, true, true, true, true, false];

function printTable(runs, durationSec) {
  const rows = runs.map((run) => {
    const wallSec = typeof run.wallMs === "number" ? run.wallMs / 1000 : NaN;
    const rt = wallSec > 0 ? durationSec / wallSec : NaN;
    const gpu = run.engine === "webcodecs-gpu";
    const num = (v) => (typeof v === "number" && isFinite(v) ? v.toFixed(2) : "-");
    const bytes = typeof run.size === "number" ? run.size : statSize(run.path);
    const flags = [run.ok === false && "FAILED", run.softwareFallback && "SW-FALLBACK",
      run.audioSkipped && "NO-AUDIO", run.engine === "ffmpeg-smart" && run.encoder && "enc=" + run.encoder,
      gpu && run.workerRuntime && String(run.workerRuntime),
      // v1.15.3 lie detector: the WebCodecs run's ACTUAL encoder rung —
      // hw=require-hardware = proven GPU ASIC; hw=software/plain + a printed
      // HW-REJECTED line means the comparison is FFmpeg-vs-CPU and says
      // NOTHING about WebCodecs-on-GPU speed.
      gpu && run.hwEncoder && "hw=" + run.hwEncoder,
      gpu && run.hwEncoder && run.hwEncoder !== "require-hardware" && run.hwEncoder !== "prefer-hardware" && "HW-REJECTED",
      gpu && run.hwRejectReason && "reason: " + String(run.hwRejectReason).slice(0, 60)].filter(Boolean).join(", ");
    return [String(run.engine), isFinite(wallSec) ? wallSec.toFixed(1) : "-",
      isFinite(rt) ? rt.toFixed(2) + "x" : "-",
      typeof bytes === "number" ? (bytes / 1048576).toFixed(1) : "-",
      run.framesEncoded != null ? String(run.framesEncoded) : "-",
      gpu ? num(run.gpuFrameRenderMs) : "-", gpu ? num(run.jsCompositorOverheadMs) : "-",
      gpu ? num(run.gpuDecodeWaitMs) : "-", flags || "-"];
  });
  const w = COLS.map((h, c) => Math.max(h.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells) => cells.map((cell, c) => (RIGHT[c] ? String(cell).padStart(w[c]) : String(cell).padEnd(w[c]))).join("  ");
  console.log("  " + line(COLS));
  console.log("  " + w.map((x) => "-".repeat(x)).join("  "));
  rows.forEach((r) => console.log("  " + line(r)));
}

function printReport(doc, title, durationSec) {
  console.log("\n== " + title + " — app " + String(doc.appVersion || "?") + " on " + String(doc.platform || "?") + " ==");
  if (doc.gpuInfo) console.log("  GPU: " + String(doc.gpuInfo).slice(0, 220));
  printTable(doc.runs, durationSec);
  // v1.15.3 lie detector advisory: a speedup number against a SOFTWARE
  // WebCodecs run is not evidence about WebCodecs-on-GPU at all.
  const gpuRun = doc.runs.find((r) => r.engine === "webcodecs-gpu");
  if (gpuRun && gpuRun.ok && gpuRun.hwEncoder &&
      gpuRun.hwEncoder !== "require-hardware" && gpuRun.hwEncoder !== "prefer-hardware") {
    console.log("  !! HARDWARE ENCODING " +
      (gpuRun.hwRejectReason ? "REJECTED: " + String(gpuRun.hwRejectReason) : "NOT AVAILABLE") +
      " — the WebCodecs arm ran on the SOFTWARE encoder: this comparison says NOTHING about WebCodecs GPU speed." +
      " Check the GPU driver + that the app build carries the D3D11VideoEncoder flags, then re-run.");
  }
  for (const run of doc.runs) if (run.ok === false) console.log("  ! " + run.engine + " FAILED: " + (run.error || "(no error message)"));
  const ff = doc.runs.find((r) => r.engine === "ffmpeg-smart" && r.ok);
  const gpu = doc.runs.find((r) => r.engine === "webcodecs-gpu" && r.ok);
  if (ff && gpu && ff.wallMs > 0 && gpu.wallMs > 0) {
    console.log("  WebCodecs GPU vs FFmpeg speedup: " + (ff.wallMs / gpu.wallMs).toFixed(1) + "x" +
      "  (FFmpeg " + (ff.wallMs / 1000).toFixed(1) + "s vs WebCodecs " + (gpu.wallMs / 1000).toFixed(1) + "s)");
  } else {
    const bad = doc.runs.filter((r) => !r.ok).map((r) => r.engine + ": " + (r.error || "?"));
    ENGINES.forEach((e) => { if (!doc.runs.some((r) => r.engine === e)) bad.push(e + ": run missing"); });
    console.log("  FAILURE SUMMARY — no speedup number: " + (bad.join(" | ") || "unknown"));
  }
}

// cross-check: an "ok" run must have actually produced a real output file
function crossCheck(doc, outputDir) {
  for (const run of doc.runs) {
    if (run.ok !== true) continue;
    const def = path.join(outputDir, run.engine === "webcodecs-gpu" ? "bench-webcodecs.mp4" : "bench-ffmpeg.mp4");
    const cands = (run.path ? [run.path, path.join(outputDir, path.basename(run.path))] : []).concat([def]);
    const found = cands.find((c) => statSize(c) !== undefined);
    if (!found) console.log("  !! WARNING: " + run.engine + " says ok but its output file is missing (looked at: " + cands.join(" ; ") + ")");
    else if (statSize(found) < 100 * 1024) {
      console.log("  !! WARNING: " + run.engine + " says ok but " + found + " is only " +
        (statSize(found) / 1024).toFixed(0) + " KB (< 100 KB) — suspiciously small");
    }
  }
}

// ── multi-round medians ──────────────────────────────────────────────
function mediansReport(docs, durationSec) {
  const median = (vals) => {
    const s = vals.filter((v) => typeof v === "number" && isFinite(v)).sort((x, y) => x - y);
    if (!s.length) return undefined;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const rows = ENGINES.map((engine) => {
    const runs = docs.map((d) => d.runs.find((r) => r.engine === engine)).filter(Boolean);
    const out = { engine: engine, label: "median", ok: runs.length > 0 && runs.every((r) => r.ok),
      softwareFallback: runs.some((r) => r.softwareFallback), audioSkipped: runs.some((r) => r.audioSkipped) };
    for (const k of ["wallMs", "size", "framesEncoded", "gpuFrameRenderMs", "jsCompositorOverheadMs", "gpuDecodeWaitMs", "encoder", "workerRuntime"]) {
      const v = k === "encoder" || k === "workerRuntime" ? runs.map((r) => r[k]).find(Boolean) : median(runs.map((r) => r[k]));
      if (v !== undefined) out[k] = v;
    }
    return out;
  });
  printReport({ runs: rows, appVersion: docs[0].appVersion, platform: docs[0].platform },
    "MEDIANS over " + docs.length + " rounds", durationSec);
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const outPath = path.resolve(a.out);
  const mediaDir = path.resolve(a.mediaDir);
  const outputDir = path.resolve(a.outputDir);
  const planPath = path.join(mediaDir, "bench-plan.json");
  if (a.exe) {
    a.exe = path.resolve(a.exe);
    if (!fs.existsSync(a.exe)) fail(1, "--exe not found: " + a.exe);
  }
  console.log("[bench] FrameFuse A/B export bench — GPU (WebCodecs) vs FFmpeg (forced " +
    (a.forceEncoder === "none" ? "auto-probe" : a.forceEncoder) + ") · timeline " + a.duration + "s @ " + a.fps +
    "fps " + a.resolution + " " + a.aspect + " quality=" + a.quality + " · rounds=" + a.rounds + (a.exe ? " · exe=" + a.exe : ""));
  if (a.keepAppOpen && a.rounds > 1) console.log("[bench] NOTE: --keep-app-open with --rounds>1 leaves one app instance per round running.");
  const FF = resolveFFmpeg();
  if (!FF) fail(2, "no ffmpeg found (looked: resources/ffmpeg/ffmpeg(.exe), then PATH).\n  Install ffmpeg on PATH or place the binary under resources/ffmpeg/.");
  console.log("[bench] ffmpeg: " + FF);
  if (!a.exe && !fs.existsSync(path.join(ROOT, "out", "index.html"))) {
    fail(4, path.join(ROOT, "out", "index.html") + " not found — run npm run build first or pass --exe.");
  }
  fs.mkdirSync(outputDir, { recursive: true });
  try { fs.unlinkSync(outPath); console.log("[bench] removed stale " + outPath); } catch (e) {}
  genFixtures(FF, a, mediaDir);
  writePlan(a, mediaDir, outputDir, planPath);
  const docs = [];
  let allOk = true;
  for (let i = 1; i <= a.rounds; i++) {
    console.log("\n── round " + i + "/" + a.rounds + " ──");
    await runRound(i, a, planPath, outPath);
    const doc = readResults(outPath);
    docs.push(doc);
    printReport(doc, "round " + i + "/" + a.rounds, a.duration);
    crossCheck(doc, outputDir);
    if (!ENGINES.every((e) => doc.runs.some((r) => r.engine === e && r.ok))) allOk = false;
  }
  if (docs.length > 1) mediansReport(docs, a.duration);
  console.log("\nFull JSON: " + outPath);
  console.log("NOTE: headless/VM software runs prove nothing about NVENC/QSV/AMF ASIC speed — run on real Windows GPU hardware.");
  process.exit(allOk ? 0 : 8);
}

main().catch((e) => fail(1, String((e && e.stack) || e)));
