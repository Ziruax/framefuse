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
const ffmpeg = require("fluent-ffmpeg");

// Resolve FFmpeg binary path — works in both dev and packaged modes
// The ffmpeg-static npm package provides the binary, but when packaged
// into an asar, the binary is extracted to app.asar.unpacked/
let ffmpegPath;

if (app.isPackaged) {
  // In packaged app, the binary is at:
  // resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe (Windows)
  // resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg (Mac/Linux)
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  ffmpegPath = path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "ffmpeg-static",
    exeName
  );
} else {
  // In dev mode, use ffmpeg-static package directly
  ffmpegPath = require("ffmpeg-static");
  // On Windows, prefer ffmpeg.exe if it exists
  if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
    const exePath = ffmpegPath + ".exe";
    try {
      if (fs.existsSync(exePath)) {
        ffmpegPath = exePath;
      }
    } catch (_) { /* ignore */ }
  }
}

// Point fluent-ffmpeg at the native binary
ffmpeg.setFfmpegPath(ffmpegPath);

const isDev = !app.isPackaged;

let mainWindow = null;
let currentCommand = null; // active fluent-ffmpeg command (for cancel)
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
    // DevTools disabled by default — uncomment to debug
    // mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const file = path.join(__dirname, "..", "out", "index.html");
    if (fs.existsSync(file)) {
      mainWindow.loadFile(file);
    } else {
      // Last-resort fallback so the window never shows blank.
      mainWindow.loadURL("file://" + file);
    }
  }

  // Open external links in the system browser, not inside the app.
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
        {
          label: "Add Images…",
          accelerator: "CmdOrCtrl+O",
          click: () =>
            mainWindow && mainWindow.webContents.send("menu:add-images"),
        },
        {
          label: "Add Audio…",
          click: () =>
            mainWindow && mainWindow.webContents.send("menu:add-audio"),
        },
        { type: "separator" },
        {
          label: "Export MP4…",
          accelerator: "CmdOrCtrl+E",
          click: () =>
            mainWindow && mainWindow.webContents.send("menu:export"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About FrameFuse",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About FrameFuse",
              message: "FrameFuse v4",
              detail:
                "Native image-to-video merger.\nKen Burns motion · Absolute timelines · Native FFmpeg encoding.\n\n" +
                "FFmpeg: " + ffmpegPath,
              buttons: ["OK"],
            });
          },
        },
        {
          label: "Filename Naming Guide",
          click: () =>
            mainWindow &&
            mainWindow.webContents.send("menu:naming-guide"),
        },
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
  const safe = String(name || "img").replace(/[^a-zA-Z0-9._-]/g, "_");
  const p = path.join(tempDir, `img_${Date.now()}_${safe}`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle("save-temp-audio", async (_evt, { name, bytes }) => {
  ensureTempDir();
  const safe = String(name || "audio").replace(/[^a-zA-Z0-9._-]/g, "_");
  const p = path.join(tempDir, `audio_${Date.now()}_${safe}`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle("cleanup-temp", async () => {
  try {
    if (fs.existsSync(tempDir)) {
      for (const f of fs.readdirSync(tempDir)) {
        fs.unlinkSync(path.join(tempDir, f));
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
    if (currentCommand) {
      currentCommand.kill("SIGKILL");
      currentCommand = null;
    }
    return true;
  } catch (e) {
    return false;
  }
});

// ---------------------------------------------------------------------------
// IPC: native FFmpeg export
// ---------------------------------------------------------------------------
// opts: {
//   outputPath, fps, width, height, bitrateMbps,
//   kenBurns: {enabled, intensity, direction},
//   segments: [{ imagePath, direction, durationMs }],
//   audioPath?: string|null
// }
ipcMain.handle("export-native", async (event, opts) => {
  const {
    outputPath,
    fps,
    width,
    height,
    bitrateMbps,
    kenBurns,
    segments,
    audioPath,
  } = opts;

  if (!outputPath) throw new Error("No output path");
  if (!segments || segments.length === 0) throw new Error("No segments");

  const intensity = Math.max(0, Math.min(100, Number(kenBurns?.intensity) || 0));
  const zoomMax = 1.06 + (intensity / 100) * 0.18;
  const enabled = !!kenBurns?.enabled;
  const globalDir = kenBurns?.direction || "in";

  const filterParts = [];
  const labels = [];

  segments.forEach((seg, i) => {
    const d = Math.max(1, Math.round((seg.durationMs / 1000) * fps));
    const dir = enabled ? seg.direction || globalDir : "none";

    // easeInOutSine via ffmpeg cos(): eased = -(cos(PI*t)-1)/2, t = on/(d-1)
    const tExpr = `on/${Math.max(1, d - 1)}`;
    const easeExpr = `-((cos(PI*${tExpr})-1)/2)`;
    const zMax = zoomMax.toFixed(6);
    const span = (zMax - 1).toFixed(6);

    let zExpr, xExpr, yExpr;
    if (!enabled || dir === "none") {
      zExpr = "1";
      xExpr = "0";
      yExpr = "0";
    } else if (dir === "in") {
      zExpr = `1+(${easeExpr})*${span}`;
      xExpr = "(iw-iw/zoom)/2";
      yExpr = "(ih-ih/zoom)/2";
    } else if (dir === "out") {
      zExpr = `${zMax}-(${easeExpr})*${span}`;
      xExpr = "(iw-iw/zoom)/2";
      yExpr = "(ih-ih/zoom)/2";
    } else {
      // Pan directions use fixed zoom.
      zExpr = zMax;
      const maxX = `(iw-iw/zoom)`;
      const maxY = `(ih-ih/zoom)`;
      if (dir === "right") {
        xExpr = `${maxX}*(${easeExpr})`;
        yExpr = `${maxY}/2`;
      } else if (dir === "left") {
        xExpr = `${maxX}*(1-(${easeExpr}))`;
        yExpr = `${maxY}/2`;
      } else if (dir === "down") {
        xExpr = `${maxX}/2`;
        yExpr = `${maxY}*(${easeExpr})`;
      } else if (dir === "up") {
        xExpr = `${maxX}/2`;
        yExpr = `${maxY}*(1-(${easeExpr}))`;
      } else {
        xExpr = `${maxX}/2`;
        yExpr = `${maxY}/2`;
      }
    }

    const part =
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${d}:s=${width}x${height}:fps=${fps},` +
      `setsar=1,format=yuv420p[v${i}]`;
    filterParts.push(part);
    labels.push(`[v${i}]`);
  });

  // Concat all video labels.
  filterParts.push(
    `${labels.join("")}concat=n=${segments.length}:v=1:a=0[vout]`,
  );
  const filterComplex = filterParts.join(";");

  const audioIdx = segments.length; // audio is the last input

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    currentCommand = cmd;
    segments.forEach((seg) => cmd.input(seg.imagePath));
    if (audioPath) cmd.input(audioPath);

    const outputOptions = ["-filter_complex", filterComplex, "-map", "[vout]"];
    if (audioPath) {
      outputOptions.push("-map", `${audioIdx}:a`, "-c:a", "aac", "-b:a", "192k");
    }
    outputOptions.push(
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-b:v",
      `${bitrateMbps}M`,
      "-movflags",
      "+faststart",
    );
    if (audioPath) outputOptions.push("-shortest");

    cmd.outputOptions(outputOptions);
    cmd.save(outputPath);

    cmd.on("progress", (progress) => {
      const percent = Math.max(0, Math.min(100, progress.percent || 0));
      const fpsNow = progress.currentFps || 0;
      const timemark = progress.timemark || "00:00:00";
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send("export-progress", {
          progress: percent,
          fps: fpsNow,
          timemark,
        });
      }
    });

    cmd.on("error", (err, _stdout, stderr) => {
      currentCommand = null;
      reject(new Error(stderr || err.message || "FFmpeg error"));
    });

    cmd.on("end", () => {
      currentCommand = null;
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
