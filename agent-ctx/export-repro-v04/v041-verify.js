// v0.4.1 verification:
//   G) single static image + 20-min VO → NEW static-image dedup: near-instant
//      video phase, exact duration, dedup label in the result
//   H) 60s NON-loop video (1800 live frames, no dedup) → the ETA carry-forward:
//      after the first ~3 s rate window, EVERY video-phase event must carry
//      etaMs > 0 (the old engine emitted it on ~1-in-24 events only)
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const engine = require("/home/z/my-project/rust-engine/framefuse-engine.linux-x64.node");

const DIR = __dirname;
const IMG = path.join(DIR, "testimg.png");
const V60 = path.join(DIR, "test60s.mp4");
const VO20 = path.join(DIR, "vo20min.mp3");

function seg(o) {
  return { id: "s", path: "", mediaType: "video", startMs: 0, endMs: 0, durationMs: 0, trimInMs: 0, speed: 1, track: 0, volume: 1, opacity: 1, hasAudio: false, loopSrc: false, ...o };
}
const base = (over = {}) => ({
  version: 1, width: 640, height: 360, fps: 30, sampleRate: 48000, audioChannels: 2,
  crf: 23, quality: "social", audioKbps: 128, backgroundColor: "#000000",
  totalMs: 0, normalizeAudio: false, fonts: {}, segments: [], music: null,
  extraAudio: [], texts: [], watermark: null, captions: null, kinetic: null, ...over,
});

const scenarios = {
  "G-static-image-20min": {
    tl: base({
      totalMs: 1200000,
      segments: [seg({ path: IMG, mediaType: "image", endMs: 1200000, durationMs: 1200000 })],
      extraAudio: [{ path: VO20, startMs: 0, volume: 1 }],
    }),
    out: "scG.mp4", wantDur: 1200, wantFrames: 36000, wantDedup: true,
  },
  "H-nodedup-60s-eta": {
    tl: base({
      totalMs: 60000,
      segments: [seg({ path: V60, endMs: 60000, durationMs: 60000, sourceDurationMs: 60000 })],
      extraAudio: [],
    }),
    out: "scH.mp4", wantDur: 60, wantFrames: 1800, wantDedup: false,
  },
};

(async () => {
  let failures = 0;
  for (const [name, sc] of Object.entries(scenarios)) {
    const OUT = path.join(DIR, sc.out);
    for (const f of [OUT, OUT + ".ffmix.tmp"]) { try { fs.unlinkSync(f); } catch {} }
    console.log(`\n━━━ ${name} ━━━`);
    let videoEvents = 0, videoEventsWithEta = 0, lastPct = -1, firstEtaIdx = -1, gapsAfterFirstEta = 0;
    const t0 = Date.now();
    try {
      const res = await engine.exportVideo(JSON.stringify(sc.tl), OUT, "", (e, p) => {
        if (e || !p || p.phase !== "video") return;
        videoEvents++;
        if (p.etaMs > 0) {
          videoEventsWithEta++;
          if (firstEtaIdx < 0) firstEtaIdx = videoEvents;
        } else if (firstEtaIdx >= 0) {
          gapsAfterFirstEta++;
        }
        if (Math.abs(p.percent - lastPct) > 20) {
          lastPct = p.percent;
          console.log(`  video ${p.percent.toFixed(0)}%${p.etaMs > 0 ? " eta=" + (p.etaMs / 1000).toFixed(1) + "s" : " (no eta)"}`);
        }
      });
      const wall = (Date.now() - t0) / 1000;
      const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT], { encoding: "utf8" }).trim());
      const frames = parseInt(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", OUT], { encoding: "utf8" }).trim() || "0", 10);
      const hasDedup = !!res.dedup;
      console.log(`  wall=${wall.toFixed(1)}s frames=${frames}/${sc.wantFrames} dur=${dur.toFixed(1)}/${sc.wantDur}s dedup=${res.dedup || "none"}`);
      const etaRatio = videoEvents > 0 ? videoEventsWithEta / videoEvents : 0;
      console.log(`  video events=${videoEvents}, with-eta=${videoEventsWithEta} (${(etaRatio * 100).toFixed(0)}%), first-eta-at-event=${firstEtaIdx}, gaps-after-first-eta=${gapsAfterFirstEta}`);

      const okDur = Math.abs(dur - sc.wantDur) < 0.5;
      const okFrames = frames === sc.wantFrames;
      const okDedup = hasDedup === sc.wantDedup;
      let okEta = true;
      if (name.startsWith("H")) {
        // CONTRACT: the first ~3 s are the rate warm-up (no ETA yet —
        // honest). Once the FIRST ETA appears, EVERY subsequent video
        // event must carry one (the carry-forward; the old engine emitted
        // it on ~1-in-24 events so the UI flashed "estimating…").
        okEta = firstEtaIdx > 0 && gapsAfterFirstEta === 0;
      }
      const pass = okDur && okFrames && okDedup && okEta;
      console.log(`  CHECKS: ${pass ? "PASS" : "FAIL"} (dur:${okDur} frames:${okFrames} dedup:${okDedup} eta:${okEta})`);
      if (!pass) failures++;
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
      failures++;
    }
  }
  console.log(`\n════ RESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} ════`);
  process.exit(failures === 0 ? 0 : 1);
})();
