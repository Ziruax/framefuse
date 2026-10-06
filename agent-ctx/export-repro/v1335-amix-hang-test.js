// agent-ctx/export-repro/v1335-amix-hang-test.js — the DECISIVE experiment
// for the stuck-at-100% root cause. The v1.33.4 harness tested the LEGACY
// single-music `-af` mux; the user's real scenario (musicClips + loop video
// with its own extracted audio) runs the FILTER_COMPLEX AMIX GRAPH:
//
//   -f concat -i list  -stream_loop -1? -i music  -i clipWav
//   -c:v copy  -filter_complex "[2:a]vol,adelay,aformat[ca0];
//     [1:a]vol,aformat[m0]; [ca0][m0]amix=inputs=2:duration=longest:normalize=0[mix];
//     [mix]alimiter,apad=whole_dur=4140[aout]"
//   -map 0:v -map [aout] -c:a aac -shortest -y out.mp4
//
// HYPOTHESIS: with an INFINITE (-stream_loop -1) music branch feeding
// amix(duration=longest), the audio chain never EOFs; -shortest + a COPY
// video stream fails to tear the graph down at the video end → ffmpeg
// encodes audio FOREVER → out_time passes totalSec (the bar clamps to its
// band top = "100%"), stderr keeps printing stats (watchdog sees life) →
// the export promise never settles = EXACTLY "stuck at 100%".
//
// Variants:
//   A. amix + music LOOP=true   (infinite input)   ← the prime suspect
//   B. amix + music LOOP=false  (finite 4140s)     ← isolate -stream_loop
//   C. single-branch music LOOP=true (no amix; the -af shape)  ← control
//
// Each variant runs with a hard 240s experiment cap: alive at cap = HANG
// CONFIRMED (we record out_time growth + last stderr lines, then kill).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const FFMPEG = "/usr/bin/ffmpeg";
const TOTAL = 4140;         // 1h9m — the user's timeline
const CLIP = 690;           // rendered once, concat 6× → 4140s
const W = 640, H = 360, FPS = 30;
const HARD_CAP_MS = 240000; // experiment cap per variant

const work = fs.mkdtempSync(path.join("/tmp", "amix-"));
console.log(`[harness] ${work} · timeline ${TOTAL}s`);

// ── run one ffmpeg with a hard cap + tick log (the runFfmpeg shape, minus
// the watchdog — we WANT to observe an infinite run, not kill it at 5 min) ──
function runCapped(tag, args, totalSec) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let ticks = 0, lastSec = 0, lastLineAt = Date.now(), tail = "";
    let outSecs = []; // sampled out_time
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      lastLineAt = Date.now();
      tail = (tail + s).slice(-2000);
      const m = s.match(/time=(\d+):(\d{2}):(\d{2})\.(\d{2})/);
      if (m) {
        ticks++;
        lastSec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
        if (ticks % 40 === 1) outSecs.push(lastSec);
      }
    });
    const cap = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) {}
    }, HARD_CAP_MS);
    proc.on("exit", (code, signal) => {
      clearTimeout(cap);
      const wall = ((Date.now() - t0) / 1000).toFixed(1);
      resolve({
        tag, code, signal, wall,
        ticks, lastSec, outSecs,
        outTimePastTotal: lastSec > totalSec + 1,
        tail: tail.split("\n").slice(-4).join("\n"),
      });
    });
  });
}

