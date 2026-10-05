#!/usr/bin/env node
// Hang-hypothesis tests for the post-95% export stages.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const DIR = "/tmp/repro";
const FF = "/usr/bin/ffmpeg";

function timedRun(label, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tail = "";
    const proc = spawn(FF, args, { stdio: ["ignore", "pipe", "pipe"] });
    let outTime = 0;
    let done = false;
    const killer = setTimeout(() => {
      if (!done) {
        try { proc.kill("SIGKILL"); } catch {}
        resolve({ label, verdict: `TIMEOUT>${timeoutMs / 1000}s`, outTime: outTime.toFixed(1), tail: tail.slice(-300) });
      }
    }, timeoutMs);
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      const m = s.match(/time=(\d+):(\d{2}):(\d{2})\.(\d{2})/);
      if (m) outTime = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
    });
    proc.on("exit", (code, signal) => {
      done = true;
      clearTimeout(killer);
      resolve({
        label,
        verdict: `exit ${code}${signal ? " " + signal : ""} @ ${((Date.now() - t0) / 1000).toFixed(1)}s wall`,
        outTime: outTime.toFixed(1),
        tail: tail.slice(-300),
      });
    });
  });
}

async function main() {
  // Build small fixtures: 30s concat video + 5s music (looped) + 30s wav
  const clip30 = path.join(DIR, "clip30.mp4");
  if (!fs.existsSync(clip30)) {
    await timedRun("make-clip30", [
      "-stream_loop", "-1", "-i", path.join(DIR, "src10s.mp4"),
      "-t", "30", "-vf", "scale=640:360", "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-y", clip30,
    ], 60000);
  }
  const music5 = path.join(DIR, "music5.mp3");
  if (!fs.existsSync(music5)) {
    await timedRun("make-music5", [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
      "-c:a", "libmp3lame", "-b:a", "128k", "-y", music5,
    ], 60000);
  }
  const concatPath = path.join(DIR, "concat30.txt");
  fs.writeFileSync(concatPath, `file '${clip30}'`, "utf-8");

  // ── H1: LOOPED music input (-stream_loop -1) + amix + apad + -shortest ──
  // This is buildConcatArgs' loop-to-fill music path in the final mux.
  const h1 = await timedRun("H1-looped-music-shortest", [
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-stream_loop", "-1", "-i", music5,
    "-c:v", "copy",
    "-filter_complex",
    "[1:a]aformat=sample_rates=48000:channel_layouts=stereo[m0];" +
      "[m0]alimiter=limit=0.97:level=false,apad=whole_dur=30.000[aout]",
    "-map", "0:v", "-map", "[aout]",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-shortest",
    "-movflags", "+faststart",
    "-y", path.join(DIR, "h1-out.mp4"),
  ], 90000);
  console.log(JSON.stringify(h1, null, 2));

  // ── H2: loudnorm analysis pass over the 69-minute MP3 (ffmpegCapture
  // uses a 60s timeout — does a real 1h9m source finish in time?) ──
  const h2 = await timedRun("H2-loudnorm-69min", [
    "-hide_banner", "-nostats",
    "-i", path.join(DIR, "music69m.mp3"),
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ], 300000);
  console.log(JSON.stringify(h2, null, 2));

  // ── H3: DYNAMIC loudnorm in the mux graph (the fallback when the
  // measurement times out) over a long audio — the in-graph ebur128 cost. ──
  const h3 = await timedRun("H3-dynamic-loudnorm-mux", [
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-i", path.join(DIR, "music69m.mp3"),
    "-t", "300", // 5 min of output to bound the test
    "-c:v", "copy",
    "-filter_complex",
    "[1:a]aformat=sample_rates=48000:channel_layouts=stereo[m0];" +
      "[m0]loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.97:level=false,apad=whole_dur=300.000[aout]",
    "-map", "0:v", "-map", "[aout]",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-shortest",
    "-movflags", "+faststart",
    "-y", path.join(DIR, "h3-out.mp4"),
  ], 300000);
  console.log(JSON.stringify(h3, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
