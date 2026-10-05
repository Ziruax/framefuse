// scripts/build-next-electron.js — static-export build step for the Electron shell.
//
// The web-preview API routes (src/app/api: tts/dub/ai) exist for `next dev`
// (the sandbox Preview Panel transport — no window.electronAPI there). Under
// production `output:"export"` (Electron loads out/index.html via file://)
// route handlers are NOT exportable — Next aborts with "export const dynamic
// force-static/revalidate not configured ... with output: export" on every
// handler, and POST handlers can never be exported.
//
// The packaged app talks IPC (electronAPI) exclusively, so the API folder is
// simply not part of the static bundle: move it aside, build, restore.
// `next dev` never runs this script — dev keeps the routes.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const apiDir = path.join(root, "src", "app", "api");
const bakDir = path.join(root, "src", ".app-api-electron-bak");

let moved = false;

if (fs.existsSync(bakDir) && fs.existsSync(apiDir)) {
  // A previous run crashed between restore steps and someone re-created api/.
  // Refuse to build rather than risk leaving the tree inconsistent.
  console.error(
    "[build-next-electron] stale backup + live api both present — restore src/.app-api-electron-bak manually first",
  );
  process.exit(1);
}
if (fs.existsSync(bakDir)) {
  // Crash aftermath: api/ was moved but never restored (the api dir itself is
  // gone). Restore it, then proceed with a fresh move below.
  fs.renameSync(bakDir, apiDir);
  console.log("[build-next-electron] restored api/ from stale backup");
}

if (fs.existsSync(apiDir)) {
  fs.renameSync(apiDir, bakDir);
  moved = true;
  console.log("[build-next-electron] src/app/api moved aside for static export");
}

try {
  execSync("npx next build --webpack", { stdio: "inherit", cwd: root });
} finally {
  if (moved) {
    fs.renameSync(bakDir, apiDir);
    console.log("[build-next-electron] src/app/api restored");
  }
}