(async () => {
  // ── media gen ──
  const gen = (args) => new Promise((res, rej) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error("gen failed " + c))));
    p.stderr.on("data", (d) => process.stderr.write(d));
  });
  const loopSrc = path.join(work, "loop10.mp4");
  await gen(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=10",
    "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "500k",
    "-c:a", "aac", "-b:a", "128k", "-shortest", "-y", loopSrc]);
  // The concat video: 690s clip ×6 (copy-level fast)
  const clip = path.join(work, "clip.mp4");
  await gen(["-stream_loop", "-1", "-i", loopSrc, "-t", String(CLIP),
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "500k", "-an", "-y", clip]);
  const list = path.join(work, "list.txt");
  fs.writeFileSync(list, Array(6).fill(`file '${clip.replace(/'/g, "'\\''")}'`).join("\n"));
  // 4140s music (AAC) + the loop video's own 4140s PCM WAV (48k stereo)
  const music = path.join(work, "music.m4a");
  await gen(["-f", "lavfi", "-i", `sine=frequency=330:duration=${TOTAL}`,
    "-c:a", "aac", "-b:a", "128k", "-y", music]);
  const clipWav = path.join(work, "audio_0000.wav");
  await gen(["-stream_loop", "-1", "-i", loopSrc, "-t", String(TOTAL),
    "-vn", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", clipWav]);
  console.log(`[gen] done · clip ${(fs.statSync(clip).size / 1e6).toFixed(0)}MB · wav ${(fs.statSync(clipWav).size / 1e6).toFixed(0)}MB · music ${(fs.statSync(music).size / 1e6).toFixed(0)}MB`);

  const AFORMAT = "aformat=sample_rates=48000:channel_layouts=stereo";
  const results = [];

  // ── Variant A: amix(clipWav 4140s + music INFINITE) — the user's shape ──
  results.push(await runCapped("A amix+loop-music(infinite)", [
    "-f", "concat", "-safe", "0", "-i", list,
    "-stream_loop", "-1", "-i", music,
    "-i", clipWav,
    "-c:v", "copy",
    "-filter_complex",
    `[2:a]volume=1.0,aformat=sample_rates=48000:channel_layouts=stereo[ca0];` +
      `[1:a]volume=0.8,${AFORMAT}[m0];` +
      `[ca0][m0]amix=inputs=2:duration=longest:normalize=0[mix];` +
      `[mix]alimiter=limit=0.97:level=false,apad=whole_dur=${TOTAL.toFixed(3)}[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-shortest",
    "-y", path.join(work, "outA.mp4"),
  ], TOTAL));

  // ── Variant B: amix(clipWav + FINITE music) ──
  results.push(await runCapped("B amix+finite-music", [
    "-f", "concat", "-safe", "0", "-i", list,
    "-i", music,
    "-i", clipWav,
    "-c:v", "copy",
    "-filter_complex",
    `[2:a]volume=1.0,aformat=sample_rates=48000:channel_layouts=stereo[ca0];` +
      `[1:a]volume=0.8,${AFORMAT}[m0];` +
      `[ca0][m0]amix=inputs=2:duration=longest:normalize=0[mix];` +
      `[mix]alimiter=limit=0.97:level=false,apad=whole_dur=${TOTAL.toFixed(3)}[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-shortest",
    "-y", path.join(work, "outB.mp4"),
  ], TOTAL));

  // ── Variant C: single-branch music LOOP=true (the -af shape, control) ──
  results.push(await runCapped("C single-af+loop-music", [
    "-f", "concat", "-safe", "0", "-i", list,
    "-stream_loop", "-1", "-i", music,
    "-c:v", "copy",
    "-af", `volume=0.8,${AFORMAT},alimiter=limit=0.97:level=false,apad=whole_dur=${TOTAL.toFixed(3)}`,
    "-map", "0:v", "-map", "1:a:0",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-shortest",
    "-y", path.join(work, "outC.mp4"),
  ], TOTAL));

  // ── report ──
  console.log("\n════ RESULTS ════");
  for (const r of results) {
    const verdict =
      r.code === 0 ? "TERMINATED (exit 0)" :
      r.signal === "SIGKILL" ? "HANG — killed at the 240s cap (STUCK CONFIRMED)" :
      `exit ${r.code} signal ${r.signal}`;
    console.log(`\n[${r.tag}] ${verdict}`);
    console.log(`  wall=${r.wall}s · ticks=${r.ticks} · last out_time=${r.lastSec.toFixed(1)}s (total ${TOTAL}s)`);
    console.log(`  out_time passed total: ${r.outTimePastTotal ? "YES — the bar clamps at band top while ffmpeg runs on" : "no"}`);
    if (r.outSecs.length > 1) console.log(`  out_time samples: ${r.outSecs.map((s) => s.toFixed(0)).join(" → ")}`);
    if (r.code !== 0) console.log(`  tail: ${r.tail}`);
    if (r.code === 0) {
      try {
        const st = fs.statSync(path.join(work, `out${r.tag[0]}.mp4`));
        console.log(`  output: ${(st.size / 1e6).toFixed(0)}MB`);
      } catch (_) {}
    }
  }
  const hang = results.filter((r) => r.signal === "SIGKILL");
  console.log(`\n${hang.length > 0 ? "!!! HANG REPRODUCED in: " + hang.map((h) => h.tag).join(" | ") : "all variants terminated"}`);
})().catch((e) => { console.error(e); process.exit(1); });
