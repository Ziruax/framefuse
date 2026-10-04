/**
 * v1.26 DUB STUDIO verification stub: drives the staged dubbing workflow
 * (dubTranscribe → dubScript → dubStart(scriptLines)) with recorded payloads.
 * The 3-b surfaces (TTS Studio, Script Writer, voice catalog) are kept. The 6-d dub
 * surface is kept so the whole Dubbing tab (Voiceover + Script Writer +
 * Translate & Dub) mounts exactly like the desktop app; the scriptwriter
 * surface (scriptModels / geminiGet / geminiSet / scriptGenerate) is added,
 * and scriptGenerate RECORDS its payload on window.__scriptGenPayload so the
 * E2E can assert the EXACT language string the renderer routes for the QWERTY
 * variants. Every other `typeof api?.x === "function"` gate stays closed
 * exactly like a browser session, so the studio mounts through the same
 * paths.
 */
(function () {
  var unsub = function () { return function () {}; };
  var HINGLISH_SCRIPT =
    "kya haal hai dosto, aaj hum ek aisi app dekhenge jo bina editing " +
    "ke reels bana deti hai. [pause] BAS teen photos daalo, gaana chuno, " +
    "aur EXPORT dabao. Seriously — itna SIMPLE kabhi nahi dekha hoga.";
  var URDU_SCRIPT =
    "kya haal hai dost, aaj hum ek aisi app dekhenge jo bina editing ke " +
    "reels bana deti hai. [pause] BAS teen photos daalo, gaana chuno, aur " +
    "EXPORT dabao.";
  window.electronAPI = {
    // v1.26: uploaded Files resolve as REAL local paths (nativeSourcePath)
    getFilePath: function (f) {
      return (f && f.name && f.name.indexOf("/") === -1) ? "/tmp/dubstudio-src-" + f.name : null;
    },
    // menu + progress subscriptions (mount path of page.tsx)
    onMenu: unsub,
    onDubProgress: unsub,
    onExportProgress: onTtsProgressStub,
    // engine diagnostics gate (EngineDiagnosticsCard probe — returns a
    // loaded native engine so the export tab renders its ok state)
    engineStatus: function () {
      return Promise.resolve({
        loaded: true, binaryPath: "/opt/framefuse/engine", version: "0.4.1",
      });
    },
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
          { shortName: "ur-PK-UzmaNeural", gender: "Female", locale: "ur-PK", friendlyName: "Uzma", displayName: "Uzma · Urdu (Pakistan)" },
          { shortName: "ur-PK-AsadNeural", gender: "Male", locale: "ur-PK", friendlyName: "Asad", displayName: "Asad · Urdu (Pakistan)" },
        ],
        pairs: {
          "hi-IN": { female: "hi-IN-SwaraNeural", male: "hi-IN-MadhurNeural" },
          "ur-PK": { female: "ur-PK-UzmaNeural", male: "ur-PK-AsadNeural" },
        },
      });
    },
    ttsPreview: function () {
      return Promise.resolve({ bytes: new ArrayBuffer(8), bytesLen: 8 });
    },
    ttsSynthesize: function () {
      return Promise.reject(new Error("stub — TTS disabled in this harness"));
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
    dubStart: function (p) {
      window.__dubStartPayload = p || {};
      if (p && Array.isArray(p.scriptLines) && p.scriptLines.length > 0) {
        // STAGE 4 (script dub): honor the edited lines verbatim.
        var bytes = new ArrayBuffer(1024);
        return Promise.resolve({
          language: p.scriptLanguage || "hi",
          speakers: [
            { id: 0, voice: "hi-IN-SwaraNeural", gender: "female" },
            { id: 1, voice: "hi-IN-MadhurNeural", gender: "male" },
          ],
          segments: p.scriptLines.map(function (l, i) {
            return {
              startMs: l.startMs, endMs: l.endMs, speaker: l.speaker,
              sourceText: l.sourceText, translatedText: l.translatedText,
              wavPath: "/tmp/dub-stub-" + i + ".wav", ttsDurMs: 900, speedApplied: 1,
              bytes: bytes,
            };
          }),
          wavPaths: p.scriptLines.map(function (_, i) { return "/tmp/dub-stub-" + i + ".wav"; }),
          totalDurationMs: 5000, warnings: [], dubDir: "/tmp/dub-stub",
        });
      }
      return Promise.reject(new Error("stub — one-shot dubbing disabled; use the Dub Studio stages"));
    },
    dubCancel: function () {
      return Promise.resolve({ ok: false, running: false });
    },
    // ── v1.26 Dub Studio staged surface (under test) ─────────────────────
    dubTranscribe: function (p) {
      window.__dubTranscribePayload = p || {};
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({
            language: "en",
            totalMs: 4800,
            wordCount: 8,
            utterances: [
              {
                startMs: 200, endMs: 2700, text: "hello world this is a test of",
                words: [
                  { text: "hello", startMs: 200, endMs: 500 },
                  { text: "world", startMs: 600, endMs: 900 },
                  { text: "this", startMs: 1000, endMs: 1200 },
                  { text: "is", startMs: 1300, endMs: 1500 },
                  { text: "a", startMs: 1600, endMs: 1700 },
                  { text: "test", startMs: 1800, endMs: 2200 },
                  { text: "of", startMs: 2500, endMs: 2700 },
                ],
              },
              {
                startMs: 4400, endMs: 4800, text: "dubbing",
                words: [{ text: "dubbing", startMs: 4400, endMs: 4800 }],
              },
            ],
          });
        }, 400);
      });
    },
    dubScript: function (p) {
      window.__dubScriptPayload = p || {};
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({
            targetLanguage: (p && p.targetLanguage) || "hi",
            targetLanguageName: "Hindi",
            speakerCount: 2,
            lines: [
              { i: 0, startMs: 200, endMs: 2700, speaker: 0, sourceText: "hello world this is a test of", translatedText: "नमस्ते दुनिया यह एक परीक्षण है" },
              { i: 1, startMs: 4400, endMs: 4800, speaker: 1, sourceText: "dubbing", translatedText: "डबिंग का" },
            ],
            warnings: [],
          });
        }, 400);
      });
    },
    // ── Script Writer surface (the surface under test) ───────────────────
    scriptModels: function () {
      return Promise.resolve({
        gemini: {
          hasKey: true,
          models: [
            { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
            { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
          ],
        },
        groq: {
          hasKey: true,
          models: [{ id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile" }],
        },
      });
    },
    geminiGet: function () {
      return Promise.resolve({ hasKey: true, maskedKey: "AIzaTEST…1234" });
    },
    geminiSet: function () {
      return Promise.resolve({ hasKey: true, maskedKey: "AIzaTEST…1234" });
    },
    geminiTest: function () {
      return Promise.resolve({
        ok: true,
        message: "stub — key check disabled in this harness",
        models: [{ id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" }],
      });
    },
    geminiClear: function () {
      return Promise.resolve({ hasKey: false, maskedKey: "" });
    },
    // ── TTS Studio surface (long-run golden path) ──────────────────────
    onTtsProgress: function (cb) { window.__ttsProgressCb = cb; return function () { window.__ttsProgressCb = null; }; },
    ttsSynthesizeLong: function (p) {
      return new Promise(function (resolve, reject) {
        var i = 0, n = 3, total = (p.text || "").length, cancelled = false;
        var t = setInterval(function () {
          if (cancelled) return;
          i += 1;
          if (window.__ttsProgressCb) window.__ttsProgressCb({ runId: p.runId, phase: "synth", chunkIndex: i, chunkCount: n, charsDone: Math.min(total, Math.round(total * i / n)), totalChars: total, status: "synthesizing" });
          if (i >= n) {
            clearInterval(t);
            var words = (p.text || "").split(/\s+/).filter(Boolean).map(function (w, k) {
              return { text: w.replace(/[^\p{L}\p{N}]/gu, ""), offsetMs: k * 420, durationMs: 380 };
            });
            setTimeout(function () {
              if (cancelled) return;
              if (window.__ttsProgressCb) window.__ttsProgressCb({ runId: p.runId, phase: "done", status: "complete", durationMs: words.length * 420 });
              resolve({ filePath: "/tmp/tts-stub.mp3", fileName: "tts-stub.mp3", bytesLen: 24694, durationMs: words.length * 420, chunkCount: n, words: words });
            }, 250);
          }
        }, 200);
        window.__ttsCancelLong = function () { cancelled = true; clearInterval(t); reject(new Error("Edge TTS synthesis cancelled")); };
      });
    },
    ttsCancelLong: function (runId) { if (window.__ttsCancelLong) window.__ttsCancelLong(); return Promise.resolve({ ok: true, running: false }); },
    ttsReadAudio: function () {
      var b64 = "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AAAlHnC7CmHNAggTDyX6EdugAAwpJfKiRWC7AhltQbo+TEFNRTMuMTAwqqqqqv/7EMTqAMKMG2nGPSYgTIOuOJYYHKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqtogybAAAAAAJh0+EdlIm9FjT8i/L+BHbwAAEQOmAvgVAUbEAsKzRF9MQU1FMy4xMDBVVVVV//sQxOoAwpQba8S1giBMg654lbAMVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVXaIMmwAAAAACUTGQlom6a2XhSSr0n4EdvAAAQg8YiyRaAtgQyeoN0fKkxBTUUzLjEwMKqqqqr/+xDE6YDCiBtrxLWCIEsDrnj2GFSqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqraAMnAAAAAACYSmgjoEB3AZleAppfwI2+AAA6IKENcC4ARMKEjbBjaTEFNRTMuMTAwqqqqqv/7EMTqAMKMG2vEvSBgS4OuePYYVKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqskQuKAAAAAAJRM4o6o/xt4MCpChNfgR2+AABIYMRZItAmwIZ+oPzfpMQU1FMy4xMDCqqqqq//sQxOmAwnwba8S1IiBJg654xaRMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqskAqKAAAAAAJhKaEvgcG/A2RpFVfwIu+AAA44RfDIwYQcCEGQpFY4KjdUxBTUUzLjEwMFVVVVX/+xDE6YDCfBtrxLUiIEyDrnj1sERVVVVVVVVVVVVVVVUgkAqICHB2BmC4AAAAAAACBS0zIUxddKKQ+y2VY4pN0gCkpd/i5nXCT3879+rq0/+/fcKCS/3axFRVTEFNRTMuMTAwVVVVVf/7EMTqAMKUG2vEpeAgTQOueJWwDFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxOqAwpwba8Sl4CBNA654lbAMVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE6gDCmBtrxKWCYEsDrnjFpExVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMTqAMKcG2fEvYBgS4OuuIWwDFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxOsAwogbZ8SxImBUg646ngAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE8wAHME9r+YeSCAAANIOAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==";
      var bin = atob(b64); var buf = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
      return Promise.resolve({ bytes: buf.buffer, bytesLen: buf.length });
    },
    scriptGenerate: function (payload) {
      // Record the exact payload the renderer routed (E2E asserts language).
      window.__scriptGenPayload = payload;
      var lang = (payload && payload.language) || "";
      var isUrdu = /Roman Urdu|Nastaliq/.test(lang) || lang === "Urdu";
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({
            ok: true,
            model: payload && payload.model,
            provider: payload && payload.provider,
            text: isUrdu ? URDU_SCRIPT : HINGLISH_SCRIPT,
          });
        }, 350);
      });
    },
  };
  function onTtsProgressStub() { return function () {}; }
})();
