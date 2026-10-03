/**
 * v1.22 UI verification stub: window.electronAPI with the DUB-GEMINI +
 * ENGINE-DIAGNOSTICS surfaces. Injected before hydration by stub-proxy.js.
 * The engine self-test is stubbed HEALTHY (rust-gpu) so the Export tab's
 * Engine diagnostics card can be verified in a plain browser.
 */
(function () {
  var unsub = function () { return function () {}; };
  window.electronAPI = {
    onMenu: unsub,
    onDubProgress: unsub,
    onExportProgress: unsub,
    ffmpegStatus: function () {
      return Promise.resolve({ ok: true, path: "/usr/bin/ffmpeg" });
    },
    whisperGroqGet: function () {
      return Promise.resolve({ hasKey: true, maskedKey: "gsk_TEST…1234" });
    },
    ttsVoices: function () {
      return Promise.resolve({
        voices: [
          { shortName: "hi-IN-SwaraNeural", gender: "Female", locale: "hi-IN", friendlyName: "Swara", displayName: "Swara · Hindi (India)" },
          { shortName: "hi-IN-MadhurNeural", gender: "Male", locale: "hi-IN", friendlyName: "Madhur", displayName: "Madhur · Hindi (India)" },
        ],
        pairs: { "hi-IN": { female: "hi-IN-SwaraNeural", male: "hi-IN-MadhurNeural" } },
      });
    },
    ttsPreview: function () {
      return Promise.resolve({ bytes: new ArrayBuffer(8), bytesLen: 8 });
    },
    // v1.22: dubModels carries the GEMINI provider block.
    dubModels: function () {
      return Promise.resolve({
        models: [
          { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", hint: "default" },
          { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", hint: "fastest" },
        ],
        default: "llama-3.3-70b-versatile",
        langNames: { hi: "Hindi", en: "English", es: "Spanish", ur: "Urdu" },
        gemini: {
          models: [
            { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", hint: "default — fastest" },
            { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "balanced" },
            { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "stable fallback" },
          ],
          default: "gemini-3.5-flash-lite",
          hasKey: true,
        },
      });
    },
    dubStart: function (p) {
      // Record the invocation so the harness can assert the v1.22 payload
      // (textProvider + geminiModel thread-through).
      window.__lastDubStart = p;
      return Promise.reject(new Error("stub — dubbing disabled in this harness"));
    },
    dubCancel: function () {
      return Promise.resolve({ ok: false, running: false });
    },
    // v1.22: engine diagnostics surface (healthy engine stub).
    engineStatus: function () {
      return Promise.resolve({
        loaded: true,
        version: "0.2.0",
        binary: "framefuse-engine.win32-x64.node",
        from: "C:\\Program Files\\FrameFuse\\resources\\app.asar.unpacked\\rust-engine\\framefuse-engine.win32-x64.node",
        error: null,
        lastFailure: null,
      });
    },
    engineSelfTest: function () {
      return Promise.resolve({
        ok: true,
        engineUsed: "rust-gpu",
        encoderName: "libx264",
        adapter: "Microsoft Basic Render Driver",
        frames: 36,
        wallMs: 542,
      });
    },
  };
})();
