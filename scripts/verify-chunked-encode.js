#!/usr/bin/env node
/**
 * v1.4.2 verification harness — CHUNKED PARALLEL ENCODE + probe-gated
 * hardware decode. Exercises the REAL export-graph.js / main.js helpers
 * against real ffmpeg runs (not mocks):
 *
 *   1. planChunkFrames: gating, frame-sum parity, boundary alignment
 *   2. buildClipArgs: legacy whole-clip argv (byte-shape) + chunk argv
 *      (µs seeks, chunk -t, fade gating first/last)
 *   3. REAL E2E: single-process encode vs 2-chunk encode + concat —
 *      frame-count parity + duration parity (the concat stays -c copy)
 *   4. REAL buildAssDocument windowing (main.js loaded through an electron
 *      stub): a cue crossing a chunk boundary renders partially in BOTH
 *      chunks — verified by burning captions into both encodes and
 *      measuring frame differences (PSNR) inside/outside the cue window
 *   5. probeHwDecode: returns a boolean on this box without throwing
 * Run: node scripts/verify-chunked-encode.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

// ── electron stub so main.js loads in plain node (test hook exports) ──
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: () => "/tmp/ffstub",
    getName: () => "FrameFuse",
    getVersion: () => "1.9.0",
    isReady: () => true,
    quit: () => {},
    // v1.8.0+ main.js appends force-GPU switches at require time.
    commandLine: { appendSwitch: () => {} },
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = {
        setWindowOpenHandler: () => ({ action: "deny" }),
        on: () => {},
        send: () => {},
      };
    }
    loadURL() {}
    loadFile() {}
    on() {}
    static getAllWindows() { return []; }
  },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: {},
  utilityProcess: { fork: () => ({}) },
};
const resolvedElectron = require.resolve("electron");
const stubModule = new Module(resolvedElectron, null);
stubModule.filename = resolvedElectron;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[resolvedElectron] = stubModule;

const ROOT = path.join(__dirname, "..");
const G = require(path.join(ROOT, "electron", "export-graph.js"));
const M = require(path.join(ROOT, "electron", "main.js"));
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));

const TMP = "/tmp/chkv";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
};

function run(args, opts = {}) {
  const r = spawnSync(FF, args, { encoding: "utf8", timeout: opts.timeout || 120000 });
  if (r.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")} → ${r.status}: ${(r.stderr || "").slice(-400)}`);
  }
  return (r.stdout || "") + (r.stderr || "");
}
function runErr(args) {
  const r = spawnSync(FF, args, { encoding: "utf8", timeout: 120000 });
  return (r.stdout || "") + (r.stderr || "");
}
function probeDur(p) {
  const o = runErr(["-hide_banner", "-i", p]);
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(o);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : -1;
}
function countFrames(p) {
  const o = runErr(["-hide_banner", "-i", p, "-map", "0:v:0", "-f", "null", "-"]);
  const ms = [...o.matchAll(/frame=\s*(\d+)/g)];
  return ms.length ? parseInt(ms[ms.length - 1][1], 10) : -1;
}

(async () => {

// ═══════════════════════════════════════════════════════════════════════
console.log("1) planChunkFrames — gating + frame-sum parity");
// ═══════════════════════════════════════════════════════════════════════
{
  ok("short clip (10s) → null", G.planChunkFrames(10000, 30, 60, 4) === null);
  ok("59s < target chunk → null", G.planChunkFrames(59000, 30, 60, 4) === null);
  const p = G.planChunkFrames(100000, 30, 60, 4);
  ok("100s → 2 chunks", !!p && p.length === 2, JSON.stringify(p));
  ok("frame sum = 3000", !!p && p.reduce((a, c) => a + c.frames, 0) === 3000);
  ok("boundary frame-aligned (chunk1.firstFrame = 1500)", !!p && p[1].firstFrame === 1500);
  ok("offsetMs = 50000 exactly", !!p && Math.abs(p[1].offsetMs - 50000) < 1e-9);
  ok("first/last flags", !!p && p[0].first && !p[0].last && !p[1].first && p[1].last);
  const p19 = G.planChunkFrames(1140000, 30, 60, 4); // the 19-minute case
  ok("19min → 4 chunks (pool width cap)", !!p19 && p19.length === 4, JSON.stringify(p19 && p19.length));
  ok("19min frame sum = 34200", !!p19 && p19.reduce((a, c) => a + c.frames, 0) === 34200);
  const odd = G.planChunkFrames((2999 / 30) * 1000, 30, 60, 4);
  ok("2999 frames split 1500+1499 (odd parity)", !!odd && odd.length === 2 && odd[0].frames === 1500 && odd[1].frames === 1499, JSON.stringify(odd));
  const capped = G.planChunkFrames(600000, 30, 60, 4);
  ok("10min → capped at 4 chunks, not 10", !!capped && capped.length === 4, JSON.stringify(capped && capped.length));
  ok("60fps boundary exact (100s → 3000+3000)", (() => {
    const q = G.planChunkFrames(100000, 60, 60, 4);
    return !!q && q[1].firstFrame === 3000 && Math.abs(q[1].offsetMs - 50000) < 1e-9;
  })());
}

// ═══════════════════════════════════════════════════════════════════════
console.log("2) buildClipArgs — legacy argv shape + chunk argv");
// ═══════════════════════════════════════════════════════════════════════
const SRC = path.join(TMP, "src.mp4");
const encArgs = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const baseSeg = { mediaType: "video", videoPath: SRC, durationMs: 100000, id: "seg1", startMs: 0, endMs: 100000 };
const commonCtx = {
  i: 0, segments: [baseSeg], fps: 30, width: 640, height: 360,
  kbEnabled: false, zoomMax: 1.06, globalDir: "in",
  transition: { style: "none" }, wm: null,
  anyAudio: false, segHasAudio: false, overlaySpecs: [],
  hwaccel: false, threads: 0,
};
{
  const legacy = G.buildClipArgs({ ...commonCtx, seg: { ...baseSeg, trimInMs: 5000 }, assSuffix: null, clipPath: "out.mp4", encArgs });
  const a = legacy.args;
  const ssIdx = a.indexOf("-ss");
  ok("legacy -ss keeps fmt3 ms format (\"5.000\")", ssIdx >= 0 && /^\d+\.\d{3}$/.test(a[ssIdx + 1]), a[ssIdx + 1]);
  const tIdx = a.indexOf("-t");
  ok("legacy -t = whole clip (\"100.000\")", tIdx >= 0 && a[tIdx + 1] === "100.000", a[tIdx + 1]);
  ok("legacy has NO -hwaccel", !a.includes("-hwaccel"));

  const plan = G.planChunkFrames(100000, 30, 60, 4);
  const c1 = G.buildClipArgs({
    ...commonCtx, seg: { ...baseSeg, trimInMs: 5000 }, assSuffix: null,
    clipPath: "chunk1.mp4", encArgs,
    chunk: { offsetMs: plan[1].offsetMs, durMs: plan[1].durMs, first: plan[1].first, last: plan[1].last },
  });
  const ss1 = c1.args[c1.args.indexOf("-ss") + 1];
  ok("chunk1 -ss µs precision = trimIn+offset (\"55.000000\")", ss1 === "55.000000", ss1);
  const t1 = c1.args[c1.args.indexOf("-t") + 1];
  ok("chunk1 -t = chunk duration (\"50.000\")", t1 === "50.000", t1);

  // fade gating: dip transition INTO seg i=1 (head fade) and OUT at the
  // next boundary (tail fade) — the plan produces both on the whole clip.
  const segs3 = [
    { ...baseSeg, id: "a", startMs: 0, endMs: 100000 },
    { ...baseSeg, id: "b", startMs: 100000, endMs: 200000 },
    { ...baseSeg, id: "c", startMs: 200000, endMs: 300000 },
  ];
  const fadeCtx = {
    ...commonCtx,
    i: 1,
    segments: segs3,
    transition: { style: "dip-black", durationMs: 600 },
    seg: segs3[1],
  };
  const whole = G.buildClipArgs({ ...fadeCtx, assSuffix: null, clipPath: "w.mp4", encArgs });
  const wholeVf = whole.args[whole.args.indexOf("-vf") + 1] || "";
  ok("whole-clip argv keeps BOTH fade in+out", wholeVf.includes("fade=t=in:st=0:d=0.600:color=black") && wholeVf.includes("fade=t=out:st=99.400:d=0.600:color=black"), wholeVf);
  const c0 = G.buildClipArgs({ ...fadeCtx, assSuffix: null, clipPath: "c0.mp4", encArgs, chunk: { offsetMs: 0, durMs: 50000, first: true, last: false } });
  const c0Vf = c0.args[c0.args.indexOf("-vf") + 1] || "";
  ok("chunk0 (first) keeps fade-in ONLY", c0Vf.includes("fade=t=in") && !c0Vf.includes("fade=t=out"), c0Vf);
  const cLast = G.buildClipArgs({ ...fadeCtx, assSuffix: null, clipPath: "cl.mp4", encArgs, chunk: { offsetMs: 50000, durMs: 50000, first: false, last: true } });
  const clVf = cLast.args[cLast.args.indexOf("-vf") + 1] || "";
  ok("chunk1 (last) keeps fade-out ONLY, st = chunkDur − d", clVf.includes("fade=t=out:st=49.400") && !clVf.includes("fade=t=in"), clVf);
  const cMid = G.buildClipArgs({ ...fadeCtx, assSuffix: null, clipPath: "cm.mp4", encArgs, chunk: { offsetMs: 50000, durMs: 50000, first: false, last: false } });
  const cmVf = cMid.args[cMid.args.indexOf("-vf") + 1] || "";
  ok("mid chunk carries NO fades", !cmVf.includes("fade="), cmVf);

  // speed: chunk offset × speed in the source seek
  const spd = G.buildClipArgs({
    ...commonCtx, seg: { ...baseSeg, trimInMs: 0, speed: 2 }, assSuffix: null,
    clipPath: "s.mp4", encArgs, chunk: { offsetMs: 50000, durMs: 50000, first: false, last: true },
  });
  const ssS = spd.args[spd.args.indexOf("-ss") + 1];
  const tIn = spd.args.indexOf("-t");
  // input -t (source window) comes BEFORE the output -t (last -t in argv)
  const outT = spd.args.lastIndexOf("-t");
  ok("speed=2 chunk: -ss = offset×2 (\"100.000000\")", ssS === "100.000000", ssS);
  ok("speed=2 chunk: input -t = dur×2 (\"100.000\")", spd.args[tIn + 1] === "100.000", spd.args[tIn + 1]);
  ok("speed=2 chunk: output -t = timeline dur (\"50.000\")", spd.args[outT + 1] === "50.000", spd.args[outT + 1]);
}

// ═══════════════════════════════════════════════════════════════════════
console.log("3) REAL E2E — single encode vs chunked+concat (frame parity)");
// ═══════════════════════════════════════════════════════════════════════
// testsrc2 varies per frame → dup/drop at a boundary would desync content.
run([
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=100",
  ...encArgs, "-y", SRC,
]);
const SINGLE = path.join(TMP, "single.mp4");
{
  const built = G.buildClipArgs({ ...commonCtx, seg: baseSeg, assSuffix: null, clipPath: SINGLE, encArgs });
  run(built.args);
}
const CHUNKED = path.join(TMP, "chunked.mp4");
{
  const plan = G.planChunkFrames(100000, 30, 60, 4);
  const chunkFiles = [];
  for (let k = 0; k < plan.length; k++) {
    const cp = path.join(TMP, `chunk_${k}.mp4`);
    chunkFiles.push(cp);
    const built = G.buildClipArgs({
      ...commonCtx, seg: baseSeg, assSuffix: null, clipPath: cp, encArgs,
      chunk: { offsetMs: plan[k].offsetMs, durMs: plan[k].durMs, first: plan[k].first, last: plan[k].last },
    });
    run(built.args);
  }
  const list = path.join(TMP, "concat.txt");
  fs.writeFileSync(list, chunkFiles.map((p) => `file '${p}'`).join("\n"), "utf8");
  run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-y", CHUNKED]);
}
{
  const nSingle = countFrames(SINGLE);
  const nChunked = countFrames(CHUNKED);
  ok("frame parity: single 3000 = chunked 3000", nSingle === 3000 && nChunked === 3000, `single=${nSingle} chunked=${nChunked}`);
  const dS = probeDur(SINGLE);
  const dC = probeDur(CHUNKED);
  ok("duration parity within 1 frame", Math.abs(dS - dC) < 1 / 30 + 0.001, `single=${dS} chunked=${dC}`);
  // clean decode of the concatenated file
  const dec = runErr(["-hide_banner", "-i", CHUNKED, "-map", "0:v:0", "-f", "null", "-"]);
  ok("concat decodes with no error", !/\berror\b|invalid data/i.test(dec));
}

// ═══════════════════════════════════════════════════════════════════════
console.log("4) REAL buildAssDocument — cue crossing a chunk boundary");
// ═══════════════════════════════════════════════════════════════════════
// Cue lives at 40–60s; the chunk boundary is 50s. The correct per-chunk
// windows render it [40,50) in chunk 0 and [50,60) in chunk 1 (chunk-local
// 0–10s each). Broken windowing (absolute times) would push chunk 1's
// caption to global 90–100s — the t=55 presence check below catches that.
{
  const cues = [{ startMs: 40000, endMs: 60000, text: "BOUNDARY TEST CAPTION" }];
  const cs = { enabled: true, presetId: "t", fontId: "t", position: "bottom", positionY: 50 };
  const docWhole = M.buildAssDocument(cues, cs, null, 640, 360, 0, 100000, 100000);
  ok("whole-window doc emits the cue", !!docWhole && /BOUNDARY TEST CAPTION/.test(docWhole));
  const d0 = M.buildAssDocument(cues, cs, null, 640, 360, 0, 50000, 50000);
  ok("chunk0 doc clamps cue to local 40–50s (window [0,50) ∩ cue [40,60))", !!d0 && /Dialogue: 0,0:00:40\.00,0:00:50\.00/.test(d0), (d0 || "").match(/Dialogue:.*/g));
  const d1 = M.buildAssDocument(cues, cs, null, 640, 360, 50000, 100000, 50000);
  ok("chunk1 doc clamps cue to 0–10s local", !!d1 && /Dialogue: 0,0:00:00.00,0:00:10.00/.test(d1), (d1 || "").match(/Dialogue:.*/g));

  const esc = (p) =>
    `subtitles=filename='${p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,")}'`;
  const assWhole = path.join(TMP, "cap_whole.ass");
  const ass0 = path.join(TMP, "cap_0.ass");
  const ass1 = path.join(TMP, "cap_1.ass");
  fs.writeFileSync(assWhole, docWhole, "utf8");
  fs.writeFileSync(ass0, d0, "utf8");
  fs.writeFileSync(ass1, d1, "utf8");

  // captioned single + captioned chunked (mirrors exactly what main.js does)
  const SINGLE_CAP = path.join(TMP, "single_cap.mp4");
  const builtSC = G.buildClipArgs({ ...commonCtx, seg: baseSeg, assSuffix: esc(assWhole), clipPath: SINGLE_CAP, encArgs });
  run(builtSC.args);
  const CHUNKED_CAP = path.join(TMP, "chunked_cap.mp4");
  {
    const plan = G.planChunkFrames(100000, 30, 60, 4);
    const chunkFiles = [];
    const assFiles = [ass0, ass1];
    for (let k = 0; k < plan.length; k++) {
      const cp = path.join(TMP, `capchunk_${k}.mp4`);
      chunkFiles.push(cp);
      const built = G.buildClipArgs({
        ...commonCtx, seg: baseSeg, assSuffix: esc(assFiles[k]), clipPath: cp, encArgs,
        chunk: { offsetMs: plan[k].offsetMs, durMs: plan[k].durMs, first: plan[k].first, last: plan[k].last },
      });
      run(built.args);
    }
    const list = path.join(TMP, "concat_cap.txt");
    fs.writeFileSync(list, chunkFiles.map((p) => `file '${p}'`).join("\n"), "utf8");
    run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-y", CHUNKED_CAP]);
  }

  // PSNR of captioned vs plain at t=45 (chunk 0, inside cue), t=55 (chunk 1,
  // inside cue), t=70 (outside cue). Low PSNR = caption burned.
  const psnrAt = (capFile, plainFile, t) => {
    const o = runErr([
      "-hide_banner", "-ss", String(t), "-i", capFile,
      "-ss", String(t), "-i", plainFile,
      "-lavfi", "psnr", "-frames:v", "1", "-f", "null", "-",
    ]);
    const m = /average:([\d.]+|inf)/.exec(o);
    return m ? (m[1] === "inf" ? Infinity : parseFloat(m[1])) : -1;
  };
  const p45 = psnrAt(CHUNKED_CAP, CHUNKED, 45);
  const p55 = psnrAt(CHUNKED_CAP, CHUNKED, 55);
  const p70 = psnrAt(CHUNKED_CAP, CHUNKED, 70);
  ok("caption PRESENT at t=45 (chunk 0 window, PSNR < 35)", p45 > 0 && p45 < 35, `psnr=${p45}`);
  ok("caption PRESENT at t=55 (chunk 1 window — THE boundary test, PSNR < 35)", p55 > 0 && p55 < 35, `psnr=${p55}`);
  ok("caption ABSENT at t=70 (PSNR > 35 or inf)", p70 > 35 || p70 === -1, `psnr=${p70}`);
  const nCap = countFrames(CHUNKED_CAP);
  ok("captioned chunked output keeps 3000 frames", nCap === 3000, `frames=${nCap}`);
  // cross-check: single-process captioned vs chunked captioned agree on visibility
  const s45 = psnrAt(SINGLE_CAP, SINGLE, 45);
  const s55 = psnrAt(SINGLE_CAP, SINGLE, 55);
  ok("single-process caption present at 45 AND 55 (baseline sanity)", s45 < 35 && s55 < 35, `45:${s45} 55:${s55}`);
}

// ═══════════════════════════════════════════════════════════════════════
console.log("5) probeHwDecode — safe boolean on this box");
// ═══════════════════════════════════════════════════════════════════════
{
  const r = await M.probeHwDecode(SRC);
  ok("probe returns a boolean without throwing", typeof r === "boolean", String(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
