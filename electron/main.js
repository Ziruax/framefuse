// electron/main.js — FrameFuse v4 main process
// Native FFmpeg encoding via raw child_process spawn
// Uses concat demuxer approach to avoid ENAMETOOLONG on Windows
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

// Resolve FFmpeg binary path
let ffmpegPath;

if (app.isPackaged) {
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  ffmpegPath = path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "ffmpeg-static",
    exeName
  );
} else {
  ffmpegPath = require("ffmpeg-static");
  if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
    const exePath = ffmpegPath + ".exe";
    try {
      if (fs.existsSync(exePath)) {
        ffmpegPath = exePath;
      }
    } catch (_) {}
  }
}

const isDev = !app.isPackaged;
let mainWindow = null;
let currentProcess = null;
const tempDir = path.join(os.tmpdir(), "framefuse-tmp");

function ensureTempDir() {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0a0a0a",
    title: "FrameFuse v4",
    autoHideMenuBar: false,
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
  } else {
    const file = path.join(__dirname, "..", "out", "index.html");
    if (fs.existsSync(file)) {
      mainWindow.loadFile(file);
    } else {
      mainWindow.loadURL("file://" + file);
    }
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildApplicationMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Add Images…", accelerator: "CmdOrCtrl+O", click: () => mainWindow && mainWindow.webContents.send("menu:add-images") },
        { label: "Add Audio…", click: () => mainWindow && mainWindow.webContents.send("menu:add-audio") },
        { type: "separator" },
        { label: "Export MP4…", accelerator: "CmdOrCtrl+E", click: () => mainWindow && mainWindow.webContents.send("menu:export") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
    {
      label: "Help",
      submenu: [
        { label: "About FrameFuse", click: () => { dialog.showMessageBox(mainWindow, { type: "info", title: "About FrameFuse", message: "FrameFuse v4", detail: "Native image-to-video merger.", buttons: ["OK"] }); } },
        { label: "Filename Naming Guide", click: () => mainWindow && mainWindow.webContents.send("menu:naming-guide") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC: temp file helpers
// ---------------------------------------------------------------------------
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
  const p = path.join(tempDir, `audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle("cleanup-temp", async () => {
  try {
    if (fs.existsSync(tempDir)) {
      for (const f of fs.readdirSync(tempDir)) {
        try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {}
      }
    }
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle("choose-output", async () => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Export MP4",
    defaultPath: `framefuse_${Date.now()}.mp4`,
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });
  if (res.canceled || !res.filePath) return null;
  if (!res.filePath.toLowerCase().endsWith(".mp4")) res.filePath += ".mp4";
  return res.filePath;
});

ipcMain.handle("cancel-export", async () => {
  try {
    if (currentProcess) {
      // On Windows, use taskkill to ensure the process tree is killed
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", currentProcess.pid, "/f", "/t"], { windowsHide: true });
      } else {
        currentProcess.kill("SIGKILL");
      }
      currentProcess = null;
    }
    return true;
  } catch (e) {
    return false;
  }
});

// ---------------------------------------------------------------------------
// IPC: native FFmpeg export
// Strategy: Two-pass approach
//   Pass 1: Encode each segment individually (zoompan per image)
//   Pass 2: Concat all segment videos + mux audio
// This avoids ENAMETOOLONG because each ffmpeg call has a short filter
// ---------------------------------------------------------------------------
ipcMain.handle("export-native", async (event, opts) => {
  const { outputPath, fps, width, height, bitrateMbps, kenBurns, segments, audioPath } = opts;

  if (!outputPath) throw new Error("No output path");
  if (!segments || segments.length === 0) throw new Error("No segments");

  const intensity = Math.max(0, Math.min(100, Number(kenBurns?.intensity) || 0));
  const zoomMax = 1.06 + (intensity / 100) * 0.18;
  const enabled = !!kenBurns?.enabled;
  const globalDir = kenBurns?.direction || "in";

  ensureTempDir();
  const tempFiles = []; // track all temp files for cleanup

  // Helper: run a single ffmpeg command
  function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { windowsHide: true });
      currentProcess = proc;
      let stderr = "";

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        currentProcess = null;
        reject(new Error(err.message));
      });

      proc.on("exit", (code, signal) => {
        currentProcess = null;
        if (signal === "SIGKILL" || signal === "SIGTERM") {
          reject(new Error("Export cancelled"));
          return;
        }
        if (code !== 0) {
          const lines = stderr.trim().split("\n");
          reject(new Error(lines.slice(-3).join("\n") || `FFmpeg error code ${code}`));
          return;
        }
        resolve();
      });
    });
  }

  // Helper: send progress
  function sendProgress(percent, fps, timemark) {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send("export-progress", {
        progress: Math.max(0, Math.min(100, percent)),
        fps: fps || 0,
        timemark: timemark || "00:00:00.00",
      });
    }
  }

  try {
    // PASS 1: Encode each segment individually
    const segmentVideos = [];
    const totalSegments = segments.length;
    let cumulativeMs = 0;
    const totalMs = segments.reduce((sum, s) => sum + s.durationMs, 0);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDurSec = seg.durationMs / 1000;
      const segFrames = Math.max(1, Math.round(segDurSec * fps));
      const dir = enabled ? seg.direction || globalDir : "none";

      // Build zoompan filter for this segment
      const tExpr = `on/${Math.max(1, segFrames - 1)}`;
      const easeExpr = `-((cos(PI*${tExpr})-1)/2)`;
      const zMax = zoomMax.toFixed(6);
      const span = (zMax - 1).toFixed(6);

      let zExpr, xExpr, yExpr;
      if (!enabled || dir === "none") {
        zExpr = "1"; xExpr = "0"; yExpr = "0";
      } else if (dir === "in") {
        zExpr = `1+(${easeExpr})*${span}`;
        xExpr = "(iw-iw/zoom)/2"; yExpr = "(ih-ih/zoom)/2";
      } else if (dir === "out") {
        zExpr = `${zMax}-(${easeExpr})*${span}`;
        xExpr = "(iw-iw/zoom)/2"; yExpr = "(ih-ih/zoom)/2";
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

      // Build filter for this single segment (short, no ENAMETOOLONG risk)
      const filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`;

      const segVideoPath = path.join(tempDir, `seg_${String(i).padStart(4, "0")}.mp4`);
      tempFiles.push(segVideoPath);

      const args = [
        "-loop", "1",
        "-t", segDurSec.toFixed(3),
        "-i", seg.imagePath,
        "-vf", filter,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-b:v", `${bitrateMbps}M`,
        "-movflags", "+faststart",
        "-y",
        segVideoPath
      ];

      await runFfmpeg(args);
      segmentVideos.push(segVideoPath);

      // Report progress: pass 1 is 0-70%
      cumulativeMs += seg.durationMs;
      const pass1Percent = (cumulativeMs / totalMs) * 70;
      sendProgress(pass1Percent, fps, `00:00:${Math.floor(cumulativeMs / 1000).toString().padStart(2, "0")}.00`);
    }

    // PASS 2: Concat all segment videos + mux audio
    // Create concat list file
    const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);
    const concatContent = segmentVideos.map(v => `file '${v.replace(/'/g, "'\\''")}'`).join("\n");
    fs.writeFileSync(concatListPath, concatContent, "utf-8");
    tempFiles.push(concatListPath);

    const concatArgs = [
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
    ];

    if (audioPath) {
      concatArgs.push("-i", audioPath);
    }

    concatArgs.push("-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps));

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

        // Parse progress for pass 2 (70-100%)
        const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        const fpsMatch = text.match(/fps=\s*(\d+)/);

        if (timeMatch) {
          const timemark = timeMatch[1];
          const fpsNow = fpsMatch ? parseInt(fpsMatch[1], 10) : 0;
          const parts = timemark.split(":").map(Number);
          const totalSec = parts.length === 3 ? (parts[0] * 3600 + parts[1] * 60 + parts[2]) : 0;
          const totalDurSec = totalMs / 1000;
          const pass2Percent = 70 + Math.min(30, (totalSec / totalDurSec) * 30);
          sendProgress(pass2Percent, fpsNow, timemark);
        }
      });

      proc.on("error", (err) => {
        currentProcess = null;
        reject(new Error(err.message));
      });

      proc.on("exit", (code, signal) => {
        currentProcess = null;
        if (signal === "SIGKILL" || signal === "SIGTERM") {
          reject(new Error("Export cancelled"));
          return;
        }
        if (code !== 0) {
          const lines = stderr.trim().split("\n");
          reject(new Error(lines.slice(-3).join("\n") || `FFmpeg concat error code ${code}`));
          return;
        }
        resolve();
      });
    });

    sendProgress(100, 0, "00:00:00.00");

    // Get output file size
    let size = 0;
    try {
      const stats = fs.statSync(outputPath);
      size = stats.size;
    } catch (e) {}

    // Cleanup temp files
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }

    return { path: outputPath, size };

  } catch (err) {
    // Cleanup temp files on error
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  ensureTempDir();
  buildApplicationMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
