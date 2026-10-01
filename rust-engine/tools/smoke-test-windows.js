// FrameFuse Rust engine — Windows CI smoke test (GitHub Actions windows-latest).
//
// A small variant of tools/smoke-test.js with:
//   * media generation built in (ffmpeg CLI fixtures into FF_TEST_MEDIA_DIR),
//   * Windows paths by default (C:\Windows\Fonts\arialbd.ttf, staged
//     resources/ffmpeg/win/ffmpeg.exe + win/dll shared libs),
//   * hard assertions (engine loads → exportVideo resolves → output exists →
//     ffprobe reports h264 + ~150 frames + aac audio),
//   * engine-info.json emitted for the CI artifact upload.
//
// Everything is env-overridable, so the SAME script also runs on the Linux
// dev sandbox (system ffmpeg + system libav 61/61/59/8/5) for pre-CI
// verification:
//   node rust-engine/tools/smoke-test-windows.js
//
// Env knobs (all optional):
//   FF_TEST_FFMPEG        ffmpeg binary   (win default resources/ffmpeg/win/ffmpeg.exe)
//   FF_TEST_FFPROBE       ffprobe binary  (win default resources/ffmpeg/win/ffprobe.exe)
//   FF_ENGINE_FFMPEG_DIR  engine ffmpeg_dir — the DLL dir passed as exportVideo's
//                         3rd arg (win default resources/ffmpeg/win/dll; non-win
//                         default "" = system loader path)
//   FF_TEST_MEDIA_DIR     fixture/output dir (default os.tmpdir()/fftest)
//   FF_TEST_FONT          sans font path (win default C:\Windows\Fonts\arialbd.ttf)
//   FF_ENGINE_INFO_OUT    engine-info.json path (default rust-engine/engine-info.json)
//   FF_TEST_REGEN=1       force fixture regeneration
//
// Expected on a GPU-less CI runner: encoder ladder h264_nvenc → h264_qsv →
// h264_amf all fail to OPEN (no physical GPU) → libx264; wgpu may init on the
// WARP software adapter (engineUsed "rust-gpu") or fall back ("rust-cpu") —
// both are accepted. A real GPU machine may report h264_nvenc/qsv/amf — any
// h264 encoder name is accepted.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const IS_WIN = process.platform === "win32";

// ── env resolution ───────────────────────────────────────────────────────────
function resolveBin(envVar, winDefault, nixDefault) {
  const v = process.env[envVar] || (IS_WIN ? winDefault : nixDefault);
  if (path.isAbsolute(v)) return v;
  if (v.includes("/") || v.includes("\\")) return path.resolve(ROOT, v); // repo-relative
  return v; // bare command name → PATH lookup at spawn time
}

/** existsSync-style check that ALSO resolves bare command names via PATH. */
function binExists(p) {
  if (p.includes("/") || p.includes("\\") || path.isAbsolute(p)) return fs.existsSync(p);
  const r = spawnSync(p, ["-version"], { timeout: 15000 });
  return !r.error && r.status === 0;
}

const FFMPEG = resolveBin(
  "FF_TEST_FFMPEG",
  "resources/ffmpeg/win/ffmpeg.exe",
  "ffmpeg",
);
const FFPROBE = resolveBin(
  "FF_TEST_FFPROBE",
  "resources/ffmpeg/win/ffprobe.exe",
  "ffprobe",
);
// NOTE: FF_ENGINE_FFMPEG_DIR "" (empty) is meaningful (system loader path) —
// only default when the env var is UNSET.
const FFMPEG_DIR = process.env.FF_ENGINE_FFMPEG_DIR !== undefined
  ? process.env.FF_ENGINE_FFMPEG_DIR
  : IS_WIN
    ? path.join(ROOT, "resources", "ffmpeg", "win", "dll")
    : "";
const MEDIA_DIR = path.resolve(
  process.env.FF_TEST_MEDIA_DIR || path.join(os.tmpdir(), "fftest"),
);
const FONT = process.env.FF_TEST_FONT
  ? (path.isAbsolute(process.env.FF_TEST_FONT)
      ? process.env.FF_TEST_FONT
      : path.resolve(process.env.FF_TEST_FONT))
  : IS_WIN
    ? "C:\\Windows\\Fonts\\arialbd.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const INFO_OUT = path.resolve(
  process.env.FF_ENGINE_INFO_OUT || path.join(ROOT, "rust-engine", "engine-info.json"),
);
const OUT_MP4 = path.join(MEDIA_DIR, "out_rust_ci.mp4");

