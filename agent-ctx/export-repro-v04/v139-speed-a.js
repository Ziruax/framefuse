// v1.33.9 SPEED verification: the user's exact scenario shapes with REAL files:
//   A) 1 image held to the timeline end + 10-min audio (static-image dedup)
//   B) 10s video looped to 10 min (static-loop packet dedup)
//   C) 1 image + 10-min audio + burned-in captions (dedup veto case — honest
//      per-frame work; measures the worst case)
// Measures wall time + output duration + frames + dedup label.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");

const RUST = require("../../electron/rust-engine-router.js");
const ENGINE = require("../../rust-engine");

const AUDIO_MS = 600000; // 10 minutes
const work = fs.mkdtempSync(path.join(os.tmpdir(), "v139spd-"));
const imgPath = path.join(work, "still.jpg");
fs.copyFileSync(path.join(__dirname, "..", "..", "public", "samples", "001__Beat_1_0s_In_the_MASTER_ENVIRONMENT_NARVARTE_HOUSE_DINING_ROOM_PROTAG.jpg"), imgPath);
const audioPath = path.join(__dirname, "vo10min.mp3");
const loopVideo = path.join(__dirname, "test10s.mp4");

function imageTimeline(withCaptions) {
  const seg = {
    id: "s1", mediaType: "image", path: imgPath,
    startMs: 0, endMs: AUDIO_MS, durationMs: AUDIO_MS, trimInMs: 0,
    sourceDurationMs: null, speed: 1, track: 0, volume: 1,
    sourceWidth: null, sourceHeight: null, kenBurns: null, geometry: null, chroma: null,
    opacity: 1, overlayLoop: false, loopSrc: false, hasAudio: false,
    transHeadMs: 0, transHeadStyle: "none", transTailMs: 0, transTailStyle: "none",
    bookendStartMs: 0, bookendEndMs: 0,
  };
  const tl = {
    version: 1, width: 1280, height: 720, fps: 30,
    sampleRate: 48000, audioChannels: 2, bitrateMbps: 0, crf: 21,
    quality: "social", audioKbps: 192, backgroundColor: "#000000",
    totalMs: AUDIO_MS, fadeInMs: 0, fadeOutMs: 0, normalizeAudio: false,
    audioTargetLufs: -16,
    fonts: { sans: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" },
    segments: [seg],
    music: { path: audioPath, volume: 1, startMs: 0, loopTrack: false, normalizeSrc: false },
    extraAudio: [], texts: [], watermark: null, captions: null, kinetic: null,
  };
  if (withCaptions) {
    tl.captions = {
      fontKey: "sans", fontSizePx: 42, textColor: "#FFFFFF", highlightColor: null,
      borderColor: "#000000", borderWidthPx: 4, bgColor: null, bgAlpha: 1, bgPaddingPx: 12,
      shadow: true, shadowColor: "#000000", shadowPx: 3, textTransform: "none",
      letterSpacingPx: 0, alignment: "center", position: "bottom", positionY: 50,
      maxWidthFrac: 0.84, wordMode: "off", animation: "none",
      cues: [
        { startMs: 500, endMs: 9000, text: "hello world one", words: [] },
        { startMs: 12000, endMs: 20000, text: "hello world two", words: [] },
      ],
    };
  }
  return tl;
}

function videoLoopTimeline() {
  return {
    version: 1, width: 1280, height: 720, fps: 30,
    sampleRate: 48000, audioChannels: 2, bitrateMbps: 0, crf: 21,
    quality: "social", audioKbps: 192, backgroundColor: "#000000",
    totalMs: AUDIO_MS, fadeInMs: 0, fadeOutMs: 0, normalizeAudio: false,
    audioTargetLufs: -16,
    fonts: { sans: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" },
    segments: [{
      id: "s1", mediaType: "video", path: loopVideo,
      startMs: 0, endMs: AUDIO_MS, durationMs: AUDIO_MS, trimInMs: 0,
      sourceDurationMs: 10000, speed: 1, track: 0, volume: 1,
      sourceWidth: null, sourceHeight: null, kenBurns: null, geometry: null, chroma: null,
      opacity: 1, overlayLoop: false, loopSrc: true, hasAudio: true,
      transHeadMs: 0, transHeadStyle: "none", transTailMs: 0, transTailStyle: "none",
      bookendStartMs: 0, bookendEndMs: 0,
    }],
    music: { path: audioPath, volume: 1, startMs: 0, loopTrack: false, normalizeSrc: false },
    extraAudio: [], texts: [], watermark: null, captions: null, kinetic: null,
  };
}

async function run(label, tl) {
  const out = path.join(work, label.replace(/\W+/g, "_") + ".mp4");
  const t0 = Date.now();
  let lastPct = 0;
  try {
    const res = await ENGINE.exportVideo(JSON.stringify(tl), out, "", (e, p) => {
      if (p && p.percent - lastPct >= 25) { lastPct = p.percent; }
    });
    const durSec = Date.now() - t0;
    const probe = await new Promise((resolve) => {
      require("child_process").exec(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${out}"`,
        (err, stdout) => resolve(err ? "probe-err" : stdout.trim()),
      );
    });
    console.log(`${label}: ${(durSec / 1000).toFixed(1)}s wall, frames=${res.frames}, dedup=${res.dedup || "none"}, outDur=${probe}s, size=${(fs.statSync(out).size / 1e6).toFixed(1)}MB, ${res.engineUsed}`);
  } catch (err) {
    console.log(`${label}: FAILED — ${err.message}`);
  }
}

(async () => { await run("A-image-hold+10min-audio", imageTimeline(false)); })();
