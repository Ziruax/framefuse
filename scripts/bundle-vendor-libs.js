// scripts/bundle-vendor-libs.js — bundles the v1.33 vendor packages
// (edge-tts-universal, groq-sdk) into self-contained CJS files under
// electron/vendor/, so the PACKAGED app can load them without node_modules
// (the build config deliberately packs ZERO node_modules into the ASAR —
// the app is otherwise dependency-free by design).
//
// Same bundling approach as build-gpu-worker.js: `bun build` (the repo's
// package manager as bundler), target=node, CJS output, everything inlined
// except Node built-ins and the ws native optionals (ws degrades gracefully
// without bufferutil/utf-8-validate — they are performance shims only).
//
// Runtime resolution (both directions):
//   electron/vendor/<name>.cjs   ← packaged app (no node_modules present)
//   node_modules/<name>          ← dev layout / smoke tests (first checked)
// The consumers (edge-tts.js, groq-fetch-adapter.js) require the vendor
// file DIRECTLY when it exists next to them — deterministic in the ASAR.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const vendorDir = path.join(root, "electron", "vendor");

const TARGETS = [
  {
    name: "edge-tts-universal",
    entry: path.join(root, "node_modules", "edge-tts-universal", "dist", "index.cjs"),
    externals: ["bufferutil", "utf-8-validate", "fsevents"],
  },
  {
    name: "groq-sdk",
    entry: path.join(root, "node_modules", "groq-sdk", "index.js"),
    externals: [],
  },
];

fs.mkdirSync(vendorDir, { recursive: true });
let failed = 0;
for (const t of TARGETS) {
  if (!fs.existsSync(t.entry)) {
    console.error(`[vendor] MISSING entry for ${t.name}: ${t.entry}`);
    failed++;
    continue;
  }
  const out = path.join(vendorDir, `${t.name}.cjs`);
  const args = [
    "build",
    t.entry,
    "--target", "node",
    "--format", "cjs",
    "--outfile", out,
    "--external", "electron",
    "--external", "fsevents",
    ...t.externals.flatMap((e) => ["--external", e]),
  ];
  const r = spawnSync("bun", args, { stdio: ["ignore", "pipe", "pipe"], cwd: root });
  if (r.status !== 0) {
    console.error(`[vendor] FAILED to bundle ${t.name}:\n${(r.stderr || r.stdout || "").toString().slice(0, 2000)}`);
    failed++;
    continue;
  }
  // Strip the sourcemap annotation line if any (keeps the file loadable
  // under plain node --check and avoids the .map dependency).
  let txt = fs.readFileSync(out, "utf8");
  txt = txt.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
  fs.writeFileSync(out, txt);
  const size = fs.statSync(out).size;
  console.log(`[vendor] ${t.name} → electron/vendor/${t.name}.cjs (${(size / 1024).toFixed(0)} KB)`);
}
if (failed > 0) {
  console.error(`[vendor] ${failed} bundle(s) FAILED — BUILD STOPPED`);
  process.exit(1);
}
console.log("[vendor] all vendor bundles OK");
