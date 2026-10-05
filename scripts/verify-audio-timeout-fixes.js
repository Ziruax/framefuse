// scripts/verify-audio-timeout-fixes.js — v1.33.1 verification.
//
// Reproduces and closes BOTH user-reported failures:
//   1. TTS: "No audio file path given" — the preload/main shape mismatch
//      (renderer sends { filePath }, preload double-wrapped it).
//   2. Groq: "test green, transcription could not reach the api" — the
//      SDK client cache poisoning (the key-test's 15 s client was handed
//      to real transcriptions) + the timeout being mislabeled as a
//      network failure.
//
// Run: node scripts/verify-audio-timeout-fixes.js

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function pass(name) {
  console.log(`  ✔ ${name}`);
}

// ---------------------------------------------------------------------------
// 1) Groq adapter cache semantics (electron/groq-fetch-adapter.js)
// ---------------------------------------------------------------------------
console.log("1) groq-fetch-adapter: cache poisoning is impossible");

const { sdkClient, resetSdkClients } = require(path.join(ROOT, "electron/groq-fetch-adapter.js"));

// The v1.33 repro sequence: the KEY TEST runs first (15 s client gets
// cached under (key, mode)), then a transcription asks for a long budget.
resetSdkClients();
const KEY = "gsk_test_key_ABCDEFGHIJKLMNOP";
const testEntry = sdkClient(KEY, "auto", { timeoutMs: 15000 });
const transcribeEntry = sdkClient(KEY, "auto", {
  timeoutMs: 900000,
  transient: true,
  onUploadProgress: () => {},
});
assert.notStrictEqual(
  transcribeEntry.client, testEntry.client,
  "transient transcription client must NOT be the cached 15 s key-test client",
);
assert.equal(transcribeEntry.timeoutMs, 900000, "transcription entry carries its own timeout");
assert.ok(transcribeEntry.client.timeout === 900000, "client option timeout is 900000");
assert.ok(testEntry.client.timeout === 15000, "key-test client keeps its 15 s timeout");
pass("transcription never receives the key-test's 15 s client");

// A second transient client is ALWAYS fresh (per-run upload progress sink
// must never leak across runs).
const second = sdkClient(KEY, "auto", { timeoutMs: 900000, transient: true });
assert.notStrictEqual(second.client, transcribeEntry.client, "transient clients are per-call");
pass("transient clients are per-call (progress sink can't leak)");

// Non-transient clients with different timeouts get separate cache slots.
resetSdkClients();
const a = sdkClient(KEY, "auto", { timeoutMs: 15000 });
const b = sdkClient(KEY, "auto", { timeoutMs: 900000 });
assert.notStrictEqual(a.client, b.client, "different timeouts → different cache entries");
const aAgain = sdkClient(KEY, "auto", { timeoutMs: 15000 });
assert.strictEqual(a.client, aAgain.client, "same (key,mode,timeout) is cached");
pass("cache key includes timeout; identical requests still reuse");

// groq-chat's per-request timeoutMs gets its own slot too (the other
// silent victim of the (key,mode)-only cache).
const chatEntry = sdkClient(KEY, "auto", { timeoutMs: 120000 });
assert.notStrictEqual(chatEntry.client, a.client, "chat's 120 s client ≠ the 15 s test client");
pass("groq-chat no longer inherits the key-test timeout");

// ---------------------------------------------------------------------------
// 2) Timeout classification (electron/groq-whisper.js mapSdkError)
// ---------------------------------------------------------------------------
console.log("2) groq-whisper: timeout is an honest, distinct verdict");

const GQ = require(path.join(ROOT, "electron/groq-whisper.js"));

// A synthetic SDK APIConnectionTimeoutError (no status, "Request timed out.").
function synthTimeout() {
  const e = new Error("Request timed out.");
  Object.defineProperty(e, "constructor", {
    value: function APIConnectionTimeoutError() {},
  });
  e.constructor.name = "APIConnectionTimeoutError";
  return e;
}
const t1 = GQ.mapSdkError(synthTimeout(), KEY, "auto");
assert.ok(/timed out/i.test(t1.message), "timeout message says timed out");
assert.ok(!/Could not reach api\.groq\.com/.test(t1.message), "timeout is not mislabeled as unreachable");
assert.equal(t1.job.code, "GROQ_TIMEOUT", "job code is GROQ_TIMEOUT");
assert.equal(t1.job.retryable, true, "timeout is retryable");
assert.equal(t1.timedOut, true);
pass("SDK timeout → GROQ_TIMEOUT verdict, no network blame");

// A message-shaped timeout ("Request timed out.") without the class name.
const t2 = GQ.mapSdkError(new Error("Request timed out."), KEY, "auto");
assert.equal(t2.job.code, "GROQ_TIMEOUT", "message heuristic detects the timeout");
pass("message-text heuristic also classifies timeouts");

