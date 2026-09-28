#!/usr/bin/env node
/**
 * scripts/verify-overlay-singledecode.js — v1.14.6 pipeline audit fix:
 * "if not used don't decode it."
 *
 * IMAGE overlays rode `-loop 1 -t <overlap>` inputs: the image2 demuxer
 * RE-DECODED the full-resolution overlay still once per OUTPUT FRAME for
 * the overlay's whole window (logos/stickers burned a full-res decode on
 * every single frame they were visible on — the same waste class the base
 * lane shed earlier in v1.14.6).
 *
 * FIX: one-frame input (no -loop/-t); the overlay CHAIN runs
 * scale/chroma/format ONCE on that frame, then `loop` duplicates it
 * (ref-counted frame copies — alpha-safe, zero per-frame pixel work) and
 * `setpts=N/(25*TB)+a/TB` rebuilds the EXACT 25 fps grid + window shift
 * the old image2 loop produced, so the framesync contract is unchanged.
 *
 * U1 unit — buildOverlayImageInputArgs: bare ["-i", path] (no -loop/-t).
 * U2 unit — buildOverlayChain imgLoop: `loop=…:size=1` + N/(25*TB) retime;
 *           absent imgLoop (video overlays): the old setpts=PTS+ form.
 * U3 unit — padOverlayInputWindows bumps imgLoop for clipped windows only.
 * E1 e2e  — RAW A/B: old `-loop 1 -t 3` input vs new single-decode chain
 *           compositing the same PNG over a 4 s moving base: rawvideo
 *           outputs BYTE-IDENTICAL (md5) + same frame count.
 * B1 bench — informational timing ratio.
 *
 * Run: node scripts/verify-overlay-singledecode.js
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = "/usr/bin/ffmpeg";
const TMP = "/tmp/ffovlsingledecode";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

function run(bin, args, timeout = 120000) {
  const r = spawnSync(bin, args, { timeout });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr && r.stderr.toString().slice(0, 500)}`);
  return r;
}

const results = [];
function report(id, name, pass, detail) {
  console.log(`── ${id}: ${name} → ${pass ? "PASS" : "FAIL"}${detail ? `  (${detail})` : ""}`);
  results.push({ id, pass });
}

const G = require(path.join(ROOT, "electron", "export-graph.js"));

// ── U1: input argv ─────────────────────────────────────────────────────
{
  const args = G.buildOverlayImageInputArgs({ durMs: 3000, path: "/x/y.png" });
  report("U1", "image overlay input = bare -i (no -loop, no -t)",
    Array.isArray(args) && args.length === 2 && args[0] === "-i" && args[1] === "/x/y.png",
    JSON.stringify(args));
}

// ── U2: chain form ─────────────────────────────────────────────────────
{
  const withLoop = G.buildOverlayChain({
    inputIdx: 3, dw: 160, dh: 90, chroma: null, a: 1.0, fps: null, imgLoop: 75,
  });
  const loopOk =
    withLoop === "[3:v]scale=160:90,format=rgba,loop=loop=75:size=1,setpts=N/(25*TB)+1.000/TB[ovl3]";
  const videoForm = G.buildOverlayChain({
    inputIdx: 2, dw: 160, dh: 90, chroma: null, a: 0.5, fps: 30,
  });
  const videoOk = videoForm === "[2:v]fps=30,scale=160:90,format=rgba,setpts=PTS+0.500/TB[ovl2]";
  const chromaForm = G.buildOverlayChain({
    inputIdx: 4, dw: 160, dh: 90, a: 0, fps: null, imgLoop: 9,
    chroma: { color: "#00FF00", similarity: 0.3, blend: 0.1, spill: 0.6, mode: "chroma" },
  });
  const chromaOk =
    chromaForm.includes("chromakey=") && chromaForm.includes("despill=") &&
    chromaForm.includes("loop=loop=9:size=1") && chromaForm.includes("setpts=N/(25*TB)+0.000/TB");
  report("U2", "chain: imgLoop → loop+retime; video/chroma unchanged",
    loopOk && videoOk && chromaOk,
    `loop=${loopOk} video=${videoOk} chroma=${chromaOk}`);
}

// ── U3: padding ────────────────────────────────────────────────────────
{
  const specs = [
    { clippedEnd: true, imgLoop: 75, a: 1, b: 4, inputArgs: ["-i", "/x.png"] },
    { clippedEnd: false, imgLoop: 50, a: 1, b: 3, inputArgs: ["-i", "/y.png"] },
    { clippedEnd: true, a: 1, b: 4, inputArgs: ["-ss", "0.5", "-t", "3.0", "-i", "/v.mp4"] },
  ];
  const SP = require(path.join(ROOT, "electron", "export-singlepass.js"));
  SP.padOverlayInputWindows(specs, 4000, 120);
  const pad1 = specs[0].imgLoop === 75 + 3; // 120 ms @ 25 fps → +3
  const untouched = specs[1].imgLoop === 50;
  const videoT = specs[2].inputArgs[3] === "3.120";
  report("U3", "pad: clipped image +3 loops, unclipped untouched, video -t +0.120",
    pad1 && untouched && videoT,
    `imgLoop=${specs[0].imgLoop} unclipped=${specs[1].imgLoop} t=${specs[2].inputArgs[3]}`);
}

// ── E1: RAW A/B byte parity ────────────────────────────────────────────
{
  const W = 640, H = 360, FPS = 30;
  // Overlay PNG: 320×180 red (opaque; alpha path is exercised by the
  // format=rgba chain regardless).
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=red:s=320x180:d=1", "-frames:v", "1", `${TMP}/ov.png`]);

  const base = ["-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}:d=4`];
  const overlayOld = ["-loop", "1", "-t", "3.000", "-i", `${TMP}/ov.png`];
  const overlayNew = ["-i", `${TMP}/ov.png`];
  const chainOld =
    `[1:v]scale=160:90,format=rgba,setpts=PTS+1.000/TB[ovl];` +
    `[0:v][ovl]overlay=40:40:enable='between(t,1.000,3.500)':eof_action=pass:shortest=0[v]`;
  const chainNew =
    `[1:v]scale=160:90,format=rgba,loop=loop=75:size=1,setpts=N/(25*TB)+1.000/TB[ovl];` +
    `[0:v][ovl]overlay=40:40:enable='between(t,1.000,3.500)':eof_action=pass:shortest=0[v]`;
  const enc = ["-map", "[v]", "-pix_fmt", "yuv420p", "-f", "rawvideo"];

  run(FF, ["-y", "-hide_banner", "-loglevel", "error", ...base, ...overlayOld,
    "-filter_complex", chainOld, ...enc, `${TMP}/old.raw`]);
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", ...base, ...overlayNew,
    "-filter_complex", chainNew, ...enc, `${TMP}/new.raw`]);

  const oldBuf = fs.readFileSync(`${TMP}/old.raw`);
  const newBuf = fs.readFileSync(`${TMP}/new.raw`);
  const FRAME_BYTES = W * H * 2 - W * H / 2; // yuv420p: 12 bits/px
  const sameBytes = oldBuf.equals(newBuf);
  const oldFrames = oldBuf.length / FRAME_BYTES;
  const newFrames = newBuf.length / FRAME_BYTES;
  const framesOk = oldFrames === 120 && newFrames === 120;
  report("E1", "A/B composite: rawvideo outputs byte-identical (md5) + 120 frames",
    sameBytes && framesOk,
    `bytes=${oldBuf.length}/${newBuf.length} frames=${oldFrames}/${newFrames} identical=${sameBytes}`);
}

// ── B1: informational timing ───────────────────────────────────────────
{
  const t = (args) => {
    const t0 = Date.now();
    run(FF, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], 300000);
    return Date.now() - t0;
  };
  // A 12 MP sticker for a 60 s window — the loop-decode tax at full res.
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "testsrc2=size=4000x3000:duration=1", "-frames:v", "1", "-q:v", "2", `${TMP}/big-ov.jpg`]);
  const common = ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=10"];
  const enc = ["-map", "[v]", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-f", "null", "-"];
  const aMs = t([...common, "-loop", "1", "-t", "10", "-i", `${TMP}/big-ov.jpg`,
    "-filter_complex", `[1:v]scale=160:90,format=rgba,setpts=PTS+0.000/TB[ovl];[0:v][ovl]overlay=40:40:eof_action=pass:shortest=0[v]`, ...enc]);
  const bMs = t([...common, "-i", `${TMP}/big-ov.jpg`,
    "-filter_complex", `[1:v]scale=160:90,format=rgba,loop=loop=250:size=1,setpts=N/(25*TB)+0.000/TB[ovl];[0:v][ovl]overlay=40:40:eof_action=pass:shortest=0[v]`, ...enc]);
  console.log(`── B1: A/B overlay loop-decode ${aMs} ms vs single-decode ${bMs} ms → ${(aMs / Math.max(1, bMs)).toFixed(2)}× (informational)`);
}

const fails = results.filter((r) => !r.pass);
console.log("");
console.log(`RESULT: ${results.length - fails.length}/${results.length} PASS${fails.length ? " — FAILURES: " + fails.map((f) => f.id).join(", ") : ""}`);
process.exit(fails.length ? 1 : 0);
