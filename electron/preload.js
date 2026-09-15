// electron/preload.js — contextBridge IPC surface for the renderer.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: () => ipcRenderer.invoke("is-electron"),

  // Diagnostics — verify FFmpeg is reachable. Returns
  // { ok, path, version, error }.
  ffmpegStatus: () => ipcRenderer.invoke("ffmpeg-status"),

  // v5.1: result of the async GPU-encoder probe (for the export badge).
  // { encoder: "NVIDIA NVENC" | "Intel QSV" | "AMD AMF" | "CPU (libx264)",
  //   encoderName: "h264_nvenc" | … | "libx264", forced: boolean }
  getExportInfo: () => ipcRenderer.invoke("export-info"),

  // v8.1: GPU acceleration status (in-app Task Manager check).
  // { ok, featureStatus: {gpu_compositing, webgl, rasterization, …},
  //   adapters: [{vendor, device, driver}], switches, platform }
  getGpuStatus: () => ipcRenderer.invoke("gpu-status"),

  // v8.1: force-encoder probe bypass (diagnostics). key ∈
  // {null,"nvenc","qsv","amf","x264"} → { ok, forced, encoder, encoderName }.
  setForceEncoder: (key) => ipcRenderer.invoke("export:set-force-encoder", key),

  exportNative: (opts) => ipcRenderer.invoke("export-native", opts),

  saveTempImage: (payload) => ipcRenderer.invoke("save-temp-image", payload),
  saveTempAudio: (payload) => ipcRenderer.invoke("save-temp-audio", payload),
  // v5.0: video sources for the multi-track timeline (same IPC pattern as
  // saveTempAudio — bytes land in a temp file, the path comes back).
  saveTempVideo: (payload) => ipcRenderer.invoke("save-temp-video", payload),
  saveTempSrt: (payload) => ipcRenderer.invoke("save-temp-srt", payload),

  chooseOutput: () => ipcRenderer.invoke("choose-output"),

  cleanupTemp: () => ipcRenderer.invoke("cleanup-temp"),

  cancelExport: () => ipcRenderer.invoke("cancel-export"),

  // ── v5.1 NATIVE WHISPER (utilityProcess service) ──────────────────────────
  // transcribe: ({ name, bytes: ArrayBuffer, language, runId? }) →
  //   { chunks, language, wordLevel, durationMs } — the main process decodes
  //   the audio with ffmpeg and runs Whisper in a utility process; the UI
  //   never blocks. Progress arrives via onWhisperProgress. `runId` (v5.2) is
  //   the renderer's client run id (crypto.randomUUID) used for per-run
  //   cancellation.
  whisperTranscribe: (payload) => ipcRenderer.invoke("whisper:transcribe", payload),
  whisperPreload: () => ipcRenderer.invoke("whisper:preload"),
  // v1.3.1: pre-download a faster-whisper model (tiny/base/small/medium).
  whisperFwPreload: (p) => ipcRenderer.invoke("whisper:fw-preload", p),
  // v5.2: cancel ALL runs (legacy, no argument) or exactly ONE run
  // ({ runId }) — returns the number of runs rejected.
  whisperCancel: (payload) => ipcRenderer.invoke("whisper:cancel", payload),
  // v5.2: model cache diagnostics for the Captions settings panel →
  //   { cacheDir, hostUsed, modelReady, cacheFiles, totalCacheBytes,
  //     lastError, childAlive, activeRuns }.
  whisperStatus: () => ipcRenderer.invoke("whisper:status"),
  onWhisperProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("whisper:progress", handler);
    return () => ipcRenderer.removeListener("whisper:progress", handler);
  },

  // ── v5.1 NATIVE PROJECT FILES ─────────────────────────────────────────────
  // saveProject: ({ doc, currentPath? }) → { path, name } | null (canceled)
  saveProject: (payload) => ipcRenderer.invoke("project:save", payload),
  saveProjectAs: (payload) => ipcRenderer.invoke("project:save-as", payload),
  // openProject: () → { path, name, doc } | null (canceled) — doc is the parsed
  // .framefuse.json document; the renderer restores it with its own loader.
  openProject: () => ipcRenderer.invoke("project:open"),
  recentProjects: () => ipcRenderer.invoke("project:recent"),
  removeRecentProject: (payload) => ipcRenderer.invoke("project:remove-recent", payload),

  // v5.1: absolute filesystem path of a picked File (Electron ≥ 32 removed
  // File.path — webUtils.getPathForFile is the supported bridge).
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch (_) {
      return null;
    }
  },

  // v4.1: export the full-timeline ASS subtitle sidecar.
  exportAssFile: (opts) => ipcRenderer.invoke("export-ass-file", opts),

  // v8 GPU export streamer — WebCodecs renderer pipeline → disk (5 MB chunks).
  // exportStart(filePath) truncates/creates the output file (mkdir -p parent),
  // exportChunk(buffer) appends bytes, exportEnd() closes the handle. The
  // muxed MP4 never has to fit in renderer RAM.
  exportStart: (filePath) => ipcRenderer.send("export-start", filePath),
  exportChunk: (buffer) => ipcRenderer.send("export-chunk", buffer),
  exportEnd: () => ipcRenderer.send("export-end"),

  onExportProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("export-progress", handler);
    return () => ipcRenderer.removeListener("export-progress", handler);
  },

  // Menu accelerators forwarded from the main process.
  onMenu: (channel, callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
