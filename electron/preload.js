// electron/preload.js — contextBridge IPC surface for the renderer.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: () => ipcRenderer.invoke("is-electron"),

  // v1.12.1: the REAL running-exe facts (app.getVersion() reads the
  // rcedit-stamped version resource) — the honest "am I on the new build?"
  // check + the CPU count that decides the parallel-pool width.
  // { version, electron, node, platform, cpus }
  appInfo: () => ipcRenderer.invoke("app-info"),

  // Diagnostics — verify FFmpeg is reachable. Returns
  // { ok, path, version, error }.
  ffmpegStatus: () => ipcRenderer.invoke("ffmpeg-status"),

  // v5.1: result of the async GPU-encoder probe (for the export badge).
  // { encoder: "NVIDIA NVENC" | "Intel QSV" | "AMD AMF" | "CPU (libx264)",
  //   encoderName: "h264_nvenc" | … | "libx264", forced: boolean,
  //   tier: "TIER_1_GPU" | "TIER_2_MODERN_CPU" | "TIER_3_CONSTRAINED_CPU",
  //   tierLabel, workers, threadsPerWorker, cpuCount, cpuModel,
  //   optimizeSubtitles } — v1.13: the Adaptive Hardware Matrix facts.
  getExportInfo: () => ipcRenderer.invoke("export-info"),

  // v8.1: force-encoder probe bypass (diagnostics). key ∈
  // {null,"nvenc","qsv","amf","x264"} → { ok, forced, encoder, encoderName }.
  setForceEncoder: (key) => ipcRenderer.invoke("export:set-force-encoder", key),

  exportNative: (opts) => ipcRenderer.invoke("export-native", opts),

  // v1.15.1 GPU-Shift: the WebCodecs export streamer bridge — muxed bytes
  // stream to disk in ~5 MB chunks (ChunkSink's append-only contract).
  // start/end are invoke() (the export must not proceed before the sink is
  // open / the file is fully flushed+closed); chunks are ordered
  // fire-and-forget send() — Chromium IPC preserves per-renderer message
  // order, and the sink's sequential-position guard fails loud on any
  // reordering, so no per-chunk round-trip is needed.
  exportStart: (filePath) => ipcRenderer.invoke("gpu-export-start", filePath),
  exportChunk: (buffer) => ipcRenderer.send("gpu-export-chunk", buffer),
  exportEnd: () => ipcRenderer.invoke("gpu-export-end"),

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
  //     lastError, childAlive, activeRuns, groq, fwAvailable }.
  whisperStatus: () => ipcRenderer.invoke("whisper:status"),
  // v1.15 GROQ WHISPER API — the user's own key, stored ONLY on this device
  // (userData/groq.json). The bridge NEVER returns the raw key — only a
  // masked form. { hasKey, maskedKey, model, models, fwAvailable }.
  whisperGroqGet: () => ipcRenderer.invoke("whisper:groq-get"),
  // { apiKey?: string ("" clears), model?: string } → same payload as get.
  whisperGroqSet: (p) => ipcRenderer.invoke("whisper:groq-set", p),
  // { apiKey?: string } → { ok, message, whisperModels } — validates the
  // candidate (or the saved key) against GET /openai/v1/models.
  whisperGroqTest: (p) => ipcRenderer.invoke("whisper:groq-test", p),
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

  // ── v1.15.2 REAL-HARDWARE A/B EXPORT BENCH (scripts/ab-export-bench.js) ──
  // main → renderer: the bench payload (fixture media bytes + config) once
  // the page is up. renderer → main: the results JSON (main writes it to
  // disk and quits). Only present in bench-mode runs; the renderer listener
  // (src/lib/merger/benchExport.ts) no-ops without these channels.
  onBenchRun: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("bench:run", handler);
    return () => ipcRenderer.removeListener("bench:run", handler);
  },
  benchResult: (payload) => ipcRenderer.invoke("bench:result", payload),
});
