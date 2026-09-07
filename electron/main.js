// electron/main.js — FrameFuse v4 main process
// Fast export: each image → MP4 clip with zoompan, then concat
const {
  app, BrowserWindow, ipcMain, dialog, Menu, shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

let ffmpegPath;
if (app.isPackaged) {
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  ffmpegPath = path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "ffmpeg-static", exeName);
} else {
  ffmpegPath = require("ffmpeg-static");
  if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
    try { if (fs.existsSync(ffmpegPath + ".exe")) ffmpegPath += ".exe"; } catch (_) {}
  }
}

const isDev = !app.isPackaged;
let mainWindow = null;
let currentProcess = null;
const tempDir = path.join(os.tmpdir(), "framefuse-tmp");

function ensureTempDir() {
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 720,
    backgroundColor: "#0a0a0a", title: "FrameFuse v4",
    autoHideMenuBar: false,
    icon: path.join(__dirname, "..", "build", "icon.ico"),
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
      { label: "About", click: () => { dialog.showMessageBox(mainWindow, { type: "info", title: "About", message: "FrameFuse v4", detail: "Native image-to-video merger.", buttons: ["OK"] }); } },
      { label: "Naming Guide", click: () => mainWindow && mainWindow.webContents.send("menu:naming-guide") },
    ]},
  ]));
}

// IPC helpers
ipcMain.handle("is-electron", () => true);

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

