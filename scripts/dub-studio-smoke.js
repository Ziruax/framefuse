// v1.26 Dub Studio staged-pipeline smoke test (node, no Electron).
// Stubs every external seam (_setDepsForTesting) and drives the REAL
// pipeline functions end to end on REAL ffmpeg-produced fixtures:
//   runDubTranscript → runDubScript → runDub(scriptLines)
// plus the legacy one-shot + single-voice paths for regression.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const DUB = require("../electron/dub-workflow.js");

const FFMPEG = require("ffmpeg-static");
const FFPROBE = "ffprobe"; // the sandbox ships a real one at /usr/bin/ffprobe
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dubstudio-"));
const SRC_WAV = path.join(TMP, "src.wav");
const TTS_MP3 = path.join(TMP, "tts.mp3");

function sh(file, args) {
  execFileSync(file, args, { stdio: "ignore" });
}

sh(FFMPEG, ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "16000", "-ac", "1", SRC_WAV]);
sh(FFMPEG, ["-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", TTS_MP3]);

// ── the stubs ──────────────────────────────────────────────────────────────
const WORDS = [
  { text: "hello", timestamp: [0.2, 0.5] },
  { text: "world", timestamp: [0.6, 0.9] },
  { text: "this", timestamp: [1.0, 1.2] },
  { text: "is", timestamp: [1.3, 1.5] },
  { text: "a", timestamp: [1.6, 1.7] },
  { text: "test", timestamp: [1.8, 2.2] },
  { text: "of", timestamp: [2.5, 2.7] },
  { text: "dubbing", timestamp: [4.4, 4.8] },
];
let progressEvents = [];
const onProgress = (p) => progressEvents.push(p);

DUB._setDepsForTesting({
  extractAudioForGroq: async (ffmpeg, wav, dir, report) => ({ filePath: wav }),
  groqTranscribe: async ({ onProgress: op }) => {
    if (op) op({ progress: 100, status: "stub" });
    return { chunks: WORDS, wordLevel: true, language: "en", duration: 3.2, text: "hello world" };
  },
  groqChat: async ({ messages }) => {
    const sys = messages[0].content;
    if (sys.includes("speaker")) {
      return {
        content: JSON.stringify({
          segments: [
            { i: 0, speaker: 0 }, { i: 1, speaker: 1 },
          ],
          speakerCount: 2,
        }),
      };
    }
    return {
      content: JSON.stringify({
        segments: [
          { i: 0, text: "नमस्ते दुनिया यह एक परीक्षण है" },
          { i: 1, text: "डबिंग का" },
        ],
      }),
    };
  },
  voicePairsByLocale: () => ({
    "hi-IN": { female: "hi-IN-SwaraNeural", male: "hi-IN-MadhurNeural" },
  }),
  ttsSynthesize: async ({ outFile }) => {
    fs.copyFileSync(TTS_MP3, outFile);
  },
});

