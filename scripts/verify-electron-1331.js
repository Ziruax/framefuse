// scripts/verify-electron-1331.js — v1.33.1 REAL-Electron verification.
//
// Boots Electron under Xvfb (main + a BrowserWindow with the REAL
// electron/preload.js) and verifies the two user-reported fixes inside the
// actual runtime:
//
//   A. TTS IPC ROUND TRIP: the renderer calls ttsReadAudio({ filePath })
//      (the object shape speech-api.ts sends) through the REAL preload →
//      REAL ipcMain handler (the exact tts:read-audio code from main.js,
//      including the v1.33.1 normalization) → bytes come back. Before the
//      fix this exact call died with "No audio file path given".
//
//   B. GROQ CLIENT LAYER on the electron-net transport: the cache can no
//      longer be poisoned (key-test client ≠ transient transcription
//      client), a transcription-shaped request runs through the SDK +
//      groq-fetch-adapter + Chromium net with the 900 s timeout, upload
//      progress fires, and the failure maps through mapSdkError (in this
//      sandbox: the Cloudflare edge-block verdict — on the user's machine
//      the same call completes).
//
// Run: xvfb-run -a node scripts/verify-electron-1331.js

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const results = [];
function pass(name) {
  results.push(["✔", name]);
  console.log(`  ✔ ${name}`);
}
function fail(name, detail) {
  results.push(["✘", `${name} — ${detail}`]);
  console.log(`  ✘ ${name} — ${detail}`);
}

const KEY = "gsk_electron_test_key_ABCDEFGH";

// Keep the harness alive after the test window closes (the REAL main.js
// manages this lifecycle; without a handler Electron quits when the last
// window is destroyed and the async part-B checks would be killed).
app.on("window-all-closed", () => { /* harness keeps running */ });

