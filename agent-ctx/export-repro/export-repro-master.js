#!/usr/bin/env node
// v2 repro harness: the EXACT two-step export argv sequence for the
// "1h9m audio + 10s video looped across the timeline + kinetic captions"
// scenario — but run with the ffmpeg that ACTUALLY SHIPS in the installer
// (BtbN master N-127203, same commit as the packaged win64 exe).
// Adds: per-step hang watchdog (kill + report), and the master-bus mux
// shape (concat + mix WAV + measured loudnorm + limiter + apad).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = "/tmp/repro2";
const FF = process.env.FF || "/tmp/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg";
const STEP_CAP_MS = Number(process.env.STEP_CAP_MS || 420000); // 7 min per step

function runFfmpeg(label, args, totalSec, opts = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const proc = spawn(FF, args, { stdio: ["ignore", "pipe", "pipe"] });
    let lastTime = 0;
    let tAtTotal = null;
    let tLastProgress = t0;
    let tail = "";
    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, STEP_CAP_MS);
    if (proc.stderr) {
      proc.stderr.on("data", (d) => {
        const s = d.toString();
        tail = (tail + s).slice(-3000);
        const mm = s.match(/time=(\d+):(\d{2}):(\d{2})\.(\d{2})/);
        if (mm) {
          tLastProgress = Date.now();
          const sec = (+mm[1]) * 3600 + (+mm[2]) * 60 + (+mm[3]) + (+mm[4]) / 100;
          lastTime = sec;
          if (tAtTotal == null && sec >= totalSec - 0.05) tAtTotal = Date.now();
        }
      });
    }
    proc.on("exit", (code, signal) => {
      clearTimeout(killer);
      const tExit = Date.now();
      const stats = {
        label,
        killed: killed ? "WATCHDOG-KILLED (HANG)" : false,
        code,
        signal,
        wallSec: ((tExit - t0) / 1000).toFixed(1),
        lastTimeSec: lastTime.toFixed(1),
        gapAtTotalToExitSec: tAtTotal != null ? ((tExit - tAtTotal) / 1000).toFixed(1) : "never-reached-total",
        silentTailSec: ((tExit - tLastProgress) / 1000).toFixed(1),
        size: opts.outPath && fs.existsSync(opts.outPath) ? (fs.statSync(opts.outPath).size / 1024 / 1024).toFixed(1) + "MB" : "no-file",
        tail: (tail.slice(-400) || "").replace(/\n/g, " | "),
      };
      console.log(JSON.stringify(stats, null, 2));
      if (killed) { reject(new Error(`HANG: ${label} exceeded ${STEP_CAP_MS / 1000}s`)); return; }
      if (code !== 0) reject(new Error(`ffmpeg exit ${code} ${signal || ""}\n${tail.slice(-800)}`));
      else resolve(stats);
    });
    proc.on("error", (e) => { clearTimeout(killer); reject(e); });
  });
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const VIDEO_TOTAL = Number(process.env.VIDEO_TOTAL || 4140);
  const AUDIO_TOTAL = Number(process.env.AUDIO_TOTAL || 4140);
  const W = 1920, H = 1080, FPS = 30;

  // ── fixtures (only if missing) ──
  const src = path.join(DIR, "src10s.mp4");
  if (!fs.existsSync(src)) {
    console.log("[fix] generating 10s 1080p30 source with audio …");
    await runFfmpeg("fixture-src", [
      "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=10`,
      "-f", "lavfi", "-i", "sine=frequency=320:duration=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-shortest",
      "-y", src,
    ], 10, { outPath: src });
  }
  const music = path.join(DIR, "music69m.mp3");
  if (!fs.existsSync(music)) {
    console.log("[fix] generating 4140s music mp3 …");
    await runFfmpeg("fixture-music", [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=" + AUDIO_TOTAL,
      "-af", "volume=0.4",
      "-c:a", "libmp3lame", "-b:a", "128k",
      "-y", music,
    ], AUDIO_TOTAL, { outPath: music });
  }
  const assPath = path.join(DIR, "captions.ass");
  if (!fs.existsSync(assPath)) {
    const lines = ["[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: KineticC0,Inter,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,0,3,5,0,0,0,1", "",
      "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"];
    for (let w = 0; w < 250; w++) {
      const st = (w * 2.0).toFixed(2);
      const en = (w * 2.0 + 1.9).toFixed(2);
      const m = Math.floor(w * 2 / 60), s = Math.floor(w * 2 % 60);
      const em = Math.floor((w * 2 + 1.9) / 60), es2 = Math.floor((w * 2 + 1.9) % 60);
      lines.push(`Dialogue: 0,0:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.00,0:${String(em).padStart(2, "0")}:${String(es2).padStart(2, "0")}.00,KineticC0,,0,0,0,,{\\pos(960,540)}word${w}`);
    }
    fs.writeFileSync(assPath, lines.join("\n"), "utf-8");
  }

  const step = process.env.STEP || "all";

  // ── STEP 1 (pool job): base-lane loop render, video-only, ASS burned ──
  const clipPath = path.join(DIR, "clip_0000.mp4");
  if (step === "all" || step === "1") {
    console.log(`\n=== STEP 1: loop render -stream_loop -1 -t ${VIDEO_TOTAL}s (video-only + ass) ===`);
    await runFfmpeg("pool-loop-render", [
      "-stream_loop", "-1",
      "-i", src,
      "-t", VIDEO_TOTAL.toFixed(3),
      "-vf", `scale=${W}:${H},ass=${assPath}:fontsdir=/home/z/my-project/public/fonts`,
      "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-y", clipPath,
    ], VIDEO_TOTAL, { outPath: clipPath });
  }

  // ── STEP 1b: clip-audio loop extraction (PCM WAV, 4140s) ──
  const wavPath = path.join(DIR, "audio_0000.wav");
  if (step === "all" || step === "1b") {
    console.log(`\n=== STEP 1b: loop audio extraction (-stream_loop -1 -t ${VIDEO_TOTAL}s PCM) ===`);
    await runFfmpeg("pool-audio-extract", [
      "-stream_loop", "-1",
      "-i", src,
      "-vn", "-ar", "48000", "-ac", "2",
      "-c:a", "pcm_s16le",
      "-t", VIDEO_TOTAL.toFixed(3),
      "-y", wavPath,
    ], VIDEO_TOTAL, { outPath: wavPath });
  }

  // ── STEP 2 (direct amix graph mux — the newAudioGraph path) ──
  if (step === "all" || step === "2") {
    const concatPath = path.join(DIR, "concat.txt");
    fs.writeFileSync(concatPath, `file '${clipPath.replace(/'/g, "'\\''")}'`, "utf-8");
    const outPath = path.join(DIR, "export-out.mp4");
    const graph = [
      `[2:a]aformat=sample_rates=48000:channel_layouts=stereo[ca0]`,
      `[1:a]aformat=sample_rates=48000:channel_layouts=stereo[m0]`,
      `[ca0][m0]amix=inputs=2:duration=longest:normalize=0[mix]`,
      `[mix]alimiter=limit=0.97:level=false,apad=whole_dur=${AUDIO_TOTAL.toFixed(3)}[aout]`,
    ].join(";");
    console.log(`\n=== STEP 2: final mux — direct amix graph (concat -c:v copy + amix + alimiter + apad, NO faststart) ===`);
    await runFfmpeg("final-mux-direct", [
      "-f", "concat", "-safe", "0", "-i", concatPath,
      "-i", music,
      "-i", wavPath,
      "-c:v", "copy",
      "-filter_complex", graph,
      "-map", "0:v", "-map", "[aout]",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-shortest",
      "-y", outPath,
    ], VIDEO_TOTAL, { outPath: outPath });
  }

  // ── STEP 2m (master-bus shape: pre-rendered mix WAV + measured loudnorm) ──
  // (a) the mix render (audio-only, -t bounded, looped music input)
  if (step === "all" || step === "2m") {
    const mixWav = path.join(DIR, "mixmaster.wav");
    console.log(`\n=== STEP 2m-a: master-bus mix render (music + clip audio → WAV, -t bounded) ===`);
    await runFfmpeg("master-mix-render", [
      "-i", music,
      "-i", wavPath,
      "-filter_complex", [
        `[1:a]aformat=sample_rates=48000:channel_layouts=stereo[ca0]`,
        `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[m0]`,
        `[ca0][m0]amix=inputs=2:duration=longest:normalize=0[mix]`,
      ].join(";"),
      "-map", "[mix]",
      "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
      "-t", AUDIO_TOTAL.toFixed(3),
      "-y", mixWav,
    ], AUDIO_TOTAL, { outPath: mixWav });
  }
  if (step === "all" || step === "2m") {
    // (b) the mux: concat + single WAV + loudnorm + limiter + apad + shortest
    const concatPath = path.join(DIR, "concat.txt");
    if (!fs.existsSync(concatPath)) fs.writeFileSync(concatPath, `file '${clipPath.replace(/'/g, "'\\''")}'`, "utf-8");
    const outPath = path.join(DIR, "export-out-mastermix.mp4");
    const af = [
      "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-22.5:measured_LRA=1.0:measured_TP=-3.0:measured_thresh=-35.2:offset=0.7:linear=true",
      "alimiter=limit=0.97:level=false",
      `apad=whole_dur=${AUDIO_TOTAL.toFixed(3)}`,
    ].join(",");
    console.log(`\n=== STEP 2m-b: master-bus mux (concat -c:v copy + WAV + loudnorm + alimiter + apad + -shortest, NO faststart) ===`);
    await runFfmpeg("final-mux-mastermix", [
      "-f", "concat", "-safe", "0", "-i", concatPath,
      "-i", path.join(DIR, "mixmaster.wav"),
      "-c:v", "copy",
      "-map", "0:v", "-map", "1:a",
      "-af", af,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-shortest",
      "-y", outPath,
    ], VIDEO_TOTAL, { outPath: outPath });
  }

  console.log("\n=== DONE (no hangs) ===");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
