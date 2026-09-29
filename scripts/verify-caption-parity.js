#!/usr/bin/env node
/**
 * scripts/verify-caption-parity.js — v1.14.6 root-cause fix:
 * "captions in preview are proper and appealing… after export captions are
 * not the same as preview."
 *
 * ROOT CAUSES (4, all fixed this round):
 *   C1  libass BorderStyle=3 fills the caption box with OUTLINECOLOUR (the
 *       shadow uses BackColour) — pre-v1.14.6 mapped the box color onto
 *       BackColour, so the exported box rendered as borderColor (usually
 *       black, FULLY opaque) instead of bgColor at bgAlpha. Empirically
 *       verified before the fix: red OutlineColour → red box, blue
 *       BackColour → blue shadow only.
 *   C2  bgPadding was ignored (Outline hard-0) → the exported box hugged
 *       the glyphs while the preview draws a padded box.
 *   C3  positionY / borderWidth / shadowBlur are 1080p-baseline px in the
 *       presets; the preview scales them by ch/1080, the ASS Style used the
 *       RAW values → wrong height/weight on 720p (fast mode) + non-1080.
 *   C4  Tier-3 machines ran optimizeAssForConstrainedCpu on the BURN-IN
 *       document (Outline/Shadow clamped to 2 px) → visibly thinner caption
 *       strokes than the preview on exactly the slow machines.
 *
 * P1-P5 unit — buildAssDocument Style math (box color/alpha, padding,
 *      marginV/outline/shadow scaling, WrapStyle 1, karaoke colors,
 *      headline scaling).
 * E1 e2e — burn a green box caption over a static image at 640×360:
 *      box pixels present, box EXTENDS past the text (padding), block
 *      bottom at height − positionY×h/1080, normalize OFF payload.
 * E2 e2e — 960×540: the bottom moves with hScale (C3).
 * E3 e2e — normalize ON control: result.audioNormalize === true.
 *
 * Run: node scripts/verify-caption-parity.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const TMP = "/tmp/ffcaptionparity";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ── electron stub ─────────────────────────────────────────────────────
const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "1.15.3",
    isReady: () => true,
    isPackaged: false,
    quit: () => {},
    commandLine: { appendSwitch: () => {} },
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { setWindowOpenHandler: () => ({ action: "deny" }), on: () => {}, send: () => {} };
    }
    loadURL() {}
    loadFile() {}
    on() {}
    static getAllWindows() { return []; }
  },
  ipcMain: {
    handle: (name, fn) => { handlers[name] = fn; },
    on: () => {},
  },
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

function run(bin, args, timeout = 120000) {
  const r = spawnSync(bin, args, { timeout });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr && r.stderr.toString().slice(0, 400)}`);
  return r;
}
const results = [];
function report(id, name, pass, detail) {
  console.log(`── ${id}: ${name} → ${pass ? "PASS" : "FAIL"}${detail ? `  (${detail})` : ""}`);
  results.push({ id, pass });
}

// ── P1-P5: unit — buildAssDocument / buildHeadlineEvents Style math ───
const mainExports = require(path.join(ROOT, "electron", "main.js"));
const { buildAssDocument, buildHeadlineEvents } = mainExports;

function styleOf(doc, styleName) {
  const m = (doc || "").split("\n").find((l) => l.startsWith(`Style: ${styleName},`));
  if (!m) return null;
  return m.split(",");
}

const csBox = {
  fontName: "DejaVu Sans", fontSize: 0.05, fontSizeScale: 1,
  textColor: "#FFFFFF", highlightColor: null, wordMode: "off", animation: "none",
  position: "bottom", positionY: 60, fontWeight: 700, fontStyle: "normal",
  bgColor: "#204080", bgAlpha: 0.8, bgPadding: 16,
  borderColor: "#000000", borderWidth: 4,
  shadow: true, shadowColor: "#000000", shadowBlur: 6,
  textTransform: "none", letterSpacing: 0, alignment: "center",
};
const cue = { startMs: 500, endMs: 2500, text: "BOX PARITY", words: [] };

{
  // P1 — 1080p box style: color+alpha on OutlineColour, padding on Outline,
  // marginV = positionY (hScale 1), shadow scaled, WrapStyle 1.
  const doc = buildAssDocument([cue], csBox, [], 1920, 1080, null, null, null);
  const f = styleOf(doc, "Default");
  const wrap1 = /WrapStyle: 1/.test(doc);
  report("P1", "1080p box: OutlineColour=bgColor+alpha, Outline=16, MarginV=60, WrapStyle 1",
    !!f && f[5] === "&H33804020" && f[15] === "3" && f[16] === "16" && f[17] === "6" && f[21] === "60" && wrap1,
    `outlineColour=${f && f[5]} bs=${f && f[15]} outline=${f && f[16]} shadow=${f && f[17]} marginV=${f && f[21]} wrap1=${wrap1}`);
}
{
  // P2 — 720p (fast mode): everything scales by 720/1080 like the preview.
  const doc = buildAssDocument([cue], csBox, [], 1280, 720, null, null, null);
  const f = styleOf(doc, "Default");
  report("P2", "720p: MarginV=40, Outline=11, Shadow=4, FontSize=36 (hScale 0.667)",
    !!f && f[21] === "40" && f[16] === "11" && f[17] === "4" && f[2] === "36",
    `marginV=${f && f[21]} outline=${f && f[16]} shadow=${f && f[17]} fontsize=${f && f[2]}`);
}
{
  // P3 — non-box preset: Outline = borderWidth × hScale (preview stroke
  // extent), BorderStyle 1, OutlineColour = borderColor.
  const csPlain = { ...csBox, bgColor: null, shadow: false };
  const d1080 = buildAssDocument([cue], csPlain, [], 1920, 1080, null, null, null);
  const d720 = buildAssDocument([cue], csPlain, [], 1280, 720, null, null, null);
  const f1 = styleOf(d1080, "Default");
  const f2 = styleOf(d720, "Default");
  report("P3", "non-box: Outline 4 @1080 → 3 @720 (borderWidth×hScale)",
    !!f1 && !!f2 && f1[15] === "1" && f1[16] === "4" && f2[16] === "3" && f1[5] === "&H00000000",
    `@1080 bs=${f1 && f1[15]} outline=${f1 && f1[16]} · @720 outline=${f2 && f2[16]}`);
}
{
  // P4 — karaoke \k: Primary = highlight, Secondary = text (unchanged law).
  const csK = { ...csBox, bgColor: null, shadow: false, wordMode: "word", highlightColor: "#FFD700" };
  const doc = buildAssDocument([{ ...cue, words: [{ text: "BOX", startMs: 500, endMs: 1500 }, { text: "PARITY", startMs: 1500, endMs: 2500 }] }], csK, [], 1920, 1080, null, null, null);
  const f = styleOf(doc, "Default");
  const karaokeLine = (doc || "").split("\n").find((l) => l.startsWith("Dialogue: 0,") && l.includes("\\k"));
  report("P4", "karaoke: Primary=highlight (&H0000D7FF), Secondary=text, \\k present",
    !!f && f[3] === "&H0000D7FF" && f[4] === "&H00FFFFFF" && !!karaokeLine,
    `primary=${f && f[3]} secondary=${f && f[4]} k=${!!karaokeLine}`);
}
{
  // P5 — headline scaling: outline/shadow scale with hScale.
  const items = [{ text: "HEADLINE", presetId: "impact", position: "bottom", animation: "fade", startMs: 0, endMs: 2000, sizeScale: 1 }];
  const h1080 = buildHeadlineEvents(items, 1920, 1080, 0, 3000, 3000);
  const h540 = buildHeadlineEvents(items, 960, 540, 0, 3000, 3000);
  const f1 = styleOf(`[V4+ Styles]\n${h1080.styleLines.join("\n")}`, "Headline");
  const f2 = styleOf(`[V4+ Styles]\n${h540.styleLines.join("\n")}`, "Headline");
  const ratio1 = f1 ? Number(f1[16]) : 0;
  const ratio2 = f2 ? Number(f2[16]) : 0;
  report("P5", "headline: outline scales 1080→540 (×0.5)",
    !!f1 && !!f2 && ratio1 > 0 && Math.abs(ratio2 / ratio1 - 0.5) < 0.11,
    `@1080 outline=${ratio1} shadow=${f1 && f1[17]} · @540 outline=${ratio2} shadow=${f2 && f2[17]}`);
}

// ── E1-E3: end-to-end burn through the REAL export-native handler ────
(async () => {
  const exportHandler = handlers["export-native"];
  if (!exportHandler) throw new Error("export-native handler not registered");

  const W0 = 640, H0 = 360;
  // NEUTRAL gray background — testsrc2 contains green/white pixels that
  // would poison the box/text detectors below.
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `color=c=0x808080:s=${W0}x${H0}:r=30`, "-frames:v", "1", `${TMP}/i0.png`]);
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=220:r=48000:d=30,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music.wav`]);

  const imgSeg = { id: "img0", fileName: "i0.png", mediaType: "image", imagePath: `${TMP}/i0.png`,
    startMs: 0, endMs: 6000, durationMs: 6000, track: 0, volume: 1, trimInMs: 0, speed: 1,
    sourceDurationMs: null, direction: "in" };

  async function runExport(outPath, W, H, cs, normalize) {
    const opts = {
      outputPath: outPath,
      fps: 30, width: W, height: H,
      bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
      slideshowFps24: false,
      kenBurns: { enabled: false, intensity: 50, direction: "in" },
      segments: [imgSeg],
      audioPath: `${TMP}/music.wav`,
      audio: { normalize: !!normalize, masterVolume: 1, fadeInMs: 0, fadeOutMs: 0, musicVolume: 0.8, musicStartMs: 0, musicLoop: true },
      captionSettings: cs, subtitleCues: [{ startMs: 500, endMs: 3500, text: "BOX PARITY", words: [] }],
      headlines: [], transition: null, watermark: null, overlays: [], sfx: [],
    };
    const fakeEvent = { sender: { isDestroyed: () => false, send: () => {} } };
    return exportHandler(fakeEvent, opts);
  }

  // Green box (bgColor #00B140, opaque, padded), shadow OFF to isolate the
  // box, DejaVu Sans (the sandbox's default libass family).
  const csGreen = {
    enabled: true, fontName: "DejaVu Sans", fontSize: 0.09, fontSizeScale: 1,
    textColor: "#FFFFFF", highlightColor: null, wordMode: "off", animation: "none",
    position: "bottom", positionY: 60, fontWeight: 700, fontStyle: "normal",
    bgColor: "#00B140", bgAlpha: 1, bgPadding: 14,
    borderColor: "#000000", borderWidth: 0,
    shadow: false, shadowColor: "#000000", shadowBlur: 0,
    textTransform: "none", letterSpacing: 0, alignment: "center",
  };

  function captionGeometry(p, tSec, W, H) {
    const out = `${TMP}/frame.raw`;
    fs.rmSync(out, { force: true });
    run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(tSec), "-i", p,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
    const buf = fs.readFileSync(out);
    let gMinX = 1e9, gMaxX = -1, gMaxY = -1, gCount = 0;
    let wMinX = 1e9, wMaxX = -1, wMaxY = -1, wCount = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        if (g > 90 && r < 90 && b < 110) { // box green
          gCount++;
          if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x; if (y > gMaxY) gMaxY = y;
        } else if (r > 200 && g > 200 && b > 200) { // text white
          wCount++;
          if (x < wMinX) wMinX = x; if (x > wMaxX) wMaxX = x; if (y > wMaxY) wMaxY = y;
        }
      }
    }
    return { gMinX, gMaxX, gMaxY, gCount, wMinX, wMaxX, wMaxY, wCount };
  }

  // E1 — 640×360: hScale = 1/3 → marginV = 20, padding = round(14/3) = 5.
  {
    const out = `${TMP}/e1.mp4`;
    const res = await runExport(out, 640, 360, csGreen, false);
    const geo = captionGeometry(out, 2.0, 640, 360);
    const boxVisible = geo.gCount > 200;
    const textInside = geo.wCount > 200 && geo.wMinX > geo.gMinX && geo.wMaxX < geo.gMaxX && geo.wMaxY <= geo.gMaxY + 2;
    // C3: block bottom = H − round(60×H/1080) = 360 − 20 = 340 (±6).
    const bottomOk = Math.abs(geo.gMaxY - (360 - 20)) <= 6;
    // C2: the box extends past the text on BOTH sides (padding).
    const padLeft = geo.wMinX - geo.gMinX;
    const padRight = geo.gMaxX - geo.wMaxX;
    const paddingOk = padLeft >= 3 && padRight >= 3;
    report("E1", "640×360 green box: visible, padded, bottom @ H−20, normalize OFF",
      boxVisible && textInside && bottomOk && paddingOk && res.audioNormalize === false,
      `box=${geo.gCount}px text=${geo.wCount}px pad=${padLeft}/${padRight} gMaxY=${geo.gMaxY} (want ≈340) bottomOk=${bottomOk} norm=${res.audioNormalize}`);
  }

  // E2 — 960×540: hScale = 0.5 → marginV = 30 → bottom ≈ 510 (C3 scales).
  {
    const out = `${TMP}/e2.mp4`;
    await runExport(out, 960, 540, csGreen, false);
    const geo = captionGeometry(out, 2.0, 960, 540);
    const bottomOk = Math.abs(geo.gMaxY - (540 - 30)) <= 7;
    report("E2", "960×540: bottom moves with hScale (H−30 = 510)",
      geo.gCount > 200 && bottomOk, `box=${geo.gCount}px gMaxY=${geo.gMaxY} (want ≈510) bottomOk=${bottomOk}`);
  }

  // E3 — normalize ON control: the payload must SAY it ran.
  {
    const out = `${TMP}/e3.mp4`;
    const res = await runExport(out, 640, 360, { ...csGreen, bgColor: null, borderWidth: 3 }, true);
    report("E3", "normalize ON control: result.audioNormalize === true", res.audioNormalize === true,
      `norm=${res.audioNormalize} fastGain=${!!res.audioFastGain}`);
  }

  const fails = results.filter((r) => !r.pass);
  console.log("");
  console.log(`RESULT: ${results.length - fails.length}/${results.length} PASS${fails.length ? " — FAILURES: " + fails.map((f) => f.id).join(", ") : ""}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
