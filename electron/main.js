// electron/main.js — FrameFuse v4.1 main process
// Two-step export: Step 1 encodes each segment (with captions), Step 2 concats (-c copy)
// This avoids CLI length limits (each ffmpeg call has a short filter string)
//
// v4.1 highlights:
//   - GPU encoding (NVENC/QSV/AMF) with runtime probe + CPU fallback — 3-10× faster
//   - Zoompan geometry EXACTLY matches the canvas preview (centered pan starts,
//     1.1× supersample baseline, easeInOutSine)
//   - Real-time export progress parsed from ffmpeg "time=" stderr + ETA
//   - Audio post-processing: loudnorm normalize, fade in/out, apad (audio no
//     longer truncates the video when shorter)
//   - ASS export parity for all 21 kinetic animations incl. karaoke-safe tags
//     + word "stack" mode + new viral pack (slam, glitch, spin, flip, elastic,
//     color-cycle, spotlight, swing, squash, zoom-words)
//   - .ass sidecar export IPC
const {
  app, BrowserWindow, ipcMain, dialog, Menu, shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");

// Resolve the FFmpeg binary path. On Windows we need ffmpeg.exe, on
// Linux/macOS we need ffmpeg. When the app is packaged, the binary is
// bundled via electron-builder's extraResources config at:
//   <resourcesPath>/ffmpeg-static/ffmpeg(.exe)
let ffmpegPath;
if (app.isPackaged) {
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const altName = process.platform === "win32" ? "ffmpeg" : "ffmpeg.exe";
  const candidates = [
    path.join(process.resourcesPath, "ffmpeg-static", exeName),
    path.join(process.resourcesPath, "ffmpeg-static", altName),
    path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "ffmpeg-static", exeName),
    path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "ffmpeg-static", altName),
    path.join(process.resourcesPath, "app", "node_modules", "ffmpeg-static", exeName),
  ];
  ffmpegPath = candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!ffmpegPath) {
    console.error("FFmpeg not found at any candidate path:", candidates);
    ffmpegPath = candidates[0];
  }
} else {
  try {
    ffmpegPath = require("ffmpeg-static");
  } catch (e) {
    ffmpegPath = "ffmpeg";
  }
  if (process.platform === "win32" && ffmpegPath && !ffmpegPath.endsWith(".exe")) {
    try { if (fs.existsSync(ffmpegPath + ".exe")) ffmpegPath += ".exe"; } catch (_) {}
  }
}
console.log("FFmpeg path:", ffmpegPath, "exists:", (() => { try { return fs.existsSync(ffmpegPath); } catch { return false; } })());

const isDev = !app.isPackaged;
let mainWindow = null;
let currentProcess = null;
const tempDir = path.join(os.tmpdir(), "framefuse-tmp");

function ensureTempDir() {
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function createWindow() {
  let iconPath = path.join(__dirname, "..", "build", "icon.ico");
  try { if (!fs.existsSync(iconPath)) iconPath = undefined; } catch (_) { iconPath = undefined; }

  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 720,
    backgroundColor: "#0a0a0a", title: "FrameFuse v4.1",
    autoHideMenuBar: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  });
  if (isDev) mainWindow.loadURL("http://localhost:3000");
  else {
    const file = path.join(__dirname, "..", "out", "index.html");
    if (fs.existsSync(file)) mainWindow.loadFile(file);
    else mainWindow.loadURL("file://" + file);
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function buildApplicationMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "Add Images…", accelerator: "CmdOrCtrl+O", click: () => mainWindow && mainWindow.webContents.send("menu:add-images") },
      { label: "Add Audio…", click: () => mainWindow && mainWindow.webContents.send("menu:add-audio") },
      { type: "separator" },
      { label: "Export MP4…", accelerator: "CmdOrCtrl+E", click: () => mainWindow && mainWindow.webContents.send("menu:export") },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ]},
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
    { label: "Help", submenu: [
      { label: "About", click: () => { dialog.showMessageBox(mainWindow, { type: "info", title: "About", message: "FrameFuse v4.1", detail: "Native image-to-video merger with viral kinetic captions.", buttons: ["OK"] }); } },
      { label: "Naming Guide", click: () => mainWindow && mainWindow.webContents.send("menu:naming-guide") },
    ]},
  ]));
}

// IPC helpers
ipcMain.handle("is-electron", () => true);

// Diagnostics — lets the renderer verify ffmpeg is reachable.
ipcMain.handle("ffmpeg-status", async () => {
  try {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return { ok: false, path: ffmpegPath || "(none)", version: null, error: "FFmpeg binary not found at expected path. Try reinstalling FrameFuse." };
    }
    const out = execSync(`"${ffmpegPath}" -version`, { encoding: "utf-8", timeout: 10000, windowsHide: true });
    const firstLine = out.split("\n")[0];
    return { ok: true, path: ffmpegPath, version: firstLine, error: null };
  } catch (e) {
    return { ok: false, path: ffmpegPath || "(none)", version: null, error: e.message };
  }
});

