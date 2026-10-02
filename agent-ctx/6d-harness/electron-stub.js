/**
 * The window.electronAPI stub injected before hydration (Task 6-d UI
 * verification). Only the dubbing-relevant surface is defined; every other
 * `typeof api?.x === "function"` gate stays closed exactly like a browser
 * session, so the studio mounts through the same paths.
 */
(function () {
  var unsub = function () { return function () {}; };
  window.electronAPI = {
    // menu + progress subscriptions (mount path of page.tsx)
    onMenu: unsub,
    onDubProgress: unsub,
    onExportProgress: unsub,
    ffmpegStatus: function () {
      return Promise.resolve({ ok: true, path: "/usr/bin/ffmpeg" });
    },
    whisperGroqGet: function () {
      return Promise.resolve({ hasKey: true, maskedKey: "gsk_TEST…1234" });
    },
    // the dub card's voice catalog (main process tts:voices shape)
    ttsVoices: function () {
      return Promise.resolve({
        voices: [
          { shortName: "hi-IN-SwaraNeural", gender: "Female", locale: "hi-IN", friendlyName: "Swara", displayName: "Swara · Hindi (India)" },
          { shortName: "hi-IN-MadhurNeural", gender: "Male", locale: "hi-IN", friendlyName: "Madhur", displayName: "Madhur · Hindi (India)" },
          { shortName: "hi-IN-NeerjaNeural", gender: "Female", locale: "hi-IN", friendlyName: "Neerja", displayName: "Neerja · Hindi (India)" },
          { shortName: "hi-IN-NeerjaMultilingualNeural", gender: "Female", locale: "hi-IN", friendlyName: "Neerja ML", displayName: "Neerja Multilingual · Hindi (India)" },
        ],
        pairs: { "hi-IN": { female: "hi-IN-SwaraNeural", male: "hi-IN-MadhurNeural" } },
      });
    },
    ttsPreview: function () {
      return Promise.resolve({ bytes: new ArrayBuffer(8), bytesLen: 8 });
    },
    dubModels: function () {
      return Promise.resolve({
        models: [
          { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", hint: "default" },
          { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", hint: "fastest" },
        ],
        default: "llama-3.3-70b-versatile",
        langNames: { hi: "Hindi", en: "English", es: "Spanish", ur: "Urdu" },
      });
    },
    dubStart: function () {
      return Promise.reject(new Error("stub — dubbing disabled in this harness"));
    },
    dubCancel: function () {
      return Promise.resolve({ ok: false, running: false });
    },
  };
})();
