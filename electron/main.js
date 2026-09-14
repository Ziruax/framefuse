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
// v6: the SINGLE-PASS whole-timeline graph builder (pure — shared with the
// bun verification harness exactly like export-graph).
const SP = require("./export-singlepass");

// Resolve the FFmpeg binary path. v1.5: a FULL bundled build (staged by
// scripts/fetch-windows-ffmpeg.js into resources/ffmpeg/<plat>/) is PREFERRED
// over ffmpeg-static — it carries ffprobe.exe (fastProbe) plus the hardware
// encoders (h264_nvenc/h264_qsv/h264_amf) and libass that the minimal
// ffmpeg-static builds lack. ffmpeg-static remains the packaged fallback;
// the system PATH is the last resort.
const FFMPEG_PLAT_DIR =
  process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
let ffmpegPath;
if (app.isPackaged) {
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const altName = process.platform === "win32" ? "ffmpeg" : "ffmpeg.exe";
  const candidates = [
    // v1.5 full build via electron-builder extraResources (resources/ffmpeg)
    path.join(process.resourcesPath, "ffmpeg", FFMPEG_PLAT_DIR, exeName),
    path.join(process.resourcesPath, "ffmpeg", FFMPEG_PLAT_DIR, altName),
    path.join(process.resourcesPath, "ffmpeg", exeName),
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
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const devCandidates = [
    // v1.5 dev: the staged full build next to the repo (fetch-windows-ffmpeg)
    path.join(__dirname, "..", "resources", "ffmpeg", FFMPEG_PLAT_DIR, exeName),
    path.join(process.cwd(), "resources", "ffmpeg", FFMPEG_PLAT_DIR, exeName),
  ];
  ffmpegPath = devCandidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!ffmpegPath) {
    try {
      ffmpegPath = require("ffmpeg-static");
    } catch (e) {
      ffmpegPath = "ffmpeg";
    }
    if (process.platform === "win32" && ffmpegPath && !ffmpegPath.endsWith(".exe")) {
      try { if (fs.existsSync(ffmpegPath + ".exe")) ffmpegPath += ".exe"; } catch (_) {}
    }
  }
}
const ffmpegBuildKind = /resources[\\/]ffmpeg([\\/]|$)/.test(String(ffmpegPath))
  ? "bundled-full"
  : /ffmpeg-static/.test(String(ffmpegPath)) ? "ffmpeg-static" : "system-path";
console.log(`[FFMPEG] Using: ${ffmpegPath} (${ffmpegBuildKind}) exists:`, (() => { try { return fs.existsSync(ffmpegPath); } catch { return false; } })());

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
  // v7 FIX B: window icon resolution — dev uses build/icon.ico; packaged
  // prefers <resources>/icon.ico (extraResources, a REAL file) and falls
  // back to the asar copy (Electron reads asar paths transparently).
  const iconCandidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "icon.ico"),
        path.join(__dirname, "..", "build", "icon.ico"),
      ]
    : [path.join(__dirname, "..", "build", "icon.ico")];
  let iconPath = iconCandidates.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
  if (!iconPath) iconPath = undefined;

  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 720,
    backgroundColor: "#0a0a0a", title: "FrameFuse v1",
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
      { label: "Add Images…", click: () => mainWindow && mainWindow.webContents.send("menu:add-images") },
      { label: "Add Video…", click: () => mainWindow && mainWindow.webContents.send("menu:add-video") },
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
// v1.5: also reports WHICH build is in use (bundled-full / ffmpeg-static /
// system-path), the hardware encoders it was compiled with, libass, and
// whether ffprobe resolved — the exact facts that decide export speed on a
// given install (full build → NVENC/QSV/AMF possible + fast JSON probes).
ipcMain.handle("ffmpeg-status", async () => {
  try {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return { ok: false, path: ffmpegPath || "(none)", version: null, error: "FFmpeg binary not found at expected path. Try reinstalling FrameFuse." };
    }
    const r = await ffmpegCapture(["-version"], 10000);
    const firstLine = r.out.split("\n")[0] || "";
    const caps = { hasNvenc: false, hasQsv: false, hasAmf: false, hasLibass: false };
    try {
      const enc = await ffmpegCapture(["-hide_banner", "-encoders"], 12000);
      caps.hasNvenc = /h264_nvenc\b/.test(enc.out);
      caps.hasQsv = /h264_qsv\b/.test(enc.out);
      caps.hasAmf = /h264_amf\b/.test(enc.out);
    } catch (_) { /* capability scan is best-effort */ }
    try {
      const flt = await ffmpegCapture(["-hide_banner", "-filters"], 12000);
      caps.hasLibass = /libass/.test(flt.out);
    } catch (_) { /* capability scan is best-effort */ }
    let hasFfprobe = false;
    try { hasFfprobe = !!(await ffprobeAvailable()); } catch (_) {}
    return {
      ok: r.code === 0,
      path: ffmpegPath,
      version: firstLine,
      build: ffmpegBuildKind,
      hasFfprobe,
      ...caps,
      error: r.code === 0 ? null : "FFmpeg did not respond in time.",
    };
  } catch (e) {
    return { ok: false, path: ffmpegPath || "(none)", version: null, build: ffmpegBuildKind, error: e.message };
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
  // v5.2 PERF: async write — the sync variant blocked the main-process event
  // loop for the duration of every media upload (hundreds of MB = seconds).
  await fs.promises.writeFile(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle("save-temp-audio", async (_evt, { name, bytes }) => {
  ensureTempDir();
  const ext = path.extname(name) || ".mp3";
  const p = path.join(tempDir, `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  await fs.promises.writeFile(p, Buffer.from(bytes));
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
  await fs.promises.writeFile(p, Buffer.from(bytes));
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

// ── v8 GPU (WebCodecs) export file streamer ────────────────────────────────
// The renderer's WebCodecs pipeline muxes MP4 bytes and streams them to disk
// in ~5 MB chunks so a 19-minute 1080p render never has to fit in RAM (the
// v5.x browser fallback held the whole muxed file in an ArrayBufferTarget).
// Fire-and-forget channels (ipcMain.on, not handle): the renderer drives the
// whole export and reports its own progress/errors.
let exportStream = null;

// Begin a streamed export: end any previous stream, mkdir -p the parent
// directory (absolute paths only), then open a truncating write stream.
// Write errors are logged and the stream is dropped — never thrown — so a
// failing disk can't crash the main process; the renderer's export-end
// still runs and the caller surfaces the truncated file.
ipcMain.on("export-start", (event, filePath) => {
  try {
    if (typeof filePath !== "string" || !filePath.trim() || !path.isAbsolute(filePath)) {
      console.warn("[export-stream] export-start ignored: filePath must be a non-empty absolute path");
      return;
    }
    if (exportStream) {
      // A previous export never called export-end — close it cleanly so the
      // file handle isn't left dangling on disk.
      try { exportStream.end(); } catch (_) { /* already ended */ }
      exportStream = null;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stream = fs.createWriteStream(filePath, { flags: "w" });
    exportStream = stream;
    stream.on("error", (err) => {
      console.error("[export-stream] write failed:", err && err.message ? err.message : err);
      // Drop the broken stream so a retried export-start opens a fresh one —
      // but only if a retry hasn't already replaced it (compare identities).
      try { stream.destroy(); } catch (_) { /* already destroyed */ }
      if (exportStream === stream) exportStream = null;
    });
  } catch (e) {
    console.error("[export-stream] export-start failed:", e && e.message ? e.message : e);
  }
});

// Append one ~5 MB muxed chunk. No open stream (or a broken one) → warn and
// ignore; whatever was already written stays on disk for export-end to close.
ipcMain.on("export-chunk", (event, buffer) => {
  if (!exportStream) {
    console.warn("[export-stream] export-chunk ignored: no open export stream");
    return;
  }
  try {
    // Buffer.from copies the IPC-serialized bytes into a Node buffer the
    // stream can own (input may arrive as Uint8Array or Buffer).
    exportStream.write(Buffer.from(buffer));
  } catch (e) {
    console.error("[export-stream] chunk write failed:", e && e.message ? e.message : e);
  }
});

// Finish the streamed export: end() flushes pending writes to disk, then the
// handle is released. Safe to call with no open stream (idempotent no-op).
ipcMain.on("export-end", () => {
  if (!exportStream) return;
  const stream = exportStream;
  exportStream = null;
  try {
    stream.end();
  } catch (e) {
    console.error("[export-stream] export-end failed:", e && e.message ? e.message : e);
  }
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

/** Async stdout/stderr capture for ANY binary — NEVER blocks the main
 *  process event loop (the v5.0 execSync/spawnSync probes froze the whole
 *  app). Resolves { code, out } with out = stdout+stderr concatenated; a
 *  timeout resolves code -1 with whatever was captured. v6: generalized
 *  from ffmpegCapture so ffprobe rides the same discipline. */
function captureExec(bin, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    let out = "";
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true });
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

function ffmpegCapture(args, timeoutMs = 12000) {
  return captureExec(ffmpegPath, args, timeoutMs);
}

// ---------------------------------------------------------------------------
// v1.2 2-PASS MEASURED LOUDNORM — pass 1 (measurement)
// ---------------------------------------------------------------------------
/**
 * Measure a file's loudness for 2-pass loudnorm: decodes audio ONLY (fast —
 * ebur128 runs hundreds of× realtime) through `loudnorm … print_format=json`
 * and parses the flat JSON summary the filter prints at the end.
 * Resolves { i, lra, tp, thresh, offset } or null when nothing parseable
 * (missing file, silent input measuring as -inf, timeout) — the graph then
 * falls back to single-pass loudnorm for that branch.
 * v6: `win` ({ ssMs, durMs }) measures a SEEKED SOURCE WINDOW (audio-only
 * decode with -ss/-t) instead of the whole file — the single-pass path
 * measures the base video inputs' own audio at their timeline windows
 * without extracting PCM WAVs first. atempo preserves integrated loudness
 * (energy per unit time is unchanged by time-stretch), so measuring the
 * pre-atempo window is equivalent to the two-step's post-atempo WAV.
 */
function measureLoudnessAsync(p, win) {
  if (typeof p !== "string" || !p) return Promise.resolve(null);
  const seekArgs = win && Number(win.durMs) > 0
    ? ["-ss", (Math.max(0, Number(win.ssMs) || 0) / 1000).toFixed(3), "-t", (Number(win.durMs) / 1000).toFixed(3)]
    : [];
  return ffmpegCapture(
    [
      "-hide_banner", "-nostats",
      ...seekArgs,
      "-i", p,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
      "-f", "null", "-",
    ],
    60000,
  ).then((r) => {
    const out = r && r.out ? r.out : "";
    const start = out.lastIndexOf("{");
    if (start < 0) return null;
    const end = out.indexOf("}", start);
    if (end < 0) return null;
    let j = null;
    try { j = JSON.parse(out.slice(start, end + 1)); } catch (_) { return null; }
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const i = num(j.input_i);
    const lra = num(j.input_lra);
    const tp = num(j.input_tp);
    const th = num(j.input_thresh);
    if (i == null || lra == null || tp == null || th == null) return null;
    return { i, lra, tp, thresh: th, offset: num(j.target_offset) };
  }).catch(() => null);
}

/**
 * Measure every audio source for the 2-pass loudnorm (bounded 8-parallel —
 * same chunk discipline as the duration probes: a 100-clip project must not
 * spawn 100 ffmpeg children at once on a weak machine).
 * Returns { clip: [measure|null per clip WAV], music: measure|null }.
 */
async function measureLoudnormContext(clipAudioJobs, audioPath) {
  const clip = new Array(clipAudioJobs.length).fill(null);
  let music = null;
  const tasks = [];
  clipAudioJobs.forEach((j, k) => tasks.push({ kind: "clip", k, p: j.wavPath }));
  if (audioPath) tasks.push({ kind: "music", p: audioPath });
  for (let c = 0; c < tasks.length; c += 8) {
    const chunk = tasks.slice(c, c + 8);
    const res = await Promise.all(chunk.map((t) => measureLoudnessAsync(t.p)));
    chunk.forEach((t, i) => {
      if (t.kind === "clip") clip[t.k] = res[i];
      else music = res[i];
    });
  }
  return { clip, music };
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

/** v1.5: models root shipped INSIDE the installer — stage-whisper-model.js
 *  fills whisper-service/models/Xenova/whisper-tiny at build time and
 *  electron-builder's extraResources places it next to the staged service
 *  (outside app.asar). The whisper pipeline builds from here FIRST (fully
 *  offline); the runtime download path remains the fallback. */
function whisperBundledModelsRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "whisper-service", "models");
  }
  return path.join(__dirname, "..", "whisper-service", "models");
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
  // v7 FIX A: activity + phase tracking for the ENGINE 2 watchdog (the
  // utilityProcess can hang inside a stalled model download with no further
  // messages — the run bookkeeping now records when it was last heard from).
  run.lastMsgAt = Date.now();
  if (msg.type === "progress" && msg.stage === "transcribe") run.phase = "infer";
  else if (msg.type === "progress") run.phase = "load";
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

// ── v1.3 FASTER-WHISPER SIDECAR (CTranslate2 int8) ─────────────────────────
// The user-reported pain: "whisper is very slow". The v5.x engine runs
// whisper-tiny through onnxruntime — decent, but CTranslate2's int8
// reimplementation (faster-whisper) is ~4× faster on the same CPU, gets
// exact word timestamps for free, and VAD-filters silence (long videos
// transcribe in a fraction of the wall time). It ships as a self-contained
// embeddable Python runtime (extraResources) — PyAV decodes the audio, so
// the ORIGINAL source path is passed straight through (zero-copy) with no
// ffmpeg pre-decode. Engine chain: faster-whisper → onnxruntime utility
// process → renderer web worker. FRAMEFUSE_FW_PYTHON=<exe> overrides the
// interpreter for Linux dev boxes.
const fwRuntime = { available: null };

function fasterWhisperRuntimeDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "faster-whisper-runtime")
    : path.join(__dirname, "..", "faster-whisper-runtime");
}

function fasterWhisperTranscriberPath() {
  return path.join(fasterWhisperRuntimeDir(), "transcriber.py");
}

function fasterWhisperPython() {
  if (process.env.FRAMEFUSE_FW_PYTHON) return process.env.FRAMEFUSE_FW_PYTHON;
  return path.join(fasterWhisperRuntimeDir(), "python", "python.exe");
}

function fasterWhisperAvailable() {
  if (fwRuntime.available != null) return fwRuntime.available;
  let ok = false;
  try {
    if (process.env.FRAMEFUSE_FW_PYTHON) {
      ok = fs.existsSync(process.env.FRAMEFUSE_FW_PYTHON);
    } else {
      ok =
        fs.existsSync(fasterWhisperPython()) &&
        fs.existsSync(fasterWhisperTranscriberPath());
    }
  } catch (_) { ok = false; }
  fwRuntime.available = ok;
  return ok;
}

function fasterWhisperCacheDir() {
  return path.join(app.getPath("userData"), "faster-whisper-models");
}

/** v1.7: the installer BUNDLES the CTranslate2 tiny model inside the
 * faster-whisper runtime (staged by scripts/stage-faster-whisper-model.js,
 * shipped via extraResources). Passing this DIRECTORY as --model makes
 * WhisperModel() load straight from disk — no first-run HuggingFace
 * download (the root cause of both "very slow first transcription" and
 * the load-phase watchdog kills that fell users back to the slower ONNX
 * engine). Non-tiny sizes still download on demand (watchdog-bounded).
 * Returns null when the bundle is absent (dev boxes, partial installs) —
 * the sidecar then keeps the historical name-based download path. */
function fasterWhisperBundledModelDir() {
  try {
    const dir = path.join(fasterWhisperRuntimeDir(), "models", "faster-whisper-tiny");
    return fs.existsSync(path.join(dir, "model.bin")) ? dir : null;
  } catch (_) {
    return null;
  }
}

/** Spawn the sidecar and stream its JSON-lines to the run bookkeeping.
 * Progress mapping mirrors the existing UI curve: load 10–25 %, transcribe
 * 25–80 %, align 80+ stays in the renderer. Returns the raw result payload
 * ({ chunks, language, wordLevel, durationMs }) — chunk shape is the SAME
 * contract the onnxruntime child returns.
 *
 * v7 FIX A — WATCHDOG (the "working for hours" hang): WhisperModel() can
 * sit forever inside huggingface_hub's model download — a stalled socket
 * with NO read timeout and NO stdout output — which used to leave the
 * transcription promise pending forever (the UI showed "Working…" for
 * hours with nothing happening). Three guards now bound the sidecar:
 *   • STALL: no stdout JSON line for 120 s → the process is dead/hung →
 *     kill + reject → the engine chain falls through to onnxruntime;
 *   • LOAD CAP: the load phase (model download included) gets 300 s total —
 *     a healthy connection downloads whisper-tiny in well under that; a
 *     trickling one is not worth waiting for when the BUNDLED onnx model
 *     is the next engine;
 *   • TOTAL CAP: 30 min hard ceiling (long-video transcription included).
 * The spawn env also sets HF_HUB_DOWNLOAD_TIMEOUT=30 so huggingface_hub's
 * own requests fail fast on dead connections instead of hanging reads. */
const FW_STALL_TIMEOUT_MS = 120000;
const FW_LOAD_TIMEOUT_MS = 300000;
const FW_TOTAL_TIMEOUT_MS = 30 * 60000;

function transcribeWithFasterWhisper(runId, { inputPath, language, model }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t0 = Date.now();
    let lastActivity = Date.now();
    let phase = "load"; // load → transcribe
    const args = [
      fasterWhisperTranscriberPath(),
      "--audio", inputPath,
      // v1.7: bundled CT2 tiny → local dir path (no download, instant
      // load). Other sizes keep the name-based download (watchdog-bounded).
      "--model", fasterWhisperBundledModelDir() ??
        (["tiny", "base", "small", "medium"].includes(model) ? model : "tiny"),
      "--language", typeof language === "string" && language ? language : "auto",
      "--cache", fasterWhisperCacheDir(),
      "--cpu-threads", String(Math.max(1, os.cpus().length)),
    ];
    const child = spawn(fasterWhisperPython(), args, {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        // v7 FIX A: bounded network ops inside the sidecar.
        HF_HUB_DOWNLOAD_TIMEOUT: "30",
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
      },
    });
    const run = whisperRuns.get(runId);
    if (run) run.python = child;

    let stdoutBuf = "";
    let stderrTail = "";
    const watchdog = setInterval(() => {
      if (settled) { clearInterval(watchdog); return; }
      const now = Date.now();
      const idle = now - lastActivity;
      if (idle > FW_STALL_TIMEOUT_MS) {
        try { child.kill(); } catch (_) {}
        finish(new Error(
          `faster-whisper produced no output for ${Math.round(idle / 1000)}s — the sidecar hung and was killed`,
        ));
        return;
      }
      if (phase === "load" && now - t0 > FW_LOAD_TIMEOUT_MS) {
        try { child.kill(); } catch (_) {}
        finish(new Error(
          "faster-whisper model load exceeded 5 minutes (slow or stalled download) — falling back to the bundled Whisper engine",
        ));
        return;
      }
      if (now - t0 > FW_TOTAL_TIMEOUT_MS) {
        try { child.kill(); } catch (_) {}
        finish(new Error("faster-whisper exceeded the 30-minute ceiling and was killed"));
      }
    }, 5000);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      const r = whisperRuns.get(runId);
      if (r) r.python = null;
      if (err) reject(err);
      else resolve(result);
    };

    child.stdout.on("data", (d) => {
      lastActivity = Date.now();
      stdoutBuf += d.toString("utf8");
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (!msg || typeof msg.type !== "string") continue;
        switch (msg.type) {
          case "stage":
            sendWhisperProgress(runId, 10, "Loading faster-whisper model…");
            break;
          case "info":
            phase = "transcribe";
            sendWhisperProgress(runId, 25, `Transcribing (model ready, ${(Math.round((msg.durationMs || 0) / 60000))} min audio)…`);
            break;
          case "progress": {
            phase = "transcribe";
            const p = Number(msg.progress);
            if (Number.isFinite(p)) {
              sendWhisperProgress(runId, Math.min(80, 25 + Math.round(p * 0.55)), "Transcribing…");
            }
            break;
          }
          case "result":
            child.kill();
            finish(null, {
              chunks: Array.isArray(msg.chunks) ? msg.chunks : null,
              language: typeof msg.language === "string" ? msg.language : null,
              wordLevel: !!msg.wordLevel,
              durationMs: Number(msg.durationMs) || 0,
            });
            break;
          case "error":
            child.kill();
            finish(new Error(String(msg.message || "faster-whisper failed")));
            break;
          default:
            break;
        }
      }
    });
    child.stderr.on("data", (d) => {
      lastActivity = Date.now(); // stderr chatter (tqdm, warnings) = alive
      stderrTail = (stderrTail + d.toString()).slice(-1500);
    });
    child.on("error", (err) => finish(new Error(`Could not start faster-whisper: ${err.message}`)));
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        finish(new Error("Transcription cancelled"));
      } else {
        finish(new Error(`faster-whisper exited (${code})${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-2).join(" ")}` : ""}`));
      }
    });
  });
}