// ── assertion collector ──────────────────────────────────────────────────────
const failures = [];
function check(cond, msg) {
  if (cond) {
    console.log("  ok  " + msg);
  } else {
    failures.push(msg);
    console.log("  FAIL " + msg);
  }
}
function die(msg) {
  console.error("SMOKE FATAL: " + msg);
  process.exit(1);
}

// ── fixture generation (same style as scripts/ab-export-bench.js) ────────────
function runFF(args, label) {
  const r = spawnSync(FFMPEG, args, { timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    die(
      "ffmpeg failed for " + label + (r.error ? " — " + r.error.message : " — exit " + r.status) +
      (r.stderr ? "\n" + String(r.stderr).trim().split("\n").slice(-6).join("\n") : ""),
    );
  }
}
function needGen(file) {
  if (process.env.FF_TEST_REGEN === "1") return true;
  try { return fs.statSync(file).size <= 1024; } catch { return true; }
}
function genFixtures() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const video = path.join(MEDIA_DIR, "src_video.mp4");
  const image = path.join(MEDIA_DIR, "src_image.png");
  const music = path.join(MEDIA_DIR, "music.m4a");
  if (needGen(video)) {
    console.log("[smoke] generating src_video.mp4 (testsrc2 640x360 30fps 4s + 440Hz aac)");
    runFF([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-shortest",
      video,
    ], "src_video.mp4");
  } else console.log("[smoke] reuse src_video.mp4");
  if (needGen(image)) {
    console.log("[smoke] generating src_image.png (gradients 640x360)");
    runFF([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "gradients=size=640x360:rate=30",
      "-frames:v", "1",
      image,
    ], "src_image.png");
  } else console.log("[smoke] reuse src_image.png");
  if (needGen(music)) {
    console.log("[smoke] generating music.m4a (440Hz stereo aac 6s)");
    runFF([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-ac", "2", "-t", "6",
      "-c:a", "aac", "-b:a", "128k",
      music,
    ], "music.m4a");
  } else console.log("[smoke] reuse music.m4a");
  for (const f of [video, image, music]) {
    if (!fs.existsSync(f)) die("fixture missing after generation: " + f);
  }
  return { video, image, music };
}

