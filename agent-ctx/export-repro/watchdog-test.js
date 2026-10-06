// agent-ctx/export-repro/watchdog-test.js — tests the REAL runFfmpeg from
// electron/main.js (sliced verbatim out of the file and evaluated with
// stubbed spawn/ffmpegPath/activeProcs) against three scenarios:
//   A. hung process (never writes stderr, never exits) → pre-total stall kill
//   B. healthy process (progress lines, clean exit) → no watchdog interference
//   C. reached total then silent (finalize-window hang) → finalize kill
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.js"), "utf8");
const start = src.indexOf("function runFfmpeg(args, totalSec, onTime, opts)");
const end = src.indexOf("async function verifyExportOutputAsync", start);
const fnSrc = src.slice(start, end);
if (!/stallWatchdog/.test(fnSrc)) throw new Error("sliced runFfmpeg lost the watchdog marker");
if (!/stallKilled/.test(fnSrc)) throw new Error("sliced runFfmpeg lost the stall-kill path");
console.log(`[test] sliced runFfmpeg (${fnSrc.length} bytes) — watchdog marker present`);

// Evaluate the real function with stubs for its module-scope dependencies.
const ffmpegPath = process.execPath; // "node" — the harness drives scenarios via args
const activeProcs = new Set();
const factory = new Function("spawn", "ffmpegPath", "activeProcs", "console",
  fnSrc + "\nreturn runFfmpeg;");
const runFfmpeg = factory(spawn, ffmpegPath, activeProcs, console);

function scenario(name, args, totalSec, opts, expect) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let onTimeGot = 0;
    let onFinalizeGot = 0;
    runFfmpeg(args, totalSec, (sec) => { onTimeGot++; void sec; }, {
      ...opts,
      onFinalize: opts && opts.onFinalize ? () => { onFinalizeGot++; } : undefined,
    }).then(
      () => { console.log(`[A/PASS?] ${name}: RESOLVED in ${((Date.now() - t0) / 1000).toFixed(1)}s`); resolve({ ok: expect === "resolve" }); },
      (err) => {
        const wall = ((Date.now() - t0) / 1000).toFixed(1);
        const msg = err.message.split("\n").slice(0, 3).join(" | ").slice(0, 220);
        console.log(`[test] ${name}: REJECTED after ${wall}s — onTime x${onTimeGot}, onFinalize x${onFinalizeGot}\n      ${msg}`);
        resolve({ ok: expect === "reject", err });
      },
    );
  });
}

(async () => {
  let failures = 0;

  // A. hung: silent, never exits. stallMs=2500.
  const a = await scenario("A hung process (no output, no exit)",
    ["-e", "setTimeout(()=>{}, 600000)"], 10,
    { stallMs: 2500 }, "reject");
  if (!a.ok) failures++;
  if (a.ok && !/stalled/.test(a.err.message)) { console.log("FAIL A: message lacks 'stalled'"); failures++; }

  // B. healthy: progress lines then clean exit — must RESOLVE fast, no kill.
  const b = await scenario("B healthy process (progress + exit 0)",
    ["-e", "for (let i=0;i<6;i++){process.stderr.write('time=00:00:0'+i+'.50\\r');}setTimeout(()=>process.exit(0),400)"],
    6, { stallMs: 2500 }, "resolve");
  if (!b.ok) failures++;

  // C. finalize hang: reaches total (time=10.0), then goes silent forever.
  // finalizeMs=2500 → killed with the finalize-phase message.
  const c = await scenario("C finalize-window hang (total reached, then silent)",
    ["-e", "process.stderr.write('time=00:00:10.00\\r');setTimeout(()=>{},600000)"],
    10, { stallMs: 2500, finalizeMs: 2500, onFinalize: true }, "reject");
  if (!c.ok) failures++;
  if (c.ok && !/while finalizing the output file/.test(c.err.message)) { console.log("FAIL C: message lacks finalize wording"); failures++; }

  // D. cancel path still intact: process killed externally (SIGTERM) →
  // "Export cancelled", NOT a stall error.
  const d = await new Promise((resolve) => {
    const p = { label: "D external cancel" };
    const proc = runFfmpeg(["-e", "setTimeout(()=>{},600000)"], 10, () => {},
      { stallMs: 600000, finalizeMs: 600000 });
    // find the live child and SIGTERM it
    setTimeout(() => {
      for (const child of activeProcs) { try { child.kill("SIGTERM"); } catch (_) {} }
    }, 300);
    proc.then(
      () => { console.log(`[test] ${p.label}: RESOLVED (unexpected)`); resolve({ ok: false }); },
      (err) => {
        console.log(`[test] ${p.label}: REJECTED — ${err.message.slice(0, 60)}`);
        resolve({ ok: err.message === "Export cancelled" });
      },
    );
  });
  if (!d.ok) failures++;

  console.log(failures === 0 ? "\nWATCHDOG TESTS: ALL PASSED" : `\nWATCHDOG TESTS: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
