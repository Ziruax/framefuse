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
  app, BrowserWindow, ipcMain, dialog, Menu, shell, utilityProcess,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

// v5.0: pure FFmpeg graph/arg builders (CommonJS, zero requires — also
// imported directly by /home/z/harness/export-graph-harness.js). Holds the
// transition tables + the v4.9 clip-argv builders (verbatim, moved here)
// plus the new video / overlay / chroma / SFX / parallel-pool graph math.
const G = require("./export-graph");

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
// v5.0: ALL live ffmpeg children (step-1 runs a parallel pool now). Cancel
// kills everything in the set; a leak guard at export end verifies the set
// is empty so no zombie encoders survive a failed/cancelled export.
const activeProcs = new Set();
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
    backgroundColor: "#0a0a0a", title: "FrameFuse v5.1",
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
      { label: "New Project", accelerator: "CmdOrCtrl+Alt+N", click: () => mainWindow && mainWindow.webContents.send("menu:new-project") },
      { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: () => mainWindow && mainWindow.webContents.send("menu:open-project") },
      { label: "Save Project", accelerator: "CmdOrCtrl+S", click: () => mainWindow && mainWindow.webContents.send("menu:save-project") },
      { label: "Save Project As…", accelerator: "CmdOrCtrl+Shift+S", click: () => mainWindow && mainWindow.webContents.send("menu:save-project-as") },
      { type: "separator" },
      { label: "Add Media…", click: () => mainWindow && mainWindow.webContents.send("menu:add-images") },
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
      { label: "About", click: () => { dialog.showMessageBox(mainWindow, { type: "info", title: "About", message: "FrameFuse v5.1", detail: "Multi-track video studio — video clips, chroma key, native Whisper captions, GPU-accelerated FFmpeg export.", buttons: ["OK"] }); } },
      { label: "Naming Guide", click: () => mainWindow && mainWindow.webContents.send("menu:naming-guide") },
    ]},
  ]));
}

// IPC helpers
ipcMain.handle("is-electron", () => true);

// Diagnostics — lets the renderer verify ffmpeg is reachable (v5.1: async —
// the old execSync blocked the main process up to 10 s on slow disks).
ipcMain.handle("ffmpeg-status", async () => {
  try {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return { ok: false, path: ffmpegPath || "(none)", version: null, error: "FFmpeg binary not found at expected path. Try reinstalling FrameFuse." };
    }
    const r = await ffmpegCapture(["-version"], 10000);
    const firstLine = r.out.split("\n")[0] || "";
    return {
      ok: r.code === 0,
      path: ffmpegPath,
      version: firstLine,
      error: r.code === 0 ? null : "FFmpeg did not respond in time.",
    };
  } catch (e) {
    return { ok: false, path: ffmpegPath || "(none)", version: null, error: e.message };
  }
});