// ── ffprobe helpers ──────────────────────────────────────────────────────────
function probe(args) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-of", "json"].concat(args), {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    die("ffprobe failed: " + (r.error ? r.error.message : "exit " + r.status) +
      (r.stderr ? " — " + String(r.stderr).trim().slice(0, 400) : ""));
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    die("ffprobe output not JSON: " + String(e.message));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  console.log("[smoke] platform:", process.platform, process.arch, "node", process.versions.node);
  console.log("[smoke] ffmpeg:", FFMPEG);
  console.log("[smoke] ffprobe:", FFPROBE);
  console.log("[smoke] engine ffmpeg_dir:", FFMPEG_DIR === "" ? "(system loader path)" : FFMPEG_DIR);
  console.log("[smoke] media dir:", MEDIA_DIR);
  console.log("[smoke] font:", FONT);
  if (!binExists(FFMPEG)) die("ffmpeg not found: " + FFMPEG);
  if (!binExists(FFPROBE)) die("ffprobe not found: " + FFPROBE);
  if (!fs.existsSync(FONT)) die("font not found: " + FONT);
  if (FFMPEG_DIR !== "") {
    let isDir = false;
    try { isDir = fs.statSync(FFMPEG_DIR).isDirectory(); } catch {}
    if (!isDir) die("FF_ENGINE_FFMPEG_DIR is not a directory: " + FFMPEG_DIR);
  }

  const fixtures = genFixtures();

  // 1. engine loads
  const engine = require(path.join(__dirname, "..", "index.js"));
  if (!engine.available()) die("ENGINE NOT AVAILABLE: " + engine.loadError());
  console.log("[smoke] engine loaded from:", engine.loadedFrom);
  console.log("[smoke] engine version:", engine.engineVersion());
  const family = engine.probeFfmpegFamily(FFMPEG_DIR);
  console.log("[smoke] ffmpeg family:", family);

  // 2. timeline (same shape as tools/smoke-test.js, Windows-resolved paths)
  const timeline = {
    version: 1,
    width: 640,
    height: 360,
    fps: 30,
    sampleRate: 48000,
    audioChannels: 2,
    bitrateMbps: 4,
    crf: 23,
    quality: "social",
    audioKbps: 128,
    backgroundColor: "#101010",
    totalMs: 5000,
    fonts: { sans: FONT },
    segments: [
      {
        id: "s1",
        mediaType: "video",
        path: fixtures.video,
        startMs: 0,
        endMs: 3000,
        durationMs: 3000,
        trimInMs: 500,
        speed: 1.0,
        track: 0,
        volume: 0.9,
        sourceDurationMs: 4000,
        hasAudio: true,
        kenBurns: { enabled: false, direction: "in", zoomMax: 1.12 },
      },
      {
        id: "s2",
        mediaType: "image",
        path: fixtures.image,
        startMs: 3000,
        endMs: 5000,
        durationMs: 2000,
        trimInMs: 0,
        speed: 1.0,
        track: 0,
        volume: 1.0,
        hasAudio: false,
        kenBurns: { enabled: true, direction: "in", zoomMax: 1.15 },
      },
    ],
    music: {
      path: fixtures.music,
      volume: 0.35,
      startMs: 0,
      fadeMs: 400,
      loop: false,
    },
    texts: [
      {
        text: "FrameFuse Rust Engine",
        startMs: 200,
        endMs: 2800,
        font: "sans",
        size: 44,
        color: "#ffffff",
        outlineColor: "#000000",
        position: "top",
        x: 0.5,
        fadeMs: 250,
      },
      {
        text: "Windows CI smoke works!",
        startMs: 3200,
        endMs: 4900,
        font: "sans",
        size: 36,
        color: "#ffe066",
        outlineColor: "#202020",
        position: "bottom",
        x: 0.5,
        fadeMs: 250,
      },
    ],
    watermark: null,
  };

  let lastPhase = "";
  let lastPercent = 0;
  const t0 = Date.now();
  engine
    .exportVideo(JSON.stringify(timeline), OUT_MP4, FFMPEG_DIR, (err, p) => {
      if (err) {
        console.error("progress callback error:", err);
        return;
      }
      if (!p) return;
      if (p.phase !== lastPhase || p.percent - lastPercent > 25) {
        lastPhase = p.phase;
        lastPercent = p.percent;
        console.log(
          "[smoke] progress: phase=" + p.phase + " percent=" + Number(p.percent).toFixed(1) +
          " fps=" + Number(p.fps).toFixed(1) + " rate=" + (p.rate == null ? "-" : p.rate) + "x",
        );
      }
    })
    .then((res) => {
      console.log("=== RESULT ===");
      console.log(JSON.stringify(res, null, 2));

      // 3. engine-side assertions
      console.log("=== ASSERTIONS (engine) ===");
      check(res && res.success === true, "exportVideo resolved with success=true");
      check(
        res.engineUsed === "rust-cpu" || res.engineUsed === "rust-gpu",
        "engineUsed is rust-cpu|rust-gpu (got: " + res.engineUsed + ")",
      );
      check(
        /h264|x264/i.test(String(res.encoderName || "")),
        "encoderName is an h264 encoder (CI expects libx264 after the nvenc/qsv/amf probes fail; got: " +
          res.encoderName + ")",
      );
      check(
        typeof res.ffmpegFamily === "string" && !res.ffmpegFamily.startsWith("error"),
        "engine loaded the FFmpeg shared-lib family (got: " + res.ffmpegFamily + ")",
      );
      check(
        !family.startsWith("error") && family.includes("61"),
        "probeFfmpegFamily resolved family 61/61/59/8/5 (got: " + family + ")",
      );
      const frames = Number(res.frames) || 0;
      check(
        frames >= 140 && frames <= 160,
        "engine reported ~150 frames (expected 150, got: " + frames + ")",
      );

      // 4. output file + ffprobe verification
      console.log("=== ASSERTIONS (output + ffprobe) ===");
      const size = fs.existsSync(OUT_MP4) ? fs.statSync(OUT_MP4).size : 0;
      check(size >= 50000, "output file exists and is >= 50 KB (" + OUT_MP4 + ", " + size + " B)");
      const v = probe([
        "-select_streams", "v:0",
        "-count_frames",
        "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration,size",
        OUT_MP4,
      ]);
      console.log("=== FFPROBE (video) ===");
      console.log(JSON.stringify(v, null, 2));
      const vs = v.streams && v.streams[0];
      check(vs && vs.codec_name === "h264", "video codec is h264 (got: " + (vs && vs.codec_name) + ")");
      check(vs && Number(vs.width) === 640 && Number(vs.height) === 360,
        "video is 640x360 (got: " + (vs && vs.width + "x" + vs.height) + ")");
      const nbFrames = Number(vs && vs.nb_read_frames) || 0;
      check(nbFrames >= 140 && nbFrames <= 160,
        "ffprobe counted ~150 frames (expected 150, got: " + nbFrames + ")");
      const dur = Number(v.format && v.format.duration) || 0;
      check(dur >= 4.5 && dur <= 5.5, "duration ~5s (got: " + dur + ")");

      const a = probe([
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate,channels",
        OUT_MP4,
      ]);
      console.log("=== FFPROBE (audio) ===");
      console.log(JSON.stringify(a, null, 2));
      const as = a.streams && a.streams[0];
      check(as && as.codec_name === "aac", "audio codec is aac (got: " + (as && as.codec_name) + ")");
      check(as && Number(as.sample_rate) === 48000 && Number(as.channels) === 2,
        "audio is 48kHz stereo (got: " + (as && as.sample_rate + "Hz/" + as.channels + "ch") + ")");

      // v2: VISUAL sanity — the GPU-YUV compute path (exercised on WARP in
      // CI via FRAMEFUSE_ENGINE_ALLOW_SOFTWARE_GPU=1) must produce REAL
      // luma, not a black/garbage frame. Decodes the whole output as 8-bit
      // GRAY (portable — no lavfi movie-filter path quirks on Windows) and
      // computes per-frame YAVG in JS. This is the assertion that can never
      // let a black-frame regression pass silently again.
      try {
        const gray = spawnSync(
          FFMPEG,
          ["-v", "error", "-i", OUT_MP4, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
          { timeout: 120000, maxBuffer: 256 * 1024 * 1024 },
        );
        if (!gray.error && gray.status === 0 && gray.stdout && gray.stdout.length > 0) {
          const W = Number(vs && vs.width) || 640;
          const H = Number(vs && vs.height) || 360;
          const frameBytes = W * H;
          const nFrames = Math.floor(gray.stdout.length / frameBytes);
          const yavg = (idx) => {
            const start = idx * frameBytes;
            let sum = 0;
            for (let i = start; i < start + frameBytes; i++) sum += gray.stdout[i];
            return sum / frameBytes;
          };
          if (nFrames > 90) {
            const f30 = yavg(30); // mid first segment (video + headline)
            const f90 = yavg(90); // second segment (Ken Burns image + text)
            check(
              f30 > 8 && f30 < 247,
              "frame 30 luma in a sane range (not black/clipped): YAVG=" + f30.toFixed(1),
            );
            check(
              Math.abs(f90 - f30) > 0.5,
              "content changes between segments (YAVG " + f30.toFixed(1) + " → " + f90.toFixed(1) + ")",
            );
          } else {
            check(false, "gray decode produced < 90 frames (got " + nFrames + ")");
          }
        } else {
          check(false, "gray decode failed (status " + gray.status + ")");
        }
      } catch (e) {
        console.log("  (luma check unavailable: " + (e && e.message) + ")");
      }

      const wallMs = Date.now() - t0;

      // 5. engine-info.json (CI artifact: version + probe + result summary)
      const info = {
        engineVersion: engine.engineVersion(),
        binary: engine.binaryName,
        loadedFrom: engine.loadedFrom,
        platform: { os: process.platform, arch: process.arch, node: process.versions.node },
        ffmpegDir: FFMPEG_DIR === "" ? "(system loader path)" : FFMPEG_DIR,
        probeFfmpegFamily: family,
        result: res,
        ffprobe: {
          video: vs || null,
          audio: as || null,
          format: v.format || null,
          outputBytes: size,
        },
        assertionsPassed: failures.length === 0,
        assertionFailures: failures,
        wallMs,
        generatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(INFO_OUT, JSON.stringify(info, null, 2) + "\n");
      console.log("[smoke] engine info →", INFO_OUT);

      console.log("=== WALL TIME: " + (wallMs / 1000).toFixed(2) + "s ===");
      if (failures.length) {
        console.error("SMOKE FAILED — " + failures.length + " assertion(s):");
        for (const f of failures) console.error("  - " + f);
        process.exit(1);
      }
      console.log("SMOKE PASSED — engine loads, exportVideo resolved, ffprobe verified h264+150frames+aac.");
    })
    .catch((err) => {
      console.error("EXPORT FAILED:", err && err.message ? err.message : err);
      process.exit(1);
    });
}

main();
