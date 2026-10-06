// agent-ctx/export-repro/verify-output-test.js — tests the REAL
// verifyExportOutputAsync from electron/main.js (sliced verbatim, evaluated
// with a stubbed probeMediaAsync + fs) against: missing file, tiny file,
// truncated duration, healthy file, and ffprobe-unavailable.
const fs = require("fs");
const path = require("path");
const os = require("os");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.js"), "utf8");
const start = src.indexOf("async function verifyExportOutputAsync");
const end = src.indexOf("\n}", src.indexOf("return size;", start)) + 2;
const fnSrc = src.slice(start, end);
if (!/EXPORT/.test(fnSrc) && !/no output file exists/.test(fnSrc)) throw new Error("bad slice");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-out-"));
// stub probeMediaAsync: duration controlled by a side map
const probeResults = new Map();
const probeMediaAsync = async (p) => probeResults.get(p) || { durationMs: 0 };
const factory = new Function("fs", "probeMediaAsync", fnSrc + "\nreturn verifyExportOutputAsync;");
const verify = factory(fs, probeMediaAsync);

async function case_(name, p, expectedSec, wantThrow, probeDurSec) {
  if (probeDurSec != null) probeResults.set(p, { durationMs: probeDurSec * 1000 });
  try {
    const size = await verify(p, expectedSec, "Export");
    if (wantThrow) { console.log(`FAIL ${name}: returned size ${size}, expected throw`); return 1; }
    console.log(`ok   ${name}: size ${size}`);
    return 0;
  } catch (e) {
    if (!wantThrow) { console.log(`FAIL ${name}: unexpected throw — ${e.message.slice(0, 140)}`); return 1; }
    console.log(`ok   ${name}: threw — ${e.message.split("\n")[0].slice(0, 140)}`);
    return 0;
  }
}

(async () => {
  let fails = 0;
  // 1. missing file
  fails += await case_("missing output", path.join(tmp, "nope.mp4"), 100, true);
  // 2. tiny husk
  const tiny = path.join(tmp, "tiny.mp4");
  fs.writeFileSync(tiny, Buffer.alloc(300, 0));
  fails += await case_("tiny husk (300B)", tiny, 100, true);
  // 3. truncated duration (good size, 41s vs 4140s expected)
  const trunc = path.join(tmp, "trunc.mp4");
  fs.writeFileSync(trunc, Buffer.alloc(4_000_000, 1));
  fails += await case_("truncated duration (41s vs 4140s)", trunc, 4140, true, 41);
  // 4. healthy (duration 4138s vs 4140s, within tolerance)
  const good = path.join(tmp, "good.mp4");
  fs.writeFileSync(good, Buffer.alloc(4_000_000, 1));
  fails += await case_("healthy (4138s vs 4140s)", good, 4140, false, 4138);
  // 5. probe unavailable (durationMs 0) but size fine → passes on size alone
  const noProbe = path.join(tmp, "noprobe.mp4");
  fs.writeFileSync(noProbe, Buffer.alloc(4_000_000, 1));
  fails += await case_("probe unavailable, size ok", noProbe, 4140, false, null);
  console.log(fails === 0 ? "\nVERIFY-OUTPUT TESTS: ALL PASSED" : `\nVERIFY-OUTPUT TESTS: ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
})();
