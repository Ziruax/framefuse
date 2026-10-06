// agent-ctx/export-repro/v1335-scenario-matrix.js — the v1.33.5 SCENARIO
// MATRIX. The full-scale loop test (v1335-fullscale-test.js) proved the
// user's exact scenario; this harness sweeps the OTHER export shapes end-to
// end through real ffmpeg, each asserting: terminates, no dynamic loudnorm
// leak, finite loop bounds, output duration correct.
//   S1 legacy audioPath + musicLoop → -af chain + apad + -shortest + finite loop
//   S2 musicClips loop=FALSE (finite music) + clip WAV + captions band
//   S3 normalize OFF (no measures at all; user-volume graph)
//   S4 4 branches → the master-mix path: mix render (bounded) + WINDOWED
//      master measure (fast) + masterMix mux with measured master gain
//   S5 short timeline (45s) — window policy measures whole (≤120s)
//   S6 music-only, no clip audio, no musicClips… legacy -af, no loop
//   S7 buildConcatArgs argv audit across shapes (no -stream_loop -1 with
//      known durations, no dynamic loudnorm with normalize ON anywhere)
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const FFMPEG = "/usr/bin/ffmpeg";
const G = require(path.join(ROOT, "electron", "export-graph.js"));

function runFfmpegCap(args, totalSec, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let ticks = 0, lastSec = 0, tail = "";
    const cap = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} }, opts.capMs || 180000);
    proc.stderr.on("data", (d) => {
      tail = (tail + d.toString()).slice(-1500);
      const m = d.toString().match(/time=(\d+):(\d{2}):(\d{2})\.(\d{2})/);
      if (m) { ticks++; lastSec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100; }
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(cap);
      resolve({ code, signal, wall: (Date.now() - t0) / 1000, ticks, lastSec, tail: tail.split("\n").slice(-3).join("\n") });
    });
  });
}
function probeDur(p) {
  return new Promise((resolve) => {
    const pr = spawn(FFMPEG, ["-hide_banner", "-i", p], { stdio: ["ignore", "pipe", "pipe"] });
    let s = "";
    pr.stderr.on("data", (d) => { s += d.toString(); });
    pr.on("exit", () => {
      const m = s.match(/Duration: (\d+):(\d+):(\d+):?(\d+)?/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0);
    });
  });
}
function gen(args) {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error("gen " + c))));
    p.stderr.on("data", (d) => process.stderr.write(d));
  });
}

