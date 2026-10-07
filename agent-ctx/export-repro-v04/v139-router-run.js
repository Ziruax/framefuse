"use strict";
const fs = require("fs");
const RUST = require("../../electron/rust-engine-router.js");
const payload = JSON.parse(fs.readFileSync("/tmp/v139-payload.json", "utf8"));
const built = RUST.buildRustTimeline(payload);
if (built.error) { console.log("REFUSED:", built.error); process.exit(1); }
const json = JSON.stringify(built.timeline);
console.log("timeline JSON length:", json.length);
// find all nulls and their field names
const nulls = [];
const re = /"([A-Za-z0-9_]+)":(null|NaN)/g;
let m; while ((m = re.exec(json))) nulls.push({ field: m[1], col: m.index });
console.log("null/NaN fields:", JSON.stringify(nulls));
// show around column 1350
function show(col) {
  const from = Math.max(0, col - 140), to = Math.min(json.length, col + 60);
  console.log(`--- around col ${col} ---\n` + json.slice(from, to) + "\n" + " ".repeat(col - from) + "^");
}
show(1350);
// run the REAL engine
(async () => {
  try {
    const res = await require("../../rust-engine").exportVideo(json, "/tmp/v139-out.mp4", "", () => {});
    console.log("\nENGINE OK:", JSON.stringify({ frames: res.frames, engineUsed: res.engineUsed, dedup: res.dedup, wallMs: res.durationMs }));
  } catch (err) {
    console.log("\nENGINE FAILED:", err.message);
    const mm = String(err.message).match(/column (\d+)/);
    if (mm) show(Number(mm[1]));
  }
})();