ipcMain.handle("whisper:transcribe", async (event, payload) => {
  const { name, bytes, language } = payload || {};
  const sourcePath =
    payload && typeof payload.sourcePath === "string" ? payload.sourcePath : null;
  const model =
    payload && typeof payload.model === "string" ? payload.model : "tiny";
  // v5.2: the renderer passes a client runId (crypto.randomUUID) so a cancel
  // can target THIS run without killing other queued runs.
  const clientRunId =
    payload && typeof payload.runId === "string" && payload.runId
      ? payload.runId
      : null;
  // v1.3 ZERO-COPY: a local on-disk source (webUtils path from the renderer)
  // is addressed DIRECTLY — no renderer→main byte upload, no temp copy. The
  // byte path remains for browser-side media / project-restored blobs.
  let inputPath = null;
  let tmpUploaded = null;
  if (sourcePath && fs.existsSync(sourcePath)) {
    inputPath = sourcePath;
  } else {
    if (!bytes || !bytes.byteLength) throw new Error("No audio data received");
    ensureTempDir();
    const ext = path.extname(name || "") || ".audio";
    tmpUploaded = path.join(tempDir, `whisper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(tmpUploaded, Buffer.from(bytes));
    inputPath = tmpUploaded;
  }
  const runId = ++whisperRunSeq;
  try {
    // ── v1.3 ENGINE 1: faster-whisper sidecar (CTranslate2 int8) ──────
    // ~4× faster than the onnxruntime path, exact word timestamps, VAD
    // silence filtering, and base/small/medium models become practical.
    // Any failure that is NOT a cancellation falls through to engine 2 so
    // a broken runtime never takes transcription down with it.
    if (fasterWhisperAvailable()) {
      try {
        const fw = await transcribeWithFasterWhisper(runId, {
          inputPath,
          language,
          model,
        });
        whisperState.lastError = null;
        whisperState.lastErrorAt = 0;
        return { ...fw, engine: "faster-whisper" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cancelled")) throw err;
        console.warn(`[whisper] faster-whisper failed, falling back to onnxruntime: ${msg}`);
        whisperState.lastError = `faster-whisper: ${msg}`;
        whisperState.lastErrorAt = Date.now();
      }
    }

    // ── ENGINE 2: onnxruntime utility process (v5.x path) ────────────
    sendWhisperProgress(runId, 2, "Decoding audio…");
    const pcm = await decodeAudioToPcm16k(inputPath);
    if (pcm.length === 0) throw new Error("Audio file is empty or silent");
    const durationMs = Math.round((pcm.length / 16000) * 1000);
    sendWhisperProgress(runId, 10, "Loading Whisper-tiny model…");

    const child = getWhisperChild();
    // v7 FIX A — ENGINE 2 watchdog: a stalled model download (or a hung
    // utilityProcess) used to leave this await pending FOREVER. Guards:
    //   • LOAD phase: no child message for 240 s → kill the service, reject
    //     with an actionable message (the child normally emits frequent
    //     model/download progress; the bundled-model load is silent but
    //     finishes in seconds).
    //   • TOTAL: 10 min + 45× the audio duration — generous for slow-CPU
    //     inference of long videos, but bounded (whisper-tiny at worst runs
    //     ~0.5× real time on one core).
    const ONNX_LOAD_STALL_MS = 240000;
    const onnxTotalCapMs = 600000 + 45 * durationMs;
    const onnxWatchdog = setInterval(() => {
      const run = whisperRuns.get(runId);
      if (!run) { clearInterval(onnxWatchdog); return; }
      const idle = Date.now() - (run.lastMsgAt || Date.now());
      if (idle > ONNX_LOAD_STALL_MS && run.phase !== "infer") {
        clearInterval(onnxWatchdog);
        try { if (whisperChild.proc) whisperChild.proc.kill(); } catch (_) {}
        whisperRuns.delete(runId);
        run.reject(new Error(
          "The Whisper service stopped responding while loading the model (no progress for 4 minutes). It was restarted — please try again.",
        ));
        return;
      }
      if (Date.now() - onnxE0 > onnxTotalCapMs) {
        clearInterval(onnxWatchdog);
        try { if (whisperChild.proc) whisperChild.proc.kill(); } catch (_) {}
        whisperRuns.delete(runId);
        run.reject(new Error(
          `Whisper transcription exceeded ${Math.round(onnxTotalCapMs / 60000)} minutes and was stopped — try a shorter clip or check CPU load.`,
        ));
      }
    }, 5000);
    const onnxE0 = Date.now();
    const result = await new Promise((resolve, reject) => {
      whisperRuns.set(runId, { resolve, reject, sender: event.sender, clientRunId, lastMsgAt: Date.now(), phase: "load" });
      try {
        // v1 fix: Electron's utilityProcess.postMessage accepts ONLY
        // MessagePortMain objects in its transfer list — transferring the PCM
        // ArrayBuffer threw "Invalid value for transfer" and killed every
        // transcription ("Could not reach the Whisper service"). The message
        // is now plain structured-clone: the Float32Array is copied (one
        // memcpy of 64 KB per second of audio — negligible next to
        // inference) and arrives as a real Float32Array in the child.
        child.postMessage({
          type: "transcribe",
          runId,
          pcm,
          sampleRate: 16000,
          language: language || "auto",
          cacheDir: whisperCacheDir(),
          // v1.5: installer-bundled model — local-first, offline transcription.
          bundledModelDir: whisperBundledModelsRoot(),
        });
      } catch (err) {
        whisperRuns.delete(runId);
        reject(new Error(`Could not reach the Whisper service: ${err.message}`));
      }
    }).finally(() => {
      clearInterval(onnxWatchdog);
    });
    sendWhisperProgress(runId, 80, "Aligning word timestamps…");
    return { ...result, durationMs, engine: "onnxruntime" };
  } finally {
    whisperRuns.delete(runId);
    if (tmpUploaded) { try { fs.unlinkSync(tmpUploaded); } catch (_) {} }
  }
});

ipcMain.handle("whisper:preload", async (event) => {
  const runId = ++whisperRunSeq;
  const child = getWhisperChild();
  // v7 FIX A: preload watchdog — the model download can stall silently; no
  // child message for 4 minutes kills the service and rejects (the next
  // call respawns it). The bundled-model preload is local + instant.
  const t0 = Date.now();
  const watchdog = setInterval(() => {
    const run = whisperRuns.get(runId);
    if (!run) { clearInterval(watchdog); return; }
    if (Date.now() - (run.lastMsgAt || t0) > 240000) {
      clearInterval(watchdog);
      try { if (whisperChild.proc) whisperChild.proc.kill(); } catch (_) {}
      whisperRuns.delete(runId);
      run.reject(new Error(
        "The Whisper model download stopped responding (no progress for 4 minutes) and was cancelled. Check your connection and try again.",
      ));
    }
  }, 5000);
  return await new Promise((resolve, reject) => {
    whisperRuns.set(runId, { resolve: () => resolve({ ok: true }), reject, sender: event.sender, lastMsgAt: Date.now(), phase: "load" });
    try {
      child.postMessage({
        type: "preload",
        runId,
        cacheDir: whisperCacheDir(),
        bundledModelDir: whisperBundledModelsRoot(),
      });
    } catch (err) {
      whisperRuns.delete(runId);
      clearInterval(watchdog);
      reject(new Error(`Could not reach the Whisper service: ${err.message}`));
    }
  }).finally(() => {
    clearInterval(watchdog);
  });
});

// v1.3.1: pre-download a faster-whisper MODEL (tiny/base/small/medium) —
// spawns the sidecar with --preload, which loads (and caches) the model
// then exits. First real transcription is then fully offline. Progress
// rides the same whisper:progress channel (load band 10–25 %).
ipcMain.handle("whisper:fw-preload", async (event, payload) => {
  if (!fasterWhisperAvailable()) {
    throw new Error("faster-whisper runtime not staged on this machine");
  }
  const model =
    payload && typeof payload.model === "string" &&
    ["tiny", "base", "small", "medium"].includes(payload.model)
      ? payload.model
      : "tiny";
  const runId = ++whisperRunSeq;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const args = [
      fasterWhisperTranscriberPath(),
      "--preload",
      // v1.7: bundled CT2 tiny → preload is a local disk verification
      // (instant); other sizes still download into the cache dir.
      "--model", fasterWhisperBundledModelDir() ?? model,
      "--cache", fasterWhisperCacheDir(),
      "--cpu-threads", String(Math.max(1, os.cpus().length)),
    ];
    const child = spawn(fasterWhisperPython(), args, {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        // v7 FIX A: bounded hub downloads + clean stderr (no tqdm noise).
        HF_HUB_DOWNLOAD_TIMEOUT: "30",
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
      },
    });
    const run = { resolve: () => { if (!settled) { settled = true; resolve({ ok: true, model }); } }, reject, sender: event.sender, python: child };
    whisperRuns.set(runId, run);
    let stderrTail = "";
    // v7 FIX A: preload watchdog — stall (no stdout activity for 2 min) or a
    // 15-minute total cap kills the sidecar and rejects with a clear message
    // (previously a dead download left the pre-download UI spinning forever).
    const t0 = Date.now();
    let lastActivity = Date.now();
    const watchdog = setInterval(() => {
      if (settled) { clearInterval(watchdog); return; }
      const now = Date.now();
      if (now - lastActivity > 120000 || now - t0 > 15 * 60000) {
        try { child.kill(); } catch (_) {}
        finish(
          (e) => reject(new Error(String(e))),
          now - lastActivity > 120000
            ? `faster-whisper pre-download produced no output for ${Math.round((now - lastActivity) / 1000)}s — killed`
            : "faster-whisper pre-download exceeded 15 minutes — killed",
        );
      }
    }, 5000);
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      const r = whisperRuns.get(runId);
      if (r) r.python = null;
      whisperRuns.delete(runId);
      fn(arg);
    };
    child.stdout.on("data", (d) => {
      lastActivity = Date.now();
      for (const line of d.toString("utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try { msg = JSON.parse(t); } catch (_) { continue; }
        if (msg && msg.type === "stage") {
          sendWhisperProgress(runId, 12, `Downloading faster-whisper ${model} model…`);
        } else if (msg && msg.type === "result" && msg.preloaded) {
          try { child.kill(); } catch (_) {}
          finish(run.resolve);
        } else if (msg && msg.type === "error") {
          try { child.kill(); } catch (_) {}
          finish((e) => reject(new Error(String(e))), msg.message || "faster-whisper preload failed");
        }
      }
    });
    child.stderr.on("data", (d) => {
      lastActivity = Date.now(); // stderr chatter = process alive
      stderrTail = (stderrTail + d.toString()).slice(-1200);
    });
    child.on("error", (err) => finish((e) => reject(new Error(String(e))), `Could not start faster-whisper: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        finish((e) => reject(new Error(String(e))), "Transcription cancelled");
      } else {
        finish((e) => reject(new Error(String(e))), `faster-whisper exited (${code})${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-2).join(" ")}` : ""}`);
      }
    });
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
    // runs keep going. v1.3: faster-whisper python runs are killed via the
    // tracked child handle (the sidecar exits on SIGTERM/SIGKILL and its
    // promise rejects with "Transcription cancelled").
    for (const [runId, run] of Array.from(whisperRuns)) {
      if (run.clientRunId === target) {
        whisperRuns.delete(runId);
        try { if (run.python) run.python.kill(); } catch (_) {}
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
    try { if (run.python) run.python.kill(); } catch (_) {}
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
  // v1.3: engine report — the sidecar wins when its runtime is staged;
  // its model cache lives in a sibling folder of userData.
  let fwCacheFiles = [];
  try { fwCacheFiles = scanWhisperCache(fasterWhisperCacheDir()); } catch (_) {}
  // v1.5: the installer-shipped model — bundled availability is the fact the
  // captions panel cares about first ("works offline out of the box").
  let bundledFiles = [];
  try { bundledFiles = scanWhisperCache(path.join(whisperBundledModelsRoot(), "Xenova")); } catch (_) {}
  const bundledReady = whisperModelReady(
    bundledFiles.map((f) => ({ ...f, name: `Xenova/${f.name}` })),
  );
  return {
    cacheDir,
    hostUsed: whisperState.hostUsed,
    modelReady: bundledReady || whisperModelReady(cacheFiles),
    bundled: {
      available: bundledReady,
      dir: whisperBundledModelsRoot(),
      files: bundledFiles,
      totalBytes: bundledFiles.reduce((n, f) => n + f.sizeBytes, 0),
    },
    cacheFiles,
    totalCacheBytes,
    lastError: whisperState.lastError,
    childAlive: !!(whisperChild.proc && !whisperChild.dead),
    activeRuns: whisperRuns.size,
    engine: fasterWhisperAvailable() ? "faster-whisper" : "onnxruntime",
    fwCacheDir: fasterWhisperCacheDir(),
    fwCacheFiles,
    fwCacheBytes: fwCacheFiles.reduce((n, f) => n + f.sizeBytes, 0),
  };
});

// ---------------------------------------------------------------------------
// GPU encoder detection + RUNTIME PROBE.
// Listing an encoder isn't enough (drivers can be broken) — we actually
// encode real test frames. Falls back to libx264 on any failure.
//
// v1.1 TURBO: the probe got a THROUGHPUT GATE. The old 3-frame 256×256
// probe only caught "encoder missing/broken init" — but the far nastier
// failure mode on Windows is a driver stack that ACCEPTS the encode and
// then crawls at 0.5–5 fps (broken QSV on outdated Intel drivers, AMF on
// half-installed Adrenalin, hybrid-GPU laptops with the iGPU parked).
// A user on such a machine exported a 19-minute video for 5–10 HOURS —
// the exact failure this gate exists to prevent. The probe now encodes
// 48 frames of REAL 1080p30 content and REQUIRES ≥ 12 fps effective
// throughput (healthy NVENC/QSV/AMF run 100–400+ fps; a healthy probe
// completes in well under a second). Anything slower is treated as a
// broken hardware path and the export rides the (fast, predictable)
// CPU libx264 path instead.
//
// Probe order also changed: NVENC → AMF → QSV (QSV is the most commonly
// broken of the three in the wild — it is probed LAST so a working AMF
// is preferred over a QSV that might pass the tiny probe and crawl on
// real content).
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
    { name: "h264_qsv", label: "Intel Quick Sync (QSV)" },
    { name: "h264_amf", label: "AMD AMF" },
  ];
  return order.filter((e) => out.includes(e.name));
}

/** Runtime probe — actually encode REAL 1080p content and GATE ON
 * THROUGHPUT (v1.1). Listed ≠ working (drivers can be broken), and a
 * listed-but-crawling encoder is worse than none — see the header comment.
 * 48 frames of 1080p30 testsrc2 ≈ 1.6 s of real video: healthy hardware
 * paths finish in < 1 s; broken ones blow the 12 s timeout or the fps
 * floor. Returns the measured fps (0 when rejected). v1.3: `extraArgs`
 * lets the libx264 baseline probe match the real export preset
 * (veryfast + crf 20) so the GPU-vs-CPU comparison is apples-to-apples.
 * v7 Step 1: `preInputArgs` carries ffmpeg GLOBAL options that must ride
 * BEFORE the input — Intel QSV on Windows needs an explicitly derived
 * d3d11va→qsv device session or the encoder init can silently fail (the
 * exact iGPU machines this pass targets). */
async function probeEncoderAsync(name, extraArgs = [], preInputArgs = []) {
  const FRAMES = 48;
  const t0 = Date.now();
  const r = await ffmpegCapture([
    "-hide_banner", "-loglevel", "error",
    ...preInputArgs,
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
    "-frames:v", String(FRAMES),
    "-c:v", name, ...extraArgs, "-pix_fmt", "yuv420p",
    "-f", "null", "-",
  ], 12000);
  if (r.code !== 0) return 0;
  const sec = Math.max(0.001, (Date.now() - t0) / 1000);
  return FRAMES / sec; // effective fps (probe includes encoder init)
}

/**
 * v1.1: minimum effective probe throughput for a hardware encoder to be
 * trusted with a real export (fps over the 48-frame 1080p probe).
 * v1.3: raised 12 → 24 fps AND gated against the measured CPU baseline —
 * a hardware encoder must be BOTH absolutely plausible (≥ 24 fps) and
 * RELATIVELY better than the same machine's libx264 veryfast (≥ 1.2×) to
 * be selected. A GPU path slower than the CPU alternative is exactly the
 * "hardware acceleration" trap that turned exports into multi-hour jobs.
 */
const GPU_PROBE_MIN_FPS = 24;
const GPU_VS_CPU_RATIO = 1.2;

async function detectGpuEncoderAsync() {
  if (detectedEncoder) return detectedEncoder;
  if (encoderDetecting) return encoderDetecting;
  encoderDetecting = (async () => {
    let pick = { name: "libx264", label: "CPU (libx264)" };
    try {
      const candidates = await listEncodersAsync();
      // v1.3: measure the CPU baseline ONLY when a hardware candidate
      // exists (CPU-only boxes skip the extra probe entirely).
      let cpuFps = 0;
      let cpuMeasured = false;
      for (const cand of candidates) {
        // v6: probe with the REAL tier args (gpuProbeSpec) so arg-shape
        // failures (unsupported -multipass/-b_ref_mode on old drivers)
        // disqualify the candidate here, never mid-export.
        // v7 Step 1: QSV probes through an EXPLICIT d3d11va→qsv device
        // derivation — without it, Quick Sync encoder init can silently
        // fail on Windows iGPU driver stacks and the probe falls back to
        // CPU even though the hardware encodes at 120+ fps. AMF needs no
        // explicit device (it creates its own context); NVENC neither.
        const spec = gpuProbeSpec(cand.name);
        const fps = await probeEncoderAsync(cand.name, spec.enc, spec.pre);
        if (fps >= GPU_PROBE_MIN_FPS) {
          if (!cpuMeasured) {
            cpuFps = await probeEncoderAsync("libx264", ["-preset", "veryfast", "-crf", "20"]);
            cpuMeasured = true;
          }
          if (fps >= Math.max(GPU_PROBE_MIN_FPS, cpuFps * GPU_VS_CPU_RATIO)) {
            pick = cand;
            console.log(`Export encoder: ${pick.label} (${pick.name}, probe ${fps.toFixed(0)} fps vs CPU ${cpuFps.toFixed(0)} fps)`);
            break;
          }
          // Listed + passes the absolute floor but LOSES to the CPU —
          // trust the predictable CPU path instead.
          console.warn(`Export encoder: ${cand.name} probed ${fps.toFixed(1)} fps but CPU libx264 measures ${cpuFps.toFixed(0)} fps — using CPU (GPU not ≥ ${GPU_VS_CPU_RATIO}× faster)`);
        } else if (fps > 0) {
          // Probe completed but crawled — log it: this is exactly the
          // machine state that used to turn exports into 5–10 hour jobs.
          console.warn(`Export encoder: ${cand.name} probed OK but only ${fps.toFixed(1)} fps (< ${GPU_PROBE_MIN_FPS}) — treating as broken, trying next`);
        }
      }
    } catch (_) { /* fall back to CPU */ }
    detectedEncoder = pick;
    if (pick.name === "libx264") console.log("Export encoder: CPU (libx264)");
    return pick;
  })();
  return encoderDetecting;
}

// ---------------------------------------------------------------------------
// v1.4.2 HARDWARE DECODE PROBE — per source file, throughput-gated.
//
// v1.1 shipped hw decode UNCONDITIONALLY OFF (-hwaccel auto could silently
// land on a WARP/broken-driver path decoding 1080p at ~1 fps). But CPU
// decode of 4K/H.265 sources is a real bottleneck on the re-encode path —
// so instead of a blanket flag, we now MEASURE: decode 72 real frames of
// the ACTUAL file twice (CPU vs -hwaccel auto) and enable hw decode only
// when it is ≥ 1.3× faster. Broken driver stacks lose the probe and stay
// on CPU — the same evidence-over-assumption philosophy as the encoder
// probe above. Both arms include the frame download (the null muxer forces
// system-memory frames), which is the exact cost our software filter graph
// pays. Cached per path; any error → CPU (never a failed export).
// ---------------------------------------------------------------------------
const hwDecodeCache = new Map();

async function probeHwDecode(path) {
  if (hwDecodeCache.has(path)) return hwDecodeCache.get(path);
  let use = false;
  try {
    const FRAMES = 72;
    const arm = (hw) => [
      "-hide_banner", "-loglevel", "error",
      ...(hw ? ["-hwaccel", "auto"] : []),
      "-i", path,
      "-map", "0:v:0",
      "-frames:v", String(FRAMES),
      "-f", "null", "-",
    ];
    const t0 = Date.now();
    const cpu = await ffmpegCapture(arm(false), 20000);
    if (cpu.code === 0) {
      const cpuMs = Math.max(1, Date.now() - t0);
      const t1 = Date.now();
      const gpu = await ffmpegCapture(arm(true), 20000);
      if (gpu.code === 0) {
        const gpuMs = Math.max(1, Date.now() - t1);
        use = gpuMs * 1.3 < cpuMs; // ≥30% faster or stay on CPU
        console.log(
          `hw-decode probe ${path}: cpu ${cpuMs}ms vs hw ${gpuMs}ms → ${use ? "ENABLED" : "cpu (not ≥1.3× faster)"}`,
        );
      }
    }
  } catch (_) { use = false; }
  hwDecodeCache.set(path, use);
  return use;
}

/** Build encoder args for a quality-first, speed-optimized encode.
 * v4.5: the `quality` profile ("draft" | "social" | "cinema" | "custom")
 * drives CRF/cq + the encoder speed preset; `crf` is the explicit target
 * used when quality === "custom". "social" keeps the exact v4.4 behavior.
 * v6 PHASE 1 (throughput pass — the quality LADDER is unchanged: same
 * CRF/CQ targets per tier, same yuv420p uniform output):
 *   - NVENC: the constrained-VBR pair (-maxrate/-bufsize) is GONE — at a
 *     CQ target it only added a rate-control pass (~15-25% throughput)
 *     without changing the CQ-driven quality decisions. -multipass qres
 *     keeps quarter-resolution rate decisions at a fraction of the cost.
 *     b_ref_mode=middle rides the quality tiers (B-frames as refs, Pascal+
 *     feature — the runtime probe validates the exact arg shape before an
 *     encoder is ever trusted with a real export).
 *   - libx264: draft drops veryfast → ultrafast (draft is explicitly the
 *     speed tier); social/cinema presets unchanged.
 * v7 Step 5 (low-end CPU fallback): on 4-or-fewer-core machines with no
 * usable iGPU/dGPU (libx264 fallback), the preset ladder drops to
 * superfast/ultrafast and `-tune fastdecode` rides along (no CABAC-side
 * deblocking overhead, simpler features — measurably friendlier to the
 * small L2/L3 caches of Atom/Celeron-class quads). Thread caps per worker
 * live in the routing code (-threads 2 / -filter_threads 2). */
const QUALITY_ENCODER = {
  draft:  { crf: 27, x264: "ultrafast", nvencPreset: "p1", nvencCq: 27, qsvQ: 27, amfI: 26, amfP: 28 },
  social: { crf: 20, x264: "veryfast",  nvencPreset: "p4", nvencCq: 23, qsvQ: 23, amfI: 22, amfP: 24 },
  // v5.2 SPEED: cinema x264 preset medium → faster. Open-source editors
  // (Shotcut/Kdenlive) default to faster-class presets — ~2× faster than
  // medium at a visually indistinguishable CRF 17 master.
  cinema: { crf: 17, x264: "faster",  nvencPreset: "p6", nvencCq: 19, qsvQ: 19, amfI: 19, amfP: 21 },
};

function encoderArgs(encoderName, bitrateMbps, width, height, quality, crf, lowEndCpu) {
  const q = QUALITY_ENCODER[quality] || QUALITY_ENCODER.social;
  const crfVal = quality === "custom" ? Math.max(14, Math.min(30, Number(crf) || 20)) : q.crf;
  const lowEnd = lowEndCpu === true;
  switch (encoderName) {
    case "h264_nvenc": {
      // v6: unconstrained constant-quality VBR — no maxrate/bufsize, CQ per
      // tier, quarter-res multipass; B-frames-as-refs on the quality tiers.
      const cq = quality === "custom" ? crfVal : q.nvencCq;
      const args = ["-c:v", "h264_nvenc", "-preset", q.nvencPreset, "-rc", "vbr", "-cq", String(cq), "-b:v", "0", "-multipass", "qres"];
      if (quality !== "draft") args.push("-tune", "hq", "-b_ref_mode", "middle");
      args.push("-pix_fmt", "yuv420p");
      return args;
    }
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", String(quality === "custom" ? crfVal : q.qsvQ), "-look_ahead", "0", "-pix_fmt", "yuv420p"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", quality === "cinema" ? "quality" : "balanced", "-rc", "vbr_peak", "-qp_i", String(quality === "custom" ? crfVal : q.amfI), "-qp_p", String((quality === "custom" ? crfVal : q.amfP) + 2), "-b:v", `${bitrateMbps || 8}M`, "-pix_fmt", "yuv420p"];
    default: {
      // libx264: profile preset balances speed vs compression efficiency.
      // "social" = veryfast (2× ultrafast at much better quality per bit);
      // "cinema" = faster for the maximum-quality master; v6 "draft" rides
      // ultrafast — the tier's whole point is speed.
      // v7 Step 5: low-end CPU fallback (no usable hardware encoder) drops
      // the ladder to superfast/ultrafast + -tune fastdecode — veryfast's
      // CABAC + finer motion estimation thrashes the small caches of
      // Atom/Celeron-class quads, which is exactly the "1.5 fps" pathology.
      let preset;
      if (lowEnd) {
        preset = quality === "draft" ? "ultrafast" : "superfast";
      } else {
        preset = quality === "cinema" ? q.x264 : (quality === "draft" ? "ultrafast" : "veryfast");
      }
      const args = ["-c:v", "libx264", "-preset", preset, "-crf", String(crfVal)];
      if (lowEnd) args.push("-tune", "fastdecode");
      args.push("-pix_fmt", "yuv420p");
      return args;
    }
  }
}

/** v6/v7: the exact probe argv for a GPU candidate — `pre` (ffmpeg GLOBAL
 * options before the input: the Intel QSV d3d11va→qsv device derivation
 * that Windows iGPU stacks need) + `enc` (the REAL tier encoder args so an
 * arg-shape failure disqualifies the candidate at probe time, never
 * mid-export). h264_amf needs no explicit device init — its encoder context
 * is self-contained on Windows. */
function gpuProbeSpec(name) {
  if (name === "h264_nvenc") {
    return {
      pre: [],
      enc: ["-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-multipass", "qres", "-tune", "hq", "-b_ref_mode", "middle"],
    };
  }
  if (name === "h264_qsv") {
    return {
      // v7 Step 1 (the exact flags): derive a QSV session from an explicit
      // d3d11va device. Without this, QSV probing on Windows silently
      // crashes and the iGPU falls back to CPU.
      pre: ["-init_hw_device", "d3d11va=dx", "-init_hw_device", "qsv=qsv@dx"],
      // The REAL export tier args (veryfast + global_quality) — probing the
      // exact shape the export will run, same philosophy as the NVENC arm.
      enc: ["-preset", "veryfast", "-global_quality", "23", "-look_ahead", "0"],
    };
  }
  return { pre: [], enc: [] }; // h264_amf — self-contained encoder context
}

/** v7 Step 1: encoder-level ffmpeg GLOBAL options for the REAL export argv.
 * QSV is selected only after the probe above SUCCEEDED with these exact
 * device-init flags — so threading the same flags into every real encode
 * (single-pass, chunked, two-step clip argv) guarantees the export runs in
 * the environment that was measured. Every other encoder gets []. */
function encoderGlobalArgs(encoderName) {
  if (encoderName === "h264_qsv" && process.platform === "win32") {
    return ["-init_hw_device", "d3d11va=dx", "-init_hw_device", "qsv=qsv@dx"];
  }
  return [];
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
// v6 PHASE 0 — FAST PROBE: ffprobe JSON (when resolvable) with an
// mtime+size keyed cache (memory + userData disk, 24h TTL), falling back
// to the battle-tested async `ffmpeg -i` stderr parser. Every consumer of
// the old path-keyed cache (stream-copy gates, overlay loop math, audio
// detection, duration probes) keeps the exact same probe SHAPE, so argv
// construction is unchanged — only acquisition got faster and persistent.
// A cached source file is probed ONCE per 24h across exports AND app
// restarts (the v5.1 scheme re-probed every export because temp names were
// unique; user sources are the hot path here).
// ---------------------------------------------------------------------------
const probeCache = new Map();      // "path|mtime|size" → probe shape
const probeInFlight = new Map();   // path → Promise (same-tick dedup)
const PROBE_TTL_MS = 24 * 3600 * 1000;
let probeDisk = null;              // { entries: { key: { t, info } } }
let probeDiskDirty = false;
let probeDiskTimer = null;
let ffprobeBin = null;             // resolved binary | false (unavailable)
let ffprobeChecked = false;

function probeDiskPath() {
  return path.join(app.getPath("userData"), "probe-cache-v6.json");
}

function loadProbeDisk() {
  if (probeDisk) return;
  try {
    probeDisk = JSON.parse(fs.readFileSync(probeDiskPath(), "utf8"));
    if (!probeDisk || typeof probeDisk !== "object" || !probeDisk.entries) {
      probeDisk = { entries: {} };
    }
  } catch (_) {
    probeDisk = { entries: {} };
  }
}

function scheduleProbeDiskSave() {
  if (probeDiskTimer) return;
  probeDiskTimer = setTimeout(() => {
    probeDiskTimer = null;
    if (!probeDiskDirty) return;
    try {
      fs.writeFileSync(probeDiskPath(), JSON.stringify(probeDisk));
      probeDiskDirty = false;
    } catch (_) { /* best-effort persistence */ }
  }, 2000);
}

/** Resolve the ffprobe binary ONCE (async, evidence-based: must print a
 *  real version line). Resolution matrix mirrors ffmpeg's: packaged
 *  extraResources → asar.unpacked → ffprobe-static npm → PATH. The
 *  in-flight promise is MEMOIZED — the export handler's parallel probe
 *  warm-up would otherwise race the first detection (ffprobeChecked flips
 *  before ffprobeBin resolves) and every concurrent probe would silently
 *  fall back to the slower ffmpeg -i parser. */
let ffprobeDetecting = null;
function ffprobeAvailable() {
  if (ffprobeDetecting) return ffprobeDetecting;
  if (ffprobeChecked) return Promise.resolve(ffprobeBin);
  ffprobeDetecting = (async () => {
    const candidates = [];
    const exeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
    const altName = process.platform === "win32" ? "ffprobe" : "ffprobe.exe";
    if (app.isPackaged) {
      // v1.5: the full bundled build ships ffprobe NEXT to ffmpeg — before
      // this, packaged installs had NO ffprobe at all (ffprobe-static is not
      // a dependency) and every media probe silently fell back to the slow
      // `ffmpeg -i` stderr parser.
      candidates.push(
        path.join(process.resourcesPath, "ffmpeg", FFMPEG_PLAT_DIR, exeName),
        path.join(process.resourcesPath, "ffmpeg", FFMPEG_PLAT_DIR, altName),
        path.join(process.resourcesPath, "ffmpeg", exeName),
        path.join(process.resourcesPath, "ffprobe-static", exeName),
        path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "ffprobe-static", exeName),
      );
    } else {
      candidates.push(
        path.join(__dirname, "..", "resources", "ffmpeg", FFMPEG_PLAT_DIR, exeName),
        path.join(process.cwd(), "resources", "ffmpeg", FFMPEG_PLAT_DIR, exeName),
      );
    }
    try {
      const s = require("ffprobe-static");
      if (s && s.path) candidates.push(s.path);
    } catch (_) { /* optional dependency */ }
    candidates.push("ffprobe"); // system PATH (dev boxes / Linux installs)
    for (const c of candidates) {
      const r = await captureExec(c, ["-version"], 8000);
      if (r && r.code === 0 && /ffprobe version/i.test(r.out)) {
        ffprobeBin = c;
        console.log("FFprobe path:", c);
        break;
      }
    }
    if (!ffprobeBin) console.log("FFprobe: not available — probes use the ffmpeg -i parser (cached)");
    ffprobeChecked = true; // resolved — later callers take the cheap path
    return ffprobeBin;
  })();
  return ffprobeDetecting;
}

/** ffprobe -show_streams/-show_format JSON → the EXACT probe shape
 *  videoProbeParser produces (width/height pre-swapped for ±90/±270
 *  displaymatrix rotation, codec/pixFmt lowercase, fps from
 *  avg_frame_rate with r_frame_rate fallback, durationMs from the
 *  container format). Returns null on anything unparseable → the caller
 *  falls back to the ffmpeg -i parser. */
function parseFfprobeJson(text) {
  let j = null;
  try { j = JSON.parse(text); } catch (_) { return null; }
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const out = {
    hasAudio: false, width: 0, height: 0, durationMs: 0,
    codec: "", pixFmt: "", fps: 0, rotated: false,
  };
  out.hasAudio = streams.some((s) => s && s.codec_type === "audio");
  const v = streams.find((s) => s && s.codec_type === "video") || null;
  if (v) {
    out.codec = String(v.codec_name || "").toLowerCase();
    out.pixFmt = String(v.pix_fmt || "").toLowerCase();
    out.width = Number(v.width) || 0;
    out.height = Number(v.height) || 0;
    const parseRate = (r) => {
      const m = /^(\d+)\/(\d+)$/.exec(String(r || ""));
      if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
      const n = Number(r);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    out.fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
    const rotations = (Array.isArray(v.side_data_list) ? v.side_data_list : [])
      .map((sd) => Number(sd && sd.rotation))
      .filter((r) => Number.isFinite(r));
    if (rotations.length > 0) {
      const a = Math.abs(rotations[0]) % 360;
      if (Math.abs(a - 90) < 0.01 || Math.abs(a - 270) < 0.01) {
        const t = out.width; out.width = out.height; out.height = t;
        out.rotated = true;
      }
    }
  }
  if (j.format && Number(j.format.duration) > 0) {
    out.durationMs = Math.round(Number(j.format.duration) * 1000);
  }
  return out;
}

/** v1.1: the full probe shape — every field the export handler consults
 * (stream-copy eligibility + overlay loop math + audio detection). */
function emptyProbe() {
  return {
    hasAudio: false, width: 0, height: 0, durationMs: 0,
    codec: "", pixFmt: "", fps: 0, rotated: false,
  };
}

async function fastProbeUncached(p) {
  const bin = await ffprobeAvailable();
  if (bin) {
    const r = await captureExec(
      bin,
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", "-i", p],
      15000,
    );
    if (r && r.code === 0 && r.out) {
      const info = parseFfprobeJson(r.out);
      if (info) return info;
    }
  }
  // Fallback: the async ffmpeg -i stderr parser (pre-v6 behavior).
  try {
    const r = await ffmpegCapture(["-hide_banner", "-i", p], 15000);
    return G.videoProbeParser(r.out);
  } catch (_) {
    return emptyProbe(); // unreadable source → silent/unknown dims
  }
}

/** v5.1-compatible entry point (same name, same promise-dedup semantics,
 * same probe shape) — now backed by ffprobe + the persistent cache. */
function probeMediaAsync(p) {
  if (typeof p !== "string" || !p) {
    return Promise.resolve(emptyProbe());
  }
  if (probeInFlight.has(p)) return probeInFlight.get(p);
  const job = (async () => {
    let key = p;
    let statOk = false;
    try {
      const st = fs.statSync(p);
      key = `${p}|${Math.round(st.mtimeMs)}|${st.size}`;
      statOk = true;
    } catch (_) { /* unreadable now — probe will report the empty shape */ }
    if (probeCache.has(key)) return probeCache.get(key);
    if (statOk) {
      loadProbeDisk();
      const e = probeDisk.entries[key];
      if (e && Date.now() - e.t < PROBE_TTL_MS && e.info) {
        probeCache.set(key, e.info);
        return e.info;
      }
    }
    const info = await fastProbeUncached(p);
    probeCache.set(key, info);
    if (statOk) {
      probeDisk.entries[key] = { t: Date.now(), info };
      probeDiskDirty = true;
      scheduleProbeDiskSave();
    }
    return info;
  })();
  probeInFlight.set(p, job);
  job.catch(() => {});
  job.finally(() => { probeInFlight.delete(p); });
  return job;
}

// ---------------------------------------------------------------------------
// v6 PHASE 3 — SMART TURBO keyframe scan: ffprobe with -skip_frame nokey
// over a -read_intervals window (decodes ONLY keyframes — a handful per
// GOP, regardless of file length). Cached per path+window. Returns
// [{ s: "<exact pts string>", ms }] or null (ffprobe unavailable / probe
// failure → the caller falls back to the legacy ffmpeg showinfo scan or
// plain re-encode).
// ---------------------------------------------------------------------------
const kfWindowCache = new Map();

async function probeKeyframesNear(p, fromSec, durSec) {
  const bin = await ffprobeAvailable();
  if (!bin) return null;
  const key = `${p}|${Math.max(0, fromSec).toFixed(3)}|${durSec.toFixed(3)}`;
  if (kfWindowCache.has(key)) return kfWindowCache.get(key);
  const job = (async () => {
    try {
      const r = await captureExec(
        bin,
        [
          "-v", "quiet", "-print_format", "json",
          "-select_streams", "v:0",
          "-show_entries", "frame=pts_time",
          "-skip_frame", "nokey",
          "-read_intervals", `${Math.max(0, fromSec).toFixed(3)}%+${durSec.toFixed(3)}`,
          "-i", p,
        ],
        20000,
      );
      if (!r || r.code !== 0 || !r.out) return null;
      let j = null;
      try { j = JSON.parse(r.out); } catch (_) { return null; }
      const frames = Array.isArray(j.frames) ? j.frames : [];
      const kfs = [];
      for (const f of frames) {
        const s = f && f.pts_time != null ? String(f.pts_time) : (f && f.pkt_pts_time != null ? String(f.pkt_pts_time) : null);
        const ms = s != null ? parseFloat(s) * 1000 : NaN;
        if (s != null && Number.isFinite(ms)) kfs.push({ s, ms });
      }
      kfs.sort((a, b) => a.ms - b.ms);
      return kfs;
    } catch (_) {
      return null;
    }
  })();
  kfWindowCache.set(key, job);
  job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------------------
// v1.4.1 KEYFRAME-ALIGNED STREAM-COPY TRIMS — the last big reason a
// cuts-only clip still re-encoded was a head trim (`trimInMs > 0` forced
// the encode path because `-c copy` can only cut ON keyframes). If the
// requested cut point happens to have a source keyframe within ONE FRAME,
// the copy path can start exactly at that keyframe and keep the fast path.
// Probe = ffmpeg with `-skip_frame nokey` (decode ONLY keyframes — a few
// frames per 5 s window, regardless of file length) + `showinfo` (prints
// each decoded frame's pts_time) + `-copyts`/`-noaccurate_seek` so the
// printed timestamps stay on the SOURCE clock and the read window starts
// at the seek-landing keyframe. All flag placements verified against the
// bundled ffmpeg 6.1.1: `-skip_frame nokey` MUST precede `-i` (a decoder
// option placed after `-i` is applied to the encoder and rejected).
// ---------------------------------------------------------------------------
const kfAlignCache = new Map(); // `${path}|${trimMs}` → Promise<{ss,deltaMs}|null>

/** Parse showinfo's `pts_time:<sec>` marks into {s: exactString, ms}. */
function parseKeyframeSecs(out) {
  const kfs = [];
  const re = /pts_time:(\d+(?:\.\d+)?)/g;
  const text = String(out || "");
  let m;
  while ((m = re.exec(text))) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) kfs.push({ s: m[1], ms: v * 1000 });
  }
  return kfs;
}

/**
 * Nearest keyframe to `trimMs` within one frame duration (tolerance
 * 1000/fps, clamped to 10–50 ms). Resolves { ss, deltaMs } — `ss` is the
 * EXACT pts string, which buildStreamCopyArgs passes to `-ss` verbatim
 * (µs precision — a rounded value 1 ms early makes the backward seek land
 * on the previous GOP) — or null (not aligned / probe failure → the clip
 * takes the re-encode path exactly as before).
 */
function findKeyframeAlignedStart(path, trimMs, fps) {
  if (typeof path !== "string" || !path || !Number.isFinite(trimMs) || trimMs <= 0) {
    return Promise.resolve(null);
  }
  const key = `${path}|${Math.round(trimMs)}`;
  if (kfAlignCache.has(key)) return kfAlignCache.get(key);
  const job = (async () => {
    try {
      const tolMs = Math.min(50, Math.max(10, Math.round(1000 / Math.max(1, Number(fps) || 30))));
      // Window: [trim−2.5 s, trim+2.5 s] read from the seek-landing keyframe
      // (−noaccurate_seek never discards pre-target packets, so the landing
      // keyframe itself is included). A keyframe within tol ≤ 50 ms of trim
      // is provably inside this window for ANY GOP size: the landing point
      // is ≤ trim−2.5 s, and reading stops at original ts trim+2.5 s.
      const ss = Math.max(0, (trimMs - 2500) / 1000).toFixed(3);
      const r = await ffmpegCapture([
        "-hide_banner", "-nostats",
        "-copyts",
        "-ss", ss, "-noaccurate_seek", "-t", "5",
        "-skip_frame", "nokey",
        "-i", path,
        "-map", "0:v:0", "-vf", "showinfo",
        "-f", "null", "-",
      ], 20000);
      const kfs = parseKeyframeSecs(r && r.out);
      let best = null;
      let bestD = Infinity;
      for (const kf of kfs) {
        const d = Math.abs(kf.ms - trimMs);
        if (d < bestD) { bestD = d; best = kf; }
      }
      return best && bestD <= tolMs
        ? { ss: best.s, deltaMs: Math.round(best.ms - trimMs) }
        : null;
    } catch (_) {
      return null;
    }
  })();
  kfAlignCache.set(key, job);
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
  const { outputPath, fps, width, height, bitrateMbps, quality, crf, audioKbps, kenBurns, segments, audioPath, audio, captionSettings, subtitleCues, headlines, transition, watermark, overlays, sfx } = opts;

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
  // v1.2: export audio bitrate — validated against the allowed ladder,
  // 192 default (the v1.1 constant).
  const abr = [96, 128, 192, 256, 320].includes(Number(audioKbps)) ? Number(audioKbps) : 192;
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
  // v1.3: ETA requires a REAL sample before it is shown — the old ≥2% gate
  // still extrapolated ffmpeg startup + filter warm-up into multi-hour
  // estimates ("estimated 22445s" on a 19-minute video) that panicked
  // users before the rate settled. 4% of content AND ≥ 5 s elapsed, and the
  // same gate applies on re-estimates (the elapsed/fraction formula is an
  // all-run average, so it only ever smooths).
  function etaFor(fraction) {
    if (fraction <= 0.04) return undefined;
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed < 5) return undefined;
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

    // ─── STEP 1 (build): probes → per-clip argv jobs ───────────────
    // v4.3 transition planning + zoompan math + all three v4.9 branches
    // (xfade head / watermark graph / plain -vf) live in
    // G.buildClipArgs — byte-identical for v4.9-shaped payloads.
    //
    // v5.2 AUDIO PIPELINE: step-1 clips are now VIDEO-ONLY. Clip audio is
    // extracted in parallel as 48 kHz stereo PCM WAVs and mixed ONCE in
    // step 2 (volume + absolute-timeline adelay per clip + music + SFX →
    // amix → a single AAC encode). This removes the v5.0/5.1 double AAC
    // encode, the per-image-clip synthesized-silence tracks, and the
    // AAC→AAC generational loss — the layout used by Shotcut-class editors.
    const jobs = [];
    const clipPaths = [];
    const clipAudioJobs = [];
    // v6: per-segment facts collected during the build loop — the single-pass
    // route consumes them (audio branch list + probe-gated hw decode).
    const segInfo = [];
    let cumulativeMs = 0;
    // v7 Step 5: low-end CPU detection — 4-or-fewer cores on the libx264
    // fallback (no usable iGPU/dGPU) switches the preset ladder to
    // superfast/ultrafast + -tune fastdecode and caps per-worker threads.
    const cpuCount = os.cpus().length;
    const lowEndCpu = cpuCount <= 4;
    const lowEndX264 = lowEndCpu && encoder.name === "libx264";
    const encArgs = encoderArgs(encoder.name, bitrateMbps, width, height, quality, crf, lowEndX264);
    // v7 Step 1: QSV's d3d11va→qsv device-init globals ride at the head of
    // every real encode argv (the probe validated the exact environment).
    const encGlobalArgs = encoderGlobalArgs(encoder.name);
    // v7 Step 4: per-segment TURBO plan recorded during the build loop — the
    // HYBRID chunked single-pass replays the clean segments as stream
    // copies (zero decode/filter/encode) while the dirty intervals render
    // through the windowed graph.
    const turboPlan = new Array(segments.length).fill(null);
    // v5.2: thread budget — divide the cores across the parallel pool so N
    // concurrent encoders never oversubscribe the CPU (the v5.1 scheme gave
    // EVERY child `-threads 0` = all cores → 4× oversubscription thrash).
    // v1.1 TURBO: the pool is now ENCODER-AWARE — hardware encoders are the
    // shared resource (consumer GPUs serialize internally and allow few
    // concurrent sessions), so a GPU export runs a TIGHTER pool with
    // per-process threads freed for the CPU filter graphs; the CPU pool
    // keeps the v5.2 core-division scheme.
    // v6 PHASE 1: GPU pool 3 → 1 (one NVENC/QSV/AMF session saturates the
    // GPU; 3 concurrent sessions mostly fought each other), CPU pool
    // min(4,cpus−2) → min(2, floor(cpus/4)) (x264 scales with THREADS far
    // better than with processes; >2 workers only added seek/GOP re-decode
    // overhead). The thread-budget division below is unchanged — a single
    // job still gets every core.
    const isGpuEncoder = encoder.name !== "libx264";
    const poolN = isGpuEncoder
      ? 1
      : Math.max(1, Math.min(2, Math.floor(os.cpus().length / 4)));
    // v1.4.2 CHUNKED PARALLEL ENCODE: long re-encode clips split into
    // frame-aligned ~60 s chunks (capped at the pool width — more chunks
    // than workers only adds seek overhead, fewer wastes the pool). This is
    // THE fix for the "one 19-minute video exports for hours" case: the
    // per-clip filter graph (libass subtitles, scale, overlay) is
    // single-threaded, so a single-process encode cannot use the machine —
    // chunks turn it into the many-clips layout the pool already
    // parallelizes, with the concat still riding `-c copy`.
    const CHUNK_TARGET_SEC = 60;
    const maxChunks = Math.max(2, poolN);
    // v1.3 THREAD-STARVATION FIX: the v5.2 budget divided the cores by the
    // POOL SIZE (min(4, cpus−2)) even when the project had FEWER clips than
    // pool slots — a 1–2 long-clip project (the common "one 19-minute
    // video" case) encoded with `-threads 1–2` on an 8-core machine, i.e.
    // 25–50% CPU utilization and 2–4× slower than necessary. The budget now
    // divides by the number of jobs that will ACTUALLY run concurrently,
    // so a single long clip gets every core — the HandBrake/Shotcut
    // single-job layout — while many-clip projects keep the v5.2
    // oversubscription-free division.
    // v1.4.2: the estimate is now CHUNK-AWARE — a chunkable long video
    // counts as its chunk count (the pool will run that many encode jobs
    // for it). Non-chunkable projects estimate exactly segments.length,
    // keeping the legacy budget byte-for-byte.
    const estVideoJobs = segments.reduce((n, s) => {
      if (s && s.mediaType === "video" && s.videoPath) {
        const plan = G.planChunkFrames(Number(s.durationMs) || 0, fps, CHUNK_TARGET_SEC, maxChunks);
        return n + (plan ? plan.length : 1);
      }
      return n + 1;
    }, 0);
    const activeJobs = Math.max(1, Math.min(poolN, estVideoJobs || segments.length));
    const threadBudget = isGpuEncoder
      ? Math.max(2, os.cpus().length)
      : lowEndX264
        // v7 Step 5: cap each pool worker at 2 threads on ≤4-core libx264
        // boxes (W×threads stays within the physical core budget — no
        // cache-thrashing oversubscription).
        ? Math.max(1, Math.min(2, Math.floor(cpuCount / activeJobs)))
        : Math.max(1, Math.floor(cpuCount / activeJobs));

    // v1.1 TURBO: stream-copy counters for the result payload + a shared
    // actual-duration accumulator (post-step-1 probe of each clip file —
    // stream copies cut at packet granularity, so the real concat length
    // can differ from the requested timeline by a frame per clip; the
    // audio graph should pad/mix to the ACTUAL video length).
    let copiedClips = 0;
    let encodedClips = 0;
    // v1.4.1: how many of the copied clips took the keyframe-aligned
    // head-trim path (result telemetry — surfaced in the export toast).
    let keyframeCuts = 0;
    // v1.4.2 chunked-encode telemetry: chunkedClips = segments split into
    // chunks, totalChunks = chunk encode jobs emitted, hwDecodeClips =
    // sources riding the throughput-gated -hwaccel auto decode path.
    let chunkedClips = 0;
    let totalChunks = 0;
    let hwDecodeClips = 0;

    // v1.4.2: write an ASS document to a temp file → the subtitles= filter
    // suffix. Shared by the segment path (tag = clip index) and the chunk
    // path (tag = clip index _ chunk index).
    const writeAssFile = (doc, tag) => {
      const assPath = path.join(tempDir, `captions_${tag}_${Date.now()}.ass`);
      fs.writeFileSync(assPath, doc, "utf-8");
      tempFiles.push(assPath);
      const escapedAssPath = assPath
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'")
        .replace(/,/g, "\\,");
      return `subtitles=filename='${escapedAssPath}'`;
    };

    // v1.4.2: overlay specs for ANY window (segment OR chunk). The chunked
    // encode path re-runs this per chunk with the chunk window so overlay
    // playback position, motion clock, and enable=between() windows stay
    // correct — identical semantics to the old inline segment loop.
    const buildOverlaySpecsForWindow = async (winStartMs, winDurMs) => {
      const specs = [];
      for (const ov of overlaySegs) {
        const win = G.overlayWindow(ov, winStartMs, winDurMs);
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
        // v5.6 MOTION PATHS: 1 keyframe = pinned position (resolved to a
        // static rect through the geometry mirror with that kf as free-form
        // x/y); ≥2 keyframes = the overlay filter's x/y become piecewise-
        // linear TIME EXPRESSIONS (the exact preview curve). tOffsetSec
        // shifts the window-local clock to the overlay's window-local clock.
        const motion = G.sanitizeMotionMirror(
          ov.overlay && ov.overlay.motion,
        );
        let x = geo.dx;
        let y = geo.dy;
        let xExpr = null;
        let yExpr = null;
        if (motion.length === 1) {
          const pinned = G.overlayGeometryMirror(width, height, srcW, srcH, {
            ...(ov.overlay || {}),
            x: motion[0].x,
            y: motion[0].y,
          });
          x = pinned.dx;
          y = pinned.dy;
        } else if (motion.length >= 2) {
          const tOffsetSec = (winStartMs - Number(ov.startMs) || 0) / 1000;
          const exprs = G.buildMotionOverlayExpr({
            videoW: width,
            videoH: height,
            dw: geo.dw,
            dh: geo.dh,
            tOffsetSec,
            motion,
          });
          if (exprs) {
            xExpr = exprs.xExpr;
            yExpr = exprs.yExpr;
          }
        }
        // v5.2: overlayLoop — a short green-screen source repeats to span
        // its whole timeline window (-stream_loop -1 on the input).
        const ovLoop = ov.overlayLoop === true;
        let srcDurMs = Number(ov.sourceDurationMs) > 0 ? Number(ov.sourceDurationMs) : 0;
        if (!srcDurMs && isVid) {
          const p = await probeMediaAsync(srcPath);
          srcDurMs = Number(p.durationMs) > 0 ? Number(p.durationMs) : 0;
        }
        // v1.4.1 PER-OVERLAY FPS NORMALIZATION: a video overlay running
        // FASTER than the project rate (e.g. 60 fps PiP over a 30 fps
        // timeline) makes the whole composite graph evaluate at the
        // overlay's rate — ~2× the scale/chroma/composite/encode work for
        // zero visual gain (the base chain already normalizes the output
        // to `fps`). `fps=<project>` at the head of the overlay chain
        // drops the surplus frames before anything runs. Near-rate or
        // slower overlays are left untouched (dup frames would only add
        // work; the overlay filter's framesync already syncs by timestamp).
        let normFps = null;
        if (isVid) {
          const ovProbe = await probeMediaAsync(srcPath);
          const ovFps = Number(ovProbe.fps) || 0;
          if (ovFps > fps + 0.5) normFps = fps;
        }
        specs.push({
          inputArgs: isVid
            ? G.buildOverlayVideoInputArgs({ ssMs: win.ssMs, durMs: win.overlapMs, path: srcPath, loop: ovLoop, srcDurMs })
            : G.buildOverlayImageInputArgs({ durMs: win.overlapMs, path: srcPath }),
          fps: normFps,
          x,
          y,
          xExpr,
          yExpr,
          dw: geo.dw,
          dh: geo.dh,
          chroma: ov.chroma || null,
          a: win.a,
          b: win.b,
          // v6.5: the authoritative "overlay continues past this window" flag
          // (padOverlayInputWindows pads exactly these inputs past a chunk
          // end — framesync eof_action=pass would otherwise drop the overlay
          // from the chunk's last frame).
          clippedEnd: win.clippedEnd,
        });
      }
      return specs;
    };

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const clipPath = path.join(tempDir, `clip_${String(i).padStart(4, "0")}.mp4`);

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

      const assSuffix = assDoc ? writeAssFile(assDoc, String(i).padStart(4, "0")) : null;

      // v5 overlay specs for THIS clip window (segment-level — used by the
      // copy gate + the whole-clip encode path; chunks re-window below).
      const overlaySpecs = await buildOverlaySpecsForWindow(segStartMs, seg.durationMs);

      const segHasAudio = !!(
        seg.mediaType === "video" &&
        seg.videoPath &&
        (await probeMediaAsync(seg.videoPath)).hasAudio
      );
      // v6: collect for the single-pass route (hw decode is probed lazily
      // there — probeHwDecode results are cached per path).
      segInfo[i] = {
        segStartMs,
        segHasAudio,
        speed: G.resolveSegSpeed(seg),
        trimInMs: Number(seg.trimInMs) || 0,
      };

      // ── v1.1 TURBO: STREAM-COPY fast path ──────────────────────
      // Cuts-only clips whose source already matches the output spec
      // are remuxed with ZERO decode/filter/encode — this is the
      // "simple cut exports in seconds" technique every fast editor
      // uses. Eligibility has two halves:
      //   (a) timeline-side (pure): G.clipNeedsReEncode — no speed, no
      //       UNALIGNED head trim, no overlays in window, no captions/
      //       headlines, no watermark, no transition fades at this
      //       boundary;
      //   (b) source-side (probe): h264 + yuv420p + output dims + fps
      //       match + no rotation + the window covers the whole source
      //       (tail-only trim ≤ 300 ms — packet-granularity cut).
      // v1.4.1 KEYFRAME-ALIGNED TRIMS: a head trim no longer disqualifies
      // the clip when a source keyframe sits within ONE FRAME of the
      // requested cut (findKeyframeAlignedStart). The copy then starts
      // at that keyframe (`-ss <exactPts> -noaccurate_seek`), keeping the
      // timeline duration exact and the content boundary within one
      // frame. Anything further than one frame stays re-encode — the
      // frame-accuracy tradeoff is deliberately one frame, no more.
      // Mixed projects are fine: copied and re-encoded parts share the
      // exact output stream spec (h264 yuv420p WxH fps), so the concat
      // demuxer + `-c copy` mux stay uniform.
      const trimInMs = Number(seg.trimInMs) || 0;
      let trimKeyAligned = false;
      let trimSs = null;
      let sandwichPlan = null;
      if (trimInMs > 0) {
        // Skip the keyframe probe when the clip is ALREADY re-encode-bound
        // for other reasons (overlaps/captions/speed/fades/...) — patch
        // trimInMs to 0 so clipNeedsReEncode reports those reasons alone.
        const otherwiseCopyEligible = !G.clipNeedsReEncode({
          i, seg: { ...seg, trimInMs: 0 }, segments, transition,
          overlayCount: overlaySpecs.length,
          assSuffix, wm,
        });
        if (otherwiseCopyEligible) {
          const preProbe = await probeMediaAsync(seg.videoPath);
          const preOk =
            preProbe.codec === "h264" &&
            preProbe.pixFmt === "yuv420p" &&
            !preProbe.rotated &&
            preProbe.width === width &&
            preProbe.height === height &&
            Math.abs((preProbe.fps || 0) - fps) < 0.06;
          if (preOk) {
            const kf = await findKeyframeAlignedStart(seg.videoPath, trimInMs, fps);
            if (kf) {
              trimKeyAligned = true;
              trimSs = kf.ss;
            } else {
              // v6 PHASE 3 SMART TURBO: no keyframe within one frame — try
              // the SANDWICH (re-encode the two ≤2s edges, stream-copy the
              // ≥4s middle between keyframes). Frame-accurate at the trim
              // boundaries AND mostly copy — the trimmed-clip TURBO hit
              // rate jumps from the ~5% exact-alignment case to any clip
              // whose GOPs straddle the trim.
              const kfs = await probeKeyframesNear(
                seg.videoPath,
                Math.max(0, (trimInMs - 2500) / 1000),
                (Number(seg.durationMs) || 0) / 1000 + 5,
              );
              if (kfs && kfs.length > 0) {
                sandwichPlan = G.planSandwichCopy({
                  trimMs: trimInMs,
                  durMs: Number(seg.durationMs) || 0,
                  keyframes: kfs,
                });
              }
            }
          }
        }
      }
      if (!G.clipNeedsReEncode({
          i, seg, segments, transition,
          overlayCount: overlaySpecs.length,
          assSuffix, wm,
          trimKeyAligned: trimKeyAligned || !!sandwichPlan,
        })) {
        const probe = await probeMediaAsync(seg.videoPath);
        const srcDur = Number(probe.durationMs) || 0;
        const specOk =
          probe.codec === "h264" &&
          probe.pixFmt === "yuv420p" &&
          !probe.rotated &&
          probe.width === width &&
          probe.height === height &&
          Math.abs((probe.fps || 0) - fps) < 0.06 &&
          srcDur > 0;
        // v1.1 legacy single-copy: untrimmed or keyframe-aligned head + the
        // window covers the source tail (packet-granularity cut).
        const formatOk = specOk &&
          (trimInMs === 0 || trimKeyAligned) &&
          (trimInMs + seg.durationMs) >= srcDur - 300;
        // v6 sandwich: any trim depth — the edges re-encode to the exact
        // boundaries, the middle copies between keyframes.
        const sandwichOk = !!sandwichPlan && specOk;
        if (formatOk) {
          tempFiles.push(clipPath);
          clipPaths.push(clipPath);
          jobs.push({
            idx: i,
            args: G.buildStreamCopyArgs({
              path: seg.videoPath,
              durMs: seg.durationMs,
              clipPath,
              ss: trimSs,
            }),
            durSec: seg.durationMs / 1000,
            durationMs: seg.durationMs,
            segId: seg.id,
            copy: true,
          });
          // v7 Step 4: record the TURBO plan so the HYBRID chunked single-pass
          // can replay this segment as a stream-copy piece (with the same
          // keyframe-aligned seek) instead of re-encoding it through the graph.
          turboPlan[i] = { kind: "copy", ss: trimSs };
          copiedClips += 1;
          // v1.4.1: count only copies that actually rode the keyframe-aligned
          // trim path (an aligned find that still re-encodes for a source-
          // format reason must not inflate the number).
          if (trimKeyAligned) keyframeCuts += 1;
          cumulativeMs += seg.durationMs;
          if (segHasAudio) {
            // PCM extraction still rides the pool (audio is mixed in
            // step 2 regardless of how the video got there).
            // v6 FIX: the extraction now SEEKS to trimInMs — the v5.2 argv
            // read from the file START, so a trimmed clip's audio came from
            // the wrong window (the video rode -ss, the audio did not).
            const wavPath = path.join(tempDir, `audio_${String(i).padStart(4, "0")}_${Date.now()}.wav`);
            tempFiles.push(wavPath);
            clipAudioJobs.push({
              idx: jobs.length + clipAudioJobs.length,
              args: [
                ...(trimInMs > 0 ? ["-ss", G.fmt3(trimInMs)] : []),
                "-i", seg.videoPath, "-vn", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", wavPath,
              ],
              wavPath,
              startMs: segStartMs,
              volume: G.normalizeVolume(seg.volume),
              durSec: seg.durationMs / 1000,
              durationMs: seg.durationMs,
              segId: seg.id,
            });
          }
          continue; // skip the encode path entirely
        }
        if (sandwichOk) {
          // v6 SMART TURBO sandwich: head edge encode → middle stream copy
          // → tail edge encode, all to the uniform output spec so the
          // concat demuxer stays -c copy. Frame-accurate at BOTH trim
          // boundaries; the ≥4s middle rides zero-decode copy.
          // v7 Step 4: recorded for the HYBRID replay (edges re-encode + the
          // middle copies — the plan is replayed with the hybrid's per-worker
          // thread budget instead of the two-step pool's).
          turboPlan[i] = { kind: "sandwich", plan: sandwichPlan };
          const emitEdge = (edge, tag) => {
            const edgePath = path.join(tempDir, `clip_${String(i).padStart(4, "0")}_${tag}.mp4`);
            tempFiles.push(edgePath);
            clipPaths.push(edgePath);
            const built = G.buildClipArgs({
              i,
              seg: { ...seg, trimInMs: edge.trimMs, durationMs: edge.durMs },
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
              clipPath: edgePath,
              encArgs,
              globalArgs: encGlobalArgs,
              anyAudio: false,
              segHasAudio: false,
              overlaySpecs,
              hwaccel: false,
              threads: threadBudget,
            });
            jobs.push({
              idx: i,
              args: built.args,
              durSec: edge.durMs / 1000,
              durationMs: edge.durMs,
              segId: seg.id,
            });
          };
          if (sandwichPlan.head) emitEdge(sandwichPlan.head, "sh");
          const midPath = path.join(tempDir, `clip_${String(i).padStart(4, "0")}_sm.mp4`);
          tempFiles.push(midPath);
          clipPaths.push(midPath);
          jobs.push({
            idx: i,
            args: G.buildStreamCopyArgs({
              path: seg.videoPath,
              durMs: sandwichPlan.middle.durMs,
              clipPath: midPath,
              ss: sandwichPlan.middle.ss,
            }),
            durSec: sandwichPlan.middle.durMs / 1000,
            durationMs: sandwichPlan.middle.durMs,
            segId: seg.id,
            copy: true,
          });
          if (sandwichPlan.tail) emitEdge(sandwichPlan.tail, "st");
          copiedClips += 1; // the middle rode copy — the TURBO telemetry counts it
          cumulativeMs += seg.durationMs;
          if (segHasAudio) {
            const wavPath = path.join(tempDir, `audio_${String(i).padStart(4, "0")}_${Date.now()}.wav`);
            tempFiles.push(wavPath);
            clipAudioJobs.push({
              idx: jobs.length + clipAudioJobs.length,
              args: [
                ...(trimInMs > 0 ? ["-ss", G.fmt3(trimInMs)] : []),
                "-i", seg.videoPath, "-vn", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", wavPath,
              ],
              wavPath,
              startMs: segStartMs,
              volume: G.normalizeVolume(seg.volume),
              durSec: seg.durationMs / 1000,
              durationMs: seg.durationMs,
              segId: seg.id,
            });
          }
          continue; // sandwiched — skip the whole-clip encode path
        }
      }
      encodedClips += 1;

      // ── v1.4.2 CHUNKED PARALLEL ENCODE + throughput-gated hw decode ──
      // A long re-encode clip is ONE ffmpeg process whose filter graph
      // (libass subtitles, scale, overlay) is single-threaded — the
      // "19-minute video exports for 3.5 hours" pathology. Frame-aligned
      // chunks (planChunkFrames) turn it into the many-clips layout the
      // pool already parallelizes; the concat rides `-c copy` as always.
      // Images are deliberately NOT chunked (zoompan frame indexing +
      // slideshows are inherently many-clip).
      const segIsVideo = seg.mediaType === "video" && seg.videoPath;
      const chunkPlan = segIsVideo
        ? G.planChunkFrames(Number(seg.durationMs) || 0, fps, CHUNK_TARGET_SEC, maxChunks)
        : null;
      // v1.4.2: hw decode only after the PROBE proves it ≥ 1.3× faster on
      // THIS file (≥ 20 s sources only — shorter clips don't pay back the
      // two probe arms). Replaces the v1.1 unconditional-off policy with
      // evidence per source; failures stay on CPU silently.
      const hw = segIsVideo && (Number(seg.durationMs) || 0) >= 20000
        ? await probeHwDecode(seg.videoPath)
        : false;
      if (hw) hwDecodeClips += 1;

      if (chunkPlan) {
        for (let k = 0; k < chunkPlan.length; k++) {
          const ch = chunkPlan[k];
          const chunkPath = path.join(
            tempDir,
            `clip_${String(i).padStart(4, "0")}_${String(k).padStart(2, "0")}.mp4`,
          );
          tempFiles.push(chunkPath);
          clipPaths.push(chunkPath);
          const chunkStartMs = segStartMs + ch.offsetMs;
          // Per-chunk ASS window — a cue crossing a chunk boundary renders
          // partially in each chunk, the EXACT semantics of cues crossing
          // segment boundaries (buildAssDocument clamps to the window).
          let chunkAssSuffix = null;
          if (captionsEnabled || headlinesEnabled) {
            const doc = buildAssDocument(
              captionsEnabled ? subtitleCues : [],
              captionsEnabled ? captionSettings : null,
              headlinesEnabled ? headlines : null,
              width, height, chunkStartMs, chunkStartMs + ch.durMs, ch.durMs,
            );
            chunkAssSuffix = doc
              ? writeAssFile(doc, `${String(i).padStart(4, "0")}_${String(k).padStart(2, "0")}`)
              : null;
          }
          const chunkOverlaySpecs = await buildOverlaySpecsForWindow(chunkStartMs, ch.durMs);
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
            assSuffix: chunkAssSuffix,
            clipPath: chunkPath,
            encArgs,
            globalArgs: encGlobalArgs,
            anyAudio: false,
            segHasAudio: false,
            overlaySpecs: chunkOverlaySpecs,
            hwaccel: hw,
            threads: threadBudget,
            chunk: { offsetMs: ch.offsetMs, durMs: ch.durMs, first: ch.first, last: ch.last },
          });
          jobs.push({
            idx: i,
            args: built.args,
            durSec: ch.durMs / 1000,
            durationMs: ch.durMs,
            segId: seg.id,
          });
        }
        chunkedClips += 1;
        totalChunks += chunkPlan.length;
      } else {
        // Whole-clip encode (legacy path — argv byte-identical apart from
        // the probed hwaccel flag, which is still false on CPU-only boxes).
        tempFiles.push(clipPath);
        clipPaths.push(clipPath);
        // v5.2: video-only clip encode — audio never rides the concat demuxer.
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
          globalArgs: encGlobalArgs,
          anyAudio: false,
          segHasAudio: false,
          overlaySpecs,
          // v1.4.2: hardware decode is PER-SOURCE, PROBE-GATED (see
          // probeHwDecode above) — no longer unconditionally disabled, but
          // enabled only where it measured ≥ 1.3× faster than CPU decode.
          hwaccel: hw,
          // v5.2: thread budget (see the pool below).
          threads: threadBudget,
        });

        jobs.push({
          idx: i,
          args: built.args,
          durSec: seg.durationMs / 1000,
          durationMs: seg.durationMs,
          segId: seg.id,
        });
      }

      // v5.2: parallel PCM extraction for the clip's own audio (speed
      // applied here via atempo; volume stays in the step-2 mix graph).
      // v6 FIX: -ss trimInMs — the extraction window now matches the video
      // arm (the v5.2 argv read the audio from the file START).
      if (segHasAudio) {
        const wavPath = path.join(tempDir, `audio_${String(i).padStart(4, "0")}_${Date.now()}.wav`);
        tempFiles.push(wavPath);
        const speed = Number(seg.speed) > 0 ? Number(seg.speed) : 1;
        const sourceWinMs = speed !== 1 ? Math.max(0, Number(seg.durationMs) || 0) * speed : 0;
        const tempo = speed !== 1 ? G.atempoFilters(speed) : [];
        clipAudioJobs.push({
          idx: jobs.length + clipAudioJobs.length,
          args: [
            ...(trimInMs > 0 ? ["-ss", G.fmt3(trimInMs)] : []),
            ...(sourceWinMs > 0 ? ["-t", (sourceWinMs / 1000).toFixed(3)] : []),
            "-i", seg.videoPath,
            "-vn",
            ...(tempo.length > 0 ? ["-af", tempo.join(",")] : []),
            "-ar", "48000", "-ac", "2",
            "-c:a", "pcm_s16le",
            "-y", wavPath,
          ],
          wavPath,
          startMs: segStartMs,
          volume: G.normalizeVolume(seg.volume),
          durSec: seg.durationMs / 1000,
          durationMs: seg.durationMs,
          segId: seg.id,
        });
      }
      cumulativeMs += seg.durationMs;
    }

    // ─── v6 SINGLE-PASS ROUTE ─────────────────────────────────────────
    // When the build loop produced ANY re-encode job (i.e. NOT a pure TURBO
    // all-copy export — those run the pool below and finish in seconds) and
    // the project fits the single-pass envelope, the WHOLE timeline renders
    // in ONE ffmpeg process via -filter_complex_script:
    //   • every segment decoded once, composited once, encoded once — no
    //     per-clip temp files, no N encoder inits, no concat demuxer round
    //     trip;
    //   • clip audio mixes from the base inputs' OWN [i:a] streams — the
    //     PCM-extraction pool jobs (and their WAV temp files) vanish;
    //   • captions burn ONCE on the concatenated stream (libass still runs
    //     single-threaded — long captioned projects keep the chunked pool
    //     via the eligibility ceiling);
    //   • the audio bus collapses to 1 pass (normalize OFF) or 2 passes
    //     (ON: parallel source-window measurement → estimated master gain,
    //     no mix WAV render, no re-measure).
    // A graph that exceeds the script budget or a process that dies at INIT
    // (<4s — graph parse/codec-open failures) falls back to the two-step
    // pool below automatically; anything later rethrows.
    const anyEncodeJob = jobs.length > 0 && jobs.some((j) => !j.copy);
    // v6 routing gate: single-pass re-encodes the WHOLE timeline, so it only
    // wins when the re-encode work is the DOMINANT cost. A mostly-copy
    // project (11 clean copies + one 1.2 s sandwich edge) must keep the TURBO
    // pool — re-encoding 24 s to save a 1.2 s edge would be a regression.
    const encodeWorkMs = jobs.reduce((a, j) => a + (j && !j.copy ? (j.durationMs || 0) : 0), 0);
    const encodeDominant = encodeWorkMs >= 8000 || encodeWorkMs >= totalMs * 0.3;
    if (anyEncodeJob && encodeDominant) {
      // ── v6.5 CPU-FIRST: CHUNKED SINGLE-PASS ──────────────────────────────
      // W parallel processes each render one timeline WINDOW through its own
      // single-pass graph (decode + filters + x264 encode), the audio bus
      // renders ONCE as its own process, and a final concat+mux glues video
      // + audio with -c copy. A single process cannot use a many-core CPU
      // when the filter graph (libass, overlay, zoompan) is the bottleneck —
      // W processes each get cores/W encoder threads. GPU boxes keep W=1 (a
      // single NVENC session saturates the GPU; the <40 s target doesn't
      // need chunking). Fallback ladder: any init-class failure (<4 s) or a
      // per-chunk graph over budget → the battle-tested two-step pool.
      const isGpuEncoder = encoder.name !== "libx264";
      const cpuCount = os.cpus().length;
      const spWorkers = isGpuEncoder
        ? 1
        : cpuCount >= 4
          ? Math.max(2, Math.min(4, Math.floor(cpuCount / 3)))
          : 1;
      // Full-timeline fade strings — the chunk planner's forbidden zones are
      // derived from these (fade rejects negative st; xfade heads need the
      // previous segment's input in-process), so boundaries never split a
      // fade ramp or a head composite.
      const fullFades = SP.buildGlobalFades({ segments, transition, totalMs });
      let chunkPlan = null;
      if (spWorkers >= 2) {
        // v7 Step 4: segClean = per-segment TURBO copy-eligibility recorded
        // during the build loop. planTimelineChunks uses it to align chunk
        // boundaries to the clean↔dirty run edges — clean chunks replay as
        // stream copies, dirty chunks as windowed single-pass graphs (the
        // 60 % TURBO hybrid). All-clean/all-dirty (or an unalignable edge)
        // keeps the plain full-timeline chunk plan, byte-identical to v6.5.
        const segClean = turboPlan.map((t) => !!t);
        chunkPlan = SP.planTimelineChunks({
          segments,
          transition,
          kbEnabled: enabled,
          globalDir,
          fps,
          totalMs,
          fades: fullFades,
          workerCount: spWorkers,
          segClean,
        });
        if (!chunkPlan || chunkPlan.chunks.length < 2) chunkPlan = null;
      }
      const eligibility = SP.singlePassEligible({
        segments,
        overlayCount: overlaySegs.length,
        totalSec,
        captionsBurned: captionsEnabled || headlinesEnabled,
        chunked: !!chunkPlan,
      });
      if (eligibility.ok) {
        // Audio branches from the collected segInfo (video segs with audio).
        const clipAudioBranches = [];
        for (let b = 0; b < segments.length; b++) {
          const info = segInfo[b];
          if (info && info.segHasAudio) {
            clipAudioBranches.push({
              inputIdx: b,
              startMs: info.segStartMs,
              volume: G.normalizeVolume(segments[b].volume),
              atempo: G.atempoFilters(info.speed),
              durationMs: Number(segments[b].durationMs) || 0,
            });
          }
        }
        // v6 AUDIO BUS: normalize ON → measure each SOURCE at its timeline
        // window (bounded 8-parallel, audio-only, seeked — no WAV extraction)
        // and estimate the summed-mix master gain (energy sum) — the v1.3
        // render-mix-to-WAV + re-measure + remux round trip is GONE. OFF →
        // zero measurement passes, straight into the graph.
        let spLoudnorm = null;
        let spMasterLoudnorm = null;
        if (audio && audio.normalize && (clipAudioBranches.length > 0 || audioPath)) {
          const measures = { clip: new Array(clipAudioBranches.length).fill(null), music: null };
          const tasks = clipAudioBranches.map((c, k) => ({
            kind: "clip", k,
            p: segments[c.inputIdx].videoPath,
            win: {
              ssMs: segInfo[c.inputIdx].trimInMs,
              durMs: (Number(segments[c.inputIdx].durationMs) || 0) * (segInfo[c.inputIdx].speed !== 1 ? segInfo[c.inputIdx].speed : 1),
            },
          }));
          if (audioPath) tasks.push({ kind: "music", p: audioPath, win: null });
          for (let t = 0; t < tasks.length; t += 8) {
            const chunkT = tasks.slice(t, t + 8);
            const res = await Promise.all(chunkT.map((task) => measureLoudnessAsync(task.p, task.win)));
            chunkT.forEach((task, r) => {
              if (task.kind === "clip") measures.clip[task.k] = res[r];
              else measures.music = res[r];
            });
          }
          spLoudnorm = measures;
          spMasterLoudnorm = G.estimateMixLoudnorm({
            totalSec,
            audio,
            clipAudio: clipAudioBranches.map((c, k) => ({
              measure: measures.clip[k],
              volume: c.volume,
              durationMs: c.durationMs,
            })),
            music: measures.music,
          });
        }
        // Probe-gated hw decode per ≥20s source (cached from the build loop
        // when it already probed this path).
        const hwaccelPerSeg = [];
        let spHwCount = 0;
        for (let b = 0; b < segments.length; b++) {
          const s = segments[b];
          const use = !!(s && s.mediaType === "video" && s.videoPath &&
            (Number(s.durationMs) || 0) >= 20000 && await probeHwDecode(s.videoPath));
          hwaccelPerSeg.push(use);
          if (use) spHwCount += 1;
        }

        // v6.5 chunked single-pass: either RETURNS (success) or clears for
        // the W=1 route / the two-step pool.
        let spSkipW1 = false;
        if (chunkPlan) {
          const W = chunkPlan.chunks.length;
          const isHybrid = !!chunkPlan.hybrid;
          // v7 Step 4: pool width = the worker budget (hybrid mixes graph
          // chunks + TURBO replay jobs in ONE pool); plain keeps W (= chunk
          // count ≤ spWorkers, same as v6.5).
          const poolWidth = Math.max(1, Math.min(isHybrid ? spWorkers : W, Math.max(1, spWorkers)));
          let threadsPer = Math.max(1, Math.round(cpuCount / poolWidth));
          let filterThreadsPer = Math.max(2, Math.min(8, Math.floor(cpuCount / poolWidth)));
          if (lowEndX264) {
            // v7 Step 5: hardcap per-worker threads on ≤4-core libx264 boxes.
            threadsPer = Math.max(1, Math.min(2, threadsPer));
            filterThreadsPer = Math.max(1, Math.min(2, filterThreadsPer));
          }
          const chunkJobs = [];
          const chunkFiles = [];
          const turboJobs = [];
          let turboCopied = 0;
          let chunkOverBudget = false;
          for (let ci = 0; ci < W && !chunkOverBudget; ci++) {
            const c = chunkPlan.chunks[ci];
            // ── v7 Step 4: CLEAN chunk — every covered segment is copy-eligible.
            // Replay the recorded TURBO plans (stream copy / keyframe-aligned
            // trim / sandwich) instead of a filter graph: ZERO decode, zero
            // filters, zero encode for this whole interval.
            if (c.clean && isHybrid) {
              for (let i = 0; i < segments.length; i++) {
                const span = chunkPlan.spans[i];
                if (!span || span.F <= 0) continue;
                if (Math.min(span.S + span.F, c.f1) - Math.max(span.S, c.f0) <= 0) continue;
                const tp = turboPlan[i];
                if (!tp) continue; // defensive: planner marked the chunk clean
                const seg = segments[i];
                if (tp.kind === "copy") {
                  const copyPath = path.join(tempDir, `hyb_${String(i).padStart(4, "0")}.mp4`);
                  tempFiles.push(copyPath);
                  chunkFiles.push(copyPath);
                  turboJobs.push({
                    idx: i,
                    args: G.buildStreamCopyArgs({
                      path: seg.videoPath,
                      durMs: seg.durationMs,
                      clipPath: copyPath,
                      ss: tp.ss,
                    }),
                    durSec: seg.durationMs / 1000,
                    durationMs: seg.durationMs,
                    segId: seg.id,
                    copy: true,
                  });
                  turboCopied += 1;
                } else if (tp.kind === "sandwich" && tp.plan) {
                  const sw = tp.plan;
                  const emitEdge = (edge, tag) => {
                    const edgePath = path.join(tempDir, `hyb_${String(i).padStart(4, "0")}_${tag}.mp4`);
                    tempFiles.push(edgePath);
                    chunkFiles.push(edgePath);
                    const built = G.buildClipArgs({
                      i,
                      seg: { ...seg, trimInMs: edge.trimMs, durationMs: edge.durMs },
                      segments,
                      fps,
                      width,
                      height,
                      kbEnabled: enabled,
                      zoomMax,
                      globalDir,
                      transition,
                      wm: null,        // sandwich-eligible ⇒ no watermark
                      assSuffix: null, // ⇒ no captions
                      clipPath: edgePath,
                      encArgs,
                      globalArgs: encGlobalArgs,
                      anyAudio: false,
                      segHasAudio: false,
                      overlaySpecs: [], // ⇒ no overlays in window
                      hwaccel: false,
                      threads: threadsPer,
                    });
                    turboJobs.push({
                      idx: i,
                      args: built.args,
                      durSec: edge.durMs / 1000,
                      durationMs: edge.durMs,
                      segId: seg.id,
                    });
                  };
                  if (sw.head) emitEdge(sw.head, "sh");
                  const midPath = path.join(tempDir, `hyb_${String(i).padStart(4, "0")}_sm.mp4`);
                  tempFiles.push(midPath);
                  chunkFiles.push(midPath);
                  turboJobs.push({
                    idx: i,
                    args: G.buildStreamCopyArgs({
                      path: seg.videoPath,
                      durMs: sw.middle.durMs,
                      clipPath: midPath,
                      ss: sw.middle.ss,
                    }),
                    durSec: sw.middle.durMs / 1000,
                    durationMs: sw.middle.durMs,
                    segId: seg.id,
                    copy: true,
                  });
                  if (sw.tail) emitEdge(sw.tail, "st");
                  turboCopied += 1;
                }
              }
              continue; // clean chunk fully handled by TURBO replay
            }
            // v6.5: per-segment SOURCE rates (probe cache is warm from the
            // build loop) — the sub-seek snaps to each source's own frame
            // grid so the sub-window's first frame is exactly the frame the
            // W=1 render displays at the boundary (see windowSegmentsForChunk).
            const srcFpsPerSeg = await Promise.all(
              segments.map(async (s) =>
                s && s.mediaType === "video" && s.videoPath
                  ? Number((await probeMediaAsync(s.videoPath)).fps) || 0
                  : 0,
              ),
            );
            const winSegs = SP.windowSegmentsForChunk(segments, chunkPlan.spans, c.f0, c.f1, fps, srcFpsPerSeg);
            const segMeta = winSegs.map((w) => ({
              origIdx: w.origIdx, S: w.S, F: w.F, k0: w.k0, k1: w.k1, ssSec: w.ssSec,
            }));
            // Per-chunk overlay specs + ASS window (the v1.4.2 windowing
            // semantics: specs/cues are chunk-LOCAL, windows clamped). The
            // overlay INPUT windows are padded ~120 ms past the chunk end so
            // framesync (eof_action=pass) composites the chunk's LAST frame —
            // an unpadded input EOFs one base-frame early and drops it.
            const ovSpecs = SP.padOverlayInputWindows(
              await buildOverlaySpecsForWindow(c.t0Ms, c.durMs),
              c.durMs,
            );
            let chunkAssSuffix = null;
            if (captionsEnabled || headlinesEnabled) {
              const doc = buildAssDocument(
                captionsEnabled ? subtitleCues : [],
                captionsEnabled ? captionSettings : null,
                headlinesEnabled ? headlines : null,
                width, height, c.t0Ms, c.t0Ms + c.durMs, c.durMs,
              );
              chunkAssSuffix = doc ? writeAssFile(doc, `sp${String(ci).padStart(2, "0")}`) : null;
            }
            const cPlan = SP.buildSinglePassPlan({
              segments: winSegs.map((w) => w.seg),
              fullSegments: segments,
              window: { t0Ms: c.t0Ms, durMs: c.durMs, segMeta },
              videoOnly: true,
              fades: fullFades,
              fps,
              width,
              height,
              totalMs,
              kbEnabled: enabled,
              zoomMax,
              globalDir,
              transition,
              wm,
              assSuffix: chunkAssSuffix,
              overlaySpecs: ovSpecs,
              audio,
              audioPath: null,
              sfx: [],
              clipAudio: [],
              loudnorm: null,
              masterLoudnorm: null,
              hwaccelPerSeg,
            });
            if (cPlan.scriptBytes > SP.SINGLEPASS_MAX_SCRIPT_BYTES) {
              console.warn(`[framefuse] chunked single-pass skipped: chunk ${ci + 1}/${W} graph ${cPlan.scriptBytes}B > ${SP.SINGLEPASS_MAX_SCRIPT_BYTES}B budget → two-step pool`);
              chunkOverBudget = true;
              break;
            }
            const scriptPath = path.join(tempDir, `graph_sp${ci}_${Date.now()}.txt`);
            fs.writeFileSync(scriptPath, cPlan.script, "utf-8");
            tempFiles.push(scriptPath);
            const chunkPath = path.join(tempDir, `spchunk_${String(ci).padStart(3, "0")}_${Date.now()}.mp4`);
            tempFiles.push(chunkPath);
            chunkFiles.push(chunkPath);
            chunkJobs.push({
              args: SP.buildSinglePassArgs({
                plan: cPlan,
                scriptPath,
                encArgs,
                abr: `${abr}k`,
                fps,
                outputPath: chunkPath,
                threads: threadsPer,
                filterThreads: filterThreadsPer,
                // v7 Step 1: QSV device-init globals at the argv head.
                globalArgs: encGlobalArgs,
              }),
              durSec: c.durMs / 1000,
              durationMs: c.durMs,
              segId: `parallel window ${ci + 1}/${W}`,
            });
          }
          if (!chunkOverBudget) {
            const dirtyChunks = chunkJobs.length;
            console.log(
              isHybrid
                ? `[framefuse] HYBRID smart render: ${dirtyChunks} re-encode windows + ${turboCopied} TURBO stream-copy segments over ${(totalMs / 1000).toFixed(1)}s (${Math.round(cpuCount)} cores)`
                : `[framefuse] chunked single-pass: ${W} parallel windows over ${(totalMs / 1000).toFixed(1)}s (${Math.round(cpuCount)} cores)`,
            );
            const spStart = Date.now();
            // v7 Step 4: ONE pool over the graph chunks + the TURBO replay jobs
            // (copies are near-instant and fill idle slots). Progress weighted
            // by each job's timeline duration (0 → 92 %).
            const poolJobs = [...chunkJobs, ...turboJobs];
            const chunkFrac = poolJobs.map(() => 0);
            let lastEmit = 0;
            const emitChunkProgress = (force) => {
              const now = Date.now();
              if (!force && now - lastEmit < 100) return;
              lastEmit = now;
              let doneMs = 0;
              for (let k = 0; k < poolJobs.length; k++) doneMs += chunkFrac[k] * poolJobs[k].durationMs;
              const frac = Math.min(1, doneMs / Math.max(1, totalMs));
              sendProgress(frac * 92, frac * totalSec, etaFor(frac));
            };
            try {
              await runPool(poolJobs, poolWidth, {
                onTime: (idx, sec) => {
                  chunkFrac[idx] = Math.min(1, sec / Math.max(0.01, poolJobs[idx].durSec));
                  emitChunkProgress(false);
                },
                onDone: (idx) => {
                  chunkFrac[idx] = 1;
                  emitChunkProgress(true);
                },
              });
              // ── Audio bus: ONE full-timeline pass (no per-chunk AAC
              //    boundary glitches, no windowed amix math). v6.5: bounded by
              //    the VIDEO frame model (totalFrames/fps), and the final mux
              //    carries -shortest — together this reproduces the W=1
              //    render's -shortest-at-min(video,audio) tail exactly on
              //    frame-inexact timelines.
              let spAudioPath = null;
              const hasAudioBus =
                clipAudioBranches.length > 0 || !!audioPath || sfxList.length > 0;
              if (hasAudioBus) {
                const aPlan = SP.buildSinglePassPlan({
                  segments,
                  audioOnly: true,
                  fps,
                  width,
                  height,
                  totalMs,
                  audio,
                  audioPath,
                  sfx: sfxList,
                  clipAudio: clipAudioBranches,
                  loudnorm: spLoudnorm,
                  masterLoudnorm: spMasterLoudnorm,
                });
                if (aPlan.hasAudioOut) {
                  const aScriptPath = path.join(tempDir, `graph_spa_${Date.now()}.txt`);
                  fs.writeFileSync(aScriptPath, aPlan.script, "utf-8");
                  tempFiles.push(aScriptPath);
                  spAudioPath = path.join(tempDir, `spaudio_${Date.now()}.m4a`);
                  tempFiles.push(spAudioPath);
                  const aArgs = SP.buildAudioOnlyArgs({
                    plan: aPlan,
                    scriptPath: aScriptPath,
                    abr: `${abr}k`,
                    totalSec: chunkPlan.totalFrames / fps,
                    outputPath: spAudioPath,
                  });
                  const audioStageStart = Date.now();
                  try {
                    await runFfmpeg(aArgs, totalSec, (sec) => {
                      const frac = 0.92 + 0.04 * Math.min(1, sec / Math.max(0.01, totalSec));
                      sendProgress(frac * 100, sec, etaFor(frac));
                    });
                  } catch (err) {
                    if (err && err.message === "Export cancelled") throw err;
                    if (Date.now() - audioStageStart < 4000) {
                      console.warn("[framefuse] audio pass failed at init — falling back to the two-step pool:", err.message);
                      spSkipW1 = true;
                    } else {
                      throw err;
                    }
                  }
                }
              }
              if (spSkipW1) { /* fall to the two-step pool below */ } else {
              // ── Concat the chunk videos + mux the audio (-c copy both).
              sendProgress(96.5, totalSec, etaFor(0.965));
              const spConcatPath = path.join(tempDir, `spconcat_${Date.now()}.txt`);
              tempFiles.push(spConcatPath);
              fs.writeFileSync(
                spConcatPath,
                chunkFiles.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
                "utf-8",
              );
              const muxArgs = [
                "-y",
                "-f", "concat", "-safe", "0", "-i", spConcatPath,
                ...(spAudioPath ? ["-i", spAudioPath] : []),
                "-map", "0:v:0",
                ...(spAudioPath ? ["-map", "1:a:0"] : []),
                "-c", "copy",
                // v6.5: bound the container at the shorter stream, exactly like
                // the W=1 render's encode-time -shortest (the audio pass is
                // already bounded by the video frame model; this trims a
                // longer music tail instead of shipping silent video frames).
                ...(spAudioPath ? ["-shortest"] : []),
                "-movflags", "+faststart",
                outputPath,
              ];
              const muxStageStart = Date.now();
              try {
                await runFfmpeg(muxArgs, totalSec, (sec) => {
                  const frac = 0.965 + 0.035 * Math.min(1, sec / Math.max(0.01, totalSec));
                  sendProgress(frac * 100, sec, etaFor(frac));
                });
              } catch (err) {
                if (err && err.message === "Export cancelled") throw err;
                if (Date.now() - muxStageStart < 4000) {
                  console.warn("[framefuse] concat/mux failed at init — falling back to the two-step pool:", err.message);
                  spSkipW1 = true;
                } else {
                  throw err;
                }
              }
              } // end else (audio pass healthy → mux ran)
            } catch (err) {
              if (err && err.message === "Export cancelled") throw err;
              if (Date.now() - spStart < 4000) {
                console.warn("[framefuse] chunked single-pass failed at init — falling back to the two-step pool:", err.message);
                spSkipW1 = true;
              } else {
                throw err;
              }
            }
            if (!spSkipW1) {
              sendProgress(100, totalSec, 0);
              for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }
              let size = 0;
              try { size = fs.statSync(outputPath).size; } catch {}
              return {
                path: outputPath,
                size,
                encoder: encoder.label,
                elapsedSec: Math.round((Date.now() - startTime) / 1000),
                // v7 Step 4: hybrid telemetry — copiedClips = the TURBO
                // stream-copy segments, encodedClips = the graph-re-encoded
                // (dirty) segments.
                copiedClips: isHybrid ? turboCopied : 0,
                encodedClips: isHybrid
                  ? segments.length - turboCopied
                  : segments.length,
                keyframeCuts: 0,
                chunkedClips: 0,
                totalChunks: isHybrid ? dirtyChunks : W,
                parallelChunks: isHybrid ? dirtyChunks : W,
                hwDecodeClips: spHwCount,
                singlePass: true,
                mode: isHybrid ? "hybrid-pass" : "parallel-pass",
              };
            }
          } else {
            spSkipW1 = true; // per-chunk graph over budget → two-step pool
          }
        }

        if (!spSkipW1) {
        // ── W=1 single-pass (GPU boxes, short timelines, <4-core CPUs) ────
        // GLOBAL-window overlay specs — one continuous read per overlay
        // instead of the per-clip re-seek the two-step pays (probes warm).
        const globalOverlaySpecs = await buildOverlaySpecsForWindow(0, totalMs);
        // Full-timeline ASS document — the SAME builder, window [0, total].
        let globalAssSuffix = null;
        if (captionsEnabled || headlinesEnabled) {
          const doc = buildAssDocument(
            captionsEnabled ? subtitleCues : [],
            captionsEnabled ? captionSettings : null,
            headlinesEnabled ? headlines : null,
            width, height, 0, totalMs, totalMs,
          );
          globalAssSuffix = doc ? writeAssFile(doc, "full") : null;
        }

        const spPlan = SP.buildSinglePassPlan({
          segments,
          fps,
          width,
          height,
          totalMs,
          kbEnabled: enabled,
          zoomMax,
          globalDir,
          transition,
          wm,
          assSuffix: globalAssSuffix,
          overlaySpecs: globalOverlaySpecs,
          audio,
          audioPath,
          sfx: sfxList,
          clipAudio: clipAudioBranches,
          loudnorm: spLoudnorm,
          masterLoudnorm: spMasterLoudnorm,
          hwaccelPerSeg,
        });

        if (spPlan.scriptBytes > SP.SINGLEPASS_MAX_SCRIPT_BYTES) {
          console.warn(`[framefuse] single-pass skipped: graph ${spPlan.scriptBytes}B > ${SP.SINGLEPASS_MAX_SCRIPT_BYTES}B budget → two-step pool`);
        } else {
          const scriptPath = path.join(tempDir, `graph_${Date.now()}.txt`);
          fs.writeFileSync(scriptPath, spPlan.script, "utf-8");
          tempFiles.push(scriptPath);
          const spArgs = SP.buildSinglePassArgs({
            plan: spPlan,
            scriptPath,
            encArgs,
            abr: `${abr}k`,
            fps,
            outputPath,
            // ONE process: the encoder may use every core; filters get a
            // slice-thread budget so scale/overlay parallelize.
            // v7 Step 5: low-end libx264 caps threads at 2 (cache thrashing).
            threads: lowEndX264 ? Math.min(2, cpuCount) : 0, // 0 = auto (all cores)
            filterThreads: lowEndX264
              ? 2
              : Math.max(2, Math.min(8, os.cpus().length)),
            // v7 Step 1: QSV device-init globals at the argv head.
            globalArgs: encGlobalArgs,
          });
          const spStart = Date.now();
          let spFastFail = false;
          try {
            await runFfmpeg(spArgs, totalSec, (sec) => {
              const frac = Math.min(1, sec / Math.max(0.01, totalSec));
              sendProgress(frac * 100, sec, etaFor(frac));
            });
          } catch (err) {
            if (err && err.message === "Export cancelled") throw err;
            if (Date.now() - spStart < 4000) {
              // Init-class failure (graph parse / codec open / input read):
              // fall back to the battle-tested two-step pool instead of
              // failing the export outright.
              console.warn("[framefuse] single-pass failed at init — falling back to the two-step pool:", err.message);
              spFastFail = true;
            } else {
              throw err;
            }
          }
          if (!spFastFail) {
            sendProgress(100, totalSec, 0);
            for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }
            let size = 0;
            try { size = fs.statSync(outputPath).size; } catch {}
            return {
              path: outputPath,
              size,
              encoder: encoder.label,
              elapsedSec: Math.round((Date.now() - startTime) / 1000),
              copiedClips: 0,
              encodedClips: segments.length,
              keyframeCuts: 0,
              chunkedClips: 0,
              totalChunks: 0,
              hwDecodeClips: spHwCount,
              singlePass: true,
              mode: "single-pass",
            };
          }
        }
        }
      } else {
        console.log(`[framefuse] single-pass skipped: ${eligibility.reason} → two-step pool`);
      }
    } else if (anyEncodeJob) {
      console.log(`[framefuse] single-pass skipped: encode work ${(encodeWorkMs / 1000).toFixed(1)}s of ${(totalMs / 1000).toFixed(1)}s timeline is not dominant → TURBO pool`);
    }

    // ─── STEP 1 (run): PARALLEL encode + audio-extraction pool ────
    // N = min(4, max(1, os.cpus() − 2)) concurrent ffmpeg children
    // (child_process.spawn). Per-clip "time=" marks aggregate into the
    // SAME export-progress channel + payload shape the UI already
    // consumes, weighted by clip duration on the master timeline.
    // v5.2: the PCM extraction jobs ride the SAME pool — they are cheap
    // (decode + WAV write) and fill idle slots while big encodes run.
    const poolJobs = [...jobs, ...clipAudioJobs];
    const clipFrac = poolJobs.map(() => 0);
    let lastEmit = 0;
    const emitProgress = (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < 100) return; // ≤10 Hz progress IPC
      lastEmit = now;
      let doneMs = 0;
      for (let k = 0; k < poolJobs.length; k++) doneMs += clipFrac[k] * poolJobs[k].durationMs;
      const frac = doneMs / Math.max(1, totalMs);
      sendProgress(frac * 95, doneMs / 1000, etaFor(frac));
    };
    await runPool(poolJobs, poolN, {
      onTime: (idx, sec) => {
        clipFrac[idx] = Math.min(1, sec / Math.max(0.01, poolJobs[idx].durSec));
        emitProgress(false);
      },
      onDone: (idx) => {
        clipFrac[idx] = 1;
        emitProgress(true);
      },
    });

    // ─── STEP 2: Concat all clips + mix audio ONCE (video: -c copy) ──
    // v1.1 TURBO: stream copies cut at PACKET granularity and re-encodes
    // round to whole frames, so the REAL concatenated video length can
    // differ from the requested timeline by a frame per clip. The audio
    // graph (apad/whole_dur + fade-out end + -shortest) should target the
    // ACTUAL length — measure each clip file (parallel, cached probe) and
    // sum. A failed probe falls back to the requested duration for that
    // clip, and the whole total falls back when nothing is measurable.
    sendProgress(96, totalSec, etaFor(0.96));
    // Probes run in bounded chunks (8 at a time) — a 100-clip project must
    // not spawn 100 ffmpeg children simultaneously on a weak machine.
    const clipDurProbe = [];
    for (let c = 0; c < clipPaths.length; c += 8) {
      const chunk = clipPaths.slice(c, c + 8);
      const ds = await Promise.all(
        chunk.map((p) => probeMediaAsync(p).then((info) => info.durationMs).catch(() => 0)),
      );
      clipDurProbe.push(...ds);
    }
    let actualTotalSec = totalSec;
    if (clipDurProbe.length > 0 && clipDurProbe.every((d) => d > 0)) {
      const actualMs = clipDurProbe.reduce((a, b) => a + b, 0);
      // Guard: a wildly-off measurement (bad probe) must never skew the
      // mix — only accept when within 2% + 1s of the requested timeline.
      if (Math.abs(actualMs - totalMs) <= totalMs * 0.02 + 1000) {
        actualTotalSec = actualMs / 1000;
      }
    }

    const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);
    tempFiles.push(concatListPath);

    // ─── v1.2: 2-PASS LOUDNORM measurement (pass 1) ────────────────
    // When normalize is ON, every audio SOURCE (each clip WAV + the music
    // track) is measured now — audio-only ffmpeg passes, bounded 8-parallel,
    // typically <1 s each — so the step-2 graph applies a STATIC linear gain
    // per source (the ffmpeg 2-pass loudnorm recipe) instead of single-pass
    // dynamic normalization, which pumps on variable material. SFX WAVs are
    // deliberately NOT normalized: they are synthesized at designed levels.
    // Measurement failure per file → null → that branch falls back to
    // single-pass loudnorm (the v5.2 behavior); normalize OFF → argv
    // unchanged (byte-identical to v1.1).
    let loudnormCtx = null;
    if (audio && audio.normalize && (clipAudioJobs.length > 0 || audioPath)) {
      loudnormCtx = await measureLoudnormContext(clipAudioJobs, audioPath);
    }

    // ─── v1.3: MASTER-BUS loudnorm (render → measure → mux) ────────
    // Per-source normalize lands each SOURCE at −16 LUFS, but N overlapping
    // sources SUM above it (2 sources ≈ −13). A mastering stage on the summed
    // mix — exactly what a DAW master chain does — makes the exported file
    // land at −16 regardless of overlap count. The mix is deterministic, so:
    //   (a) render the post-volume mix to a temp WAV (audio-only, fast; the
    //       rawMix graph stops before limiter/pad), output -t bounded (the
    //       looped music input is infinite here — no video stream to stop it);
    //   (b) MEASURE that WAV (measureLoudnessAsync);
    //   (c) the final mux uses the WAV as its single audio input with the
    //       measured master loudnorm + limiter + pad (buildConcatArgs'
    //       masterMix mode).
    // Only when normalize is ON and ≥2 branches actually overlap-sum; a
    // single branch is already at −16 (the per-source pass), and normalize
    // OFF keeps the byte-identical v1.2 argv. A failed render or measurement
    // falls back to the v1.2 direct graph — never to a failed export.
    let masterMix = null;
    const audioBranchCount =
      (audioPath ? 1 : 0) + clipAudioJobs.length + sfxList.length;
    if (
      audio && audio.normalize && audioBranchCount >= 2 && actualTotalSec > 0
    ) {
      try {
        const mixWavPath = path.join(tempDir, `mixmaster_${Date.now()}.wav`);
        tempFiles.push(mixWavPath);
        const renderArgs = G.buildAudioMixRenderArgs({
          audioPath,
          audio,
          totalSec: actualTotalSec,
          sfx: sfxList,
          loudnorm: loudnormCtx,
          clipAudio: clipAudioJobs.map((j) => ({
            wavPath: j.wavPath,
            startMs: j.startMs,
            volume: j.volume,
          })),
          mixWavPath,
        });
        await runFfmpeg(renderArgs, actualTotalSec, () => {});
        const masterMeasure = await measureLoudnessAsync(mixWavPath);
        if (fs.existsSync(mixWavPath) && fs.statSync(mixWavPath).size > 44) {
          masterMix = { wavPath: mixWavPath, loudnorm: masterMeasure };
        }
      } catch (_) {
        masterMix = null; // render failed → v1.2 direct graph
      }
    }

    const concatContent = clipPaths.map(p => {
      const safePath = p.replace(/\\/g, "/").replace(/'/g, "'\\''");
      return `file '${safePath}'`;
    }).join("\n");
    fs.writeFileSync(concatListPath, concatContent, "utf-8");

    // v5.2: G.buildConcatArgs muxes the concat video with the SINGLE-PASS
    // audio mix (clip WAVs + music + SFX → amix → AAC once). Music-only /
    // no-audio projects keep the exact v4.9 -af / copy paths.
    // v1.1: totalSec = the ACTUAL concatenated video length (see above).
    const concatArgs = G.buildConcatArgs({
      concatListPath,
      audioPath,
      audio,
      outputPath,
      totalSec: actualTotalSec,
      sfx: sfxList,
      loudnorm: loudnormCtx,
      masterMix,
      audioKbps: abr,
      clipAudio: clipAudioJobs.map((j) => ({
        wavPath: j.wavPath,
        startMs: j.startMs,
        volume: j.volume,
      })),
      newAudioGraph: anyVideoAudio || sfxList.length > 0,
    });

    await runFfmpeg(concatArgs, actualTotalSec, (sec) => {
      const frac = 0.96 + 0.04 * Math.min(1, sec / Math.max(0.01, actualTotalSec));
      // v5 fix (pre-existing v4.9 bug): sendProgress takes PERCENT — the old
      // code passed the 0.96..1.0 fraction, so the bar dipped 96 → ~1 → 100
      // during the mux. Payload shape (progress/fps/eta/timemark) unchanged.
      sendProgress(frac * 100, sec, etaFor(frac));
    });

    sendProgress(100, actualTotalSec, 0);

    // Cleanup
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }

    let size = 0;
    try { size = fs.statSync(outputPath).size; } catch {}
    // v1.1 TURBO: the result carries the performance story so the UI can
    // show users WHY the export was fast (encoder + stream-copy counts).
    // v1.4.1: keyframeCuts = copied clips that entered the fast path via a
    // keyframe-aligned head trim (vs. trimIn=0 copies).
    // v1.4.2: chunkedClips/totalChunks = the chunked parallel encode (long
    // re-encode clips split across the pool), hwDecodeClips = sources
    // riding the throughput-gated hardware decode path.
    return {
      path: outputPath,
      size,
      encoder: encoder.label,
      elapsedSec: Math.round((Date.now() - startTime) / 1000),
      copiedClips,
      encodedClips,
      keyframeCuts,
      chunkedClips,
      totalChunks,
      hwDecodeClips,
      singlePass: false,
      mode: "two-step",
    };

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

// Test hook — exposes the ASS builder + the v1.4.2 hw-decode probe to the
// dev verification harness (scripts/verify-chunked-encode.js stubs the
// electron module so main.js loads in plain node).
// Harmless in production: nothing requires the Electron main entry.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildAssDocument, assAnimTags, buildHeadlineEvents, probeHwDecode };
}
