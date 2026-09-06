// electron/main.js — FrameFuse v4 main process
// Native FFmpeg encoding via fluent-ffmpeg + ffmpeg-static.
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
const { execFile } = require("child_process");

// Resolve FFmpeg binary path — works in both dev and packaged modes
let ffmpegPath;
let ffprobePath = null;

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
    } catch (_) { /* ignore */ }
  }
}

const isDev = !app.isPackaged;
let mainWindow = null;
let currentProcess = null; // active ffmpeg child process (for cancel)
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
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
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
        { label: "About FrameFuse", click: () => { dialog.showMessageBox(mainWindow, { type: "info", title: "About FrameFuse", message: "FrameFuse v4", detail: "Native image-to-video merger.\nKen Burns motion · Absolute timelines · Native FFmpeg encoding.", buttons: ["OK"] }); } },
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
  // Use short sequential names to avoid ENAMETOOLONG
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
      currentProcess.kill("SIGKILL");
      currentProcess = null;
    }
    return true;
  } catch (e) {
    return false;
  }
});

// ---------------------------------------------------------------------------
// IPC: native FFmpeg export — uses raw child_process, NOT fluent-ffmpeg
// This avoids the ENAMETOOLONG error by writing filter_complex to a file
// and using -filter_complex_script instead of -filter_complex
// ---------------------------------------------------------------------------
ipcMain.handle("export-native", async (event, opts) => {
  const { outputPath, fps, width, height, bitrateMbps, kenBurns, segments, audioPath } = opts;

  if (!outputPath) throw new Error("No output path");
  if (!segments || segments.length === 0) throw new Error("No segments");

  const intensity = Math.max(0, Math.min(100, Number(kenBurns?.intensity) || 0));
  const zoomMax = 1.06 + (intensity / 100) * 0.18;
  const enabled = !!kenBurns?.enabled;
  const globalDir = kenBurns?.direction || "in";

  // Build filter_complex string
  const filterParts = [];
  const labels = [];

  segments.forEach((seg, i) => {
    const d = Math.max(1, Math.round((seg.durationMs / 1000) * fps));
    const dir = enabled ? seg.direction || globalDir : "none";

    const tExpr = `on/${Math.max(1, d - 1)}`;
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

    const part =
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${d}:s=${width}x${height}:fps=${fps},` +
      `setsar=1,format=yuv420p[v${i}]`;
    filterParts.push(part);
    labels.push(`[v${i}]`);
  });

  filterParts.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=0[vout]`);
  const filterComplex = filterParts.join(";");

  // Write filter_complex to a temp file to avoid ENAMETOOLONG
  ensureTempDir();
  const filterScriptPath = path.join(tempDir, `filter_${Date.now()}.txt`);
  fs.writeFileSync(filterScriptPath, filterComplex, "utf-8");

  // Build ffmpeg arguments — use -filter_complex_script instead of -filter_complex
  const args = [];

  // Input images (loop each for its duration)
  segments.forEach((seg) => {
    args.push("-loop", "1", "-t", (seg.durationMs / 1000).toFixed(3), "-i", seg.imagePath);
  });

  // Audio input
  if (audioPath) {
    args.push("-i", audioPath);
  }

  // Use filter_complex_script (reads from file, avoids ENAMETOOLONG)
  args.push("-filter_complex_script", filterScriptPath);
  args.push("-map", "[vout]");

  if (audioPath) {
    args.push("-map", `${segments.length}:a`);
  }

  // Video encoding
  args.push(
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-b:v", `${bitrateMbps}M`,
  );

  // Audio encoding
  if (audioPath) {
    args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  }

  args.push("-movflags", "+faststart");
  args.push("-y"); // overwrite
  args.push(outputPath);

  return new Promise((resolve, reject) => {
    const proc = execFile(ffmpegPath, args, {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    currentProcess = proc;

    let stderrData = "";
    let lastProgress = 0;

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      stderrData += text;

      // Parse progress from ffmpeg stderr
      // Look for "frame=  123 fps= 45 q=28.0 size=    1024kB time=00:00:05.12"
      const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      const fpsMatch = text.match(/fps=\s*(\d+)/);
      const sizeMatch = text.match(/size=\s*(\d+)kB/);

      if (timeMatch) {
        const timemark = timeMatch[1];
        const fpsNow = fpsMatch ? parseInt(fpsMatch[1], 10) : 0;

        // Parse timemark to seconds
        const parts = timemark.split(":").map(Number);
        const totalSec = parts.length === 3 ? (parts[0] * 3600 + parts[1] * 60 + parts[2]) : 0;

        // Calculate total duration from segments
        const totalDurSec = segments.reduce((sum, s) => sum + s.durationMs, 0) / 1000;
        const percent = totalDurSec > 0 ? Math.min(100, (totalSec / totalDurSec) * 100) : 0;

        if (percent > lastProgress) {
          lastProgress = percent;
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send("export-progress", {
              progress: percent,
              fps: fpsNow,
              timemark: timemark,
            });
          }
        }
      }
    });

    proc.on("error", (err) => {
      currentProcess = null;
      try { fs.unlinkSync(filterScriptPath); } catch (_) {}
      reject(new Error(err.message || "Failed to spawn FFmpeg"));
    });

    proc.on("exit", (code, signal) => {
      currentProcess = null;
      try { fs.unlinkSync(filterScriptPath); } catch (_) {}

      if (signal === "SIGKILL" || signal === "SIGTERM") {
        reject(new Error("Export cancelled"));
        return;
      }
      if (code !== 0) {
        // Extract last few lines of stderr for error message
        const lines = stderrData.trim().split("\n");
        const lastLines = lines.slice(-5).join("\n");
        reject(new Error(lastLines || `FFmpeg exited with code ${code}`));
        return;
      }

      try {
        const stats = fs.statSync(outputPath);
        resolve({ path: outputPath, size: stats.size });
      } catch (e) {
        resolve({ path: outputPath, size: 0 });
      }
    });
  });
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
