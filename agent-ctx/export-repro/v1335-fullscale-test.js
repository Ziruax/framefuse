// agent-ctx/export-repro/v1335-fullscale-test.js — the v1.33.5 VERIFICATION:
// the user's exact scenario (10s loop video → 4140s timeline + 1h9m music +
// burned captions + the loop video's own extracted audio) through the REAL
// sliced code (runFfmpeg + measureLoudnessAsync + measureLoudnormContext
// + export-graph builders), asserting:
//   1. the windowed measure of the 4140s PCM WAV completes in < 30s (was:
//      killed at 255s → null → the dynamic-loudnorm death spiral);
//   2. audioFastGain engages (2 branches, measured) → NO master-mix render;
//   3. the amix mux terminates (finite -stream_loop N, not -1);
//   4. the mux argv carries NO dynamic loudnorm filter;
//   5. every phase band ticks (no frozen spans), ETA is phase-local;
//   6. the full chain completes and the output is 4140s.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

const ROOT = path.join(__dirname, "..", "..");
const FFMPEG = "/usr/bin/ffmpeg";
const TOTAL_SEC = 4140; // 1h9m
const W = 640, H = 360, FPS = 30;

// ── slice the REAL functions out of main.js (evaluated with stub deps) ──
const src = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
const rStart = src.indexOf("function runFfmpeg(args, totalSec, onTime, opts)");
const rEnd = src.indexOf("/** v1.33.3 (stuck-at-100% follow-up): VERIFY", rStart);
const runFfmpegSrc = src.slice(rStart, rEnd);
for (const marker of ["outTimeStallMs", "OUT-TIME STALL GUARD", "killProc(proc)", "lastOutTimeSec"]) {
  if (runFfmpegSrc.indexOf(marker) < 0) throw new Error(`sliced runFfmpeg lost the v1.33.5 ${marker} marker`);
}
const mStart = src.indexOf("const MEASURE_WINDOW_MAX_SEC = 120");
const mEnd = src.indexOf("async function measureLoudnormContext", mStart);
const measureSrc = src.slice(mStart, mEnd);
for (const marker of ["MEASURE_WINDOW_SEC = 90", "shrinkMeasureWindow", "effectiveMeasureSec", "resolveWindow"]) {
  if (measureSrc.indexOf(marker) < 0) throw new Error(`sliced measure block lost the v1.33.5 ${marker} marker`);
}
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
const probeCache = new Map();
const stubs = {
  fs, path, os, spawn, ffmpegPath: FFMPEG, activeProcs, tempDir: null,
  loudnessCacheKey: (p, win, st) => `${p}|${Math.round(st.mtimeMs)}|${st.size}|${win ? `${win.ssMs}|${win.durMs}` : "full"}`,
  loadLoudnessDisk: () => {}, pruneLoudnessDisk: () => {},
  scheduleLoudnessDiskSave: () => {}, flushLoudnessDisk: () => {},
  loudnessDisk: { entries: {} }, loudnessCacheStats: { hits: 0, misses: 0 },
  probeMediaAsync: (p) => {
    if (probeCache.has(p)) return probeCache.get(p);
    const j = probeDur(p).then((d) => ({ durationMs: d * 1000 }));
    probeCache.set(p, j);
    return j;
  },
  killProc: (proc) => { try { proc.kill("SIGKILL"); } catch (_) {} },
  console,
};
const factory = new Function(...Object.keys(stubs),
  measureSrc + "\n" + runFfmpegSrc + "\nreturn { runFfmpeg, measureLoudnessAsync, effectiveMeasureSec, shrinkMeasureWindow };");
const { runFfmpeg, measureLoudnessAsync, effectiveMeasureSec } = factory(...Object.values(stubs));

// the REAL graph builders
const G = require(path.join(ROOT, "electron", "export-graph.js"));

