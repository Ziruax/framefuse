// electron/main.js — FrameFuse v4 main process
// SINGLE-PASS filtergraph export — one ffmpeg process, no intermediate files
// Auto-detects GPU encoder (NVIDIA/Intel/AMD) with libx264 fallback
const {
  app, BrowserWindow, ipcMain, dialog, Menu, shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");

// Resolve FFmpeg binary path
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
// GPU ENCODER DETECTION
// Tests which hardware encoders are available by running ffmpeg -encoders
// and checking if h264_nvenc, h264_qsv, or h264_amf are present.
// ---------------------------------------------------------------------------
let detectedEncoder = null;

function detectGpuEncoder() {
  if (detectedEncoder) return detectedEncoder;
  try {
    const output = execSync(`"${ffmpegPath}" -encoders 2>&1`, { encoding: "utf-8", timeout: 10000 });
    if (output.includes("h264_nvenc")) {
      detectedEncoder = { name: "h264_nvenc", preset: "p1", tune: "hq", label: "NVIDIA NVENC" };
    } else if (output.includes("h264_qsv")) {
      detectedEncoder = { name: "h264_qsv", preset: "veryfast", tune: null, label: "Intel QSV" };
    } else if (output.includes("h264_amf")) {
      detectedEncoder = { name: "h264_amf", preset: "speed", tune: null, label: "AMD AMF" };
    } else {
      detectedEncoder = { name: "libx264", preset: "ultrafast", tune: null, label: "CPU (libx264)" };
    }
  } catch (e) {
    detectedEncoder = { name: "libx264", preset: "ultrafast", tune: null, label: "CPU (libx264)" };
  }
  return detectedEncoder;
}

// ---------------------------------------------------------------------------
// IPC: SINGLE-PASS FILTERGRAPH EXPORT
// One ffmpeg process. No intermediate files. No concat step.
// All images → filter_complex → concat → encode → output
// ---------------------------------------------------------------------------
ipcMain.handle("export-native", async (event, opts) => {
  const { outputPath, fps, width, height, bitrateMbps, kenBurns, segments, audioPath, captionSettings, subtitleCues } = opts;

  if (!outputPath) throw new Error("No output path");
  if (!segments || segments.length === 0) throw new Error("No segments");

  const intensity = Math.max(0, Math.min(100, Number(kenBurns?.intensity) || 0));
  const zoomMax = 1.06 + (intensity / 100) * 0.18;
  const enabled = !!kenBurns?.enabled;
  const globalDir = kenBurns?.direction || "in";

  const captionsEnabled = !!captionSettings?.enabled && subtitleCues && subtitleCues.length > 0;
  const totalMs = segments.reduce((sum, s) => sum + s.durationMs, 0);
  const totalFrames = segments.reduce((sum, s) => sum + Math.max(1, Math.round((s.durationMs / 1000) * fps)), 0);

  // Detect GPU encoder
  const encoder = detectGpuEncoder();

  function sendProgress(percent, fpsVal, timemark) {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send("export-progress", {
        progress: Math.max(0, Math.min(100, percent)),
        fps: fpsVal || 0,
        timemark: timemark || "00:00:00.00",
      });
    }
  }

  sendProgress(1, 0, "00:00:00.00");

  try {
    // ─── BUILD ARGS ───────────────────────────────────────────────
    const args = [];

    // 1. Add all images as inputs (-loop 1 -t dur -i img)
    segments.forEach((seg) => {
      args.push("-loop", "1", "-t", (seg.durationMs / 1000).toFixed(3), "-i", seg.imagePath);
    });

    // 2. Add audio input
    if (audioPath) {
      args.push("-i", audioPath);
    }

    // 3. Build filter_complex
    // Scale to 1.1x target (not 2x) for zoompan quality without 4K overhead
    const scaleW = Math.round(width * 1.1);
    const scaleH = Math.round(height * 1.1);

    let filterComplex = "";
    let concatInputs = "";
    let cumulativeMs = 0;

    segments.forEach((seg, i) => {
      const segDurSec = seg.durationMs / 1000;
      const segFrames = Math.max(1, Math.round(segDurSec * fps));
      const dir = enabled ? seg.direction || globalDir : "none";
      const segStartMs = cumulativeMs;
      const segEndMs = cumulativeMs + seg.durationMs;

      // Build zoompan expressions
      let zExpr, xExpr, yExpr;

      if (!enabled || dir === "none") {
        zExpr = "1";
        xExpr = "iw/2-(iw/zoom/2)";
        yExpr = "ih/2-(ih/zoom/2)";
      } else {
        const tExpr = `on/${Math.max(1, segFrames - 1)}`;
        const easeExpr = `-((cos(PI*${tExpr})-1)/2)`;
        const zMax = zoomMax.toFixed(6);
        const span = (zMax - 1).toFixed(6);

        if (dir === "in") {
          zExpr = `1+(${easeExpr})*${span}`;
          xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
        } else if (dir === "out") {
          zExpr = `${zMax}-(${easeExpr})*${span}`;
          xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
        } else {
          zExpr = zMax;
          const maxX = "(iw-iw/zoom)"; const maxY = "(ih-ih/zoom)";
          if (dir === "right") { xExpr = `${maxX}*(${easeExpr})`; yExpr = `${maxY}/2`; }
          else if (dir === "left") { xExpr = `${maxX}*(1-(${easeExpr}))`; yExpr = `${maxY}/2`; }
          else if (dir === "down") { xExpr = `${maxX}/2`; yExpr = `${maxY}*(${easeExpr})`; }
          else if (dir === "up") { xExpr = `${maxX}/2`; yExpr = `${maxY}*(1-(${easeExpr}))`; }
          else { xExpr = `${maxX}/2`; yExpr = `${maxY}/2`; }
        }
      }

      // Build filter for this segment
      // scale to 1.1x → crop → zoompan to target → format
      let filter = `[${i}:v]scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,crop=${scaleW}:${scaleH},zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`;

      // Add drawtext for captions overlapping this segment
      if (captionsEnabled) {
        const cs = captionSettings;
        const fontName = cs.fontName || "Arial";
        const fontSize = Math.round((cs.fontSize || 0.05) * height * (cs.fontSizeScale || 1));
        const textColor = (cs.textColor || "#FFFFFF").replace("#", "0x");
        const borderColor = (cs.borderColor || "#000000").replace("#", "0x");
        const borderWidth = cs.borderWidth || 2;
        const position = cs.customPosition || cs.position || "bottom";
        const marginV = cs.positionY || 50;

        // Calculate max chars per line based on video width and font size
        // Average char width ≈ 0.6 × font size for sans-serif
        const charWidth = fontSize * 0.6;
        const maxWidthPx = width * 0.82; // 82% of video width
        const maxCharsPerLine = Math.floor(maxWidthPx / charWidth);

        let yExprCap;
        if (position === "top") yExprCap = `${marginV}`;
        else if (position === "center") yExprCap = `(h-text_h)/2`;
        else yExprCap = `h-text_h-${marginV}`;

        for (const cue of subtitleCues) {
          if (cue.endMs <= segStartMs || cue.startMs >= segEndMs) continue;

          const cueStartSec = Math.max(0, (cue.startMs - segStartMs) / 1000);
          const cueEndSec = Math.min(segDurSec, (cue.endMs - segStartMs) / 1000);

          // Wrap text into multiple lines (drawtext doesn't auto-wrap)
          // Use literal \n for line breaks in drawtext
          const words = cue.text.split(/\s+/);
          let lines = [];
          let currentLine = "";
          for (const word of words) {
            const testLine = currentLine ? currentLine + " " + word : word;
            if (testLine.length > maxCharsPerLine && currentLine) {
              lines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = testLine;
            }
          }
          if (currentLine) lines.push(currentLine);
          const wrappedText = lines.join("\\n"); // Literal \n for drawtext

          // Escape special characters for drawtext
          const escapedText = wrappedText
            .replace(/\\/g, "\\\\")
            .replace(/:/g, "\\:")
            .replace(/'/g, "\u2019");

          filter += `,drawtext=font='${fontName}':fontsize=${fontSize}:fontcolor=${textColor}:bordercolor=${borderColor}:borderw=${borderWidth}:text='${escapedText}':x=(w-text_w)/2:y=${yExprCap}:enable='between(t,${cueStartSec.toFixed(3)},${cueEndSec.toFixed(3)})'`;
        }
      }

      filter += `[v${i}]`;
      filterComplex += filter + ";";
      concatInputs += `[v${i}]`;
      cumulativeMs = segEndMs;
    });

    // Add concat at the end
    filterComplex += `${concatInputs}concat=n=${segments.length}:v=1:a=0[outv]`;

    // ─── CLEANUP TRAILING PUNCTUATION ──────────────────────────────
    filterComplex = filterComplex.trim().replace(/;+$/, "").replace(/\n+$/, "");

    // ─── PASS FILTER DIRECTLY ─────────────────────────────────────
    // Node.js spawn() bypasses cmd.exe and handles up to 32767 chars.
    // If the total args string exceeds 25000 chars, use a batch file.
    const filterScriptPath = null; // not used unless batch fallback
    args.push("-filter_complex", filterComplex);

    // Cleanup helper (race-condition safe) — no-op since we pass filter directly
    const cleanupFilterScript = () => {};

    // 4. Map outputs
    args.push("-map", "[outv]");
    if (audioPath) {
      args.push("-map", `${segments.length}:a`);
    }

    // 5. Encoder selection
    if (encoder.name === "h264_nvenc") {
      args.push("-c:v", "h264_nvenc", "-preset", "p1", "-tune", "hq");
    } else if (encoder.name === "h264_qsv") {
      args.push("-c:v", "h264_qsv", "-preset", "veryfast");
    } else if (encoder.name === "h264_amf") {
      args.push("-c:v", "h264_amf", "-quality", "speed");
    } else {
      // CPU fallback
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-threads", "0");
    }

    // Bitrate
    args.push("-b:v", `${bitrateMbps}M`);
    args.push("-pix_fmt", "yuv420p");

    // Audio
    if (audioPath) {
      args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
    }

    args.push("-movflags", "+faststart", "-y", outputPath);

    // ─── RUN FFMPEG ───────────────────────────────────────────────
    // spawn() bypasses cmd.exe's 8191 char limit (can handle 32767 chars).
    // For filters > 8000 chars, we use -filter_complex_script (see above).
    // So we always use spawn() directly — no batch file needed.
    return await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { windowsHide: true });

      currentProcess = proc;
      let stderrData = "";

      proc.stderr.on("data", (data) => {
        const text = data.toString();
        stderrData += text;

        // Parse progress from stderr
        // FFmpeg outputs: frame=  123 fps= 45 q=28.0 size=    1024kB time=00:00:05.12
        const frameMatch = text.match(/frame=\s*(\d+)/);
        const fpsMatch = text.match(/fps=\s*(\d+)/);
        const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);

        if (frameMatch) {
          const currentFrame = parseInt(frameMatch[1], 10);
          const fpsNow = fpsMatch ? parseInt(fpsMatch[1], 10) : 0;
          const percent = totalFrames > 0 ? Math.min(99, (currentFrame / totalFrames) * 100) : 0;
          const timemark = timeMatch ? timeMatch[1] : "00:00:00.00";
          sendProgress(percent, fpsNow, timemark);
        }
      });

      proc.on("error", (err) => {
        currentProcess = null;
        reject(new Error(err.message || "Failed to spawn FFmpeg"));
      });

      proc.on("exit", (code, signal) => {
        currentProcess = null;

        if (signal === "SIGKILL" || signal === "SIGTERM") {
          reject(new Error("Export cancelled"));
          return;
        }

        if (code !== 0) {
          // If GPU encoder failed, try fallback with libx264
          if (encoder.name !== "libx264" && stderrData.includes("not supported") || stderrData.includes("Failed")) {
            // Retry with CPU encoder
            const cpuArgs = args.filter(a => a !== "-preset" && a !== "p1" && a !== "veryfast" && a !== "speed" && a !== "-tune" && a !== "hq" && a !== "-quality");
            // Replace encoder
            const encIdx = cpuArgs.indexOf("-c:v");
            if (encIdx >= 0) {
              cpuArgs[encIdx + 1] = "libx264";
              cpuArgs.splice(encIdx + 2, 0, "-preset", "ultrafast", "-crf", "22", "-threads", "0");
            }

            const retryProc = spawn(ffmpegPath, cpuArgs, { windowsHide: true });
            currentProcess = retryProc;
            let retryStderr = "";

            retryProc.stderr.on("data", (data) => {
              const text = data.toString();
              retryStderr += text;
              const frameMatch = text.match(/frame=\s*(\d+)/);
              const fpsMatch = text.match(/fps=\s*(\d+)/);
              const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
              if (frameMatch) {
                const currentFrame = parseInt(frameMatch[1], 10);
                const fpsNow = fpsMatch ? parseInt(fpsMatch[1], 10) : 0;
                const percent = totalFrames > 0 ? Math.min(99, (currentFrame / totalFrames) * 100) : 0;
                const timemark = timeMatch ? timeMatch[1] : "00:00:00.00";
                sendProgress(percent, fpsNow, timemark);
              }
            });

            retryProc.on("error", (err) => { currentProcess = null; reject(new Error(err.message)); });
            retryProc.on("exit", (code2, signal2) => {
              currentProcess = null;
              cleanupFilterScript();
              if (signal2 === "SIGKILL" || signal2 === "SIGTERM") { reject(new Error("Export cancelled")); return; }
              if (code2 !== 0) {
                const lines = retryStderr.trim().split("\n");
                reject(new Error(lines.slice(-5).join("\n") || `FFmpeg error code ${code2}`));
                return;
              }
              sendProgress(100, 0, "00:00:00.00");
              try { resolve({ path: outputPath, size: fs.statSync(outputPath).size }); }
              catch { resolve({ path: outputPath, size: 0 }); }
            });
            return;
          }

          const lines = stderrData.trim().split("\n");
          cleanupFilterScript();
          reject(new Error(lines.slice(-5).join("\n") || `FFmpeg exited with code ${code}`));
          return;
        }

        cleanupFilterScript();
        sendProgress(100, 0, "00:00:00.00");
        try { resolve({ path: outputPath, size: fs.statSync(outputPath).size }); }
        catch { resolve({ path: outputPath, size: 0 }); }
      });
    });
  } catch (err) {
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
