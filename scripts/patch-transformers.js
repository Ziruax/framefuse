#!/usr/bin/env node
// scripts/patch-transformers.js — idempotent node_modules patch, run by the
// root `postinstall` hook (bun install / npm install).
//
// WHY: @xenova/transformers 2.17.2 src/env.js does
//   const FS_AVAILABLE = !isEmpty(fs);
// where isEmpty(obj) is Object.keys(obj).length === 0.
//   - webpack (browser field "fs": false) stubs `fs` as an EMPTY OBJECT →
//     Object.keys({}) === [] → FS_AVAILABLE = false. Fine.
//   - Turbopack (Next.js 16 dev server) stubs `fs` as `void 0` →
//     Object.keys(undefined) THROWS "Cannot convert undefined or null to
//     object" during module evaluation — which is exactly why Whisper
//     transcription failed in `next dev` ("Whisper transcription failed /
//     Cannot convert undefined or null to object") while the webpack-built
//     packaged app worked.
//
// The patch makes the availability checks null-safe, which is behavior-
// identical in every environment:
//   - Node/Electron native (real fs/path): `fs != null` → true, keys non-empty
//     → FS_AVAILABLE = true (unchanged).
//   - webpack browser stub ({}): `{} != null` → true, isEmpty → true → false
//     (unchanged).
//   - Turbopack stub (void 0): `undefined != null` → false → FS_AVAILABLE =
//     false — now WITHOUT throwing (the fix).
//
// The patch marker is the "FRAMEFUSE PATCH" comment, so the script is
// idempotent and safe to run repeatedly.

const fs = require("fs");
const path = require("path");

const TARGET = path.join(
  __dirname,
  "..",
  "node_modules",
  "@xenova",
  "transformers",
  "src",
  "env.js",
);

const ORIGINAL = `const FS_AVAILABLE = !isEmpty(fs); // check if file system is available
const PATH_AVAILABLE = !isEmpty(path); // check if path is available`;

const PATCHED = `// FRAMEFUSE PATCH (v5.2.1): null-safe availability checks. Some bundlers
// (Turbopack) replace \`import fs from 'fs'\` with \`void 0\` instead of the
// empty-object stub webpack's browser field produces — \`Object.keys(void 0)\`
// throws "Cannot convert undefined or null to object" at module evaluation.
const FS_AVAILABLE = fs != null && !isEmpty(fs); // check if file system is available
const PATH_AVAILABLE = path != null && !isEmpty(path); // check if path is available`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.log(
      "[patch-transformers] node_modules/@xenova/transformers not present — skipping (dev dependency install only?)",
    );
    return;
  }
  let src;
  try {
    src = fs.readFileSync(TARGET, "utf8");
  } catch (err) {
    console.warn(`[patch-transformers] could not read env.js: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (src.includes("FRAMEFUSE PATCH (v5.2.1)")) {
    console.log("[patch-transformers] already patched — nothing to do");
    return;
  }

  if (!src.includes(ORIGINAL)) {
    // The upstream file changed shape (version bump). Fail loudly so we
    // notice instead of silently shipping the Turbopack breakage again.
    console.warn(
      "[patch-transformers] env.js does not match the expected 2.17.2 source — " +
        "check whether @xenova/transformers was updated and whether the " +
        "Turbopack `void 0` stubbing issue still applies.",
    );
    return;
  }

  fs.writeFileSync(TARGET, src.replace(ORIGINAL, PATCHED), "utf8");
  console.log(
    "[patch-transformers] patched env.js (null-safe fs/path availability " +
      "checks — fixes Turbopack dev \"Cannot convert undefined or null to object\")",
  );
}

main();