ipcMain.handle("save-temp-image", async (_evt, { name, bytes }) => {
  ensureTempDir();
  const ext = path.extname(name) || ".jpg";
  const p = path.join(tempDir, `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle("save-temp-audio", async (_evt, { name, bytes }) => {
  ensureTempDir();
  const ext = path.extname(name) || ".mp3";
  const p = path.join(tempDir, `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle("cleanup-temp", async () => {
  try { if (fs.existsSync(tempDir)) for (const f of fs.readdirSync(tempDir)) try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {} return true; } catch { return false; }
});

ipcMain.handle("choose-output", async () => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Export MP4", defaultPath: `framefuse_${Date.now()}.mp4`,
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });
  if (res.canceled || !res.filePath) return null;
  if (!res.filePath.toLowerCase().endsWith(".mp4")) res.filePath += ".mp4";
  return res.filePath;
});

ipcMain.handle("cancel-export", async () => {
  try {
    if (currentProcess) {
      if (process.platform === "win32") spawn("taskkill", ["/pid", currentProcess.pid, "/f", "/t"], { windowsHide: true });
      else currentProcess.kill("SIGKILL");
      currentProcess = null;
    }
    return true;
  } catch { return false; }
});

// ---------------------------------------------------------------------------
// GPU encoder detection + RUNTIME PROBE.
// Listing an encoder isn't enough (drivers can be broken) — we actually
// encode 3 tiny test frames. Falls back to libx264 on any failure.
// ---------------------------------------------------------------------------
let detectedEncoder = null;

function listEncoders() {
  try {
    const output = execSync(`"${ffmpegPath}" -hide_banner -encoders 2>&1`, { encoding: "utf-8", timeout: 10000 });
    if (output.includes("h264_nvenc")) return { name: "h264_nvenc", label: "NVIDIA NVENC" };
    if (output.includes("h264_qsv")) return { name: "h264_qsv", label: "Intel QSV" };
    if (output.includes("h264_amf")) return { name: "h264_amf", label: "AMD AMF" };
  } catch (_) { /* ignore */ }
  return null;
}

function probeEncoder(name) {
  try {
    execSync(
      `"${ffmpegPath}" -hide_banner -loglevel error -f lavfi -i color=c=black:s=256x256:r=30:d=0.1 ` +
      `-frames:v 3 -c:v ${name} -f null - 2>&1`,
      { encoding: "utf-8", timeout: 15000, windowsHide: true },
    );
    return true;
  } catch (_) { return false; }
}

function detectGpuEncoder() {
  if (detectedEncoder) return detectedEncoder;
  const listed = listEncoders();
  if (listed && probeEncoder(listed.name)) {
    detectedEncoder = listed;
  } else {
    detectedEncoder = { name: "libx264", label: "CPU (libx264)" };
  }
  console.log("Export encoder:", detectedEncoder.label, `(${detectedEncoder.name})`);
  return detectedEncoder;
}

/** Build encoder args for a quality-first, speed-optimized encode. */
function encoderArgs(encoderName, bitrateMbps, width, height) {
  switch (encoderName) {
    case "h264_nvenc":
      // Constant-quality mode: visually lossless-to-high quality, no wasted bits.
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", `${Math.round((bitrateMbps || 8) * 1.5)}M`, "-bufsize", `${Math.round((bitrateMbps || 8) * 3)}M`, "-pix_fmt", "yuv420p"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23", "-look_ahead", "0", "-pix_fmt", "yuv420p"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "vbr_peak", "-qp_i", "22", "-qp_p", "24", "-b:v", `${bitrateMbps || 8}M`, "-pix_fmt", "yuv420p"];
    default:
      // libx264: "veryfast" is ~2× the speed of ultrafast at MUCH better
      // quality per bit. Still-image-heavy content compresses well, so
      // files stay small.
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
  }
}

