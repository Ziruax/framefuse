// electron/main.js — FrameFuse v4 main process
// Two-step export: Step 1 encodes each segment (with captions), Step 2 concats (-c copy)
// This avoids CLI length limits (each ffmpeg call has a short filter string)
const {
  app, BrowserWindow, ipcMain, dialog, Menu, shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");

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

// GPU encoder detection
let detectedEncoder = null;
function detectGpuEncoder() {
  if (detectedEncoder) return detectedEncoder;
  try {
    const output = execSync(`"${ffmpegPath}" -encoders 2>&1`, { encoding: "utf-8", timeout: 10000 });
    if (output.includes("h264_nvenc")) detectedEncoder = { name: "h264_nvenc", preset: "p1", tune: "hq", label: "NVIDIA NVENC" };
    else if (output.includes("h264_qsv")) detectedEncoder = { name: "h264_qsv", preset: "veryfast", tune: null, label: "Intel QSV" };
    else if (output.includes("h264_amf")) detectedEncoder = { name: "h264_amf", preset: "speed", tune: null, label: "AMD AMF" };
    else detectedEncoder = { name: "libx264", preset: "ultrafast", tune: null, label: "CPU (libx264)" };
  } catch (e) {
    detectedEncoder = { name: "libx264", preset: "ultrafast", tune: null, label: "CPU (libx264)" };
  }
  return detectedEncoder;
}

// Helper: run ffmpeg and wait
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    currentProcess = proc;
    let stderr = "";
    proc.stderr.on("data", (data) => { stderr += data.toString(); });
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

// ---------------------------------------------------------------------------
// IPC: TWO-STEP EXPORT (proven, reliable, no CLI length issues)
// Step 1: Encode each image → MP4 clip with zoompan + drawtext (captions)
//         Each ffmpeg call has a SHORT filter string (one image, a few cues)
// Step 2: Concat all clips + mux audio using -f concat -c copy (INSTANT)
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
  const encoder = detectGpuEncoder();

  // Pre-compute caption config
  let capConfig = null;
  let assFilePath = null;
  if (captionsEnabled) {
    const cs = captionSettings;
    const fontName = cs.fontName || "Arial";
    const fontSize = Math.round((cs.fontSize || 0.05) * height * (cs.fontSizeScale || 1));
    const textColor = (cs.textColor || "#FFFFFF");
    const borderColor = (cs.borderColor || "#000000");
    const borderWidth = cs.borderWidth || 2;
    const position = cs.customPosition || cs.position || "bottom";
    const marginV = cs.positionY || 50;

    // Build ASS subtitle file for this export
    // ASS supports multi-line text, wrapping, colors, positioning natively
    const assLines = [];
    assLines.push("[Script Info]");
    assLines.push("ScriptType: v4.00+");
    assLines.push(`PlayResX: ${width}`);
    assLines.push(`PlayResY: ${height}`);
    assLines.push("WrapStyle: 0"); // 0 = smart wrapping, even lines
    assLines.push("ScaledBorderAndShadow: yes");
    assLines.push("");
    assLines.push("[V4+ Styles]");
    assLines.push("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding");
    
    // Convert hex #RRGGBB to ASS &HAABBGGRR (alpha inverted)
    const toAssColor = (hex, alpha = 1) => {
      const h = hex.replace(/^#/, "");
      const r = h.slice(0, 2);
      const g = h.slice(2, 4);
      const b = h.slice(4, 6);
      const assAlpha = Math.round((1 - alpha) * 255).toString(16).padStart(2, "0").toUpperCase();
      return `&H${assAlpha}${b}${g}${r}`.toUpperCase();
    };

    // Alignment: 1=bottom-left, 2=bottom-center, 3=bottom-right
    //            4=middle-left, 5=middle-center, 6=middle-right
    //            7=top-left, 8=top-center, 9=top-right
    let alignment = 2; // bottom-center default
    if (position === "top") alignment = 8;
    else if (position === "center") alignment = 5;
    
    const bold = (cs.fontWeight || 600) >= 600 ? -1 : 0;
    
    assLines.push(`Style: Default,${fontName},${fontSize},${toAssColor(textColor)},${toAssColor(textColor)},${toAssColor(borderColor)},${toAssColor("#000000", 0.5)},${bold},0,0,0,100,100,0,0,1,${borderWidth},1,${alignment},40,40,${marginV},1`);
    assLines.push("");
    assLines.push("[Events]");
    assLines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");

    // Add each cue as an ASS dialogue event
    let cumulativeCueMs = 0;
    for (const cue of subtitleCues) {
      const startSec = cue.startMs / 1000;
      const endSec = cue.endMs / 1000;
      
      // Format time as H:MM:SS.cc
      const fmtTime = (sec) => {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        const cs = Math.round((sec % 1) * 100);
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
      };

      // ASS uses \N for hard line breaks, \n for soft wraps
      // Replace newlines in cue text with \N
      const assText = cue.text.replace(/\n/g, "\\N");
      
      assLines.push(`Dialogue: 0,${fmtTime(startSec)},${fmtTime(endSec)},Default,,0,0,0,,${assText}`);
    }

    // Write ASS file
    assFilePath = path.join(tempDir, `captions_${Date.now()}.ass`);
    tempFiles.push(assFilePath);
    fs.writeFileSync(assFilePath, assLines.join("\n"), "utf-8");

    capConfig = { assFilePath, fontSize, fontName, textColor, borderColor, borderWidth };
  }

  function sendProgress(percent, fpsVal, timemark) {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send("export-progress", {
        progress: Math.max(0, Math.min(100, percent)),
        fps: fpsVal || 0,
        timemark: timemark || "00:00:00.00",
      });
    }
  }

  ensureTempDir();
  const tempFiles = [];

  try {
    // ─── STEP 1: Encode each segment ──────────────────────────────
    const clipPaths = [];
    let cumulativeMs = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDurSec = seg.durationMs / 1000;
      const segFrames = Math.max(1, Math.round(segDurSec * fps));
      const dir = enabled ? seg.direction || globalDir : "none";
      const segStartMs = cumulativeMs;
      const segEndMs = cumulativeMs + seg.durationMs;

      // Build zoompan expressions
      let zExpr, xExpr, yExpr;
      if (!enabled || dir === "none") {
        zExpr = "1"; xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
      } else {
        const tExpr = `on/${Math.max(1, segFrames - 1)}`;
        const easeExpr = `-((cos(PI*${tExpr})-1)/2)`;
        const zMax = zoomMax.toFixed(6);
        const span = (zMax - 1).toFixed(6);
        if (dir === "in") { zExpr = `1+(${easeExpr})*${span}`; xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)"; }
        else if (dir === "out") { zExpr = `${zMax}-(${easeExpr})*${span}`; xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)"; }
        else {
          zExpr = zMax;
          const maxX = "(iw-iw/zoom)"; const maxY = "(ih-ih/zoom)";
          if (dir === "right") { xExpr = `${maxX}*(${easeExpr})`; yExpr = `${maxY}/2`; }
          else if (dir === "left") { xExpr = `${maxX}*(1-(${easeExpr}))`; yExpr = `${maxY}/2`; }
          else if (dir === "down") { xExpr = `${maxX}/2`; yExpr = `${maxY}*(${easeExpr})`; }
          else if (dir === "up") { xExpr = `${maxX}/2`; yExpr = `${maxY}*(1-(${easeExpr}))`; }
          else { xExpr = `${maxX}/2`; yExpr = `${maxY}/2`; }
        }
      }

      // Build -vf: scale(1.1x) + crop + zoompan + format + drawtext(captions)
      const scaleW = Math.round(width * 1.1);
      const scaleH = Math.round(height * 1.1);
      let vfParts = [
        `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase`,
        `crop=${scaleW}:${scaleH}`,
        `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps}`,
        `setsar=1`,
        `format=yuv420p`,
      ];

      // Add subtitles filter for captions (ASS supports multi-line, wrapping, positioning)
      if (capConfig && capConfig.assFilePath) {
        // Escape the ASS file path for the subtitles filter
        // Windows paths need backslashes escaped and colons escaped
        const escapedAssPath = capConfig.assFilePath
          .replace(/\\/g, "\\\\")
          .replace(/:/g, "\\:");
        vfParts.push(`subtitles=filename='${escapedAssPath}'`);
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
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-threads", "0",
        "-movflags", "+faststart",
        "-y",
        clipPath,
      ];

      await runFfmpeg(args);

      // Progress: 0-95% for step 1
      const pct = ((i + 1) / segments.length) * 95;
      cumulativeMs = segEndMs;
      sendProgress(pct, 0, `00:00:${String(Math.floor(cumulativeMs / 1000)).padStart(2, "0")}.00`);
    }

    // ─── STEP 2: Concat all clips + mux audio (INSTANT: -c copy) ───
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
    if (audioPath) concatArgs.push("-c:a", "aac", "-b:a", "192k", "-shortest");
    concatArgs.push("-movflags", "+faststart", "-y", outputPath);

    await runFfmpeg(concatArgs);

    sendProgress(100, 0, "00:00:00.00");

    // Cleanup
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }

    let size = 0;
    try { size = fs.statSync(outputPath).size; } catch (_) {}
    return { path: outputPath, size };

  } catch (err) {
    // Cleanup temp files on error
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
