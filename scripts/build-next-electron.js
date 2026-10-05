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
//
// v1.28: `resources/` (the ~430 MB staged Windows ffmpeg.exe + DLLs) must
// ALSO leave the tree for the build window: with it present anywhere under
// the project root — even as a hidden sibling directory — the Next 16.3
// build worker's memory balloons past 3.4 GB and the container OOM-kills it
// mid-compile (reproduced deterministically; the same tree without it
// builds clean). The electron:build chain stages resources/ AFTER this
// step, but a previous session's staged copy lingers — so it is parked OUT
// of the tree (os.tmpdir(), cross-device-safe) and put back right after.
// electron-builder needs it only at PACKAGE time (extraResources), long
// after this script restores it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");

/** Move `rel` aside to a dot-sibling INSIDE the tree (crash-safe restore). */
function moveAsideInTree(rel, bakRel) {
  const dir = path.join(root, rel);
  const bak = path.join(root, bakRel);
  if (fs.existsSync(bak) && fs.existsSync(dir)) {
    console.error(
      `[build-next-electron] stale backup + live ${rel} both present — restore ${bakRel} manually first`,
    );
    process.exit(1);
  }
  if (fs.existsSync(bak)) {
    fs.renameSync(bak, dir);
    console.log(`[build-next-electron] restored ${rel} from stale backup`);
  }
  if (fs.existsSync(dir)) {
    fs.renameSync(dir, bak);
    console.log(`[build-next-electron] ${rel} moved aside for the build window`);
    return bak; // restore target marker
  }
  return null;
}

/** Park `dir` OUTSIDE the project tree (rename, cross-device copy fallback). */
function parkOutsideTree(rel) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return null;
  const parked = path.join(os.tmpdir(), `framefuse-${rel}-build-park`);
  fs.rmSync(parked, { recursive: true, force: true });
  try {
    fs.renameSync(dir, parked);
  } catch {
    // EXDEV (different filesystems) — copy then remove.
    fs.cpSync(dir, parked, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`[build-next-electron] ${rel} parked outside the tree (${parked})`);
  return parked;
}

const apiBak = moveAsideInTree(path.join("src", "app", "api"), path.join("src", ".app-api-electron-bak"));
const resourcesParked = parkOutsideTree("resources");

try {
  execSync("npx next build --webpack", { stdio: "inherit", cwd: root });
} finally {
  if (apiBak) {
    fs.renameSync(apiBak, path.join(root, path.join("src", "app", "api")));
    console.log("[build-next-electron] src/app/api restored");
  }
  if (resourcesParked) {
    const dest = path.join(root, "resources");
    try {
      fs.renameSync(resourcesParked, dest);
    } catch {
      fs.cpSync(resourcesParked, dest, { recursive: true });
      fs.rmSync(resourcesParked, { recursive: true, force: true });
    }
    console.log("[build-next-electron] resources/ restored");
  }
}