// Helper: run ffmpeg and wait. `totalSec` enables real-time progress via
// stderr "time=" parsing; `onTime` receives fractional seconds.
function runFfmpeg(args, totalSec, onTime) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    currentProcess = proc;
    let stderr = "";
    let stderrTail = "";
    proc.stderr.on("data", (data) => {
      const s = data.toString();
      if (onTime && totalSec > 0) {
        const m = s.match(/time=(\d+):(\d{2}):(\d{2})\.(\d{2})/);
        if (m) {
          const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
          onTime(Math.min(sec, totalSec));
        }
      }
      stderr += s;
      stderrTail = (stderrTail + s).slice(-4000);
    });
    proc.on("error", (err) => { currentProcess = null; reject(new Error(err.message)); });
    proc.on("exit", (code, signal) => {
      currentProcess = null;
      if (signal === "SIGKILL" || signal === "SIGTERM") { reject(new Error("Export cancelled")); return; }
      if (code !== 0) {
        const lines = stderrTail.trim().split("\n");
        reject(new Error(lines.slice(-6).join("\n") || `FFmpeg error code ${code}`));
        return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// ASS builder — shared by the export burn-in AND the .ass sidecar export.
// Mirrors src/lib/merger/captionAnimations.ts so preview == export.
// ---------------------------------------------------------------------------

const ANIM = {
  POP_IN_MS: 220, SLIDE_UP_MS: 280, BOUNCE_IN_MS: 380, REVEAL_MS: 320,
  SHAKE_MS: 280, TYPEWRITER_MS_PER_CHAR: 45, SLAM_MS: 180, GLITCH_MS: 220,
  SPIN_IN_MS: 300, FLIP_IN_MS: 260, ELASTIC_MS: 450, ZOOM_WORDS_MS: 160,
  SQUASH_MS: 340,
};

const COLOR_CYCLE_PALETTE = ["#FDE047", "#22D3EE", "#F472B6", "#A3E635"];

function hexToAssColor(hex, alpha = 1) {
  const h = (hex || "#FFFFFF").replace(/^#/, "");
  const assAlpha = Math.round((1 - alpha) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `&H${assAlpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function hexToAssBgr(hex) {
  const h = (hex || "#FFFFFF").replace(/^#/, "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/**
 * ASS animation tags for one word. `karaoke: true` restricts to line-safe
 * tags (\fscx/\fscy/\frz/\alpha/\1c/\2c/\t) because \move/\fad are
 * once-per-line globals that would animate the WHOLE karaoke line.
 * Mirrors assWordAnimationTags() in captionAnimations.ts.
 */
function assAnimTags(animation, wordDurMs, ch, karaoke, wordIndex, highlightColor) {
  if (!animation || animation === "none") return "";
  const chScale = ch / 1080;
  const blocks = [];
  const wIdx = wordIndex || 0;

  switch (animation) {
    case "pop-in": {
      blocks.push(`{\\fscx40\\fscy40\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(ANIM.POP_IN_MS * 0.7)},\\fscx115\\fscy115\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(ANIM.POP_IN_MS * 0.7)},${ANIM.POP_IN_MS},\\fscx100\\fscy100)}`);
      break;
    }
    case "slide-up": {
      if (karaoke) {
        blocks.push(`{\\alpha&HFF&\\fry-4}`);
        blocks.push(`{\\t(0,${ANIM.SLIDE_UP_MS},\\alpha&H00&\\fry0)}`);
      } else {
        const dy = Math.round(30 * chScale);
        blocks.push(`{\\move(0,${dy},0,0,0,${ANIM.SLIDE_UP_MS})\\fad(${Math.round(ANIM.SLIDE_UP_MS * 0.6)},0)}`);
      }
      break;
    }
    case "bounce-in": {
      if (karaoke) {
        blocks.push(`{\\fscx60\\fscy60\\alpha&HFF&}`);
        blocks.push(`{\\t(0,${Math.round(ANIM.BOUNCE_IN_MS * 0.6)},\\fscx112\\fscy112\\alpha&H00&)}`);
        blocks.push(`{\\t(${Math.round(ANIM.BOUNCE_IN_MS * 0.6)},${ANIM.BOUNCE_IN_MS},\\fscx100\\fscy100)}`);
      } else {
        const dy = Math.round(25 * chScale);
        const t1 = Math.round(ANIM.BOUNCE_IN_MS * 0.6);
        blocks.push(`{\\move(0,${-dy},0,0,0,${t1})\\fad(${Math.round(ANIM.BOUNCE_IN_MS * 0.4)},0)\\t(${t1},${ANIM.BOUNCE_IN_MS},\\fry1)}`);
      }
      break;
    }
    case "scale-pulse": {
      const half = Math.max(1, Math.round(wordDurMs / 2));
      blocks.push(`{\\t(0,${Math.round(half * 0.5)},\\fscx118\\fscy118)}`);
      blocks.push(`{\\t(${Math.round(half * 0.5)},${half},\\fscx100\\fscy100)}`);
      blocks.push(`{\\t(${half},${Math.round(half + (wordDurMs - half) * 0.5)},\\fscx118\\fscy118)}`);
      blocks.push(`{\\t(${Math.round(half + (wordDurMs - half) * 0.5)},${wordDurMs},\\fscx100\\fscy100)}`);
      break;
    }
    case "fade-through": {
      if (karaoke) {
        blocks.push(`{\\alpha&HFF&}`);
        blocks.push(`{\\t(0,150,\\alpha&H00&)}`);
      } else {
        blocks.push(`{\\fad(150,150)}`);
      }
      break;
    }
    case "typewriter": {
      blocks.push(karaoke
        ? `{\\alpha&HFF&\\t(0,${ANIM.TYPEWRITER_MS_PER_CHAR * 6},\\alpha&H00&)}`
        : `{\\fad(${ANIM.TYPEWRITER_MS_PER_CHAR * 6},0)}`);
      break;
    }
    case "reveal": {
      if (karaoke) {
        blocks.push(`{\\alpha&HC0&}`);
        blocks.push(`{\\t(0,${ANIM.REVEAL_MS},\\alpha&H00&)}`);
      } else {
        blocks.push(`{\\clip(0,0,0,${ch})\\fad(${Math.round(ANIM.REVEAL_MS * 0.5)},0)\\t(0,${ANIM.REVEAL_MS},\\clip(0,0,2000,${ch}))}`);
      }
      break;
    }
    case "wave": {
      const amp = Math.max(1, Math.round(6 * chScale));
      const q = Math.max(50, Math.round(wordDurMs / 4));
      blocks.push(`{\\t(0,${q},\\fry${amp})}`);
      blocks.push(`{\\t(${q},${q * 2},\\fry${-amp})}`);
      blocks.push(`{\\t(${q * 2},${q * 3},\\fry${amp})}`);
      blocks.push(`{\\t(${q * 3},${wordDurMs},\\fry0)}`);
      break;
    }
    case "jitter": {
      const amp = 2;
      const steps = Math.min(6, Math.max(3, Math.round(wordDurMs / 80)));
      const stepMs = Math.max(40, Math.round(wordDurMs / steps));
      for (let i = 0; i < steps; i++) {
        const t1 = i * stepMs;
        const t2 = (i + 1) * stepMs;
        const rx = i % 2 === 0 ? amp : -amp;
        const ry = i % 3 === 0 ? amp : -amp;
        blocks.push(`{\\t(${t1},${t2},\\frx${rx}\\fry${ry})}`);
      }
      blocks.push(`{\\t(${steps * stepMs},${wordDurMs},\\frx0\\fry0)}`);
      break;
    }
    case "shake": {
      const amp = 4;
      const steps = 5;
      const stepMs = Math.round(ANIM.SHAKE_MS / steps);
      for (let i = 0; i < steps; i++) {
        const t1 = i * stepMs;
        const t2 = (i + 1) * stepMs;
        const decay = 1 - i / steps;
        const rx = (i % 2 === 0 ? 1 : -1) * Math.max(1, Math.round(amp * decay));
        blocks.push(`{\\t(${t1},${t2},\\frx${rx})}`);
      }
      blocks.push(`{\\t(${ANIM.SHAKE_MS},${Math.max(ANIM.SHAKE_MS + 50, wordDurMs)},\\frx0)}`);
      break;
    }
    case "drift": {
      if (karaoke) {
        blocks.push(`{\\t(0,${wordDurMs},\\fscx96\\fscy96\\alpha&H30&)}`);
      } else {
        const dy = Math.round(-8 * chScale);
        blocks.push(`{\\move(0,0,0,${dy},0,${wordDurMs})}`);
      }
      break;
    }
    // ── v4.1 viral kinetic pack ──────────────────────────────────────
    case "slam": {
      blocks.push(`{\\fscx240\\fscy240\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(ANIM.SLAM_MS * 0.5)},\\fscx115\\fscy115\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(ANIM.SLAM_MS * 0.5)},${ANIM.SLAM_MS},\\fscx100\\fscy100)}`);
      blocks.push(`{\\t(${ANIM.SLAM_MS},${ANIM.SLAM_MS + 80},\\frz2)}`);
      blocks.push(`{\\t(${ANIM.SLAM_MS + 80},${ANIM.SLAM_MS + 140},\\frz0)}`);
      break;
    }
    case "glitch": {
      const hl = highlightColor ? hexToAssBgr(highlightColor) : null;
      blocks.push(`{\\alpha&HA0&\\frz-3}`);
      blocks.push(`{\\t(0,60,\\alpha&H40&\\frz3)}`);
      if (hl) blocks.push(`{\\1c${hl}}`);
      blocks.push(`{\\t(60,120,\\alpha&H00&\\frz-2)}`);
      blocks.push(`{\\t(120,${ANIM.GLITCH_MS},\\alpha&H00&\\frz0)}`);
      break;
    }
    case "spin-in": {
      blocks.push(`{\\frz-14\\fscx60\\fscy60\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${ANIM.SPIN_IN_MS},\\frz0\\fscx100\\fscy100\\alpha&H00&)}`);
      break;
    }
    case "flip-in": {
      blocks.push(`{\\fscy5\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(ANIM.FLIP_IN_MS * 0.8)},\\fscy108\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(ANIM.FLIP_IN_MS * 0.8)},${ANIM.FLIP_IN_MS},\\fscy100)}`);
      break;
    }
    case "elastic": {
      blocks.push(`{\\fscx30\\fscy30\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(ANIM.ELASTIC_MS * 0.55)},\\fscx106\\fscy106\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(ANIM.ELASTIC_MS * 0.55)},${Math.round(ANIM.ELASTIC_MS * 0.8)},\\fscx97\\fscy97)}`);
      blocks.push(`{\\t(${Math.round(ANIM.ELASTIC_MS * 0.8)},${ANIM.ELASTIC_MS},\\fscx100\\fscy100)}`);
      break;
    }
    case "color-cycle": {
      const color = COLOR_CYCLE_PALETTE[wIdx % COLOR_CYCLE_PALETTE.length];
      const ass = hexToAssBgr(color);
      if (karaoke) {
        // Karaoke: pre-highlight color is Secondary → \2c per word.
        blocks.push(`{\\2c${ass}\\fscx85\\fscy85\\alpha&HFF&}`);
        blocks.push(`{\\t(0,160,\\fscx100\\fscy100\\alpha&H00&)}`);
      } else {
        blocks.push(`{\\1c${ass}\\fscx85\\fscy85\\alpha&HFF&}`);
        blocks.push(`{\\t(0,160,\\fscx100\\fscy100\\alpha&H00&)}`);
      }
      break;
    }
    case "spotlight": {
      blocks.push(`{\\fscx70\\fscy70\\alpha&HFF&}`);
      blocks.push(`{\\t(0,140,\\fscx112\\fscy112\\alpha&H00&)}`);
      blocks.push(`{\\t(140,200,\\fscx100\\fscy100)}`);
      const half = Math.max(1, Math.round(wordDurMs / 2));
      blocks.push(`{\\t(200,${Math.round(200 + half * 0.4)},\\fscx106\\fscy106)}`);
      blocks.push(`{\\t(${Math.round(200 + half * 0.4)},${Math.max(200 + half, 201)},\\fscx100\\fscy100)}`);
      break;
    }
    case "swing": {
      const amp = 8;
      const q = Math.max(50, Math.round(wordDurMs / 4));
      blocks.push(`{\\frz${amp}}`);
      blocks.push(`{\\t(0,${q},\\frz${-amp})}`);
      blocks.push(`{\\t(${q},${q * 2},\\frz${amp})}`);
      blocks.push(`{\\t(${q * 2},${q * 3},\\frz${-amp})}`);
      blocks.push(`{\\t(${q * 3},${wordDurMs},\\frz0)}`);
      break;
    }
    case "squash": {
      blocks.push(`{\\fscy40\\fscx135\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(ANIM.SQUASH_MS * 0.6)},\\fscy40\\fscx135\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(ANIM.SQUASH_MS * 0.6)},${Math.round(ANIM.SQUASH_MS * 0.85)},\\fscy108\\fscx92)}`);
      blocks.push(`{\\t(${Math.round(ANIM.SQUASH_MS * 0.85)},${ANIM.SQUASH_MS},\\fscy100\\fscx100)}`);
      break;
    }
    case "zoom-words": {
      blocks.push(`{\\fscx160\\fscy160\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${ANIM.ZOOM_WORDS_MS},\\fscx100\\fscy100\\alpha&H00&)}`);
      break;
    }
    default:
      return "";
  }
  return blocks.length ? blocks.join("") : "";
}

function assFmtTime(sec) {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Escape user text for ASS. Curly braces are REMOVED (libass renders "\{"
 * literally as a backslash — stripping is the only safe transform).
 * Newlines become \N.
 */
function escapeAssText(s) {
  if (!s) return "";
  return s
    .replace(/\\/g, "\u2216") // rare — avoid tag injection
    .replace(/[{}]/g, "")
    .replace(/\n/g, "\\N");
}

/**
 * Build the full ASS document for a set of cues on the master timeline,
 * with cue times SHIFTED to be relative to [segStartMs, segEndMs] and
 * clamped to [0, segDurMs]. When segStartMs/segEndMs are omitted the
 * cues are emitted with their absolute (master timeline) times — used
 * for the .ass sidecar export.
 *
 * Word modes:
 *   - "off": one Dialogue per cue (full text).
 *   - "word": one Dialogue with \k karaoke tags (Primary=highlight,
 *     Secondary=text). Karaoke-safe animation tags only.
 *   - "word-only": one Dialogue per word (full tag set incl. \move/\fad).
 *   - "stack": one Dialogue per stack-state — line i spans word i's
 *     [start, next word's start), shows words 0..i stacked with \N,
 *     previous words dim, active word highlighted + animated.
 */
function buildAssDocument(cues, cs, width, height, segStartMs, segEndMs, segDurMs) {
  if (!cs) return null;

  const fontName = cs.fontName || "Arial";
  const fontSize = Math.round((cs.fontSize || 0.05) * height * (cs.fontSizeScale || 1));
  const textColor = cs.textColor || "#FFFFFF";
  const highlightColor = cs.highlightColor || null;
  const wordMode = cs.wordMode || "off";
  const animation = cs.animation || "none";
  const karaoke = wordMode === "word";

  const position = cs.customPosition || cs.position || "bottom";
  const marginV = cs.positionY != null ? cs.positionY : 50;
  const fontWeight = cs.fontWeight || 600;
  const bold = fontWeight >= 600 ? -1 : 0;
  const italic = (cs.fontStyle || "normal") === "italic" ? -1 : 0;
  const bgColor = cs.bgColor || null;
  const bgAlpha = cs.bgAlpha != null ? cs.bgAlpha : 1;
  const borderColor = cs.borderColor || "#000000";
  const borderWidth = cs.borderWidth != null ? cs.borderWidth : 2;
  const shadow = !!cs.shadow;
  const shadowColor = cs.shadowColor || "#000000";
  const shadowBlur = cs.shadowBlur != null ? cs.shadowBlur : 3;
  const textTransform = cs.textTransform || "none";
  const spacing = cs.letterSpacing || 0;
  const alignment = cs.alignment || "center";

  // Alignment: 2=bottom-center, 5=middle-center, 8=top-center
  let assAlignment = position === "top" ? 8 : position === "center" ? 5 : 2;
  if (alignment === "left") assAlignment -= 1;
  else if (alignment === "right") assAlignment += 1;

  const borderStyle = bgColor ? 3 : 1;
  const outline = bgColor ? 0 : borderWidth;
  const shadowVal = shadow ? Math.max(1, Math.round(shadowBlur)) : 0;
  const backColour = bgColor
    ? hexToAssColor(bgColor, bgAlpha)
    : hexToAssColor(shadow ? shadowColor : "#000000", 0.5);

  // Karaoke \k mode: Primary = highlight (post-fill), Secondary = text.
  const primary = karaoke && highlightColor ? highlightColor : textColor;
  const secondary = karaoke ? textColor : textColor;

  const transform = (s) => {
    if (textTransform === "uppercase") return s.toUpperCase();
    if (textTransform === "lowercase") return s.toLowerCase();
    return s;
  };

  const assLines = [];
  assLines.push("[Script Info]");
  assLines.push("ScriptType: v4.00+");
  assLines.push(`PlayResX: ${width}`);
  assLines.push(`PlayResY: ${height}`);
  assLines.push("WrapStyle: 0");
  assLines.push("ScaledBorderAndShadow: yes");
  assLines.push("");
  assLines.push("[V4+ Styles]");
  assLines.push("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding");
  assLines.push(`Style: Default,${fontName},${fontSize},${hexToAssColor(primary)},${hexToAssColor(secondary)},${hexToAssColor(borderColor)},${backColour},${bold},${italic},0,0,100,100,${spacing},0,${borderStyle},${outline},${shadowVal},${assAlignment},40,40,${marginV},1`);
  assLines.push("");
  assLines.push("[Events]");
  assLines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");

  const useSegmentWindow = typeof segStartMs === "number" && typeof segDurMs === "number";
  const winStart = useSegmentWindow ? segStartMs : 0;
  const winEnd = useSegmentWindow ? segEndMs : Infinity;
  const clampDur = useSegmentWindow ? segDurMs : Infinity;

  let emitted = 0;
  for (const cue of cues) {
    if (cue.endMs <= winStart || cue.startMs >= winEnd) continue;

    const relStartMs = Math.max(0, cue.startMs - winStart);
    const relEndMs = Math.min(clampDur, cue.endMs - winStart);
    if (relEndMs <= relStartMs) continue;

    const hasWords = Array.isArray(cue.words) && cue.words.length > 0;

    // Word-timing visibility helper: overlap with the segment window.
    const wStart = (w) => Math.max(0, w.startMs - winStart);
    const wEnd = (w) => Math.min(clampDur, w.endMs - winStart);

    // ── Stack mode: one Dialogue per stack state ──
    if (wordMode === "stack" && hasWords) {
      const words = cue.words;
      for (let i = 0; i < words.length; i++) {
        const start = wStart(words[i]);
        // Line i lives until the next word begins (or cue end).
        const nextStart = i + 1 < words.length ? wStart(words[i + 1]) : relEndMs;
        const end = Math.max(nextStart, start + 100);
        if (end <= start) continue;

        // Max 8 rows visible (matches the canvas window).
        const from = Math.max(0, i - 7);
        const parts = [];
        for (let j = from; j <= i; j++) {
          const wt = escapeAssText(transform(words[j].text || ""));
          if (!wt) continue;
          if (j === i) {
            // Active word: highlight + full animation tags.
            const tags = assAnimTags(animation, wEnd(words[i]) - start, height, false, i, highlightColor);
            parts.push(`{\\alpha&H00&\\1c${hexToAssBgr(highlightColor || textColor)}}${tags}${wt}`);
          } else {
            // Spoken words above: dim.
            parts.push(`{\\alpha&HA0&\\1c${hexToAssBgr(textColor)}}${wt}`);
          }
        }
        if (parts.length === 0) continue;
        assLines.push(`Dialogue: 0,${assFmtTime(start / 1000)},${assFmtTime(Math.min(end, relEndMs) / 1000)},Default,,0,0,0,,${parts.join("\\N")}`);
        emitted++;
      }
      continue;
    }

    // ── Word-only mode: one Dialogue per word ──
    if (wordMode === "word-only" && hasWords) {
      // The active word renders in the preset's highlight color (matches
      // drawWordOnly in native.ts).
      const hlTag = highlightColor ? `{\\1c${hexToAssBgr(highlightColor)}}` : "";
      for (const w of cue.words) {
        if (w.endMs <= winStart || w.startMs >= winEnd) continue;
        const ws = wStart(w);
        const we = wEnd(w);
        if (we <= ws) continue;
        const wt = escapeAssText(transform(w.text || ""));
        if (!wt) continue;
        const tags = assAnimTags(animation, we - ws, height, false, cue.words.indexOf(w), highlightColor);
        assLines.push(`Dialogue: 0,${assFmtTime(ws / 1000)},${assFmtTime(we / 1000)},Default,,0,0,0,,${hlTag}${tags}${wt}`);
        emitted++;
      }
      continue;
    }

    // ── Word (karaoke highlight) mode: one Dialogue with \k tags ──
    if (wordMode === "word" && hasWords) {
      const parts = [];
      let wIdx = 0;
      for (const w of cue.words) {
        if (w.endMs <= winStart || w.startMs >= winEnd) { wIdx++; continue; }
        const ws = wStart(w);
        const we = wEnd(w);
        const wDurCs = Math.max(1, Math.round((we - ws) / 10));
        const wt = escapeAssText(transform(w.text || ""));
        if (!wt) { wIdx++; continue; }
        const tags = assAnimTags(animation, we - ws, height, true, wIdx, highlightColor);
        parts.push(`${tags}{\\k${wDurCs}}${wt}`);
        wIdx++;
      }
      if (parts.length === 0) continue;
      const karaokeText = parts.join(" ");
      assLines.push(`Dialogue: 0,${assFmtTime(relStartMs / 1000)},${assFmtTime(relEndMs / 1000)},Default,,0,0,0,,${karaokeText}`);
      emitted++;
      continue;
    }

    // ── Standard mode (off) or no word timestamps: full text line ──
    const text = escapeAssText(transform(cue.text || ""));
    if (!text) continue;
    const tags = assAnimTags(animation, relEndMs - relStartMs, height, false, 0, highlightColor);
    assLines.push(`Dialogue: 0,${assFmtTime(relStartMs / 1000)},${assFmtTime(relEndMs / 1000)},Default,,0,0,0,,${tags}${text}`);
    emitted++;
  }

  if (emitted === 0) return null;
  return assLines.join("\n");
}

// ---------------------------------------------------------------------------
// IPC: export the full-timeline .ass sidecar (v4.1)
// ---------------------------------------------------------------------------
ipcMain.handle("export-ass-file", async (event, opts) => {
  try {
    const { cues, captionSettings, width, height } = opts;
    if (!cues || cues.length === 0) return null;
    const doc = buildAssDocument(cues, captionSettings, width, height, null, null, null);
    if (!doc) return null;

    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Export ASS Subtitles",
      defaultPath: `framefuse_captions_${Date.now()}.ass`,
      filters: [{ name: "ASS Subtitles", extensions: ["ass"] }],
    });
    if (res.canceled || !res.filePath) return null;
    if (!res.filePath.toLowerCase().endsWith(".ass")) res.filePath += ".ass";
    fs.writeFileSync(res.filePath, doc, "utf-8");
    return { path: res.filePath, size: fs.statSync(res.filePath).size };
  } catch (err) {
    throw new Error(err.message || String(err));
  }
});

// ---------------------------------------------------------------------------
// IPC: TWO-STEP EXPORT
// Step 1: Encode each image → MP4 clip with zoompan + ASS subtitles burn-in
// Step 2: Concat all clips + mux audio using -f concat -c copy (INSTANT)
// ---------------------------------------------------------------------------
ipcMain.handle("export-native", async (event, opts) => {
  const { outputPath, fps, width, height, bitrateMbps, kenBurns, segments, audioPath, audio, captionSettings, subtitleCues } = opts;

  if (!outputPath) throw new Error("No output path");
  if (!segments || segments.length === 0) throw new Error("No segments");

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error("FFmpeg not found. The bundled FFmpeg binary is missing or corrupted. Please reinstall FrameFuse. Expected at: " + ffmpegPath);
  }

  const intensity = Math.max(0, Math.min(100, Number(kenBurns?.intensity) || 0));
  const zoomMax = 1.06 + (intensity / 100) * 0.18;
  const enabled = !!kenBurns?.enabled;
  const globalDir = kenBurns?.direction || "in";

  const captionsEnabled = !!captionSettings?.enabled && subtitleCues && subtitleCues.length > 0;
  const totalMs = segments.reduce((sum, s) => Math.max(sum, s.endMs ?? (s.startMs ?? 0) + s.durationMs), 0) || segments.reduce((sum, s) => sum + s.durationMs, 0);
  const totalSec = totalMs / 1000;
  const encoder = detectGpuEncoder();

  ensureTempDir();
  const tempFiles = [];
  const startTime = Date.now();

  function sendProgress(percent, timemarkSec, etaSec) {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send("export-progress", {
        progress: Math.max(0, Math.min(100, percent)),
        fps: 0,
        eta: etaSec,
        timemark: timemarkSec != null ? assFmtTime(timemarkSec).replace(".", ",") : undefined,
      });
    }
  }

  // Elapsed/ETA for the UI.
  function etaFor(fraction) {
    if (fraction <= 0.02) return undefined;
    const elapsed = (Date.now() - startTime) / 1000;
    return Math.max(0, Math.round(elapsed / fraction - elapsed));
  }

  try {
    // ─── STEP 1: Encode each segment ──────────────────────────────
    const clipPaths = [];
    let cumulativeMs = 0;
    const doneMs = [0]; // master-timeline ms completed before the current clip

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDurSec = seg.durationMs / 1000;
      const segFrames = Math.max(2, Math.round(segDurSec * fps));
      const dir = enabled ? seg.direction || globalDir : "none";

      const segStartMs = (typeof seg.startMs === "number") ? seg.startMs : cumulativeMs;
      const segEndMs = (typeof seg.endMs === "number") ? seg.endMs : (cumulativeMs + seg.durationMs);

      // ── Build zoompan expressions — EXACT canvas parity ──
      // The pre-scale is 1.1× supersampled cover, so zoompan's z baseline
      // is 1.1 (= canvas zoom 1.0). Pan modes start CENTERED (x/y = max/2)
      // and slide to the edge, matching drawFrame()'s centered start.
      let zExpr, xExpr, yExpr;
      if (!enabled || dir === "none") {
        zExpr = "1.1"; xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
      } else {
        const tExpr = `on/${Math.max(1, segFrames - 1)}`;
        const easeExpr = `-((cos(PI*${tExpr})-1)/2)`; // easeInOutSine (same as canvas)
        const zBase = 1.1;
        const zMaxEff = (1.1 * zoomMax).toFixed(6);
        const spanEff = (1.1 * zoomMax - 1.1).toFixed(6);
        const maxX = "(iw-iw/zoom)";
        const maxY = "(ih-ih/zoom)";
        if (dir === "in") {
          zExpr = `${zBase.toFixed(6)}+(${easeExpr})*${spanEff}`;
          xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
        } else if (dir === "out") {
          zExpr = `${zMaxEff}-(${easeExpr})*${spanEff}`;
          xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
        } else {
          // Pan modes: constant zoom, window slides center → edge.
          zExpr = zMaxEff;
          if (dir === "right") { xExpr = `${maxX}/2*(1+(${easeExpr}))`; yExpr = `${maxY}/2`; }
          else if (dir === "left") { xExpr = `${maxX}/2*(1-(${easeExpr}))`; yExpr = `${maxY}/2`; }
          else if (dir === "down") { xExpr = `${maxX}/2`; yExpr = `${maxY}/2*(1+(${easeExpr}))`; }
          else if (dir === "up") { xExpr = `${maxX}/2`; yExpr = `${maxY}/2*(1-(${easeExpr}))`; }
          else { xExpr = `${maxX}/2`; yExpr = `${maxY}/2`; }
        }
      }

      // ── Build -vf: 1.1× supersampled cover + zoompan + subtitles ──
      const scaleW = Math.round(width * 1.1);
      const scaleH = Math.round(height * 1.1);
      const vfParts = [
        `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${scaleW}:${scaleH}`,
        `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps}`,
        `setsar=1`,
        `format=yuv420p`,
      ];

      if (captionsEnabled) {
        const doc = buildAssDocument(subtitleCues, captionSettings, width, height, segStartMs, segEndMs, seg.durationMs);
        if (doc) {
          const assPath = path.join(tempDir, `captions_${String(i).padStart(4, "0")}_${Date.now()}.ass`);
          fs.writeFileSync(assPath, doc, "utf-8");
          tempFiles.push(assPath);
          const escapedAssPath = assPath
            .replace(/\\/g, "/")
            .replace(/:/g, "\\:")
            .replace(/'/g, "\\'")
            .replace(/,/g, "\\,");
          vfParts.push(`subtitles=filename='${escapedAssPath}'`);
        }
      }

      const vf = vfParts.join(",");
      const clipPath = path.join(tempDir, `clip_${String(i).padStart(4, "0")}.mp4`);
      tempFiles.push(clipPath);
      clipPaths.push(clipPath);

      const args = [
        "-loop", "1",
        "-i", seg.imagePath,
        "-t", segDurSec.toFixed(3),
        "-vf", vf,
        ...encoderArgs(encoder.name, bitrateMbps, width, height),
        "-r", String(fps),
        "-threads", "0",
        "-y",
        clipPath,
      ];

      // Real-time progress: clip i covers [doneMs[i], doneMs[i]+dur] of the
      // master timeline. 95% of the bar is step 1, 5% step 2.
      const baseFrac = doneMs[0] / Math.max(1, totalMs);
      const segFrac = seg.durationMs / Math.max(1, totalMs);
      await runFfmpeg(args, segDurSec, (secInClip) => {
        const frac = baseFrac + segFrac * Math.min(1, secInClip / Math.max(0.01, segDurSec));
        sendProgress(frac * 95, (doneMs[0] + secInClip * 1000) / 1000, etaFor(frac));
      });

      doneMs[0] += seg.durationMs;
      cumulativeMs += seg.durationMs;
      sendProgress((doneMs[0] / Math.max(1, totalMs)) * 95, cumulativeMs / 1000, etaFor(doneMs[0] / Math.max(1, totalMs)));
    }

    // ─── STEP 2: Concat all clips + mux audio (INSTANT: -c copy) ───
    sendProgress(96, totalSec, etaFor(0.96));

    const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);
    tempFiles.push(concatListPath);

    const concatContent = clipPaths.map(p => {
      const safePath = p.replace(/\\/g, "/").replace(/'/g, "'\\''");
      return `file '${safePath}'`;
    }).join("\n");
    fs.writeFileSync(concatListPath, concatContent, "utf-8");

    const concatArgs = [
      "-f", "concat", "-safe", "0", "-i", concatListPath,
    ];
    if (audioPath) concatArgs.push("-i", audioPath);

    // ALWAYS -c copy for video (captions already burned in step 1)
    concatArgs.push("-c:v", "copy");

    if (audioPath) {
      // Audio chain: [normalize] → [fade in] → [fade out] → [pad to video length].
      // apad=whole_dur pads with silence exactly to the video duration so a
      // short track no longer TRUNCATES the exported video (and never hangs
      // the muxer the way bare `apad -shortest` can with stream copy).
      const af = [];
      if (audio?.normalize) af.push("loudnorm=I=-16:TP=-1.5:LRA=11");
      if (audio?.fadeInMs > 0) {
        af.push(`afade=t=in:st=0:d=${(audio.fadeInMs / 1000).toFixed(3)}`);
      }
      if (audio?.fadeOutMs > 0) {
        const start = Math.max(0, totalSec - audio.fadeOutMs / 1000);
        af.push(`afade=t=out:st=${start.toFixed(3)}:d=${(audio.fadeOutMs / 1000).toFixed(3)}`);
      }
      af.push(`apad=whole_dur=${totalSec.toFixed(3)}`);
      concatArgs.push("-af", af.join(","));
      concatArgs.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest");
    }

    concatArgs.push("-movflags", "+faststart", "-y", outputPath);

    await runFfmpeg(concatArgs, totalSec, (sec) => {
      const frac = 0.96 + 0.04 * Math.min(1, sec / Math.max(0.01, totalSec));
      sendProgress(frac, sec, etaFor(frac));
    });

    sendProgress(100, totalSec, 0);

    // Cleanup
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }

    let size = 0;
    try { size = fs.statSync(outputPath).size; } catch (_) {}
    return { path: outputPath, size, encoder: encoder.label };

  } catch (err) {
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }
    throw err;
  }
});

// App lifecycle
app.whenReady().then(() => {
  ensureTempDir();
  buildApplicationMenu();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
