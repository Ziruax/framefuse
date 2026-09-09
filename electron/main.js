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
  // Resolve app icon with graceful fallback if the build/icon.ico is
  // missing (e.g. during dev before electron-builder has been run).
  // Electron accepts undefined for the icon option and falls back to
  // its default window icon.
  let iconPath = path.join(__dirname, "..", "build", "icon.ico");
  try { if (!fs.existsSync(iconPath)) iconPath = undefined; } catch (_) { iconPath = undefined; }

  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 720,
    backgroundColor: "#0a0a0a", title: "FrameFuse v4",
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

  // ─── Caption styling config (computed once, reused per-segment) ───
  // Each clip needs its cues time-shifted to be relative to that
  // clip's 0-based clock (clip-time 0 = the segment's absolute startMs
  // on the master timeline). A single global ASS file with absolute
  // timestamps would only match cues whose startMs < segDurSec for
  // every clip — i.e. the first caption(s) get burned in repeated
  // across every clip. This is the bug we fix here, plus we add
  // word-by-word (ASS \k karaoke tags / per-word Dialogue lines) and
  // kinetic typography animation (ASS \t transform tags) support.
  let capStyle = null;
  if (captionsEnabled) {
    const cs = captionSettings;
    const fontName = cs.fontName || "Arial";
    const fontSize = Math.round((cs.fontSize || 0.05) * height * (cs.fontSizeScale || 1));
    const textColor = cs.textColor || "#FFFFFF";
    const borderColor = cs.borderColor || "#000000";
    const borderWidth = cs.borderWidth || 2;
    const highlightColor = cs.highlightColor || null;
    const position = cs.customPosition || cs.position || "bottom";
    const marginV = cs.positionY || 50;
    const fontWeight = cs.fontWeight || 600;
    const fontStyle = cs.fontStyle || "normal";
    const shadow = cs.shadow || false;
    const shadowColor = cs.shadowColor || "#000000";
    const shadowBlur = cs.shadowBlur || 3;
    const bgColor = cs.bgColor || null;
    const bgAlpha = cs.bgAlpha || 1;
    const textTransform = cs.textTransform || "none";
    const letterSpacing = cs.letterSpacing || 0;
    const alignment = cs.alignment || "center";
    const wordMode = cs.wordMode || "off";
    const animation = cs.animation || "none";

    // Convert hex #RRGGBB to ASS &HAABBGGRR (alpha inverted vs CSS).
    const toAssColor = (hex, alpha = 1) => {
      const h = (hex || "#FFFFFF").replace(/^#/, "");
      const r = h.slice(0, 2);
      const g = h.slice(2, 4);
      const b = h.slice(4, 6);
      const assAlpha = Math.round((1 - alpha) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();
      return `&H${assAlpha}${b}${g}${r}`.toUpperCase();
    };

    // Alignment: 2=bottom-center, 5=middle-center, 8=top-center
    let assAlignment = 2;
    if (position === "top") assAlignment = 8;
    else if (position === "center") assAlignment = 5;

    // Horizontal alignment: left=1/4/7, center=2/5/8, right=3/6/9
    if (alignment === "left") assAlignment -= 1;
    else if (alignment === "right") assAlignment += 1;

    const bold = fontWeight >= 600 ? -1 : 0;
    const italic = fontStyle === "italic" ? -1 : 0;

    // BorderStyle: 1=outline+shadow, 3=opaque background box
    const borderStyle = bgColor ? 3 : 1;
    const outline = bgColor ? 0 : borderWidth;
    const shadowVal = shadow ? Math.max(1, Math.round(shadowBlur)) : 0;

    // BackColour: background box (BorderStyle 3) or shadow color (BorderStyle 1)
    const backColour = bgColor
      ? toAssColor(bgColor, bgAlpha)
      : toAssColor(shadow ? shadowColor : "#000000", 0.5);

    // Spacing = letterSpacing in ASS
    const spacing = letterSpacing || 0;

    capStyle = {
      fontName,
      fontSize,
      textColor,
      borderColor,
      highlightColor,
      alignment: assAlignment,
      bold,
      italic,
      borderStyle,
      outline,
      shadowVal,
      backColour,
      spacing,
      marginV,
      textTransform,
      wordMode,
      animation,
    };
  }

  // Format time as H:MM:SS.cc (ASS centisecond resolution)
  function assFmtTime(sec) {
    const clamped = Math.max(0, sec);
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = Math.floor(clamped % 60);
    const cs = Math.round((clamped % 1) * 100);
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }

  // Convert hex #RRGGBB to ASS &HAABBGGRR.
  function toAssLocal(hex, alpha = 1) {
    const h = (hex || "#FFFFFF").replace(/^#/, "");
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    const assAlpha = Math.round((1 - alpha) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
    return `&H${assAlpha}${b}${g}${r}`.toUpperCase();
  }

  // Build ASS animation tags for a single word. Mirrors
  // assWordAnimationTags() in src/lib/merger/captionAnimations.ts so the
  // burned-in export visually matches the preview.
  //
  // ASS animation fundamentals:
  //   - All tags inside ONE {} block apply as a group at the start of
  //     the line. A second \move or \t in the same block silently
  //     overrides the first.
  //   - For multi-stage animation, emit SEPARATE {} blocks per stage.
  //     libass reads them in order; each \t animates a single property
  //     over [t1,t2] within the line's start time.
  //   - \fad(t1,t2) and \move(x1,y1,x2,y2,t1,t2) are special — they
  //     can only appear ONCE per line. Multiple \fad calls overwrite.
  //   - For shake/jitter/wave we approximate the multi-stage motion
  //     with sequential \t blocks that animate \frx (rotation) or
  //     a single \move with the dominant end position. This is a
  //     faithful enough approximation that the export matches the
  //     canvas preview's spirit (motion = attention).
  function assAnimTags(animation, wordDurMs, ch) {
    if (!animation || animation === "none") return "";
    const chScale = ch / 1080;
    const POP_IN_MS = 220;
    const SLIDE_UP_MS = 280;
    const BOUNCE_IN_MS = 380;
    const REVEAL_MS = 320;
    const SHAKE_MS = 280;
    const TYPEWRITER_MS_PER_CHAR = 45;

    // Each entry is a complete {} override block, joined without
    // separators. libass treats consecutive {} blocks as sequential
    // override states.
    const blocks = [];

    switch (animation) {
      case "pop-in": {
        // Initial state: scaled to 40%, fully transparent. Then animate
        // to 115% (overshoot) at 70% of POP_IN_MS, then settle to 100%.
        blocks.push(`{\\fscx40\\fscy40\\alpha&HFF&}`);
        blocks.push(`{\\t(0,${Math.round(POP_IN_MS * 0.7)},\\fscx115\\fscy115\\alpha&H00&)}`);
        blocks.push(`{\\t(${Math.round(POP_IN_MS * 0.7)},${POP_IN_MS},\\fscx100\\fscy100)}`);
        break;
      }
      case "slide-up": {
        const dy = Math.round(30 * chScale);
        // Single \move covers the whole slide; \fad adds the fade.
        blocks.push(`{\\move(0,${dy},0,0,0,${SLIDE_UP_MS})\\fad(${Math.round(SLIDE_UP_MS * 0.6)},0)}`);
        break;
      }
      case "bounce-in": {
        // Two-stage bounce via \t animating \org (origin) offset.
        // Stage 1: drop from -dy to 0 over 60% of duration.
        // Stage 2: tiny overshoot (3% of dy) and settle over remaining 40%.
        const dy = Math.round(25 * chScale);
        const overshoot = Math.max(1, Math.round(dy * 0.15));
        const t1 = Math.round(BOUNCE_IN_MS * 0.6);
        // \move handles the main drop. \fad handles the fade-in.
        // The overshoot is approximated with \t animating \fry by 1°
        // (a tiny visual nudge — full 2-stage \move isn't supported in
        // a single block).
        blocks.push(`{\\move(0,${-dy},0,0,0,${t1})\\fad(${Math.round(BOUNCE_IN_MS * 0.4)},0)\\t(${t1},${BOUNCE_IN_MS},\\fry${overshoot > 0 ? 1 : -1})}`);
        break;
      }
      case "scale-pulse": {
        // Two pulses via two sequential \t blocks.
        const half = Math.max(1, Math.round(wordDurMs / 2));
        blocks.push(`{\\t(0,${Math.round(half * 0.5)},\\fscx118\\fscy118)}`);
        blocks.push(`{\\t(${Math.round(half * 0.5)},${half},\\fscx100\\fscy100)}`);
        blocks.push(`{\\t(${half},${Math.round(half + (wordDurMs - half) * 0.5)},\\fscx118\\fscy118)}`);
        blocks.push(`{\\t(${Math.round(half + (wordDurMs - half) * 0.5)},${wordDurMs},\\fscx100\\fscy100)}`);
        break;
      }
      case "fade-through": {
        blocks.push(`{\\fad(150,150)}`);
        break;
      }
      case "typewriter": {
        // Approximate per-character reveal with a slow fade.
        blocks.push(`{\\fad(${TYPEWRITER_MS_PER_CHAR * 6},0)}`);
        break;
      }
      case "reveal": {
        // Animate a clip rect from 0 width to full width.
        blocks.push(`{\\clip(0,0,0,${ch})\\fad(${Math.round(REVEAL_MS * 0.5)},0)\\t(0,${REVEAL_MS},\\clip(0,0,2000,${ch}))}`);
        break;
      }
      case "wave": {
        // Approximate sine wave with two-stage \t animating \fry
        // (small rotation) — gives a gentle rocking that reads as
        // "wave" without the multi-\move conflict.
        const amp = Math.max(1, Math.round(6 * chScale));
        const q = Math.max(50, Math.round(wordDurMs / 4));
        blocks.push(`{\\t(0,${q},\\fry${amp})}`);
        blocks.push(`{\\t(${q},${q * 2},\\fry${-amp})}`);
        blocks.push(`{\\t(${q * 2},${q * 3},\\fry${amp})}`);
        blocks.push(`{\\t(${q * 3},${wordDurMs},\\fry0)}`);
        break;
      }
      case "jitter": {
        // Multi-stage jitter via sequential \t blocks animating \frx
        // (rotation x) and \fry (rotation y) — small angles read as
        // jitter without breaking ASS's single-\move rule.
        const amp = 2; // degrees — small but visible
        const steps = Math.min(6, Math.max(3, Math.round(wordDurMs / 80)));
        const stepMs = Math.max(40, Math.round(wordDurMs / steps));
        for (let i = 0; i < steps; i++) {
          const t1 = i * stepMs;
          const t2 = (i + 1) * stepMs;
          const rx = (i % 2 === 0 ? amp : -amp);
          const ry = (i % 3 === 0 ? amp : -amp);
          blocks.push(`{\\t(${t1},${t2},\\frx${rx}\\fry${ry})}`);
        }
        // Final reset to 0 so the word settles.
        blocks.push(`{\\t(${steps * stepMs},${wordDurMs},\\frx0\\fry0)}`);
        break;
      }
      case "shake": {
        // Strong horizontal shake via sequential \frx rotation,
        // decaying amplitude. This reads as a punchy shake.
        const amp = 4; // degrees
        const steps = 5;
        const stepMs = Math.round(SHAKE_MS / steps);
        for (let i = 0; i < steps; i++) {
          const t1 = i * stepMs;
          const t2 = (i + 1) * stepMs;
          const decay = 1 - i / steps;
          const rx = (i % 2 === 0 ? 1 : -1) * Math.max(1, Math.round(amp * decay));
          blocks.push(`{\\t(${t1},${t2},\\frx${rx})}`);
        }
        // Reset after shake completes.
        blocks.push(`{\\t(${SHAKE_MS},${Math.max(SHAKE_MS + 50, wordDurMs)},\\frx0)}`);
        break;
      }
      case "drift": {
        // Single \move upward — works because there's only one move.
        const dy = Math.round(-8 * chScale);
        blocks.push(`{\\move(0,0,0,${dy},0,${wordDurMs})}`);
        break;
      }
      default:
        return "";
    }
    return blocks.length ? blocks.join("") : "";
  }

  // Build the ASS file for a single segment, with cue times SHIFTED to
  // be relative to that segment's clip-time (0 .. segDurSec). Only
  // cues whose absolute [startMs, endMs] overlap the segment's absolute
  // [startMs, endMs] are included; their times are clamped to [0, dur].
  //
  // Word-by-word support:
  //   - wordMode "off": standard Dialogue line per cue (full text).
  //   - wordMode "word": single Dialogue line spanning the cue with \k
  //     karaoke tags. PrimaryColour=highlight, SecondaryColour=text so
  //     libass highlights the active word.
  //   - wordMode "word-only": one Dialogue line per word, each showing
  //     only that single word.
  //
  // Kinetic typography animation (animation != "none"):
  //   Each word gets assAnimTags() prepended (ASS \t / \move / \fad
  //   transform tags) so the burned-in export matches the canvas
  //   preview. For "word-only" mode the tags go on each per-word line;
  //   for "word" mode they go inside each \k block; for "off" mode they
  //   go at the start of the cue's single Dialogue line.
  //
  // Returns the path to the written .ass file, or null if no cues apply.
  function writeSegmentAss(segIndex, segStartMs, segEndMs, segDurMs) {
    if (!capStyle) return null;

    const style = capStyle;
    // For "word" karaoke mode we swap PrimaryColour and SecondaryColour
    // so libass renders the active word in the highlight color and the
    // inactive words in the preset's textColor.
    const primary = style.highlightColor || style.textColor;
    const secondary = style.textColor;

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
    assLines.push(`Style: Default,${style.fontName},${style.fontSize},${toAssLocal(primary)},${toAssLocal(secondary)},${toAssLocal(style.borderColor)},${style.backColour},${style.bold},${style.italic},0,0,100,100,${style.spacing},0,${style.borderStyle},${style.outline},${style.shadowVal},${style.alignment},40,40,${style.marginV},1`);
    assLines.push("");
    assLines.push("[Events]");
    assLines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");

    // Apply text transform consistently for export parity with preview.
    const transform = (s) => {
      if (style.textTransform === "uppercase") return s.toUpperCase();
      if (style.textTransform === "lowercase") return s.toLowerCase();
      return s;
    };

    // Escape user text for ASS so { } \ and stray ASS tags don't break
    // the Dialogue line. Per-word text (already split by whitespace) is
    // also escaped via this helper.
    const escapeAssText = (s) => {
      if (!s) return "";
      // Backslash first (so we don't double-escape what we add).
      let out = s.replace(/\\/g, "\\\\");
      // Curly braces → escape so libass treats them as literal chars
      // instead of override-block delimiters.
      out = out.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
      // Newlines → ASS hard line break \N (after backslash escape this
      // becomes \\N which is what libass expects).
      out = out.replace(/\n/g, "\\N");
      return out;
    };

    let emitted = 0;
    for (const cue of subtitleCues) {
      // Skip cues that do not overlap this segment's absolute window.
      if (cue.endMs <= segStartMs || cue.startMs >= segEndMs) continue;

      const relStartMs = Math.max(0, cue.startMs - segStartMs);
      const relEndMs = Math.min(segDurMs, cue.endMs - segStartMs);
      if (relEndMs <= relStartMs) continue;

      const hasWords = Array.isArray(cue.words) && cue.words.length > 0;

      // ── Word-only mode: one Dialogue line per word ──
      if (style.wordMode === "word-only" && hasWords) {
        for (const w of cue.words) {
          if (w.endMs <= segStartMs || w.startMs >= segEndMs) continue;
          const wStart = Math.max(0, w.startMs - segStartMs);
          const wEnd = Math.min(segDurMs, w.endMs - segStartMs);
          if (wEnd <= wStart) continue;
          const wt = escapeAssText(transform(w.text || ""));
          if (!wt) continue;
          const animTags = assAnimTags(style.animation, wEnd - wStart, height);
          assLines.push(`Dialogue: 0,${assFmtTime(wStart / 1000)},${assFmtTime(wEnd / 1000)},Default,,0,0,0,,${animTags}${wt}`);
          emitted++;
        }
        continue;
      }

      // ── Word (karaoke highlight) mode: one Dialogue line with \k tags ──
      if (style.wordMode === "word" && hasWords) {
        const parts = [];
        for (const w of cue.words) {
          if (w.endMs <= segStartMs || w.startMs >= segEndMs) continue;
          const wStart = Math.max(0, w.startMs - segStartMs);
          const wEnd = Math.min(segDurMs, w.endMs - segStartMs);
          const wDurCs = Math.max(1, Math.round((wEnd - wStart) / 10));
          const wt = escapeAssText(transform(w.text || ""));
          if (!wt) continue;
          const animTags = assAnimTags(style.animation, wEnd - wStart, height);
          parts.push(`${animTags}{\\k${wDurCs}}${wt}`);
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
      const assText = text; // escapeAssText already converted \n → \\N
      const animTags = assAnimTags(style.animation, relEndMs - relStartMs, height);
      assLines.push(`Dialogue: 0,${assFmtTime(relStartMs / 1000)},${assFmtTime(relEndMs / 1000)},Default,,0,0,0,,${animTags}${assText}`);
      emitted++;
    }

    if (emitted === 0) return null;

    const assPath = path.join(tempDir, `captions_${String(segIndex).padStart(4, "0")}_${Date.now()}.ass`);
    fs.writeFileSync(assPath, assLines.join("\n"), "utf-8");
    return assPath;
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

      // Use the segment's absolute master-timeline window when present
      // (sent by the renderer as seg.startMs / seg.endMs). Fall back to
      // the cumulative sequential cursor for older callers that don't
      // send absolute times — in that case cue mapping still works for
      // contiguous sequential timelines.
      const segStartMs = (typeof seg.startMs === "number") ? seg.startMs : cumulativeMs;
      const segEndMs = (typeof seg.endMs === "number") ? seg.endMs : (cumulativeMs + seg.durationMs);

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

      // Build -vf: scale(1.1x) + crop + zoompan + format + subtitles
      const scaleW = Math.round(width * 1.1);
      const scaleH = Math.round(height * 1.1);
      let vfParts = [
        `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase`,
        `crop=${scaleW}:${scaleH}`,
        `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps}`,
        `setsar=1`,
        `format=yuv420p`,
      ];

      // Add subtitles filter for captions (per-segment ASS file with
      // cues shifted to be relative to this clip's 0-based timeline,
      // per-word \k karaoke tags when wordMode is enabled, and per-word
      // \t animation tags when an animation is enabled).
      if (captionsEnabled) {
        const segAssPath = writeSegmentAss(i, segStartMs, segEndMs, seg.durationMs);
        if (segAssPath) {
          tempFiles.push(segAssPath);
          // Escape the ASS file path for FFmpeg's subtitles filter.
          // Cross-platform safety:
          //   1. backslashes → forward slashes (libass prefers forward
          //      slashes on Windows; FFmpeg normalizes them)
          //   2. colons escaped to \: (Windows drive letters like C:)
          //   3. single quotes escaped to \' (filter syntax)
          //   4. commas escaped to \, (filter argument separator)
          const escapedAssPath = segAssPath
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
      cumulativeMs += seg.durationMs;
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