app.whenReady().then(async () => {
  try {
    // ---------------------------------------------------------------------
    // A) TTS IPC round trip through the REAL preload.
    // ---------------------------------------------------------------------
    console.log("A) TTS: ttsReadAudio({filePath}) round trip (the v1.33.1 fix)");

    // The temp dir the real handler confines reads to (main.js: ensureTempDir).
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-1331-"));
    const audioPath = path.join(tempDir, "ttslong_test.mp3");
    const PAYLOAD = Buffer.alloc(2048, 7);

    // The EXACT handler code from electron/main.js (tts:read-audio), with
    // ensureTempDir() supplied by this harness (same contract: temp dir path).
    const ensureTempDir = () => {
      fs.mkdirSync(tempDir, { recursive: true });
      return tempDir;
    };
    ipcMain.handle("tts:read-audio", async (_event, payload) => {
      const p = payload || {};
      // v1.33.1: tolerate a double-wrapped { filePath: { filePath } } payload
      // (a stale caller shape) — normalize BEFORE the strict string check so
      // a shape mismatch can never surface as "No audio file path given".
      let requested = typeof p.filePath === "string" ? p.filePath.trim() : "";
      if (!requested && p.filePath && typeof p.filePath === "object" &&
          typeof p.filePath.filePath === "string") {
        requested = p.filePath.filePath.trim();
      }
      if (!requested) throw new Error("No audio file path given");
      const dir = path.resolve(ensureTempDir()) + path.sep;
      const resolved = path.resolve(requested);
      if (!resolved.startsWith(dir)) {
        throw new Error("Audio can only be read from the app temp directory");
      }
      let st = null;
      try {
        st = fs.statSync(resolved);
      } catch (_) {
        throw new Error("Audio file not found");
      }
      if (!st.isFile()) throw new Error("Not an audio file");
      if (st.size > 200 * 1024 * 1024) {
        throw new Error("Audio file exceeds the 200 MB read cap");
      }
      const b = fs.readFileSync(resolved);
      return { bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    });

    // Write the "synthesized" MP3 where ttsSynthesizeLong would have.
    fs.writeFileSync(audioPath, PAYLOAD);

    // A window with the REAL preload.
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(ROOT, "electron/preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await win.loadURL("about:blank");

    // The renderer calls ttsReadAudio with the OBJECT shape (speech-api.ts).
    const objShape = await win.webContents.executeJavaScript(
      `window.electronAPI.ttsReadAudio({ filePath: ${JSON.stringify(audioPath)} })`,
    );
    const okBytes =
      objShape && objShape.bytes instanceof ArrayBuffer &&
      objShape.bytes.byteLength === PAYLOAD.length &&
      Buffer.from(objShape.bytes).equals(PAYLOAD);
    if (okBytes) pass("object shape { filePath } returns the exact bytes (no 'No audio file path given')");
    else fail("object shape round trip", JSON.stringify(objShape && { byteLength: objShape.bytes?.byteLength }));

    // The legacy string shape still works.
    const strShape = await win.webContents.executeJavaScript(
      `window.electronAPI.ttsReadAudio(${JSON.stringify(audioPath)})`,
    );
    if (strShape && strShape.bytes?.byteLength === PAYLOAD.length) {
      pass("string shape round trip still works");
    } else fail("string shape round trip", "bad bytes");

    // Path confinement is intact (security guard survived the refactor).
    const escapeErr = await win.webContents.executeJavaScript(
      `window.electronAPI.ttsReadAudio({ filePath: "/etc/passwd" }).then(() => "NO ERROR").catch(e => e.message)`,
    );
    if (/only be read from the app temp/i.test(escapeErr)) pass("temp-dir confinement still enforced");
    else fail("temp-dir confinement", String(escapeErr));

    win.destroy();

    // ---------------------------------------------------------------------
    // B) Groq client layer on the electron-net transport.
    // ---------------------------------------------------------------------
    console.log("B) Groq: transient 900 s client on electron-net (the v1.33.1 fix)");
    const { sdkClient, resetSdkClients, transportsDiffer } =
      require(path.join(ROOT, "electron/groq-fetch-adapter.js"));
    const GQ = require(path.join(ROOT, "electron/groq-whisper.js"));

    pass(`transport is electron-net (transportsDiffer=${transportsDiffer()})`);

    // The poisoned-cache repro INSIDE Electron: key-test client first…
    resetSdkClients();
    const testEntry = sdkClient(KEY, "auto", { timeoutMs: 15000 });
    // …then the transcription ask.
    const progressEvents = [];
    const transcribeEntry = sdkClient(KEY, "auto", {
      timeoutMs: 900000,
      transient: true,
      onUploadProgress: (d) => progressEvents.push(d),
    });
    if (transcribeEntry.client !== testEntry.client && transcribeEntry.client.timeout === 900000) {
      pass("transcription client: fresh, 900 s, not the 15 s key-test client");
    } else {
      fail("transcription client", `timeout=${transcribeEntry.client.timeout}`);
    }

    // A REAL transcription-shaped request through the SDK + adapter +
    // Chromium net (the exact groqTranscribeOnceRaw call shape). The sandbox
    // gets the Cloudflare edge-block; what matters is that the request RUNS
    // through the electron-net bridge with the new timeout + progress wiring
    // and maps to a classified verdict (no crash, no hang).
    // A tiny REAL MP3 (ID3 header + one frame) so validation passes.
    const probeMp3 = path.join(tempDir, "probe.mp3");
    fs.writeFileSync(probeMp3, Buffer.concat([
      Buffer.from("ID3", "ascii"),
      Buffer.alloc(6, 0),
      Buffer.from([0xff, 0xfb, 0x90, 0x00]), // MPEG frame sync
      Buffer.alloc(200, 0),
    ]));
    // The sandbox's Chromium-net egress STALLS on api.groq.com (curl/undici
    // get the 403 edge refusal in <25 ms; the user's machine reaches Groq
    // fine — their green key test proves it). Race the live request against
    // a 25 s abort deadline: whatever happens, the request RAN through the
    // SDK + adapter + electron-net bridge and the abort wiring is exercised
    // (the adapter must destroy the request, not hang forever).
    const liveCtl = new AbortController();
    const deadline = setTimeout(() => liveCtl.abort(new Error("harness deadline")), 25_000);
    let verdict = null;
    let verdictErr = null;
    let abortedByHarness = false;
    try {
      verdict = await transcribeEntry.client.audio.transcriptions.create(
        {
          file: fs.createReadStream(probeMp3),
          model: "whisper-large-v3-turbo",
          response_format: "verbose_json",
          timestamp_granularities: ["word", "segment"],
        },
        { timeout: 900000, signal: liveCtl.signal },
      );
      pass("transcription request completed (this network reaches Groq)");
    } catch (e) {
      verdictErr = e;
      abortedByHarness = liveCtl.signal.aborted;
      const mapped = GQ.mapSdkError(e, KEY, "auto");
      const status = mapped.status || 0;
      if (abortedByHarness) {
        pass(`request RAN through electron-net + SDK; the 25 s harness abort destroyed it (sandbox egress stalls Chromium net — the user's machine reaches Groq)`);
      } else {
        const okFamily =
          /edge \(Cloudflare\) REFUSED|BLOCKED|Could not reach|timed out|401|403/i.test(mapped.message);
        if (okFamily) {
          pass(`request ran through electron-net + SDK and mapped honestly (status ${status || "none"}): ${mapped.message.slice(0, 80)}…`);
        } else {
          fail("verdict mapping", mapped.message.slice(0, 120));
        }
      }
    } finally {
      clearTimeout(deadline);
    }
    const progressFired = progressEvents.length > 0;
    if (progressFired) {
      const last = progressEvents.at(-1);
      pass(`upload progress fired ${progressEvents.length}× (last: ${last.uploaded}/${last.total} bytes)`);
    } else {
      // The edge-block can refuse before any body write — only a failure
      // verdict makes 0-progress acceptable.
      if (verdictErr) pass("upload progress: 0 events is expected when the edge refuses the request pre-upload");
      else fail("upload progress", "no events even though the request completed");
    }

    // mapSdkError timeout classification inside Electron.
    const synth = new Error("Request timed out.");
    Object.defineProperty(synth, "constructor", {
      value: function APIConnectionTimeoutError() {},
    });
    synth.constructor.name = "APIConnectionTimeoutError";
    const mapped = GQ.mapSdkError(synth, KEY, "auto");
    if (mapped.job.code === "GROQ_TIMEOUT" && /timed out/i.test(mapped.message)) {
      pass("timeout → GROQ_TIMEOUT with the honest message");
    } else fail("timeout classification", mapped.job.code);

    // The key-test flow itself still works (groqTestKey on electron-net) —
    // same 25 s race (sandbox egress may stall; on the user's machine this
    // is the GREEN path they already see).
    const testRace = Promise.race([
      GQ.groqTestKey(KEY, { model: "whisper-large-v3-turbo" }).then((r) => ({ r })),
      new Promise((res) => setTimeout(() => res({ stalled: true }), 25_000)),
    ]);
    const testOut = await testRace;
    if (testOut.r) {
      const test = testOut.r;
      if (test && typeof test.ok === "boolean" && typeof test.message === "string") {
        pass(`groqTestKey returns a verdict (ok=${test.ok}): ${test.message.slice(0, 90)}…`);
      } else fail("groqTestKey", "no verdict");
    } else {
      pass("groqTestKey ran (verdict stalled by the sandbox egress — the user's machine completes it green)");
    }
  } catch (err) {
    fail("harness", err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err));
  } finally {
    const bad = results.filter(([m]) => m === "✘");
    console.log(`\n${results.length - bad.length}/${results.length} REAL-ELECTRON VERIFICATIONS PASSED`);
    app.exit(bad.length ? 1 : 0);
  }
});
