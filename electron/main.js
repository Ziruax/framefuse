// electron/main.js — FrameFuse v4 main process
// Fast single-pass FFmpeg encoding via concat demuxer
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
  ffmpegPath = path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "ffmpeg-static", exeName);
} else {
  ffmpegPath = require("ffmpeg-static");
  if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
    const exePath = ffmpegPath + ".exe";
    try { if (fs.existsSync(exePath)) ffmpegPath = exePath; } catch (_) {}
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
  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
  } else {
    const file = path.join(__dirname, "..", "out", "index.html");
    if (fs.existsSync(file)) mainWindow.loadFile(file);
    else mainWindow.loadURL("file://" + file);
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) { shell.openExternal(url); return { action: "deny" }; }
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
      { label: "About FrameFuse", click: () => { dialog.showMessageBox(mainWindow, { type: "info", title: "About", message: "FrameFuse v4", detail: "Native image-to-video merger.", buttons: ["OK"] }); } },
      { label: "Filename Naming Guide", click: () => mainWindow && mainWindow.webContents.send("menu:naming-guide") },
    ]},
  ]));
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
// IPC: FAST single-pass FFmpeg export
// Uses concat demuxer with per-image duration + zoompan in a single call
// This is 10x faster than two-pass because:
//   1. Only ONE ffmpeg process (not N+1 processes)
//   2. No intermediate MP4 files written to disk
//   3. libx264 can optimize across segment boundaries
//   4. Audio muxed in the same pass
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
  const tempFiles = [];

  try {
    // STRATEGY: Use concat demuxer for images (fast, no filter_complex needed)
    // Then apply zoompan as a post-filter on the concatenated stream
    // This avoids the giant -filter_complex string entirely

    // Step 1: Create concat demuxer file with per-image duration
    const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);
    tempFiles.push(concatListPath);

    const concatLines = segments.map((seg) => {
      const dur = (seg.durationMs / 1000).toFixed(3);
      // Use forward slashes (ffmpeg requires this even on Windows)
      const imgPath = seg.imagePath.replace(/\\/g, "/");
      return `file '${imgPath}'\nduration ${dur}`;
    });
    // Add the last image again without duration (ffmpeg concat demuxer requirement)
    const lastImgPath = segments[segments.length - 1].imagePath.replace(/\\/g, "/");
    concatLines.push(`file '${lastImgPath}'`);

    fs.writeFileSync(concatListPath, concatLines.join("\n"), "utf-8");

    // Step 2: Build the zoompan filter for the concatenated video stream
    // Total frames = sum of all segment frames
    const totalFrames = segments.reduce((sum, seg) => sum + Math.max(1, Math.round((seg.durationMs / 1000) * fps)), 0);
    const totalDurSec = segments.reduce((sum, seg) => sum + seg.durationMs, 0) / 1000;

    // Build a filter that applies different zoompan for each segment's time range
    // Using if() expressions based on frame number 'on'
    let zExpr, xExpr, yExpr;

    if (!enabled) {
      // No Ken Burns — just scale and format
      zExpr = "1"; xExpr = "0"; yExpr = "0";
    } else {
      // Build per-segment zoompan expressions using if() chains
      // For each segment, compute the frame range and apply the appropriate zoom
      let frameOffset = 0;
      const zParts = [];
      const xParts = [];
      const yParts = [];

      segments.forEach((seg, i) => {
        const segFrames = Math.max(1, Math.round((seg.durationMs / 1000) * fps));
        const dir = enabled ? seg.direction || globalDir : "none";
        const tExpr = `(on-${frameOffset})/${Math.max(1, segFrames - 1)}`;
        const easeExpr = `-((cos(PI*${tExpr})-1)/2)`;
        const zMax = zoomMax.toFixed(6);
        const span = (zMax - 1).toFixed(6);

        let segZ, segX, segY;
        if (dir === "none") {
          segZ = "1"; segX = "0"; segY = "0";
        } else if (dir === "in") {
          segZ = `1+(${easeExpr})*${span}`;
          segX = "(iw-iw/zoom)/2"; segY = "(ih-ih/zoom)/2";
        } else if (dir === "out") {
          segZ = `${zMax}-(${easeExpr})*${span}`;
          segX = "(iw-iw/zoom)/2"; segY = "(ih-ih/zoom)/2";
        } else {
          segZ = zMax;
          const maxX = "(iw-iw/zoom)"; const maxY = "(ih-ih/zoom)";
          if (dir === "right") { segX = `${maxX}*(${easeExpr})`; segY = `${maxY}/2`; }
          else if (dir === "left") { segX = `${maxX}*(1-(${easeExpr}))`; segY = `${maxY}/2`; }
          else if (dir === "down") { segX = `${maxX}/2`; segY = `${maxY}*(${easeExpr})`; }
          else if (dir === "up") { segX = `${maxX}/2`; segY = `${maxY}*(1-(${easeExpr}))`; }
          else { segX = `${maxX}/2`; segY = `${maxY}/2`; }
        }

        if (i === 0) {
          zParts.push(`if(lt(on,${frameOffset + segFrames}),${segZ}`);
          xParts.push(`if(lt(on,${frameOffset + segFrames}),${segX}`);
          yParts.push(`if(lt(on,${frameOffset + segFrames}),${segY}`);
        } else {
          zParts.push(`,if(lt(on,${frameOffset + segFrames}),${segZ}`);
          xParts.push(`,if(lt(on,${frameOffset + segFrames}),${segX}`);
          yParts.push(`,if(lt(on,${frameOffset + segFrames}),${segY}`);
        }

        frameOffset += segFrames;
      });

      // Close all if() statements
      zParts.push("".padStart(segments.length, ")"));
      xParts.push("".padStart(segments.length, ")"));
      yParts.push("".padStart(segments.length, ")"));

      zExpr = zParts.join("");
      xExpr = xParts.join("");
      yExpr = yParts.join("");
    }

    // Build the video filter: scale + crop + zoompan
    // Use -vf instead of -filter_complex (shorter, works with single input)
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`;

    // Build ffmpeg arguments
    const args = [
      "-f", "concat", "-safe", "0", "-i", concatListPath,
    ];

    if (audioPath) {
      args.push("-i", audioPath);
    }

    args.push("-vf", vf);
    args.push("-map", "0:v:0");
    if (audioPath) {
      args.push("-map", "1:a:0");
    }

    args.push(
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-b:v", `${bitrateMbps}M`,
    );

    if (audioPath) {
      args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
    }

    args.push("-movflags", "+faststart", "-y", outputPath);

    // Check if the -vf argument is too long for Windows command line
    // Windows limit: 32767 chars. If vf is over 8000 chars, use a batch file
    const vfLength = args.join(" ").length;
    const useBatchFile = process.platform === "win32" && vfLength > 8000;

    return await new Promise((resolve, reject) => {
      let proc;

      if (useBatchFile) {
        // Write a batch file to avoid command line length limit
        const batchFile = path.join(tempDir, `run_${Date.now()}.bat`);
        tempFiles.push(batchFile);
        const quotedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ");
        const batchContent = `@"${ffmpegPath}" ${quotedArgs}`;
        fs.writeFileSync(batchFile, batchContent, "utf-8");
        proc = spawn("cmd.exe", ["/c", batchFile], { windowsHide: true });
      } else {
        proc = spawn(ffmpegPath, args, { windowsHide: true });
      }

      currentProcess = proc;
      let stderrData = "";
      let lastProgress = 0;

      proc.stderr.on("data", (data) => {
        const text = data.toString();
        stderrData += text;

        // Parse progress from ffmpeg stderr
        const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        const fpsMatch = text.match(/fps=\s*(\d+)/);

        if (timeMatch) {
          const timemark = timeMatch[1];
          const fpsNow = fpsMatch ? parseInt(fpsMatch[1], 10) : 0;
          const parts = timemark.split(":").map(Number);
          const totalSec = parts.length === 3 ? (parts[0] * 3600 + parts[1] * 60 + parts[2]) : 0;
          const percent = totalDurSec > 0 ? Math.min(100, (totalSec / totalDurSec) * 100) : 0;

          if (percent > lastProgress) {
            lastProgress = percent;
            if (event.sender && !event.sender.isDestroyed()) {
              event.sender.send("export-progress", { progress: percent, fps: fpsNow, timemark });
            }
          }
        }
      });

      proc.on("error", (err) => {
        currentProcess = null;
        reject(new Error(err.message || "Failed to spawn FFmpeg"));
      });

      proc.on("exit", (code, signal) => {
        currentProcess = null;
        // Cleanup temp files
        for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }

        if (signal === "SIGKILL" || signal === "SIGTERM") {
          reject(new Error("Export cancelled"));
          return;
        }
        if (code !== 0) {
          const lines = stderrData.trim().split("\n");
          reject(new Error(lines.slice(-5).join("\n") || `FFmpeg exited with code ${code}`));
          return;
        }

        try {
          const stats = fs.statSync(outputPath);
          resolve({ path: outputPath, size: stats.size });
        } catch {
          resolve({ path: outputPath, size: 0 });
        }
      });
    });
  } catch (err) {
    // Cleanup temp files on error
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }
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
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