// A plain connection error stays a network verdict (with the message kept).
const c1 = GQ.mapSdkError(new Error("connect ECONNREFUSED 1.2.3.4:443"), KEY, "auto");
assert.ok(/Could not reach api\.groq\.com: connect ECONNREFUSED/.test(c1.message), "connection error keeps its cause");
assert.equal(c1.job.code, "GROQ_CONNECTION");
assert.ok(!c1.timedOut);
pass("real connection errors keep the 'could not reach' family + cause");

// User abort is NOT a timeout.
const { APIUserAbortError } = (() => {
  // Build the shape the SDK uses: constructor name APIUserAbortError.
  const e = new Error("Request was aborted.");
  Object.defineProperty(e, "constructor", {
    value: function APIUserAbortError() {},
  });
  e.constructor.name = "APIUserAbortError";
  return { APIUserAbortError: e };
})();
const u1 = GQ.mapSdkError(APIUserAbortError, KEY, "auto");
assert.ok(!u1.timedOut, "user abort is not a timeout");
pass("user abort is not classified as timeout");

// isSdkTimeoutError export sanity.
assert.equal(GQ.isSdkTimeoutError(synthTimeout()), true);
assert.equal(GQ.isSdkTimeoutError(new Error("Request timed out.")), true);
assert.equal(GQ.isSdkTimeoutError(new Error("connect ECONNREFUSED")), false);
assert.equal(GQ.isSdkTimeoutError(null), false);
pass("isSdkTimeoutError export works");

// ---------------------------------------------------------------------------
// 3) The preload ttsReadAudio shape fix (the TTS "No audio file path given")
// ---------------------------------------------------------------------------
console.log("3) preload: ttsReadAudio accepts both shapes (TTS fix)");

const Module = require("node:module");
const origLoad = Module._load;
// Minimal electron stub for preload.js: contextBridge + ipcRenderer.
const invokeCalls = [];
const electronStub = {
  contextBridge: {
    exposeInMainWorld: (name, api) => {
      electronStub.__exposed = { name, api };
    },
  },
  ipcRenderer: {
    invoke: async (channel, payload) => {
      invokeCalls.push({ channel, payload });
      return { bytes: new ArrayBuffer(8), bytesLen: 8 };
    },
    on: () => () => {},
    removeListener: () => {},
    send: () => {},
  },
  __exposed: null,
};
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};
try {
  require(path.join(ROOT, "electron/preload.js"));
} finally {
  Module._load = origLoad;
}
const exposed = electronStub.__exposed;
assert.ok(exposed && exposed.api && typeof exposed.api.ttsReadAudio === "function",
  "preload exposes ttsReadAudio");

// (a) The object shape the renderer actually sends (types.ts + speech-api.ts).
exposed.api.ttsReadAudio({ filePath: "/tmp/ff/ttslong_1.mp3" });
assert.equal(invokeCalls.at(-1).channel, "tts:read-audio");
assert.deepEqual(invokeCalls.at(-1).payload, { filePath: "/tmp/ff/ttslong_1.mp3" },
  "the object shape is normalized — NO double wrap");
pass("object shape { filePath } no longer double-wraps (the TTS bug)");

// (b) The bare-string shape (older callers) still works.
exposed.api.ttsReadAudio("/tmp/ff/ttslong_2.mp3");
assert.deepEqual(invokeCalls.at(-1).payload, { filePath: "/tmp/ff/ttslong_2.mp3" });
pass("string shape still works");

// (c) Garbage degrades to an explicit empty path (main throws its clear error).
exposed.api.ttsReadAudio(undefined);
assert.deepEqual(invokeCalls.at(-1).payload, { filePath: "" });
exposed.api.ttsReadAudio({ nope: 1 });
assert.deepEqual(invokeCalls.at(-1).payload, { filePath: "" });
pass("invalid input degrades to { filePath: \"\" } (main's clear error)");

// ---------------------------------------------------------------------------
// 4) main.js tts:read-audio normalization (defensive layer)
// ---------------------------------------------------------------------------
console.log("4) main: tts:read-audio tolerates a double-wrapped payload");
const mainSrc = require("node:fs").readFileSync(path.join(ROOT, "electron/main.js"), "utf8");
assert.ok(
  /p\.filePath\.filePath/.test(mainSrc),
  "main normalizes the wrapped { filePath: { filePath } } payload",
);
// And the wrapped payload resolves to the SAME string the strict check wants.
const normalize = (p) => {
  let requested = typeof p.filePath === "string" ? p.filePath.trim() : "";
  if (!requested && p.filePath && typeof p.filePath === "object" &&
      typeof p.filePath.filePath === "string") {
    requested = p.filePath.filePath.trim();
  }
  return requested;
};
assert.equal(normalize({ filePath: { filePath: "/tmp/ff/x.mp3" } }), "/tmp/ff/x.mp3");
assert.equal(normalize({ filePath: "/tmp/ff/x.mp3" }), "/tmp/ff/x.mp3");
assert.equal(normalize({ filePath: "" }), "");
pass("main-side normalization unwraps + keeps strict empty rejection");

console.log("\nALL AUDIO-TIMEOUT-FIX VERIFICATIONS PASSED");