// ── progress recorder + phase tracker (mirrors the handler bands) ──
const events = [];
let exportPhase = "prepare";
const t0 = Date.now();
function sendProgress(pct, sec, eta) {
  events.push({ at: Math.round((Date.now() - t0) / 100) / 10, pct: Math.round(pct * 100) / 100, sec, eta, phase: exportPhase });
  if (process.env.VERBOSE) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${String(pct).padStart(6)}%  t=${sec != null ? sec.toFixed(0) : "?"}s  eta=${eta ?? "—"}  ${exportPhase}`);
}

const work = fs.mkdtempSync(path.join("/tmp", "v1335-"));
console.log(`[harness] ${work} · ${TOTAL_SEC}s timeline · sliced REAL v1.33.5 code`);

async function gen(tag, args) {
  const t = Date.now();
  await runFfmpeg(["-hide_banner", "-loglevel", "error", ...args], 0, null, { stallMs: 120000 });
  console.log(`[gen] ${tag} ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

(async () => {
  // ═══ the user's media ═══
  const loopSrc = path.join(work, "loop10.mp4"); // 10s video WITH audio
  await gen("10s loop source (video+audio)", [
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=10",
    "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "500k",
    "-c:a", "aac", "-b:a", "128k", "-shortest", "-y", loopSrc,
  ]);
  const music = path.join(work, "music.m4a"); // 1h9m music
  await gen("69-min music", [
    "-f", "lavfi", "-i", `sine=frequency=330:duration=${TOTAL_SEC},tremolo=f=2:d=0.3`,
    "-c:a", "aac", "-b:a", "128k", "-y", music,
  ]);

  // ═══ STEP 1: the loop encode (0-95% band) with burned captions ═══
  const ass = path.join(work, "captions.ass");
  {
    const cues = [];
    const ts = (sec) => {
      const h = String(Math.floor(sec / 3600));
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
      const ss = String(Math.floor(sec % 60)).padStart(2, "0");
      return `${h}:${m}:${ss}.00`;
    };
    for (let s = 0; s < TOTAL_SEC; s += 30) cues.push(`Dialogue: 0,${ts(s)},${ts(s + 4)},Default,,0,0,0,,v1.33.5 caption @ ${s}s`);
    fs.writeFileSync(ass, `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Alignment, MarginV\nStyle: Default,Arial,42,&H00FFFFFF,2,40\n\n[Events]\nFormat: Layer, Start, End, Style, Text\n${cues.join("\n")}\n`, "utf-8");
  }
  const clip = path.join(work, "clip_0000.mp4");
  {
    exportPhase = "video";
    const esc = ass.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    // render 690s once (wall-clock sane), concat 6× → 4140s — identical mux semantics
    await runFfmpeg(
      ["-hide_banner", "-stream_loop", "-1", "-i", loopSrc, "-t", "690",
       "-vf", `subtitles=filename='${esc}',scale=${W}:${H},setpts=PTS-STARTPTS`,
       "-r", String(FPS), "-c:v", "libx264", "-preset", "ultrafast",
       "-b:v", "500k", "-an", "-y", clip],
      690,
      (sec) => sendProgress(95 * Math.min(1, sec / 690), sec),
      { stallMs: 300000 },
    );
  }
  const list = path.join(work, "concat.txt");
  fs.writeFileSync(list, Array(6).fill(`file '${clip.replace(/'/g, "'\\''")}'`).join("\n"), "utf-8");
  const clipWav = path.join(work, "audio_0000.wav"); // the loop video's own audio, 4140s PCM
  await gen("loop clip audio extract (-stream_loop, -t 4140 → PCM WAV)", [
    "-stream_loop", "-1", "-i", loopSrc, "-vn", "-ar", "48000", "-ac", "2",
    "-c:a", "pcm_s16le", "-t", String(TOTAL_SEC), "-y", clipWav,
  ]);

  // ═══ STEP 2: clipDurProbe → actualTotalSec (the 95.4 phase) ═══
  exportPhase = "audio";
  sendProgress(95.4, TOTAL_SEC, undefined);
  const probedClip = await probeDur(clip);
  const probedWav = await probeDur(clipWav);
  const actualTotalSec = TOTAL_SEC; // (probe-accepted in production: 6×690=4140)
  console.log(`[probe] clip=${probedClip}s · wav=${probedWav}s`);

  // ═══ STEP 3: the WINDOWED measure (95.5→96) — THE ROOT-CAUSE FIX ═══
  const clipAudioJobs = [{ wavPath: clipWav, startMs: 0, volume: 1, durationMs: TOTAL_SEC * 1000 }];
  let measureWall = 0;
  const loudnormCtx = { clip: [null], music: null };
  {
    const mT = Date.now();
    let ticks = 0;
    const effSec = effectiveMeasureSec(TOTAL_SEC);
    if (effSec !== 90) throw new Error(`effectiveMeasureSec(4140) = ${effSec}, expected 90`);
    loudnormCtx.clip[0] = await measureLoudnessAsync(clipWav, null, Math.max(90000, Math.min(600000, 90000 + TOTAL_SEC * 40)), (sec) => {
      ticks++;
      exportPhase = "audio-measure";
      sendProgress(95.5 + 0.5 * Math.min(1, sec / effSec), sec);
    });
    measureWall = (Date.now() - mT) / 1000;
    console.log(`[measure] WINDOWED measure: ${measureWall.toFixed(1)}s · ${ticks} ticks · i=${loudnormCtx.clip[0] ? loudnormCtx.clip[0].i : "NULL"}`);
    if (measureWall > 30) throw new Error(`windowed measure took ${measureWall.toFixed(1)}s (>30s) — the constant-cost fix regressed`);
    if (!loudnormCtx.clip[0] || !Number.isFinite(loudnormCtx.clip[0].i)) throw new Error("measure returned null — death-spiral entry");
    if (ticks < 2) throw new Error("measure band froze (no live ticks)");
  }
  exportPhase = "audio";
  sendProgress(96, TOTAL_SEC, undefined);

  // ═══ STEP 4: audioFastGain decision (what production computes) ═══
  const musicCount = 1; // musicClips path (the user's audio)
  const branchCount = clipAudioJobs.length + musicCount;
  const clipsUsable = loudnormCtx.clip.every((m) => G.loudnessGainDb(m) != null);
  const musicUsable = true; // no legacy path measured
  const audioFastGain = branchCount > 0 && branchCount <= 3 && clipsUsable && musicUsable;
  console.log(`[fastpath] audioFastGain=${audioFastGain} (branches=${branchCount}, clipsUsable=${clipsUsable})`);
  if (!audioFastGain) throw new Error("audioFastGain=false — the master-mix death-spiral path would run");
  const est = G.estimateMixLoudnessDb({
    totalSec: actualTotalSec, audio: { normalize: true },
    clipAudio: clipAudioJobs.map((j, k) => ({ measure: loudnormCtx.clip[k], volume: j.volume, durationMs: j.durationMs })),
    music: null,
  });
  const masterGainDb = est ? Math.round((-16 - est.i) * 100) / 100 : null;
  console.log(`[fastpath] masterGainDb=${masterGainDb}`);

  // ═══ STEP 5: the MUX (97→99.7) via the REAL buildConcatArgs ═══
  // musicClips shape (the user's): loop=true? Test BOTH. Here: loop=true with
  // a KNOWN durationMs → finite -stream_loop N (not -1).
  const musicDurMs = (await probeDur(music)) * 1000;
  const out = path.join(work, "export.mp4");
  const expectedOutBytes = 6 * fs.statSync(clip).size + (192 * 1000 / 8) * TOTAL_SEC;
  const skipFaststart = expectedOutBytes > 1.5 * 1024 ** 3;
  const concatArgs = G.buildConcatArgs({
    concatListPath: list,
    musicTracks: [{ path: music, startMs: 0, volume: 0.8, loop: true, durationMs: musicDurMs, durSec: musicDurMs / 1000 }],
    audio: { normalize: true, masterVolume: 1 },
    outputPath: out,
    totalSec: actualTotalSec,
    loudnorm: loudnormCtx,
    audioFastGain,
    masterGainDb,
    audioKbps: 192,
    clipAudio: clipAudioJobs.map((j) => ({ wavPath: j.wavPath, startMs: j.startMs, volume: j.volume })),
    newAudioGraph: true,
    ...(skipFaststart ? { faststart: false } : {}),
  });
  // ── argv assertions ──
  const argv = concatArgs.join(" ");
  if (/loudnorm=I=-16:TP=-1\.5:LRA=11(?!\w)/.test(argv) && !/measured_I=/.test(argv)) {
    throw new Error("DYNAMIC loudnorm leaked into the mux (no measured_ params) — the slow-path fallback");
  }
  if (argv.includes("-stream_loop -1")) throw new Error("infinite -stream_loop -1 leaked into the mux");
  const loopN = concatArgs[concatArgs.indexOf("-stream_loop") + 1];
  if (!/^\d+$/.test(String(loopN))) throw new Error(`music loop count not finite: ${loopN}`);
  console.log(`[mux] argv OK · -stream_loop ${loopN} (finite) · no dynamic loudnorm · faststart ${skipFaststart ? "OFF (>1.5GB gate)" : "ON"}`);

  {
    const mT = Date.now();
    let finalizeFired = 0;
    const muxEta = { lastSec: 0, lastAt: 0, rate: 0 };
    let etaSamples = [];
    exportPhase = "mux";
    await runFfmpeg(concatArgs, actualTotalSec, (sec) => {
      const frac = 0.97 + 0.027 * Math.min(1, sec / actualTotalSec);
      const now = Date.now();
      if (sec > muxEta.lastSec + 0.5 && now > muxEta.lastAt) {
        const inst = (sec - muxEta.lastSec) / ((now - muxEta.lastAt) / 1000);
        if (inst > 0) muxEta.rate = muxEta.rate > 0 ? 0.3 * muxEta.rate + 0.7 * inst : inst;
        muxEta.lastSec = sec; muxEta.lastAt = now;
      }
      const etaSec = muxEta.rate > 0.01 ? Math.min(3600, Math.round(Math.max(0, actualTotalSec - sec) / muxEta.rate)) : undefined;
      if (etaSec != null) etaSamples.push(etaSec);
      sendProgress(frac * 100, sec, etaSec);
    }, {
      maxMs: Math.min(7200000, Math.max(600000, actualTotalSec * 750)),
      outTimeStallMs: 120000,
      onFinalize: () => { finalizeFired++; exportPhase = "finalize"; sendProgress(99.7, actualTotalSec, undefined); },
      onFinalizeProgress: (f) => sendProgress(99.7 + 0.27 * Math.min(0.95, Math.max(0, f)), actualTotalSec, undefined),
      finalizeEstimateMs: 15000,
      finalizeMs: skipFaststart ? 90000 : 300000,
      noFinalizeOnTotal: skipFaststart,
    });
    const muxWall = (Date.now() - mT) / 1000;
    console.log(`[mux] DONE ${muxWall.toFixed(1)}s · finalize x${finalizeFired} · out ${(fs.statSync(out).size / 1e6).toFixed(0)}MB · ETA samples ${etaSamples.length > 0 ? etaSamples.slice(0, 3).join(",") + " … " + etaSamples.slice(-2).join(",") : "none"}`);
  }
  exportPhase = "done";
  sendProgress(100, actualTotalSec, 0);

  // ═══ assertions on the whole run ═══
  const outDur = await probeDur(out);
  console.log(`[verify] output duration ${outDur}s (${TOTAL_SEC}s expected)`);
  if (Math.abs(outDur - TOTAL_SEC) > 3) throw new Error(`output duration ${outDur}s != ${TOTAL_SEC}s`);
  const muxEvents = events.filter((e) => e.phase === "mux");
  if (muxEvents.length < 10) throw new Error("mux band did not tick");
  const lastMuxEta = [...muxEvents].reverse().find((e) => e.eta != null);
  if (!lastMuxEta) throw new Error("no phase-local ETA during the mux (time estimation still wrong)");
  // 100% only at done:
  for (const e of events) {
    if (e.phase !== "done" && e.pct >= 99.99) throw new Error(`100% appeared during ${e.phase} @ ${e.at}s`);
  }
  console.log(`\n════ V1.33.5 FULL-SCALE VERIFICATION PASSED ════`);
  console.log(`  measure: ${measureWall.toFixed(1)}s (was: killed at 255s → null → dynamic loudnorm)`);
  console.log(`  fast path engaged: audioFastGain=${audioFastGain}, masterGainDb=${masterGainDb}`);
  console.log(`  mux: finite loop N=${loopN}, no dynamic loudnorm, terminated`);
  console.log(`  total wall: ${((Date.now() - t0) / 1000).toFixed(1)}s for a ${TOTAL_SEC}s (${(TOTAL_SEC / ((Date.now() - t0) / 1000)).toFixed(1)}× realtime) timeline`);
})().catch((e) => { console.error("\n!!!! FAILED:", e.message); process.exit(1); });
