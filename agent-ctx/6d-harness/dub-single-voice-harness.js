/**
 * Task 6-d harness — single-voice dubbing mode end-to-end (real ffmpeg +
 * ffprobe; Groq + Edge TTS stubbed through the _setDepsForTesting seams).
 * Drives the REAL runDub pipeline and asserts:
 *   1. voiceMode "single" + singleVoice → NO speaker-detection LLM call,
 *      every segment speaker 0, every synthesis uses the single voice.
 *   2. voiceMode "single" + empty singleVoice → still no detection, voice
 *      falls back to the locale pair's female.
 *   3. No voiceMode + non-empty singleVoice (task rule) → single mode.
 *   4. voiceMode "multi" (or absent, no singleVoice) → legacy behavior:
 *      speaker LLM called, alternating female/male voices.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const DUB = require("/home/z/my-project/electron/dub-workflow.js");

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dub-single-"));
const src = path.join(tmp, "src.mp4");
execSync(
  `${FFMPEG} -y -f lavfi -i testsrc=size=320x240:rate=10 -f lavfi -i sine=frequency=440:duration=6 -t 6 -c:v libx264 -preset ultrafast -c:a aac ${src}`,
  { stdio: "pipe" },
);

let chatCalls = []; // "speakers" | "translate"
let synthVoices = [];
let statuses = [];

DUB._setDepsForTesting({
  extractAudioForGroq: async (ff, wav, dir, onp) => ({ filePath: wav }),
  groqTranscribe: async () => ({
    language: "en",
    chunks: [
      { text: "Hello there my friend", timestamp: [0.2, 1.5] },
      { text: "How are you today", timestamp: [2.0, 3.2] },
      { text: "I am fine thanks", timestamp: [3.8, 5.0] },
    ],
  }),
  groqChat: async (o) => {
    const sys = o.messages[0].content;
    const isSpeakers = sys.includes("You analyse transcripts");
    chatCalls.push(isSpeakers ? "speakers" : "translate");
    const content = isSpeakers
      ? JSON.stringify({
          speakerCount: 2,
          segments: [
            { i: 0, speaker: 0 },
            { i: 1, speaker: 1 },
            { i: 2, speaker: 0 },
          ],
        })
      : JSON.stringify({
          segments: [
            { i: 0, text: "नमस्ते दोस्त" },
            { i: 1, text: "आज आप कैसे हैं" },
            { i: 2, text: "मैं ठीक हूँ धन्यवाद" },
          ],
        });
    return { content };
  },
  voicePairsByLocale: () => ({
    "hi-IN": { female: "hi-IN-SwaraNeural", male: "hi-IN-MadhurNeural" },
  }),
  ttsSynthesize: async (o) => {
    synthVoices.push(o.voice);
    execSync(
      `${FFMPEG} -y -f lavfi -i sine=frequency=330:duration=1 -ac 1 -ar 16000 -c:a libmp3lame -b:a 32k ${o.outFile}`,
      { stdio: "pipe" },
    );
    return { filePath: o.outFile };
  },
});

async function run(label, opts) {
  chatCalls = [];
  synthVoices = [];
  statuses = [];
  const result = await DUB.runDub({
    segments: [{ videoPath: src, startMs: 0 }],
    sourceLanguage: "auto",
    targetLanguage: "hi",
    targetLocale: "hi-IN",
    apiKey: "test-key",
    tempDir: tmp,
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    onProgress: (p) => statuses.push(p.status),
    ...opts,
  });
  console.log(`\n=== ${label} ===`);
  console.log("  speakers:", JSON.stringify(result.speakers));
  console.log("  seg speakers:", result.segments.map((s) => s.speaker).join(","));
  console.log("  chatCalls:", chatCalls.join(","));
  console.log("  synthVoices:", synthVoices.join(","));
  console.log("  warnings:", result.warnings.length ? result.warnings.join(" | ") : "(none)");
  DUB.cleanupDubTemp(result.dubDir);
  return result;
}

(async () => {
  // 1. single + explicit male voice
  const r1 = await run("SINGLE + hi-IN-MadhurNeural", {
    voiceMode: "single",
    singleVoice: "hi-IN-MadhurNeural",
  });
  assert(!chatCalls.includes("speakers"), "single: speaker LLM must NOT run");
  assert(chatCalls.includes("translate"), "single: translate must run");
  assert.deepStrictEqual(r1.speakers, [{ id: 0, voice: "hi-IN-MadhurNeural", gender: null }]);
  assert(r1.segments.every((s) => s.speaker === 0), "single: all segments speaker 0");
  assert(synthVoices.length === 3 && synthVoices.every((v) => v === "hi-IN-MadhurNeural"));
  assert(statuses.some((s) => s.includes("Single voice mode — skipping speaker detection")));
  assert(!statuses.some((s) => s.includes("Detecting speakers")));

  // 2. single + empty voice → pair female fallback (detection still skipped)
  const r2 = await run("SINGLE + empty voice → pair female", {
    voiceMode: "single",
    singleVoice: "",
  });
  assert(!chatCalls.includes("speakers"), "single-empty: speaker LLM must NOT run");
  assert.deepStrictEqual(r2.speakers, [{ id: 0, voice: "hi-IN-SwaraNeural", gender: "female" }]);
  assert(synthVoices.every((v) => v === "hi-IN-SwaraNeural"));

  // 3. no voiceMode + non-empty singleVoice → single (task rule)
  const r3 = await run("LEGACY payload: singleVoice only", {
    singleVoice: "hi-IN-MadhurNeural",
  });
  assert(!chatCalls.includes("speakers"), "legacy-single: speaker LLM must NOT run");
  assert(r3.speakers[0].voice === "hi-IN-MadhurNeural");

  // 4. multi (absent everything) → legacy behavior
  const r4 = await run("MULTI (legacy, no overrides)", {});
  assert(chatCalls.includes("speakers"), "multi: speaker LLM MUST run");
  assert.deepStrictEqual(r4.speakers, [
    { id: 0, voice: "hi-IN-SwaraNeural", gender: "female" },
    { id: 1, voice: "hi-IN-MadhurNeural", gender: "male" },
  ]);
  assert.deepStrictEqual(
    r4.segments.map((s) => s.speaker),
    [0, 1, 0],
  );
  assert.deepStrictEqual(synthVoices, ["hi-IN-SwaraNeural", "hi-IN-MadhurNeural", "hi-IN-SwaraNeural"]);
  assert(statuses.some((s) => s.includes("Detecting speakers")));
  assert(!statuses.some((s) => s.includes("Single voice mode")));

  // 5. multi + speakerVoices overrides (the main.js femaleVoice/maleVoice map)
  const r5 = await run("MULTI + speakerVoices overrides", {
    speakerVoices: { 0: "hi-IN-SwaraNeural", 1: "hi-IN-MadhurNeural" },
  });
  assert(chatCalls.includes("speakers"));
  assert(r5.speakers[0].voice === "hi-IN-SwaraNeural");
  assert(r5.speakers[1].voice === "hi-IN-MadhurNeural");

  // 6. multi + leftover singleVoice → per the task rule ("non-empty
  //    singleVoice → skip detection") the single voice WINS. The app can
  //    never reach this state: the UI clears singleVoice when leaving
  //    single mode and loadDubSettings nulls it unless voiceMode==="single".
  const r6 = await run("MULTI + leftover singleVoice (spec rule: single wins)", {
    voiceMode: "multi",
    singleVoice: "hi-IN-MadhurNeural",
  });
  assert(!chatCalls.includes("speakers"), "leftover singleVoice: detection skipped per spec");
  assert(r6.speakers.length === 1);
  assert(r6.speakers[0].voice === "hi-IN-MadhurNeural");

  console.log("\nALL 6 RUNS PASS ✅");
})().catch((err) => {
  console.error("\nHARNESS FAILED:", err.message);
  process.exit(1);
});