const work = fs.mkdtempSync(path.join("/tmp", "matrix-"));
let failures = 0;
function check(name, ok, why) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + why}`);
  if (!ok) failures++;
}

(async () => {
  // ── shared media (45s scale — semantics identical to hours, full-scale
  // proven separately; keeps the matrix fast + disk-sane) ──
  const clip = path.join(work, "clip.mp4"); // video-only 45s (loop render shape)
  await gen(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "45",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k", "-an", "-y", clip]);
  const list = path.join(work, "list.txt");
  fs.writeFileSync(list, `file '${clip.replace(/'/g, "'\\''")}'`, "utf-8");
  const wav = path.join(work, "audio_0000.wav"); // 45s PCM
  await gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=45", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", wav]);
  const music20 = path.join(work, "music20.m4a"); // 20s (loop source)
  await gen(["-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:a", "aac", "-y", music20]);
  const music45 = path.join(work, "music45.m4a"); // 45s full length
  await gen(["-f", "lavfi", "-i", "sine=frequency=220:duration=45", "-c:a", "aac", "-y", music45]);
  const TOTAL = 45;

  const common = { concatListPath: list, outputPath: path.join(work, "out.mp4"), totalSec: TOTAL, audioKbps: 192 };
  const noDyn = (args) => {
    const s = args.join(" ");
    return !(/loudnorm=I=-16:TP=-1\.5:LRA=11(?!\w)/.test(s) && !/measured_I=/.test(s));
  };

  // ═ S1: legacy audioPath + musicLoop → -af + finite loop + -shortest ═
  {
    console.log("\n[S1] legacy single music, LOOP, -af chain");
    const args = G.buildConcatArgs({
      ...common, audioPath: music20,
      audio: { normalize: true, musicLoop: true, musicVolume: 0.9 },
      musicDurSec: 20, // v1.33.5: probed by the caller
      loudnorm: { music: { i: -22.1, lra: 5, tp: -12.3, thresh: -32.5, offset: 0.2 } },
    });
    const i = args.indexOf("-stream_loop");
    check("finite loop count", i >= 0 && /^\d+$/.test(String(args[i + 1])), `loop=${args[i + 1]}`);
    check("no dynamic loudnorm", noDyn(args), args.join(" ").slice(0, 120));
    const r = await runFfmpegCap(args, TOTAL);
    const dur = await probeDur(common.outputPath);
    check("terminates exit 0", r.code === 0, `code=${r.code} ${r.tail}`);
    check(`duration ${dur}s ≈ 45`, Math.abs(dur - 45) <= 1.5, `dur=${dur}`);
  }

  // ═ S2: musicClips loop=FALSE + clip WAV (amix, the modern path) ═
  {
    console.log("\n[S2] musicClips (no loop) + clip audio → amix graph");
    const args = G.buildConcatArgs({
      ...common,
      musicTracks: [{ path: music45, startMs: 0, volume: 0.8, loop: false, durationMs: 45000, durSec: 45 }],
      audio: { normalize: true, masterVolume: 1 },
      newAudioGraph: true,
      loudnorm: { clip: [{ i: -22.05, lra: 5, tp: -12, thresh: -32, offset: 0.1 }], music: null },
      audioFastGain: true, masterGainDb: 2.1,
      clipAudio: [{ wavPath: wav, startMs: 0, volume: 1 }],
    });
    check("no dynamic loudnorm", noDyn(args));
    const r = await runFfmpegCap(args, TOTAL);
    const dur = await probeDur(common.outputPath);
    check("terminates exit 0", r.code === 0, `code=${r.code} ${r.tail}`);
    check(`duration ${dur}s ≈ 45`, Math.abs(dur - 45) <= 1.5, `dur=${dur}`);
    check("ticks flowed", r.ticks >= 2, `ticks=${r.ticks} (45s mux finishes in <2s — the full-scale harness proves sustained tick flow at 4140s scale)`);
  }

  // ═ S3: normalize OFF — no loudnorm anywhere, loop music finite ═
  {
    console.log("\n[S3] normalize OFF + looping music clip");
    const args = G.buildConcatArgs({
      ...common,
      musicTracks: [{ path: music20, startMs: 5000, volume: 1, loop: true, durationMs: 20000, durSec: 20 }],
      audio: { normalize: false, masterVolume: 1, fadeInMs: 500, fadeOutMs: 800 },
      newAudioGraph: true,
      clipAudio: [],
    });
    check("no loudnorm at all", !args.join(" ").includes("loudnorm"));
    const i = args.indexOf("-stream_loop");
    check("finite loop count", i >= 0 && /^\d+$/.test(String(args[i + 1])), `loop=${args[i + 1]}`);
    const r = await runFfmpegCap(args, TOTAL);
    const dur = await probeDur(common.outputPath);
    check("terminates exit 0", r.code === 0, `code=${r.code} ${r.tail}`);
    check(`duration ${dur}s ≈ 45`, Math.abs(dur - 45) <= 1.5, `dur=${dur}`);
  }

  // ═ S4: ≥4 branches → MASTER-MIX path (render → windowed measure → mux) ═
  {
    console.log("\n[S4] 4-branch master-mix (render + windowed master measure + mux)");
    // 4 branches: 2 clip WAVs + 2 music clips
    const wav2 = path.join(work, "audio_0001.wav");
    await gen(["-f", "lavfi", "-i", "sine=frequency=550:duration=45", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", wav2]);
    const mixWav = path.join(work, "mixmaster.wav");
    const renderArgs = G.buildAudioMixRenderArgs({
      audioPath: null,
      musicTracks: [
        { path: music45, startMs: 0, volume: 0.8, loop: false, durationMs: 45000, durSec: 45 },
        { path: music20, startMs: 10000, volume: 0.5, loop: true, durationMs: 20000, durSec: 20 },
      ],
      audio: { normalize: true, masterVolume: 1 },
      totalSec: TOTAL,
      clipAudio: [
        { wavPath: wav, startMs: 0, volume: 1 },
        { wavPath: wav2, startMs: 2000, volume: 0.7 },
      ],
      mixWavPath: mixWav,
    });
    const i = renderArgs.indexOf("-stream_loop");
    check("mix render finite loop", i >= 0 && /^\d+$/.test(String(renderArgs[i + 1])), `loop=${renderArgs[i + 1]}`);
    const rr = await runFfmpegCap(renderArgs, TOTAL, { capMs: 60000 });
    check("mix render terminates", rr.code === 0, `code=${rr.code} ${rr.tail}`);
    // the WINDOWED master measure (the v1.33.5 policy: 45s ≤ 120s → whole)
    const measureT = Date.now();
    const mr = await runFfmpegCap(["-hide_banner", "-i", mixWav, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], 45, { capMs: 60000 });
    const measureWall = (Date.now() - measureT) / 1000;
    check(`master measure fast (${measureWall.toFixed(1)}s)`, mr.code === 0 && measureWall < 10);
    const masterMix = { wavPath: mixWav, loudnorm: { i: -18.2, lra: 4, tp: -10.5, thresh: -28.4, offset: 0.05 } };
    const args = G.buildConcatArgs({
      ...common, masterMix, audio: { normalize: true },
      totalSec: TOTAL,
    });
    check("masterMix mux measured (linear) loudnorm", args.join(" ").includes("measured_I=") && args.join(" ").includes("linear=true"));
    const r = await runFfmpegCap(args, TOTAL);
    const dur = await probeDur(common.outputPath);
    check("mux terminates", r.code === 0, `code=${r.code} ${r.tail}`);
    check(`duration ${dur}s ≈ 45`, Math.abs(dur - 45) <= 1.5, `dur=${dur}`);
  }

  // ═ S5: short 45s timeline window policy — measures whole (≤120s) ═
  {
    console.log("\n[S5] short-source window policy (45s → whole)");
    // slice the policy helpers straight out of main.js
    const src = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
    const a = src.indexOf("const MEASURE_WINDOW_MAX_SEC = 120");
    const b = src.indexOf("async function measureLoudnormContext", a);
    const helpers = src.slice(a, b);
    const f = new Function(helpers + "\nreturn { effectiveMeasureSec, shrinkMeasureWindow };")();
    check("45s → whole (45)", f.effectiveMeasureSec(45) === 45);
    check("120s → whole (120)", f.effectiveMeasureSec(120) === 120);
    check("121s → 90 window", f.effectiveMeasureSec(121) === 90);
    check("4140s → 90 window", f.effectiveMeasureSec(4140) === 90);
    const w45 = f.shrinkMeasureWindow(0, 45000);
    check("45s window: ss=0 dur=45000", w45.ssMs === 0 && w45.durMs === 45000, JSON.stringify(w45));
    const w4140 = f.shrinkMeasureWindow(0, 4140000);
    check("4140s window: ss≈828s dur=90s", Math.abs(w4140.ssMs - 828000) < 1500 && w4140.durMs === 90000, JSON.stringify(w4140));
    const wSmart = f.shrinkMeasureWindow(5000, 4140000); // a seeked 4140s window at +5s
    check("smart-path window keeps the seek base", Math.abs(wSmart.ssMs - 833000) < 1500, JSON.stringify(wSmart));
  }

  // ═ S6: music-only legacy, no loop, normalize ON with measured gain ═
  {
    console.log("\n[S6] legacy music-only, measured gain, no loop");
    const args = G.buildConcatArgs({
      ...common, audioPath: music45,
      audio: { normalize: true, musicLoop: false },
      loudnorm: { music: { i: -23.1, lra: 6, tp: -13, thresh: -33, offset: 0.4 } },
    });
    check("measured linear loudnorm", args.join(" ").includes("linear=true"));
    check("no -stream_loop", !args.includes("-stream_loop"));
    const r = await runFfmpegCap(args, TOTAL);
    const dur = await probeDur(common.outputPath);
    check("terminates exit 0", r.code === 0, `code=${r.code} ${r.tail}`);
    check(`duration ${dur}s ≈ 45`, Math.abs(dur - 45) <= 1.5, `dur=${dur}`);
  }

  // ═ S7: NULL measure + normalize ON → NO dynamic loudnorm anywhere ═
  {
    console.log("\n[S7] failed-measure fallback (null) — must skip, not go dynamic");
    const args = G.buildConcatArgs({
      ...common, audioPath: music45,
      audio: { normalize: true, musicLoop: true },
      musicDurSec: 45,
      loudnorm: { music: null }, // the v1.33.4 death-spiral entry
    });
    check("NO loudnorm filter (skipped)", !args.join(" ").includes("loudnorm"), args.join(" ").slice(0, 160));
    const r = await runFfmpegCap(args, TOTAL);
    check("terminates exit 0", r.code === 0, `code=${r.code} ${r.tail}`);
    const amix = G.buildConcatArgs({
      ...common,
      musicTracks: [{ path: music20, startMs: 0, volume: 1, loop: true, durationMs: 20000, durSec: 20 }],
      audio: { normalize: true },
      newAudioGraph: true,
      loudnorm: { clip: [null] }, // unmeasured clip branch
      clipAudio: [{ wavPath: wav, startMs: 0, volume: 1 }],
    });
    check("amix unmeasured branch skips loudnorm", !amix.join(" ").includes("loudnorm"), amix.join(" ").slice(0, 160));
  }

  console.log(`\n${failures === 0 ? "════ SCENARIO MATRIX: ALL PASSED ════" : `════ SCENARIO MATRIX: ${failures} FAILURE(S) ════`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