// v5.1: encoder badge for the export UI (result of the async GPU probe).
ipcMain.handle("export-info", async () => {
  const enc = await detectGpuEncoderAsync();
  return { encoder: enc.label, encoderName: enc.name };
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

// v5.0: video sources for the multi-track timeline — same pattern as
// save-temp-audio (temp dir, unique name, write bytes, return path). The
// returned path feeds the base-lane video clips AND overlay compositing;
// cleanup-temp removes it with everything else in the dir.
ipcMain.handle("save-temp-video", async (_evt, { name, bytes }) => {
  ensureTempDir();
  const ext = path.extname(name) || ".mp4";
  const p = path.join(tempDir, `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
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

// ---------------------------------------------------------------------------
// v5.1 NATIVE PROJECT FILES — save/open dialogs + recents (userData).
// The renderer keeps its self-contained .framefuse.json document (media
// inlined); these handlers just give it NATIVE file dialogs, a current-path
// short-circuit for Cmd+S, and a persisted recents list for the menu.
// ---------------------------------------------------------------------------
function recentsPath() {
  return path.join(app.getPath("userData"), "framefuse-recent-projects.json");
}

function loadRecentProjects() {
  try {
    const raw = fs.readFileSync(recentsPath(), "utf-8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.path === "string" && fs.existsSync(e.path))
      .slice(0, 8);
  } catch (_) { return []; }
}

function saveRecentProjects(list) {
  try {
    fs.mkdirSync(path.dirname(recentsPath()), { recursive: true });
    fs.writeFileSync(recentsPath(), JSON.stringify(list, null, 2), "utf-8");
  } catch (_) { /* recents are best-effort */ }
}

function rememberProject(filePath) {
  const list = loadRecentProjects().filter((e) => e.path !== filePath);
  list.unshift({
    path: filePath,
    name: path.basename(filePath, path.extname(filePath)),
    savedAt: Date.now(),
  });
  saveRecentProjects(list.slice(0, 8));
}

function defaultProjectName(doc) {
  try {
    const name = doc && typeof doc.name === "string" && doc.name ? doc.name : "untitled";
    return name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
  } catch (_) { return "untitled"; }
}

async function saveProjectDialog(doc, currentPath) {
  let filePath = currentPath || null;
  if (!filePath) {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Save FrameFuse Project",
      defaultPath: `${defaultProjectName(doc)}.framefuse.json`,
      filters: [{ name: "FrameFuse Project", extensions: ["framefuse.json", "json"] }],
    });
    if (res.canceled || !res.filePath) return null;
    filePath = res.filePath;
    if (!/\.json$/i.test(filePath)) filePath += ".framefuse.json";
  }
  fs.writeFileSync(filePath, JSON.stringify(doc));
  rememberProject(filePath);
  return { path: filePath, name: path.basename(filePath, path.extname(filePath)) };
}

ipcMain.handle("project:save", async (_e, { doc, currentPath }) => {
  return saveProjectDialog(doc, currentPath || null);
});

ipcMain.handle("project:save-as", async (_e, { doc }) => {
  return saveProjectDialog(doc, null);
});

ipcMain.handle("project:open", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Open FrameFuse Project",
    properties: ["openFile"],
    filters: [{ name: "FrameFuse Project", extensions: ["framefuse.json", "json"] }],
  });
  if (res.canceled || !res.filePaths || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const doc = JSON.parse(raw);
    if (!doc || doc.app !== "framefuse") {
      throw new Error("Not a FrameFuse project file");
    }
    rememberProject(filePath);
    return { path: filePath, name: path.basename(filePath, path.extname(filePath)), doc };
  } catch (err) {
    throw new Error(`Could not open project: ${err.message}`);
  }
});

ipcMain.handle("project:recent", () => loadRecentProjects());

ipcMain.handle("project:remove-recent", (_e, { path: p }) => {
  saveRecentProjects(loadRecentProjects().filter((e) => e.path !== p));
  return true;
});

/** Kill one ffmpeg child (Windows needs taskkill for the whole tree). */
function killProc(proc) {
  try {
    if (!proc || proc.exitCode !== null || proc.signalCode) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", proc.pid, "/f", "/t"], { windowsHide: true });
    } else {
      proc.kill("SIGKILL");
    }
  } catch (_) { /* already gone */ }
}

/** Kill every live ffmpeg child (pool + step-2 mux). */
function killAllProcs() {
  for (const proc of Array.from(activeProcs)) killProc(proc);
}

/** Leak guard: an export must never leave ffmpeg children behind. */
function leakGuard() {
  if (activeProcs.size > 0) {
    console.warn(`[framefuse] export ended with ${activeProcs.size} ffmpeg process(es) still alive — killing`);
    killAllProcs();
  }
}

/** Async ffmpeg stdout/stderr capture — NEVER blocks the main process event
 *  loop (the v5.0 execSync/spawnSync probes froze the whole app). Resolves
 *  { code, out } with out = stdout+stderr concatenated; a timeout resolves
 *  code -1 with whatever was captured. */
function ffmpegCapture(args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    let out = "";
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, out, error: err.message });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { proc.kill("SIGKILL"); } catch (_) {}
      resolve({ code: -1, out, timeout: true });
    }, timeoutMs);
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { out += d.toString(); });
    proc.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, out, error: err.message });
    });
    proc.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

ipcMain.handle("cancel-export", async () => {
  try {
    killAllProcs();
    return true;
  } catch { return false; }
});

// ---------------------------------------------------------------------------
// v5.1 NATIVE WHISPER SERVICE (utilityProcess).
//
// The v5.0 renderer Web Worker broke in the PACKAGED app — webpack's worker
// chunk loader resolved chunk URLs relative to the worker script location
// and duplicated the `_next/static/chunks` prefix
// ("…app.asar/out/_next/static/chunks/_next/static/chunks/590caa2a….js"),
// so importScripts failed and every transcription errored. The native
// service fixes this at the root: NO renderer worker at all. Transformers.js
// + onnxruntime-node run in a utility process (native threads, disk model
// cache in userData — downloaded once, available forever).
// ---------------------------------------------------------------------------
const whisperChild = { proc: null, dead: true };
const whisperRuns = new Map(); // runId → { resolve, reject, sender, clientRunId? }
let whisperRunSeq = 0;

/** v5.2 whisper diagnostics state — surfaced by the whisper:status IPC so
 *  the Captions settings panel can show model/cache health at a glance. */
const whisperState = {
  lastError: null,
  lastErrorAt: 0,
  hostUsed: null,
};

function whisperCacheDir() {
  return path.join(app.getPath("userData"), "whisper-models");
}

function whisperChildEntry() {
  // Packaged: staged service at <resources>/whisper-service (extraResources,
  // outside asar so ESM imports + the native onnxruntime binding load).
  return app.isPackaged
    ? path.join(process.resourcesPath, "whisper-service", "whisper-child.js")
    : path.join(__dirname, "whisper-child.js");
}

function getWhisperChild() {
  if (whisperChild.proc && !whisperChild.dead) return whisperChild.proc;
  // v5.2: a cache-dir creation failure must NOT be silent — it is the #1
  // cause of "model downloaded but never reused" confusion.
  try {
    fs.mkdirSync(whisperCacheDir(), { recursive: true });
  } catch (err) {
    const message = `Could not create the Whisper model cache folder (${whisperCacheDir()}): ${
      err instanceof Error ? err.message : String(err)
    }`;
    whisperState.lastError = message;
    whisperState.lastErrorAt = Date.now();
    console.error("[whisper]", message);
  }
  const proc = utilityProcess.fork(whisperChildEntry(), [], {
    serviceName: "framefuse-whisper",
    stdio: "pipe",
  });
  whisperChild.proc = proc;
  whisperChild.dead = false;
  if (proc.stdout) proc.stdout.on("data", (d) => console.log("[whisper]", String(d).trim()));
  if (proc.stderr) proc.stderr.on("data", (d) => console.error("[whisper]", String(d).trim()));
  proc.on("message", onWhisperChildMessage);
  proc.on("exit", () => {
    whisperChild.proc = null;
    whisperChild.dead = true;
    const hadRuns = whisperRuns.size > 0;
    // Every pending run must fail fast — the UI can never hang.
    for (const [runId, run] of Array.from(whisperRuns)) {
      whisperRuns.delete(runId);
      run.reject(new Error("The Whisper service stopped unexpectedly. Please try again."));
    }
    // Only record a crash as lastError when work was actually in flight —
    // normal app-quit kills must not pollute the diagnostics view.
    if (hadRuns) {
      whisperState.lastError = "The Whisper service stopped unexpectedly. Please try again.";
      whisperState.lastErrorAt = Date.now();
    }
  });
  return proc;
}

/** Same curve the renderer's mapWorkerProgress applies (model/download
 *  10–25 %, transcribe 25–80 %) — computed here so the renderer stays a dumb
 *  relay. "download" events carry the same per-file percent as the paired
 *  "model" event (the child emits both), so they share the model band — no
 *  bar jitter, and the file name rides along in the status message. */
function mapWhisperProgress(stage, progress) {
  const p = Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress))) : 0;
  if (stage === "model" || stage === "download") return Math.round(10 + 15 * (p / 100));
  return Math.min(80, Math.max(25, p));
}

function sendWhisperProgress(runId, progress, status, extra) {
  const run = whisperRuns.get(runId);
  const wc = run && run.sender;
  if (wc && !wc.isDestroyed()) {
    wc.send("whisper:progress", { progress, status, ...(extra || {}) });
  }
}

function onWhisperChildMessage(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  // v5.2 diagnostics: which host/mirror served the model (has no runId).
  if (msg.type === "model-info") {
    if (typeof msg.host === "string") whisperState.hostUsed = msg.host;
    return;
  }
  if (msg.runId === -1) return; // "service-ready" ping from the child
  if (typeof msg.runId !== "number") return;
  const run = whisperRuns.get(msg.runId);
  if (!run) return; // stale (cancelled) — discard
  switch (msg.type) {
    case "progress": {
      const raw = msg.stage === "download" ? msg.percent : msg.progress;
      const progress = mapWhisperProgress(msg.stage, raw);
      // Pass the new download stage through so the renderer can show the
      // file name and rescale the band for standalone pre-downloads.
      const extra =
        msg.stage === "download"
          ? {
              stage: "download",
              file: typeof msg.file === "string" ? msg.file : undefined,
            }
          : { stage: typeof msg.stage === "string" ? msg.stage : undefined };
      sendWhisperProgress(msg.runId, progress, msg.status || "", extra);
      break;
    }
    case "result":
      whisperRuns.delete(msg.runId);
      // A successful run means the service is healthy again — clear stale
      // error diagnostics so the status row does not cry wolf.
      whisperState.lastError = null;
      whisperState.lastErrorAt = 0;
      run.resolve({
        chunks: msg.chunks ?? null,
        language: msg.language ?? null,
        wordLevel: !!msg.wordLevel,
      });
      break;
    case "error":
      whisperRuns.delete(msg.runId);
      whisperState.lastError = msg.message || "Whisper service failed";
      whisperState.lastErrorAt = Date.now();
      run.reject(new Error(msg.message || "Whisper service failed"));
      break;
    default:
      break;
  }
}

/** Decode any audio/video file to mono 16 kHz f32le PCM with ffmpeg —
 *  async + streamed, so the main process NEVER blocks. */
function decodeAudioToPcm16k(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-i", filePath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-f", "f32le", "pipe:1",
    ], { windowsHide: true });
    const chunks = [];
    let stderrTail = "";
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    proc.on("error", (err) => reject(new Error(err.message)));
    proc.on("exit", (code) => {
      if (code === 0) {
        const buf = Buffer.concat(chunks);
        const pcm = new Float32Array(Math.floor(buf.length / 4));
        for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readFloatLE(i * 4);
        resolve(pcm);
      } else {
        const detail = stderrTail.trim().split("\n").slice(-3).join(" ");
        reject(new Error(`Audio decode failed: ${detail || `ffmpeg exit ${code}`}`));
      }
    });
  });
}

ipcMain.handle("whisper:transcribe", async (event, payload) => {
  const { name, bytes, language } = payload || {};
  // v5.2: the renderer passes a client runId (crypto.randomUUID) so a cancel
  // can target THIS run without killing other queued runs.
  const clientRunId =
    payload && typeof payload.runId === "string" && payload.runId
      ? payload.runId
      : null;
  if (!bytes || !bytes.byteLength) throw new Error("No audio data received");
  ensureTempDir();
  const ext = path.extname(name || "") || ".audio";
  const tmp = path.join(tempDir, `whisper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(tmp, Buffer.from(bytes));
  const runId = ++whisperRunSeq;
  try {
    sendWhisperProgress(runId, 2, "Decoding audio…");
    const pcm = await decodeAudioToPcm16k(tmp);
    if (pcm.length === 0) throw new Error("Audio file is empty or silent");
    const durationMs = Math.round((pcm.length / 16000) * 1000);
    sendWhisperProgress(runId, 10, "Loading Whisper-tiny model…");

    const child = getWhisperChild();
    const result = await new Promise((resolve, reject) => {
      whisperRuns.set(runId, { resolve, reject, sender: event.sender, clientRunId });
      try {
        // Zero-copy: transfer the PCM buffer to the service.
        child.postMessage(
          { type: "transcribe", runId, pcm, sampleRate: 16000, language: language || "auto", cacheDir: whisperCacheDir() },
          [pcm.buffer],
        );
      } catch (err) {
        whisperRuns.delete(runId);
        reject(new Error(`Could not reach the Whisper service: ${err.message}`));
      }
    });
    sendWhisperProgress(runId, 80, "Aligning word timestamps…");
    return { ...result, durationMs };
  } finally {
    whisperRuns.delete(runId);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

ipcMain.handle("whisper:preload", async (event) => {
  const runId = ++whisperRunSeq;
  const child = getWhisperChild();
  return await new Promise((resolve, reject) => {
    whisperRuns.set(runId, { resolve: () => resolve({ ok: true }), reject, sender: event.sender });
    try {
      child.postMessage({ type: "preload", runId, cacheDir: whisperCacheDir() });
    } catch (err) {
      whisperRuns.delete(runId);
      reject(new Error(`Could not reach the Whisper service: ${err.message}`));
    }
  });
});

ipcMain.handle("whisper:cancel", async (_event, payload) => {
  const child = whisperChild.proc;
  const target =
    payload && typeof payload === "object" && typeof payload.runId === "string"
      ? payload.runId
      : null;
  if (target) {
    // v5.2: cancel ONE renderer run (by its client runId) — other queued
    // runs keep going. The child adds the numeric runId to its cancelled set
    // so a queued-but-unstarted job is skipped outright.
    for (const [runId, run] of Array.from(whisperRuns)) {
      if (run.clientRunId === target) {
        whisperRuns.delete(runId);
        try { if (child) child.postMessage({ type: "cancel", runId }); } catch (_) {}
        run.reject(new Error("Transcription cancelled"));
        return 1;
      }
    }
    return 0; // already finished / never started — nothing to cancel
  }
  // Legacy behavior (no argument): reject ALL pending runs.
  let cancelled = 0;
  for (const [runId, run] of Array.from(whisperRuns)) {
    whisperRuns.delete(runId);
    try { if (child) child.postMessage({ type: "cancel", runId }); } catch (_) {}
    run.reject(new Error("Transcription cancelled"));
    cancelled++;
  }
  return cancelled;
});

// ── v5.2 whisper:status — model cache diagnostics for the Captions panel ──

/** Recursive cache scan: [{ name (posix-relative), sizeBytes }] — the
 *  whisper cache holds ~7 small entries, so an unbounded walk is fine. */
function scanWhisperCache(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return; // missing dir → empty cache
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        files.push({
          name: path.relative(root, p).split(path.sep).join("/"),
          sizeBytes: fs.statSync(p).size,
        });
      } catch (_) {
        /* raced deletion — skip */
      }
    }
  };
  walk(root);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** modelReady heuristic: quantized (or fp32) ONNX encoder + merged decoder
 *  plus the config/tokenizer/preprocessor files transformers.js needs.
 *  Measured file set (verified by the 3-a sandbox smoke test):
 *    Xenova/whisper-tiny/config.json
 *    Xenova/whisper-tiny/generation_config.json
 *    Xenova/whisper-tiny/preprocessor_config.json
 *    Xenova/whisper-tiny/tokenizer.json + tokenizer_config.json
 *    Xenova/whisper-tiny/onnx/encoder_model_quantized.onnx     (~10.1 MB)
 *    Xenova/whisper-tiny/onnx/decoder_model_merged_quantized.onnx (~30.7 MB) */
function whisperModelReady(files) {
  const names = new Set(files.map((f) => f.name));
  const base = "Xenova/whisper-tiny";
  const has = (n) => names.has(`${base}/${n}`);
  const encoder =
    has("onnx/encoder_model_quantized.onnx") || has("onnx/encoder_model.onnx");
  const decoder =
    has("onnx/decoder_model_merged_quantized.onnx") ||
    has("onnx/decoder_model_merged.onnx");
  if (!encoder || !decoder) return false;
  // Guard against truncated/partial downloads: the ONNX pair must be
  // substantive (> 1 MB combined).
  const onnxBytes = files
    .filter((f) => f.name.startsWith(`${base}/onnx/`) && f.name.endsWith(".onnx"))
    .reduce((n, f) => n + f.sizeBytes, 0);
  if (onnxBytes < 1024 * 1024) return false;
  return (
    has("config.json") &&
    has("preprocessor_config.json") &&
    (has("tokenizer.json") || has("vocab.json"))
  );
}

ipcMain.handle("whisper:status", async () => {
  const cacheDir = whisperCacheDir();
  const cacheFiles = scanWhisperCache(cacheDir);
  const totalCacheBytes = cacheFiles.reduce((n, f) => n + f.sizeBytes, 0);
  return {
    cacheDir,
    hostUsed: whisperState.hostUsed,
    modelReady: whisperModelReady(cacheFiles),
    cacheFiles,
    totalCacheBytes,
    lastError: whisperState.lastError,
    childAlive: !!(whisperChild.proc && !whisperChild.dead),
    activeRuns: whisperRuns.size,
  };
});

// ---------------------------------------------------------------------------
// GPU encoder detection + RUNTIME PROBE.
// Listing an encoder isn't enough (drivers can be broken) — we actually
// encode 3 tiny test frames. Falls back to libx264 on any failure.
// ---------------------------------------------------------------------------
let detectedEncoder = null;      // resolved value (session cache)
let encoderDetecting = null;     // in-flight promise

// v5.1: ALL detection is ASYNC (spawn, never execSync). The v5.0 code ran
// execSync listEncoders + probeEncoder inside the export handler — up to
// 25 s of a COMPLETELY FROZEN main process (no window events, no IPC) before
// the first frame encoded. Detection now runs once at app start (warm) and
// the export handler just awaits the cached promise.

/** Async encoder list — parse the full -encoders table. */
async function listEncodersAsync() {
  const r = await ffmpegCapture(["-hide_banner", "-encoders"], 10000);
  if (r.code !== 0) return [];
  const out = r.out;
  const order = [
    { name: "h264_nvenc", label: "NVIDIA NVENC" },
    { name: "h264_qsv", label: "Intel QSV" },
    { name: "h264_amf", label: "AMD AMF" },
  ];
  return order.filter((e) => out.includes(e.name));
}

/** Runtime probe — actually encode 3 tiny test frames. Listed ≠ working
 * (drivers can be broken), and a listed-but-broken NVENC must not hide a
 * perfectly good AMF/QSV — every listed candidate is probed in order. */
async function probeEncoderAsync(name) {
  const r = await ffmpegCapture([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30:d=0.1",
    "-frames:v", "3", "-c:v", name, "-f", "null", "-",
  ], 15000);
  return r.code === 0;
}

async function detectGpuEncoderAsync() {
  if (detectedEncoder) return detectedEncoder;
  if (encoderDetecting) return encoderDetecting;
  encoderDetecting = (async () => {
    let pick = { name: "libx264", label: "CPU (libx264)" };
    try {
      const candidates = await listEncodersAsync();
      for (const cand of candidates) {
        if (await probeEncoderAsync(cand.name)) { pick = cand; break; }
      }
    } catch (_) { /* fall back to CPU */ }
    detectedEncoder = pick;
    console.log("Export encoder:", pick.label, `(${pick.name})`);
    return pick;
  })();
  return encoderDetecting;
}

/** Build encoder args for a quality-first, speed-optimized encode.
 * v4.5: the `quality` profile ("draft" | "social" | "cinema" | "custom")
 * drives CRF/cq + the encoder speed preset; `crf` is the explicit target
 * used when quality === "custom". "social" keeps the exact v4.4 behavior. */
const QUALITY_ENCODER = {
  draft:  { crf: 27, x264: "veryfast", nvencPreset: "p1", nvencCq: 27, qsvQ: 27, amfI: 26, amfP: 28 },
  social: { crf: 20, x264: "veryfast", nvencPreset: "p4", nvencCq: 23, qsvQ: 23, amfI: 22, amfP: 24 },
  cinema: { crf: 17, x264: "medium",   nvencPreset: "p6", nvencCq: 19, qsvQ: 19, amfI: 19, amfP: 21 },
};

function encoderArgs(encoderName, bitrateMbps, width, height, quality, crf) {
  const q = QUALITY_ENCODER[quality] || QUALITY_ENCODER.social;
  const crfVal = quality === "custom" ? Math.max(14, Math.min(30, Number(crf) || 20)) : q.crf;
  switch (encoderName) {
    case "h264_nvenc":
      // Constant-quality mode: visually lossless-to-high quality, no wasted bits.
      return ["-c:v", "h264_nvenc", "-preset", q.nvencPreset, "-tune", "hq", "-rc", "vbr", "-cq", String(quality === "custom" ? crfVal : q.nvencCq), "-b:v", "0", "-maxrate", `${Math.round((bitrateMbps || 8) * 1.5)}M`, "-bufsize", `${Math.round((bitrateMbps || 8) * 3)}M`, "-pix_fmt", "yuv420p"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", String(quality === "custom" ? crfVal : q.qsvQ), "-look_ahead", "0", "-pix_fmt", "yuv420p"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", quality === "cinema" ? "quality" : "balanced", "-rc", "vbr_peak", "-qp_i", String(quality === "custom" ? crfVal : q.amfI), "-qp_p", String((quality === "custom" ? crfVal : q.amfP) + 2), "-b:v", `${bitrateMbps || 8}M`, "-pix_fmt", "yuv420p"];
    default:
      // libx264: profile preset balances speed vs compression efficiency.
      // "social"/"draft" = veryfast (2× ultrafast at much better quality per
      // bit); "cinema" = medium for the maximum-quality master.
      return ["-c:v", "libx264", "-preset", quality === "cinema" ? q.x264 : "veryfast", "-crf", String(crfVal), "-pix_fmt", "yuv420p"];
  }
}

// Helper: run ffmpeg and wait. `totalSec` enables real-time progress via
// stderr "time=" parsing; `onTime` receives fractional seconds. Every live
// child registers itself in `activeProcs` so cancel-export / pool failure /
// the leak guard can kill the WHOLE set (v4.9 killed a single child).
function runFfmpeg(args, totalSec, onTime) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    activeProcs.add(proc);
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
    proc.on("error", (err) => { activeProcs.delete(proc); reject(new Error(err.message)); });
    proc.on("exit", (code, signal) => {
      activeProcs.delete(proc);
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
// v5.0 media probing — `ffmpeg -i <path>` stderr parsed once per file
// (audio-stream detection + effective display dimensions). Cached by path:
// temp names are unique per export, so the cache is a session-wide memo.
// ---------------------------------------------------------------------------
const probeCache = new Map();

/** v5.1: ASYNC media probe (`ffmpeg -i <path>` stderr parsed once per file,
 * cached). The v5.0 spawnSync version blocked the ENTIRE main process for
 * up to 15 s per file, sequentially — with a handful of imported videos the
 * app visibly froze before the first encode. All probes are now warmed in
 * PARALLEL before the job loop (see export-native).
 * NOTE: `ffmpeg -i` alone exits 1 ("at least one output file") — the probe
 * data lives on stderr, which ffmpegCapture concatenates into `out`, so the
 * parser runs regardless of the exit code. */
function probeMediaAsync(p) {
  if (typeof p !== "string" || !p) {
    return Promise.resolve({ hasAudio: false, width: 0, height: 0 });
  }
  if (probeCache.has(p)) return Promise.resolve(probeCache.get(p));
  const job = (async () => {
    let info = { hasAudio: false, width: 0, height: 0 };
    try {
      const r = await ffmpegCapture(["-hide_banner", "-i", p], 15000);
      const parsed = G.videoProbeParser(r.out);
      info = { hasAudio: parsed.hasAudio, width: parsed.width, height: parsed.height };
    } catch (_) { /* unreadable source → treated as silent/unknown dims */ }
    probeCache.set(p, info);
    return info;
  })();
  // On failure cache the fallback synchronously so retries don't re-probe.
  job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------------------
// v5.0 PARALLEL step-1 pool — clips encode in a worker pool of
// min(4, max(1, cpus − 2)) concurrent ffmpeg children (spawn, not exec).
// Any failure fails the whole export (with the clip index in the message)
// and kills all siblings; cancellation surfaces as the v4.9
// "Export cancelled" error verbatim.
// ---------------------------------------------------------------------------
async function runPool(jobs, workerCount, cbs) {
  let next = 0;
  let aborted = false;
  const failures = [];
  const killSiblings = () => {
    if (!aborted) {
      aborted = true;
      killAllProcs();
    }
  };
  const workers = Array.from({ length: Math.max(1, workerCount) }, () =>
    (async () => {
      while (!aborted) {
        const idx = next;
        next += 1;
        if (idx >= jobs.length) return;
        try {
          await runFfmpeg(jobs[idx].args, jobs[idx].durSec, (sec) => cbs.onTime(idx, sec));
          cbs.onDone(idx);
        } catch (err) {
          killSiblings();
          failures.push({ idx, err });
          return;
        }
      }
    })(),
  );
  await Promise.all(workers);
  if (failures.length > 0) {
    const { idx, err } = failures[0];
    if (err && err.message === "Export cancelled") throw err;
    const seg = jobs[idx] && jobs[idx].segId ? ` (segment "${jobs[idx].segId}")` : "";
    throw new Error(`Failed to encode clip ${idx + 1} of ${jobs.length}${seg}: ${(err && err.message) || err}`);
  }
}

// ---------------------------------------------------------------------------
// ASS builder — shared by the export burn-in AND the .ass sidecar export.
// Mirrors src/lib/merger/captionAnimations.ts so preview == export.
// ---------------------------------------------------------------------------

const ANIM = {
  POP_IN_MS: 220, SLIDE_UP_MS: 280, BOUNCE_IN_MS: 380, REVEAL_MS: 320,
  SHAKE_MS: 280, TYPEWRITER_MS_PER_CHAR: 45, SLAM_MS: 180, GLITCH_MS: 220,
  SPIN_IN_MS: 300, FLIP_IN_MS: 260, ELASTIC_MS: 450, ZOOM_WORDS_MS: 160,
  SQUASH_MS: 340, TRACKING_IN_MS: 300, BLUR_IN_MS: 260, HEARTBEAT_MS: 640,
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
    case "tracking-in": {
      if (karaoke) {
        // \fsp would leak across the line's word layout — approximate with
        // a tight pop (mirrors captionAnimations.ts).
        blocks.push(`{\\fscx92\\fscy92\\alpha&HFF&}`);
        blocks.push(`{\\t(0,${ANIM.TRACKING_IN_MS},\\fscx100\\fscy100\\alpha&H00&)}`);
      } else {
        const sp = Math.max(1, Math.round(8 * chScale));
        blocks.push(`{\\fsp${sp}\\alpha&HE6&}`);
        blocks.push(`{\\t(0,${ANIM.TRACKING_IN_MS},\\fsp0\\alpha&H00&)}`);
      }
      break;
    }
    case "blur-in": {
      blocks.push(`{\\fscx118\\fscy118\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(ANIM.BLUR_IN_MS * 0.7)},\\fscx104\\fscy104\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(ANIM.BLUR_IN_MS * 0.7)},${ANIM.BLUR_IN_MS},\\fscx100\\fscy100)}`);
      break;
    }
    case "heartbeat": {
      const b1 = Math.round(ANIM.HEARTBEAT_MS * 0.28);
      const rest = Math.round(ANIM.HEARTBEAT_MS * 0.5);
      const b2 = Math.round(ANIM.HEARTBEAT_MS * 0.78);
      blocks.push(`{\\t(0,${Math.round(b1 / 2)},\\fscx114\\fscy114)}`);
      blocks.push(`{\\t(${Math.round(b1 / 2)},${b1},\\fscx100\\fscy100)}`);
      blocks.push(`{\\t(${rest},${Math.round(rest + (b2 - rest) / 2)},\\fscx108\\fscy108)}`);
      blocks.push(`{\\t(${Math.round(rest + (b2 - rest) / 2)},${b2},\\fscx100\\fscy100)}`);
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

// ---------------------------------------------------------------------------
// HEADLINE PRESETS — mirror of src/lib/merger/headlinePresets.ts so the
// exported ASS headline styles match the canvas preview exactly.
// ---------------------------------------------------------------------------

const HEADLINE_PRESETS = {
  impact: {
    ffmpegName: "Impact", fontSize: 0.085, fontWeight: 900, italic: false,
    textColor: "#FFFFFF", accentColor: null, bgColor: null, bgAlpha: 1,
    borderColor: "#000000", borderWidth: 6, shadow: true,
    shadowColor: "#000000", shadowBlur: 12, textTransform: "uppercase",
    letterSpacing: 2, positionY: 90, maxWidth: 0.86,
  },
  neon: {
    ffmpegName: "Segoe UI", fontSize: 0.062, fontWeight: 800, italic: false,
    textColor: "#67E8F9", accentColor: "#E879F9", bgColor: null, bgAlpha: 1,
    borderColor: "#0E7490", borderWidth: 2, shadow: true,
    shadowColor: "#D946EF", shadowBlur: 22, textTransform: "uppercase",
    letterSpacing: 4, positionY: 100, maxWidth: 0.84,
  },
  sticker: {
    ffmpegName: "Segoe UI", fontSize: 0.056, fontWeight: 900, italic: false,
    textColor: "#1C1917", accentColor: "#F59E0B", bgColor: "#FBBF24", bgAlpha: 1,
    borderColor: "#78350F", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 10, textTransform: "uppercase",
    letterSpacing: 1, positionY: 96, maxWidth: 0.8,
  },
  serif: {
    ffmpegName: "Georgia", fontSize: 0.055, fontWeight: 400, italic: true,
    textColor: "#F5F5F4", accentColor: null, bgColor: null, bgAlpha: 1,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "none",
    letterSpacing: 1, positionY: 110, maxWidth: 0.82,
  },
  banner: {
    ffmpegName: "Segoe UI", fontSize: 0.05, fontWeight: 700, italic: false,
    textColor: "#FFFFFF", accentColor: "#34D399", bgColor: "#0F0F12", bgAlpha: 0.72,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "none",
    letterSpacing: 2, positionY: 100, maxWidth: 0.86,
  },
};

function getHeadlinePreset(id) {
  return HEADLINE_PRESETS[id] || HEADLINE_PRESETS.impact;
}

/**
 * Entrance tags for one headline item — mirror of headlineTransform() in
 * native.ts so the burn-in matches the preview.
 */
function headlineAnimTags(animation, ch) {
  const chScale = ch / 1080;
  switch (animation) {
    case "fade":
      return `{\\fad(300,300)}`;
    case "slide-up": {
      const dy = Math.max(2, Math.round(34 * chScale));
      return `{\\move(0,${dy},0,0,0,280)\\fad(180,0)}`;
    }
    case "pop":
      return `{\\fscx60\\fscy60\\alpha&HFF&\\t(0,182,\\fscx112\\fscy112\\alpha&H00&)\\t(182,260,\\fscx100\\fscy100)}${""}\\fad(0,300)`;
    case "zoom-punch":
      return `{\\fscx200\\fscy200\\alpha&HFF&\\t(0,200,\\fscx100\\fscy100\\alpha&H00&)\\fad(0,300)}`;
    default:
      return `{\\fad(0,300)}`;
  }
}

/**
 * Build the Headline styles + Dialogue lines (clipped to the segment
 * window, times relative to the window start). Returns
 * { styleLines, eventLines } — the caller places the styles inside
 * [V4+ Styles] and the events inside [Events]. Layer 1 so headlines
 * render above caption lines.
 */
function buildHeadlineEvents(headlines, width, height, winStart, winEnd, clampDur) {
  const styleLines = [];
  const eventLines = [];
  const hScale = height / 1080;

  for (const item of headlines) {
    if (!item || !item.text) continue;
    if (item.endMs <= winStart || item.startMs >= winEnd) continue;
    const relStart = Math.max(0, item.startMs - winStart);
    const relEnd = Math.min(clampDur, item.endMs - winStart);
    if (relEnd <= relStart) continue;

    const p = getHeadlinePreset(item.presetId);
    const sizeScale = item.sizeScale || 1;
    const fontSize = Math.max(10, Math.round(p.fontSize * height * sizeScale));
    const positionY = Math.round(p.positionY * hScale);
    const bold = p.fontWeight >= 600 ? -1 : 0;
    const italic = p.italic ? -1 : 0;
    // Alignment: 8=top-center, 5=middle-center, 2=bottom-center.
    const alignment = item.position === "top" ? 8 : item.position === "center" ? 5 : 2;
    const borderStyle = p.bgColor ? 3 : 1;
    const outline = p.bgColor ? 0 : Math.max(0, Math.round(p.borderWidth));
    const shadowVal = p.shadow ? Math.max(1, Math.round(p.shadowBlur / 2)) : 0;
    const backColour = p.bgColor
      ? hexToAssColor(p.bgColor, p.bgAlpha)
      : hexToAssColor(p.accentColor || p.shadowColor || "#000000", 0.55);
    const marginLR = Math.round((width * (1 - p.maxWidth)) / 2);
    const spacing = Math.round((p.letterSpacing || 0) * hScale * 10) / 10;

    styleLines.push(
      `Style: Headline,${p.ffmpegName},${fontSize},${hexToAssColor(p.textColor)},${hexToAssColor(p.textColor)},${hexToAssColor(p.borderColor || p.textColor)},${backColour},${bold},${italic},0,0,100,100,${spacing},0,${borderStyle},${outline},${shadowVal},${alignment},${marginLR},${marginLR},${positionY},1`,
    );

    let text = String(item.text);
    if (p.textTransform === "uppercase") text = text.toUpperCase();
    const tags = headlineAnimTags(item.animation, height);
    eventLines.push(
      `Dialogue: 1,${assFmtTime(relStart / 1000)},${assFmtTime(relEnd / 1000)},Headline,,0,0,0,,${tags}${escapeAssText(text)}`,
    );
  }
  return { styleLines, eventLines, count: eventLines.length };
}

/**
 * Build the full ASS document for a set of cues on the master timeline,
 * with cue times SHIFTED to be relative to [segStartMs, segEndMs] and
 * clamped to [0, segDurMs]. When segStartMs/segEndMs are omitted the
 * cues are emitted with their absolute (master timeline) times — used
 * for the .ass sidecar export.
 *
 * Headlines (v4.2): when `headlines` is a non-empty array, a Headline
 * style + one Dialogue per item are appended (Layer 1, above captions).
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
function buildAssDocument(cues, cs, headlines, width, height, segStartMs, segEndMs, segDurMs) {
  const hasHeadlines = Array.isArray(headlines) && headlines.some((h) => h && h.text);
  if (!cs && !hasHeadlines) return null;

  const fontName = (cs && cs.fontName) || "Arial";
  const fontSize = Math.round(((cs && cs.fontSize) || 0.05) * height * ((cs && cs.fontSizeScale) || 1));
  const textColor = (cs && cs.textColor) || "#FFFFFF";
  const highlightColor = (cs && cs.highlightColor) || null;
  const wordMode = (cs && cs.wordMode) || "off";
  const animation = (cs && cs.animation) || "none";
  const karaoke = wordMode === "word";

  const position = (cs && (cs.customPosition || cs.position)) || "bottom";
  const marginV = cs && cs.positionY != null ? cs.positionY : 50;
  const fontWeight = (cs && cs.fontWeight) || 600;
  const bold = fontWeight >= 600 ? -1 : 0;
  const italic = ((cs && cs.fontStyle) || "normal") === "italic" ? -1 : 0;
  const bgColor = (cs && cs.bgColor) || null;
  const bgAlpha = cs && cs.bgAlpha != null ? cs.bgAlpha : 1;
  const borderColor = (cs && cs.borderColor) || "#000000";
  const borderWidth = cs && cs.borderWidth != null ? cs.borderWidth : 2;
  const shadow = !!(cs && cs.shadow);
  const shadowColor = (cs && cs.shadowColor) || "#000000";
  const shadowBlur = cs && cs.shadowBlur != null ? cs.shadowBlur : 3;
  const textTransform = (cs && cs.textTransform) || "none";
  const spacing = (cs && cs.letterSpacing) || 0;
  const alignment = (cs && cs.alignment) || "center";

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

  const useSegmentWindow = typeof segStartMs === "number" && typeof segDurMs === "number";
  const winStart = useSegmentWindow ? segStartMs : 0;
  const winEnd = useSegmentWindow ? segEndMs : Infinity;
  const clampDur = useSegmentWindow ? segDurMs : Infinity;

  // ── Headline overlay styles + events (v4.2, Layer 1) ──
  const headline = hasHeadlines
    ? buildHeadlineEvents(headlines, width, height, winStart, winEnd, clampDur)
    : { styleLines: [], eventLines: [], count: 0 };

  // [V4+ Styles] — Default (captions) + Headline styles.
  if (cs) {
    assLines.push(`Style: Default,${fontName},${fontSize},${hexToAssColor(primary)},${hexToAssColor(secondary)},${hexToAssColor(borderColor)},${backColour},${bold},${italic},0,0,100,100,${spacing},0,${borderStyle},${outline},${shadowVal},${assAlignment},40,40,${marginV},1`);
  }
  assLines.push(...headline.styleLines);
  assLines.push("");
  assLines.push("[Events]");
  assLines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
  assLines.push(...headline.eventLines);

  let emitted = headline.count;

  if (!cs || !Array.isArray(cues) || cues.length === 0) {
    return emitted > 0 ? assLines.join("\n") : null;
  }

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
    const { cues, captionSettings, headlines, width, height } = opts;
    const hasHl = Array.isArray(headlines) && headlines.length > 0;
    if ((!cues || cues.length === 0) && !hasHl) return null;
    const doc = buildAssDocument(cues || [], captionSettings, headlines, width, height, null, null, null);
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
// Step 1: Encode each segment → MP4 clip with zoompan + ASS subtitles burn-in
//         (+ v4.3 segment transitions: xfade head composites / dip fades;
//          v5.0: VIDEO sources, overlay compositing, chroma key, per-clip
//          audio tracks, PARALLEL encode pool)
// Step 2: Concat all clips + mux audio using -f concat -c copy (INSTANT)
//
// v5.0 NOTE: the transition tables (XFADE_NAMES / DIP_COLORS / clampTrMs /
// frozenZoompanExpr) and the full per-clip argv builder live in
// ./export-graph.js (pure CommonJS — shared with the test harness).
// ---------------------------------------------------------------------------

ipcMain.handle("export-native", async (event, opts) => {
  const { outputPath, fps, width, height, bitrateMbps, quality, crf, kenBurns, segments, audioPath, audio, captionSettings, subtitleCues, headlines, transition, watermark, overlays, sfx } = opts;

  if (!outputPath) throw new Error("No output path");
  if (!segments || segments.length === 0) throw new Error("No segments");

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error("FFmpeg not found. The bundled FFmpeg binary is missing or corrupted. Please reinstall FrameFuse. Expected at: " + ffmpegPath);
  }

  // v4.4 watermark: { imagePath, x, y, w, h, opacity } — geometry computed
  // ONCE in the renderer process (watermarkGeometry) so preview + export
  // can never disagree. The chain (scale → setsar → rgba →
  // colorchannelmixer=aa → overlay) lives in export-graph.buildClipArgs.
  const wm =
    watermark && watermark.imagePath && Number(watermark.w) > 0
      ? {
          imagePath: watermark.imagePath,
          x: Math.round(Number(watermark.x) || 0),
          y: Math.round(Number(watermark.y) || 0),
          w: Math.round(Number(watermark.w)),
          h: Math.round(Number(watermark.h) || watermark.w),
          opacity: Math.max(0.05, Math.min(1, Number(watermark.opacity) || 1)).toFixed(3),
        }
      : null;

  const intensity = Math.max(0, Math.min(100, Number(kenBurns?.intensity) || 0));
  const zoomMax = 1.06 + (intensity / 100) * 0.18;
  const enabled = !!kenBurns?.enabled;
  const globalDir = kenBurns?.direction || "in";

  const captionsEnabled = !!captionSettings?.enabled && subtitleCues && subtitleCues.length > 0;
  const headlinesEnabled = Array.isArray(headlines) && headlines.some((h) => h && h.text && h.endMs > h.startMs);
  const totalMs = segments.reduce((sum, s) => Math.max(sum, s.endMs ?? (s.startMs ?? 0) + s.durationMs), 0) || segments.reduce((sum, s) => sum + s.durationMs, 0);
  const totalSec = totalMs / 1000;
  // v5.1: async warm-started GPU detection — the handler NEVER blocks the
  // main process before the first frame (was: execSync up to 25 s).
  const encoder = await detectGpuEncoderAsync();

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
    // ─── v5.0 media resolution: overlays + SFX + audio mode ─────────
    // Overlays (track ≥ 1) are NOT concat clips — they composite on top of
    // whichever base clip their window intersects, in track→startMs order
    // (the preview draw order). SFX items arrive as already-rendered temp
    // WAVs (native.ts uploads them via saveTempAudio).
    const overlaySegs = (Array.isArray(overlays) ? overlays : [])
      .filter((ov) => ov && (ov.imagePath || ov.videoPath))
      .slice()
      .sort(
        (a, b) =>
          (Number(a.track) || 0) - (Number(b.track) || 0) ||
          (Number(a.startMs) || 0) - (Number(b.startMs) || 0),
      );
    const sfxList = (Array.isArray(sfx) ? sfx : []).filter(
      (s) => s && typeof s.wavPath === "string" && s.wavPath,
    );

    // Base-lane validation: a VIDEO segment must carry its temp file.
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s && s.mediaType === "video" && !s.videoPath && !s.imagePath) {
        throw new Error(`Segment ${i + 1} is a video but has no source file`);
      }
    }

    // v5 AUDIO MODE: the new amix graph runs when CLIP audio actually
    // participates — any BASE video with an audio stream (detected by
    // probing the temp file's stderr) or any SFX placement. A music-only
    // v4.9-shaped project keeps the EXACT v4.9 mux path; a project with no
    // audio at all keeps the video-only concat (both byte-identical).
    //
    // v5.1 PERF: every needed media probe is warmed in PARALLEL here (async
    // spawn) — the job loop below then reads everything from the cache. The
    // v5.0 code probed sequentially with spawnSync, freezing the app.
    const probePaths = new Set();
    for (const s of segments) {
      if (s && s.mediaType === "video" && s.videoPath) probePaths.add(s.videoPath);
    }
    for (const ov of overlaySegs) {
      const p = ov.mediaType === "video" && ov.videoPath ? ov.videoPath : ov.imagePath;
      if (p && !(Number(ov.sourceWidth) > 0 && Number(ov.sourceHeight) > 0)) {
        probePaths.add(p);
      }
    }
    await Promise.all(Array.from(probePaths).map((p) => probeMediaAsync(p)));

    let anyVideoAudio = false;
    for (const s of segments) {
      if (s && s.mediaType === "video" && s.videoPath) {
        if ((await probeMediaAsync(s.videoPath)).hasAudio) { anyVideoAudio = true; break; }
      }
    }
    const anyAudio = sfxList.length > 0 || anyVideoAudio;

    // ─── STEP 1 (build): probes → per-clip argv jobs ───────────────
    // v4.3 transition planning + zoompan math + all three v4.9 branches
    // (xfade head / watermark graph / plain -vf) live in
    // G.buildClipArgs — byte-identical for v4.9-shaped payloads.
    const jobs = [];
    const clipPaths = [];
    let cumulativeMs = 0;
    const encArgs = encoderArgs(encoder.name, bitrateMbps, width, height, quality, crf);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const clipPath = path.join(tempDir, `clip_${String(i).padStart(4, "0")}.mp4`);
      tempFiles.push(clipPath);
      clipPaths.push(clipPath);

      const segStartMs = (typeof seg.startMs === "number") ? seg.startMs : cumulativeMs;
      const segEndMs = (typeof seg.endMs === "number") ? seg.endMs : (cumulativeMs + seg.durationMs);

      let assDoc = null;
      if (captionsEnabled || headlinesEnabled) {
        assDoc = buildAssDocument(
          captionsEnabled ? subtitleCues : [],
          captionsEnabled ? captionSettings : null,
          headlinesEnabled ? headlines : null,
          width, height, segStartMs, segEndMs, seg.durationMs,
        );
      }

      const assSuffix = assDoc
        ? (() => {
            const assPath = path.join(tempDir, `captions_${String(i).padStart(4, "0")}_${Date.now()}.ass`);
            fs.writeFileSync(assPath, assDoc, "utf-8");
            tempFiles.push(assPath);
            const escapedAssPath = assPath
              .replace(/\\/g, "/")
              .replace(/:/g, "\\:")
              .replace(/'/g, "\\'")
              .replace(/,/g, "\\,");
            return `subtitles=filename='${escapedAssPath}'`;
          })()
        : null;

      // v5 overlay specs for THIS clip window: every overlay whose
      // [startMs, endMs) intersects [segStartMs, segStartMs + dur). Source
      // dims prefer the payload (image natural dims shipped by native.ts),
      // else probed from the file. Geometry mirrors renderer.overlayGeometry.
      const overlaySpecs = [];
      for (const ov of overlaySegs) {
        const win = G.overlayWindow(ov, segStartMs, seg.durationMs);
        if (!win || win.overlapMs <= 0) continue;
        const isVid = ov.mediaType === "video" && ov.videoPath;
        const srcPath = isVid ? ov.videoPath : ov.imagePath;
        let srcW = Number(ov.sourceWidth) > 0 ? Number(ov.sourceWidth) : 0;
        let srcH = Number(ov.sourceHeight) > 0 ? Number(ov.sourceHeight) : 0;
        if (!srcW || !srcH) {
          const probe = await probeMediaAsync(srcPath);
          srcW = probe.width;
          srcH = probe.height;
        }
        const geo = G.overlayGeometryMirror(width, height, srcW, srcH, ov.overlay);
        if (geo.dw <= 0 || geo.dh <= 0) continue;
        overlaySpecs.push({
          inputArgs: isVid
            ? G.buildOverlayVideoInputArgs({ ssMs: win.ssMs, durMs: win.overlapMs, path: srcPath })
            : G.buildOverlayImageInputArgs({ durMs: win.overlapMs, path: srcPath }),
          x: geo.dx,
          y: geo.dy,
          dw: geo.dw,
          dh: geo.dh,
          chroma: ov.chroma || null,
          a: win.a,
          b: win.b,
        });
      }

      const segHasAudio = !!(
        seg.mediaType === "video" &&
        seg.videoPath &&
        (await probeMediaAsync(seg.videoPath)).hasAudio
      );

      const built = G.buildClipArgs({
        i,
        seg,
        segments,
        fps,
        width,
        height,
        kbEnabled: enabled,
        zoomMax,
        globalDir,
        transition,
        wm,
        assSuffix,
        clipPath,
        encArgs,
        anyAudio,
        segHasAudio,
        overlaySpecs,
        // v5.1: hardware DECODE for base video clips (d3d11va on Windows,
        // auto-detected; silently falls back to software when unavailable —
        // the filters still run on CPU, ffmpeg copies frames across).
        hwaccel: true,
      });

      jobs.push({
        idx: i,
        args: built.args,
        durSec: seg.durationMs / 1000,
        durationMs: seg.durationMs,
        segId: seg.id,
      });
      cumulativeMs += seg.durationMs;
    }

    // ─── STEP 1 (run): PARALLEL encode pool — the v5 PERF core ─────
    // N = min(4, max(1, os.cpus() − 2)) concurrent ffmpeg children
    // (child_process.spawn). Per-clip "time=" marks aggregate into the
    // SAME export-progress channel + payload shape the UI already
    // consumes, weighted by clip duration on the master timeline.
    const poolN = Math.min(4, Math.max(1, os.cpus().length - 2));
    const clipFrac = jobs.map(() => 0);
    let lastEmit = 0;
    const emitProgress = (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < 100) return; // ≤10 Hz progress IPC
      lastEmit = now;
      let doneMs = 0;
      for (let k = 0; k < jobs.length; k++) doneMs += clipFrac[k] * jobs[k].durationMs;
      const frac = doneMs / Math.max(1, totalMs);
      sendProgress(frac * 95, doneMs / 1000, etaFor(frac));
    };
    await runPool(jobs, poolN, {
      onTime: (idx, sec) => {
        clipFrac[idx] = Math.min(1, sec / Math.max(0.01, jobs[idx].durSec));
        emitProgress(false);
      },
      onDone: (idx) => {
        clipFrac[idx] = 1;
        emitProgress(true);
      },
    });

    // ─── STEP 2: Concat all clips + mux audio (INSTANT: -c copy) ───
    sendProgress(96, totalSec, etaFor(0.96));

    const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);
    tempFiles.push(concatListPath);

    const concatContent = clipPaths.map(p => {
      const safePath = p.replace(/\\/g, "/").replace(/'/g, "'\\''");
      return `file '${safePath}'`;
    }).join("\n");
    fs.writeFileSync(concatListPath, concatContent, "utf-8");

    // v5: G.buildConcatArgs keeps the v4.9 mux argv byte-identical for
    // music-only / no-audio projects and emits the amix graph (clip audio
    // + music + adelay'd SFX → apad) when the new audio mode is active.
    const concatArgs = G.buildConcatArgs({
      concatListPath,
      audioPath,
      audio,
      outputPath,
      totalSec,
      sfx: sfxList,
      newAudioGraph: anyAudio,
    });

    await runFfmpeg(concatArgs, totalSec, (sec) => {
      const frac = 0.96 + 0.04 * Math.min(1, sec / Math.max(0.01, totalSec));
      // v5 fix (pre-existing v4.9 bug): sendProgress takes PERCENT — the old
      // code passed the 0.96..1.0 fraction, so the bar dipped 96 → ~1 → 100
      // during the mux. Payload shape (progress/fps/eta/timemark) unchanged.
      sendProgress(frac * 100, sec, etaFor(frac));
    });

    sendProgress(100, totalSec, 0);

    // Cleanup
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }

    let size = 0;
    try { size = fs.statSync(outputPath).size; } catch {}
    return { path: outputPath, size, encoder: encoder.label };

  } catch (err) {
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }
    throw err;
  } finally {
    // v5 leak guard: a finished (or failed/cancelled) export must never
    // leave ffmpeg children behind — kill + warn if any survived.
    leakGuard();
  }
});

// App lifecycle
app.whenReady().then(() => {
  ensureTempDir();
  buildApplicationMenu();
  createWindow();
  // v5.1: warm the GPU-encoder probe at startup so the FIRST export starts
  // encoding immediately instead of paying the detection latency up front.
  detectGpuEncoderAsync();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// v5.1: the Whisper utility process must not outlive the app.
app.on("will-quit", () => {
  try { if (whisperChild.proc) whisperChild.proc.kill(); } catch (_) {}
});

// Test hook — exposes the ASS builder to the dev verification harness.
// Harmless in production: nothing requires the Electron main entry.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildAssDocument, assAnimTags, buildHeadlineEvents };
}
