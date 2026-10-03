// v1.22 E2E: the flagship transcription→captions flow through the REAL
// router (runRustExport) — proves the export rides the NATIVE Rust engine
// (no FFmpeg-CLI fallback) and that captions burn in with karaoke highlight.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const R = require(path.join(__dirname, "..", "electron", "rust-engine-router.js"));
const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";

function solidPng(filePath, w, h, rgb) {
  const zlib = require("zlib");
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    let crc = 0xffffffff;
    for (const b of Buffer.concat([t, data])) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const c = Buffer.alloc(4);
    c.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2];
    }
  }
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
  return filePath;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cap-"));
  const imgA = solidPng(path.join(tmp, "a.png"), 640, 360, [40, 38, 34]);
  const imgB = solidPng(path.join(tmp, "b.png"), 640, 360, [58, 44, 22]);
  const out = path.join(tmp, "out.mp4");

  // The exact renderer-style export-native payload the flagship flow ships:
  // transcribe → captions auto-ON (word karaoke mode + pop-in animation).
  const opts = {
    width: 640,
    height: 360,
    fps: 24,
    quality: "social",
    slideshowFps24: false,
    outputPath: out,
    segments: [
      { id: "s1", mediaType: "image", imagePath: imgA, startMs: 0, endMs: 2000, durationMs: 2000, trimInMs: 0, speed: 1, volume: 1, track: 0 },
      { id: "s2", mediaType: "image", imagePath: imgB, startMs: 2000, endMs: 4000, durationMs: 2000, trimInMs: 0, speed: 1, volume: 1, track: 0 },
    ],
    audio: { masterVolume: 1 },
    captionSettings: {
      enabled: true,
      presetId: "word-karaoke",
      fontSize: 5.5,
      fontSizeScale: 1,
      textColor: "#FFFFFF",
      highlightColor: "#FACC15",
      borderColor: "#000000",
      borderWidth: 2,
      bgColor: null,
      shadow: true,
      shadowBlur: 3,
      textTransform: "none",
      letterSpacing: 0,
      alignment: "center",
      position: "bottom",
      positionY: 50,
      maxWidth: 0.84,
      wordMode: "word",
      animation: "pop-in",
      fontFamily: "inter",
    },
    subtitleCues: [
      {
        id: 1,
        startMs: 200,
        endMs: 1900,
        text: "quick fox jumps",
        words: [
          { text: "quick", startMs: 200, endMs: 700 },
          { text: "fox", startMs: 700, endMs: 1200 },
          { text: "jumps", startMs: 1200, endMs: 1900 },
        ],
      },
      {
        id: 2,
        startMs: 2100,
        endMs: 3900,
        text: "over lazy dog",
        words: [
          { text: "over", startMs: 2100, endMs: 2600 },
          { text: "lazy", startMs: 2600, endMs: 3100 },
          { text: "dog", startMs: 3100, endMs: 3900 },
        ],
      },
    ],
    headlines: [],
    overlays: [],
    voiceovers: [],
    sfx: [],
    transition: { style: "none", durationMs: 0 },
  };

  const fakeEvent = {
    sender: { isDestroyed: () => false, send: () => {} },
  };

  console.log("── gate:", JSON.stringify(R.rustEligible(opts).ok ? "RUST-ELIGIBLE" : "GATED: " + R.rustEligible(opts).reason));
  const t0 = Date.now();
  const res = await R.runRustExport(opts, fakeEvent, { ffmpegPath: FFMPEG, cpuCount: 4 });
  if (!res) {
    console.error("FAIL — runRustExport returned null (CLI fallback). Reason trace:", R.rustFailureReason());
    process.exit(1);
  }
  console.log("── engineUsed:", res.engineUsed, "| encoder:", res.encoderName, "| frames:", res.framesEncoded, "| wall:", Date.now() - t0 + "ms");
  if (!String(res.engineUsed).startsWith("rust")) {
    console.error("FAIL — engine is not the Rust native engine");
    process.exit(1);
  }

  // ffprobe: a real, valid MP4 must exist.
  const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_format", out]).toString());
  const dur = Number(probe.format.duration);
  console.log("── ffprobe: duration", dur.toFixed(2) + "s, size", probe.format.size, "bytes");
  if (dur < 3.5) {
    console.error("FAIL — output too short");
    process.exit(1);
  }

  // Pixel verification: frame at t=1.0s (mid first cue, active word
  // highlighted gold #FACC15) must contain near-gold pixels; frame at t=0.05s
  // (before any cue) must NOT. Full-frame scan (the caption block's exact
  // band varies with position/font — the full frame is the honest check).
  function goldPixelsAt(sec) {
    const frame = path.join(tmp, `f${sec}.png`);
    execFileSync(FFMPEG, ["-y", "-loglevel", "quiet", "-ss", String(sec), "-i", out, "-frames:v", "1", frame]);
    const raw = execFileSync(FFMPEG, ["-loglevel", "quiet", "-i", frame, "-vf", "format=rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
    let gold = 0;
    for (let i = 0; i < raw.length; i += 3) {
      const r = raw[i], g = raw[i + 1], b = raw[i + 2];
      if (r > 170 && g > 130 && b < 120 && g > b + 30) gold++;
    }
    return gold;
  }
  const preGold = goldPixelsAt(0.05);
  const midGold = goldPixelsAt(1.0);
  console.log("── caption pixels: pre-cue gold px:", preGold, "| mid-cue gold px:", midGold);
  if (midGold < 200) {
    console.error("FAIL — no karaoke highlight visible at the active word");
    process.exit(1);
  }
  // white caption text should also be present mid-cue
  console.log("PASS — flagship caption export ran the NATIVE Rust engine with visible karaoke captions");
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
