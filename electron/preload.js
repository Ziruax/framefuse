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

  // ── v1.22 NATIVE ENGINE DIAGNOSTICS ────────────────────────────────────
  // engineStatus: () → { loaded, version, binary, from, error, lastFailure,
  //   diagnostics } — the load state + the LAST reason an export bypassed
  //   the Rust engine (gate / timeline / runtime).
  engineStatus: () => ipcRenderer.invoke("engine:status"),
  // engineSelfTest: () → { ok, engineUsed?, encoderName?, adapter?, error?,
  //   stage?, wallMs?, frames?, dllDir?, status } — runs a REAL 36-frame
  // mini export through the Rust engine in THIS runtime; the definitive
  // "is the engine healthy" check with the exact error when it is not.
  engineSelfTest: () => ipcRenderer.invoke("engine:selftest"),

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

  // ── v1.20 WHISPER (Groq Cloud — the ONLY transcription engine) ────────────
  // transcribe: ({ name, bytes: ArrayBuffer, language, runId? }) →
  //   { chunks, language, wordLevel, durationMs } — the main process extracts
  //   compact audio with ffmpeg and calls the Groq Whisper API; the UI never
  //   blocks. Progress arrives via onWhisperProgress. `runId` (v5.2) is the
  //   renderer's client run id (crypto.randomUUID) used for per-run
  //   cancellation. No key saved → a clear actionable error (no local engine
  //   fallback exists anymore).
  whisperTranscribe: (payload) => ipcRenderer.invoke("whisper:transcribe", payload),
  // v5.2: cancel ALL runs (legacy, no argument) or exactly ONE run
  // ({ runId }) — returns the number of runs rejected.
  whisperCancel: (payload) => ipcRenderer.invoke("whisper:cancel", payload),
  // v1.20: Groq engine config — { hasKey, maskedKey, model, models } (the
  //   local model-cache diagnostics are gone with the local engines).
  whisperStatus: () => ipcRenderer.invoke("whisper:status"),
  // v1.15 GROQ WHISPER API — the user's own key, stored ONLY on this device
  // (userData/groq.json). The bridge NEVER returns the raw key — only a
  // masked form. { hasKey, maskedKey, model, models }.
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

  // ── v1.17 VOICEOVER (Edge TTS) + TRANSLATE/DUB ────────────────────────────
  // ttsVoices: () → { voices: [{shortName, gender, locale, friendlyName,
  //   displayName}], pairs: { "hi-IN": { female, male }, … } } — the catalog
  //   is cached main-side (one network fetch per session, fallback catalog
  //   offline).
  ttsVoices: () => ipcRenderer.invoke("tts:voices"),
  // ttsPreview: ({ voice, text, style? }) → { bytes: ArrayBuffer, bytesLen }
  //   — a SHORT sample (≤300 chars), never written to disk. Single-flight
  //   main-side: starting a new preview cancels the previous one (voice
  //   browsing is rapid-fire).
  ttsPreview: (p) => ipcRenderer.invoke("tts:preview", p),
  // ttsSynthesize: ({ text, voice, ratePct, pitchHz, volumePct, style? }) →
  //   { filePath, bytes: ArrayBuffer(MP3), durationMs, words: [{ text,
  //   offsetMs, durationMs }] } — narration for the timeline voiceover
  //   lane (≤3000 chars; longer scripts → ttsSynthesizeLong).
  ttsSynthesize: (p) => ipcRenderer.invoke("tts:synthesize", p),
  // LONG-FORM TTS: ttsSynthesizeLong: ({ runId, text, voice, ratePct,
  //   pitchHz, volumePct, style }) → { filePath, fileName, bytesLen,
  //   durationMs, words, chunkCount } — scripts up to ~200 k words are
  //   chunked main-side (sentence boundaries, 3 in flight) and merged into
  //   ONE MP3; words carry GLOBAL timings. The merged bytes stay in the
  //   main process — fetch them for playback with ttsReadAudio(filePath).
  //   ONE long run at a time; progress arrives via onTtsProgress ({ runId,
  //   phase: "synth"|"probe"|"done", chunkIndex, chunkCount, charsDone,
  //   totalChars, status, durationMs }); cancel with ttsCancelLong(runId).
  ttsSynthesizeLong: (p) => ipcRenderer.invoke("tts:synthesize-long", p),
  // ttsCancelLong: (runId) → { ok, running } — aborts the active long run
  //   (no-op when none is running or the runId doesn't match the run).
  ttsCancelLong: (runId) => ipcRenderer.invoke("tts:cancel-long", { runId }),
  // ttsReadAudio: (filePath) → { bytes: ArrayBuffer } — reads an MP3 the
  //   main process wrote into its temp dir (path guarded against escapes,
  //   ≤200 MB) so the renderer can build a playback Blob.
  // v1.33.1 SHAPE FIX: callers pass BOTH forms — the renderer's typed
  // contract is ttsReadAudio({ filePath }) (src/lib/merger/types.ts +
  // speech-api.ts) while this wrapper historically took a bare string.
  // The double-wrap ({ filePath: { filePath } }) made the main process's
  // strict string check see "" and every desktop TTS-Studio Generate died
  // with "No audio file path given". Normalize BOTH shapes here so the
  // payload that crosses the IPC boundary is always { filePath: string }.
  ttsReadAudio: (p) => {
    const filePath =
      typeof p === "string"
        ? p
        : p && typeof p === "object" && typeof p.filePath === "string"
          ? p.filePath
          : "";
    return ipcRenderer.invoke("tts:read-audio", { filePath });
  },
  onTtsProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("tts:progress", handler);
    return () => ipcRenderer.removeListener("tts:progress", handler);
  },
  // dubStart: ({ segments, sourceLanguage, targetLanguage, targetLocale,
  //   groqModel, textProvider, geminiModel, femaleVoice, maleVoice,
  //   voiceMode, singleVoice }) → dub result (segments carry wav BYTES).
  //   voiceMode "single" + singleVoice = one Edge-TTS voice for every line
  //   (speaker detection skipped). v1.22: textProvider "gemini" + geminiModel
  //   routes the speaker/translation phases through the Gemini key (shared
  //   with the Script Writer); "groq" (default) uses groqModel. Whisper
  //   transcription is always Groq. Progress arrives via onDubProgress.
  //   Reuses the Captions-tab Groq key — there is no second key UI.
  dubStart: (p) => ipcRenderer.invoke("dub:start", p),
  // v1.26 Dub Studio stages (same dub:progress channel + dubCancel abort):
  // dubTranscribe: ({ segments, sourceLanguage }) → word-level transcript
  //   { language, totalMs, wordCount, utterances:[{…, words:[…]}] }.
  dubTranscribe: (p) => ipcRenderer.invoke("dub:transcribe", p),
  // dubScript: ({ utterances, targetLanguage, targetLocale, groqModel,
  //   textProvider, geminiModel, voiceMode, singleVoice }) → the editable
  //   dubbing script { lines, speakerCount, warnings }.
  dubScript: (p) => ipcRenderer.invoke("dub:script", p),
  // dubCancel: () → { ok, running } — aborts the active dub run.
  dubCancel: (p) => ipcRenderer.invoke("dub:cancel", p),
  // dubModels: () → { models, default, langNames, gemini: { models, default,
  //   hasKey } } — picker data, no key needed (v1.22: + the Gemini list).
  dubModels: () => ipcRenderer.invoke("dub:models"),
  onDubProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("dub:progress", handler);
    return () => ipcRenderer.removeListener("dub:progress", handler);
  },

  // ── v1.20 AI SCRIPT WRITING (Gemini default + Groq) ──────────────────────
  // geminiGet: () → { hasKey, maskedKey } — the key lives ONLY on this
  //   device (userData/gemini.json, 0600); the bridge NEVER returns the raw
  //   key, only the masked form.
  geminiGet: () => ipcRenderer.invoke("gemini:get"),
  // geminiSet: ({ apiKey }) → same masked payload — stores the key on-device.
  geminiSet: (p) => ipcRenderer.invoke("gemini:set", p),
  // geminiTest: ({ apiKey? }) → { ok, message, modelCount } — validates the
  //   candidate (or the saved key) against GET /v1beta/models.
  geminiTest: (p) => ipcRenderer.invoke("gemini:test", p),
  // geminiClear: () → { ok } — removes the stored key entirely.
  geminiClear: () => ipcRenderer.invoke("gemini:clear"),
  // scriptGenerate: ({ provider: "gemini"|"groq", model, prompt, tone?,
  //   durationSec?, language? }) → { ok: true, text, model, provider } |
  //   { ok: false, error } — never rejects with a user-facing failure; the
  //   renderer shows `error` inline.
  scriptGenerate: (p) => ipcRenderer.invoke("script:generate", p),
  // scriptModels: () → { gemini: { models, default, hasKey }, groq: { models,
  //   default, hasKey } } — the Script Writer model picker data.
  scriptModels: () => ipcRenderer.invoke("script:models"),

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