// ── THE TEST ───────────────────────────────────────────────────────────────
(async () => {
  const common = {
    segments: [{ videoPath: SRC_WAV, startMs: 0 }],
    apiKey: "stub-key",
    tempDir: TMP,
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    targetLanguage: "hi",
    targetLocale: "hi-IN",
    groqModel: "stub-model",
    onProgress,
  };

  // STAGE 1 — word-level transcript
  progressEvents = [];
  const t = await DUB.runDubTranscript({ ...common });
  console.log("[1] transcript:", {
    language: t.language,
    wordCount: t.wordCount,
    lines: t.utterances.length,
    line1Words: t.utterances[0].words?.map((w) => w.text),
    firstWord: t.utterances[0].words?.[0],
  });
  if (t.wordCount !== 8) throw new Error("expected 8 words, got " + t.wordCount);
  if (!t.utterances[0].words || t.utterances[0].words.length === 0) throw new Error("no word-level data on line 1");
  if (t.utterances.length < 2) throw new Error("expected ≥2 utterance lines");
  if (!progressEvents.some((p) => p.phase === "done")) throw new Error("no done progress event");
  const leftovers = fs.readdirSync(TMP).filter((f) => f.startsWith("framefuse-dub-"));
  if (leftovers.length > 0) throw new Error(`transcript temp dirs leaked: ${leftovers}`);

  // STAGE 2 — the script
  progressEvents = [];
  const s = await DUB.runDubScript({
    utterances: t.utterances,
    sourceLanguage: t.language,
    targetLanguage: "hi",
    targetLocale: "hi-IN",
    groqModel: "stub",
    textProvider: "groq",
    apiKey: "stub-key",
    voiceMode: "multi",
    onProgress,
  });
  console.log("[2] script:", {
    speakers: s.speakerCount,
    lines: s.lines.length,
    langName: s.targetLanguageName,
    line0: { spk: s.lines[0].speaker, src: s.lines[0].sourceText, txt: s.lines[0].translatedText },
    line1: { spk: s.lines[1].speaker, txt: s.lines[1].translatedText },
    warnings: s.warnings,
  });
  if (s.speakerCount !== 2) throw new Error("expected 2 speakers");
  if (s.lines.length !== 2) throw new Error("expected 2 lines");
  if (s.lines[0].translatedText !== "नमस्ते दुनिया यह एक परीक्षण है") throw new Error("translation mismatch");
  if (s.lines[1].speaker !== 1) throw new Error("speaker assignment mismatch");

  // STAGE 3 — dub FROM the edited script (edit + reassign line 1 → speaker 0)
  progressEvents = [];
  const edited = s.lines.map((l) =>
    l.i === 1 ? { ...l, translatedText: "यह एक संपादित परीक्षण है", speaker: 0 } : l,
  );
  const r = await DUB.runDub({
    ...common,
    scriptLines: edited.map((l) => ({
      speaker: l.speaker, sourceText: l.sourceText, translatedText: l.translatedText,
      startMs: l.startMs, endMs: l.endMs,
    })),
    scriptVoices: { 1: "hi-IN-MadhurNeural" },
    scriptLanguage: "hi",
    scriptSpeakerCount: 2,
    voiceMode: "multi",
  });
  console.log("[3] script dub:", {
    speakers: r.speakers,
    segments: r.segments.length,
    language: r.language,
    seg1: { spk: r.segments[1].speaker, txt: r.segments[1].translatedText, ttsDurMs: r.segments[1].ttsDurMs },
    wavExists: fs.existsSync(r.segments[0].wavPath),
  });
  if (r.segments.length !== 2) throw new Error("expected 2 fitted segments");
  if (r.segments[1].speaker !== 0) throw new Error("edited speaker not honored");
  if (r.segments[1].translatedText !== "यह एक संपादित परीक्षण है") throw new Error("edited text not honored");
  if (r.language !== "hi") throw new Error("script language not propagated");
  if (!fs.existsSync(r.segments[0].wavPath)) throw new Error("wav missing");
  DUB.cleanupDubTemp(r.dubDir);

  // REGRESSION — legacy one-shot (multi)
  const r2 = await DUB.runDub({ ...common, voiceMode: "multi" });
  console.log("[4] legacy one-shot:", { segments: r2.segments.length, speakers: r2.speakers.length, language: r2.language });
  if (r2.segments.length !== 2) throw new Error("legacy pipeline broke");
  DUB.cleanupDubTemp(r2.dubDir);

  // REGRESSION — single-voice
  const r3 = await DUB.runDub({ ...common, voiceMode: "single", singleVoice: "hi-IN-SwaraNeural" });
  console.log("[5] single-voice:", { speakers: r3.speakers.length, voice: r3.speakers[0].voice });
  if (r3.speakers.length !== 1 || r3.speakers[0].voice !== "hi-IN-SwaraNeural") throw new Error("single-voice broke");
  DUB.cleanupDubTemp(r3.dubDir);

  console.log("DUB STUDIO SMOKE: ALL PASSED");
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