ipcMain.handle("save-temp-srt", async (_evt, { name, text }) => {
  ensureTempDir();
  const safeName = String(name || "subs.srt").replace(/[\\/:*?"<>|]/g, "_");
  const ext = path.extname(safeName) || ".srt";
  const p = path.join(tempDir, `srt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  // Always write SRT as UTF-8 (libass expects UTF-8).
  fs.writeFileSync(p, String(text || ""), "utf-8");
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
// IPC: FAST export
// Step 1: Each image → MP4 clip with zoompan Ken Burns (parallel, ultrafast)
// Step 2: Concat all clips + mux audio (-c copy, instant)
// ---------------------------------------------------------------------------
ipcMain.handle("export-native", async (event, opts) => {
  const { outputPath, fps, width, height, bitrateMbps, kenBurns, segments, audioPath, captionSettings } = opts;

  if (!outputPath) throw new Error("No output path");
  if (!segments || segments.length === 0) throw new Error("No segments");

  const intensity = Math.max(0, Math.min(100, Number(kenBurns?.intensity) || 0));
  const zoomMax = 1.06 + (intensity / 100) * 0.18;
  const enabled = !!kenBurns?.enabled;
  const globalDir = kenBurns?.direction || "in";

  // Caption settings: if enabled and an SRT path was provided, burn it in.
  const captionsEnabled =
    !!captionSettings &&
    !!captionSettings.enabled &&
    typeof captionSettings.srtPath === "string" &&
    captionSettings.srtPath.length > 0;
  const captionStyle = captionsEnabled ? (captionSettings.ffmpegStyle || "") : "";

  ensureTempDir();
  const tempFiles = [];
  const totalMs = segments.reduce((sum, s) => sum + s.durationMs, 0);

  function sendProgress(percent, fpsVal, timemark) {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send("export-progress", {
        progress: Math.max(0, Math.min(100, percent)),
        fps: fpsVal || 0,
        timemark: timemark || "00:00:00.00",
      });
    }
  }

  function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { windowsHide: true });
      currentProcess = proc;
      let stderr = "";

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => { currentProcess = null; reject(new Error(err.message)); });
      proc.on("exit", (code, signal) => {
        currentProcess = null;
        if (signal === "SIGKILL" || signal === "SIGTERM") { reject(new Error("Export cancelled")); return; }
        if (code !== 0) {
          const lines = stderr.trim().split("\n");
          reject(new Error(lines.slice(-5).join("\n") || `FFmpeg error code ${code}`));
          return;
        }
        resolve();
      });
    });
  }

  try {
    // STEP 1: Encode each image to a short MP4 clip
    const clipPaths = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDurSec = seg.durationMs / 1000;
      const segFrames = Math.max(1, Math.round(segDurSec * fps));
      const dir = enabled ? seg.direction || globalDir : "none";

      // Build zoompan filter
      // Key: use -loop 1 -t <dur> -i <img> (input duration limit)
      // Then zoompan with d=<total_frames> produces the zoom over all frames
      // fps in zoompan sets output framerate

      let zExpr, xExpr, yExpr;

      if (!enabled || dir === "none") {
        zExpr = "1";
        xExpr = "iw/2-(iw/zoom/2)";
        yExpr = "ih/2-(ih/zoom/2)";
      } else {
        // Use 'on' (output frame number) for the zoom progression
        // d = segFrames means zoompan produces segFrames frames
        const tExpr = `on/${Math.max(1, segFrames - 1)}`;
        const easeExpr = `-((cos(PI*${tExpr})-1)/2)`;
        const zMax = zoomMax.toFixed(6);
        const span = (zMax - 1).toFixed(6);

        if (dir === "in") {
          zExpr = `1+(${easeExpr})*${span}`;
          xExpr = "iw/2-(iw/zoom/2)";
          yExpr = "ih/2-(ih/zoom/2)";
        } else if (dir === "out") {
          zExpr = `${zMax}-(${easeExpr})*${span}`;
          xExpr = "iw/2-(iw/zoom/2)";
          yExpr = "ih/2-(ih/zoom/2)";
        } else {
          zExpr = zMax;
          const maxX = "(iw-iw/zoom)";
          const maxY = "(ih-ih/zoom)";
          if (dir === "right") { xExpr = `${maxX}*(${easeExpr})`; yExpr = `${maxY}/2`; }
          else if (dir === "left") { xExpr = `${maxX}*(1-(${easeExpr}))`; yExpr = `${maxY}/2`; }
          else if (dir === "down") { xExpr = `${maxX}/2`; yExpr = `${maxY}*(${easeExpr})`; }
          else if (dir === "up") { xExpr = `${maxX}/2`; yExpr = `${maxY}*(1-(${easeExpr}))`; }
          else { xExpr = `${maxX}/2`; yExpr = `${maxY}/2`; }
        }
      }

      // Scale to 2x for quality, then zoompan to target size
      const scaleW = width * 2;
      const scaleH = height * 2;
      const vf = `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,crop=${scaleW}:${scaleH},zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`;

      const clipPath = path.join(tempDir, `clip_${String(i).padStart(4, "0")}.mp4`);
      tempFiles.push(clipPath);
      clipPaths.push(clipPath);

      // CORRECT ffmpeg args for looping a single image with duration:
      // -loop 1 = loop the input image
      // -i <img> = input
      // -t <dur> = stop after this duration (AFTER -i, not before)
      // -vf = video filter
      const args = [
        "-loop", "1",
        "-i", seg.imagePath,
        "-t", segDurSec.toFixed(3),
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-movflags", "+faststart",
        "-y",
        clipPath,
      ];

      await runFfmpeg(args);
      clipPaths.push(clipPath);

      // Progress: 0-80% for step 1
      const pct = ((i + 1) / segments.length) * 80;
      const elapsedSec = (i + 1) * segDurSec;
      const tm = `${String(Math.floor(elapsedSec / 3600)).padStart(2, "0")}:${String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(elapsedSec % 60)).padStart(2, "0")}.00`;
      sendProgress(pct, 0, tm);
    }

    // Remove duplicates from clipPaths (we pushed twice)
    const uniqueClipPaths = [...new Set(clipPaths)];

    // STEP 2: Concat all clips + mux audio
    const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);
    tempFiles.push(concatListPath);

    const concatContent = uniqueClipPaths.map(p => {
      const safePath = p.replace(/\\/g, "/").replace(/'/g, "'\\''");
      return `file '${safePath}'`;
    }).join("\n");
    fs.writeFileSync(concatListPath, concatContent, "utf-8");

    // Build concat args — use -c copy for video (instant, no re-encode)
    // UNLESS captions need to be burned in, in which case we re-encode the
    // concatenated stream with a subtitles filter.
    const concatArgs = [
      "-f", "concat", "-safe", "0", "-i", concatListPath,
    ];

    if (audioPath) {
      concatArgs.push("-i", audioPath);
    }

    if (captionsEnabled) {
      // libass subtitles filter — escape backslashes and colons in the SRT path
      // for Windows compatibility. The filename= parameter is required when the
      // path contains special characters; force_style applies the preset styling.
      const escapedSrt = captionSettings.srtPath
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:");
      const vf = `subtitles=filename='${escapedSrt}':force_style='${captionStyle}'`;
      concatArgs.push("-vf", vf);
      // Re-encode the video so the filter is applied.
      concatArgs.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p");
    } else {
      concatArgs.push("-c:v", "copy");
    }

    if (audioPath) {
      concatArgs.push("-c:a", "aac", "-b:a", "192k", "-shortest");
    }

    concatArgs.push("-movflags", "+faststart", "-y", outputPath);

    // Run concat with progress monitoring
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, concatArgs, { windowsHide: true });
      currentProcess = proc;
      let stderr = "";

      proc.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;

        // Parse progress for step 2 (80-100%)
        const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        const fpsMatch = text.match(/fps=\s*(\d+)/);

        if (timeMatch) {
          const timemark = timeMatch[1];
          const fpsNow = fpsMatch ? parseInt(fpsMatch[1], 10) : 0;
          const parts = timemark.split(":").map(Number);
          const totalSec = parts.length === 3 ? (parts[0] * 3600 + parts[1] * 60 + parts[2]) : 0;
          const totalDurSec = totalMs / 1000;
          const pct = 80 + Math.min(20, (totalSec / totalDurSec) * 20);
          sendProgress(pct, fpsNow, timemark);
        }
      });

      proc.on("error", (err) => { currentProcess = null; reject(new Error(err.message)); });
      proc.on("exit", (code, signal) => {
        currentProcess = null;
        if (signal === "SIGKILL" || signal === "SIGTERM") { reject(new Error("Export cancelled")); return; }
        if (code !== 0) {
          const lines = stderr.trim().split("\n");
          reject(new Error(lines.slice(-5).join("\n") || `FFmpeg concat error code ${code}`));
          return;
        }
        resolve();
      });
    });

    sendProgress(100, 0, "00:00:00.00");

    // Cleanup
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }

    let size = 0;
    try { size = fs.statSync(outputPath).size; } catch (_) {}
    return { path: outputPath, size };

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
