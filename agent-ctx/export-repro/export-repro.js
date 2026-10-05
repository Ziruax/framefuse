#!/usr/bin/env node
// Repro harness: mirrors FrameFuse's two-step export argv sequence for the
// "10s video looped over 1h9m audio + kinetic captions" scenario.
// Instruments the wall-clock gap between out_time==total (progress=100%)
// and process exit — the user's "stuck at 100%" window.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = "/tmp/repro";
const FF = "/usr/bin/ffmpeg";

function runFfmpeg(label, args, totalSec, opts = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const proc = spawn(FF, args, { stdio: ["ignore", "pipe", "pipe"] });
    let lastTime = 0;
    let tAtTotal = null; // wall-clock ms when out_time first reached totalSec
    let tLastProgress = t0;
    let tail = "";
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
      const tExit = Date.now();
      const stats = {
        label,
        code,
        signal,
        wallSec: ((tExit - t0) / 1000).toFixed(1),
        lastTimeSec: lastTime.toFixed(1),
        gapAtTotalToExitSec:
          tAtTotal != null ? ((tExit - tAtTotal) / 1000).toFixed(1) : "never-reached-total",
        silentTailSec: ((tExit - tLastProgress) / 1000).toFixed(1),
        size: opts.outPath && fs.existsSync(opts.outPath)
          ? (fs.statSync(opts.outPath).size / 1024 / 1024).toFixed(1) + "MB"
          : "no-file",
        tail: tail.slice(-400),
      };
      console.log(JSON.stringify(stats, null, 2));
      if (code !== 0) reject(new Error(`ffmpeg exit ${code} ${signal || ""}\n${tail.slice(-800)}`));
      else resolve(stats);
    });
    proc.on("error", reject);
  });
}

async function main() {
  // video: loop render covers VIDEO_TOTAL; audio: the full 4140s music.
  const VIDEO_TOTAL = Number(process.env.VIDEO_TOTAL || 300);
  const AUDIO_TOTAL = Number(process.env.AUDIO_TOTAL || 4140);
  const SKIP_VIDEO = process.env.SKIP_VIDEO === "1";
  const SKIP_WAV = process.env.SKIP_WAV === "1";
  const W = 1920, H = 1080, FPS = 30;
  const maxrate = process.env.VIDEO_MAXRATE
    ? ["-maxrate", process.env.VIDEO_MAXRATE, "-bufsize", `${Number(String(process.env.VIDEO_MAXRATE).replace(/[^0-9.]/g, "")) * 2}${String(process.env.VIDEO_MAXRATE).endsWith("K") ? "K" : "M"}`]
    : [];

  const assPath = path.join(DIR, "captions.ass");
  if (!fs.existsSync(assPath)) {
    const lines = ["[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: KineticC0,Inter,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,0,3,5,0,0,0,1`, "",
      "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"];
    for (let w = 0; w < 250; w++) {
      const st = (w * 2.0).toFixed(2);
      const en = (w * 2.0 + 1.9).toFixed(2);
      lines.push(`Dialogue: 0,0:00:${st.padStart(5, "0")},0:00:${en.padStart(5, "0")},KineticC0,,0,0,0,,{\\pos(960,540)}word${w}`);
    }
    fs.writeFileSync(assPath, lines.join("\n"), "utf-8");
  }

  // ── STEP 1 (pool job): base-lane loop render, video-only, ASS burned ──
  const clipPath = path.join(DIR, "clip_0000.mp4");
  if (!SKIP_VIDEO) {
    console.log(`\n=== STEP 1: loop render -stream_loop -1 -t ${VIDEO_TOTAL}s (video-only + ass) ===`);
    await runFfmpeg("pool-loop-render", [
      "-stream_loop", "-1",
      "-i", path.join(DIR, "src10s.mp4"),
      "-t", VIDEO_TOTAL.toFixed(3),
      "-vf", `scale=${W}:${H},ass=${assPath}:fontsdir=/home/z/my-project/public/fonts`,
      "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", ...maxrate,
      "-pix_fmt", "yuv420p",
      "-y", clipPath,
    ], VIDEO_TOTAL, { outPath: clipPath });
  }

  // ── STEP 1b (pool job): clip-audio loop extraction (PCM WAV) ──
  const wavPath = path.join(DIR, "audio_0000.wav");
  if (!SKIP_WAV) {
    console.log(`\n=== STEP 1b: loop audio extraction (-stream_loop -1 -t ${VIDEO_TOTAL}s PCM) ===`);
    await runFfmpeg("pool-audio-extract", [
      "-stream_loop", "-1",
      "-i", path.join(DIR, "src10s.mp4"),
      "-vn", "-ar", "48000", "-ac", "2",
      "-c:a", "pcm_s16le",
      "-t", VIDEO_TOTAL.toFixed(3),
      "-y", wavPath,
    ], VIDEO_TOTAL, { outPath: wavPath });
  }

  // ── STEP 2: concat + music mix mux (the 96→100% stage) ──
  const concatPath = path.join(DIR, "concat.txt");
  fs.writeFileSync(concatPath, `file '${clipPath.replace(/'/g, "'\\''")}'`, "utf-8");
  const outPath = path.join(DIR, "export-out.mp4");

  const graph = [
    `[2:a]aformat=sample_rates=48000:channel_layouts=stereo[ca0]`,
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo[m0]`,
    `[ca0][m0]amix=inputs=2:duration=longest:normalize=0[mix]`,
    `[mix]alimiter=limit=0.97:level=false,apad=whole_dur=${AUDIO_TOTAL.toFixed(3)}[aout]`,
  ].join(";");
  console.log(`\n=== STEP 2: final mux (concat -c:v copy + amix + apad + faststart) ===`);
  await runFfmpeg("final-mux", [
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-i", path.join(DIR, "music69m.mp3"),
    "-i", wavPath,
    "-c:v", "copy",
    "-filter_complex", graph,
    "-map", "0:v", "-map", "[aout]",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-shortest",
    "-movflags", "+faststart",
    "-y", outPath,
  ], VIDEO_TOTAL, { outPath });

  console.log("\n=== DONE ===");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
