// scripts/patch-electron-builder.js — FrameFuse v1.1 CI durability patch.
//
// The Windows NSIS installer is cross-built on this Linux sandbox, where
// the seccomp policy kills WINE with SIGSYS (bad system call). Two
// node_modules patches keep the build working without wine EXECUTION:
//
//   1. app-builder-lib/out/targets/nsis/NsisTarget.js — extract the NSIS
//      uninstaller NATIVELY on Linux (the macOS Catalina code path:
//      UninstallerReader parses the NSIS binary instead of executing the
//      installer under wine).
//
//   2. app-builder-lib/out/winPackager.js — edit the exe's version
//      resource + icon NATIVELY via the project's scripts/rcedit-native.js
//      (resedit) instead of running rcedit-ia32.exe under wine.
//
// Both patches are IDEMPOTENT (marker-comment detection) and loudly no-op
// when the upstream file shape changes (patch-transformers.js pattern).
// Run automatically by the root "postinstall" so `bun install` /
// `npm install` re-applies them.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let applied = 0;

function patch(relPath, find, replace, marker, name) {
  const p = path.join(ROOT, "node_modules", relPath);
  if (!fs.existsSync(p)) {
    console.warn(`[patch-electron-builder] ${name}: SKIP — ${relPath} not found`);
    return;
  }
  let src = fs.readFileSync(p, "utf8");
  if (src.includes(marker)) {
    console.log(`[patch-electron-builder] ${name}: already applied`);
    return;
  }
  if (!src.includes(find)) {
    console.warn(`[patch-electron-builder] ${name}: SKIP — upstream shape changed (pattern not found)`);
    return;
  }
  src = src.replace(find, replace);
  fs.writeFileSync(p, src);
  applied += 1;
  console.log(`[patch-electron-builder] ${name}: patched`);
}

// ── Patch 1: NsisTarget.js — native uninstaller extraction on Linux ────
patch(
  "app-builder-lib/out/targets/nsis/NsisTarget.js",
  "if ((0, macosVersion_1.isMacOsCatalina)()) {",
  "if ((0, macosVersion_1.isMacOsCatalina)() || process.platform === \"linux\") {",
  'isMacOsCatalina)() || process.platform === "linux")',
  "nsis-uninstaller-native",
);

// ── Patch 2: winPackager.js — native rcedit via resedit on Linux ──────
patch(
  "app-builder-lib/out/winPackager.js",
  `        else if (this.info.framework.name === "electron") {
            const vendorPath = await (0, windowsSignToolManager_1.getSignVendorPath)();
            await (0, wine_1.execWine)(path.join(vendorPath, "rcedit-ia32.exe"), path.join(vendorPath, "rcedit-x64.exe"), args);
        }`,
  `        else if (this.info.framework.name === "electron") {
            // PATCH (FrameFuse v1.1 CI): the build sandbox's seccomp policy
            // kills wine with SIGSYS, so rcedit cannot run. Edit the exe's
            // version resource + icon NATIVELY with resedit via the
            // project's scripts/rcedit-native.js (same rcedit CLI subset).
            await new Promise((resolve, reject) => {
                const { execFile } = require("child_process");
                execFile(process.execPath, [path.join(__dirname, "..", "..", "..", "scripts", "rcedit-native.js"), ...args], { maxBuffer: 1024 * 1024 * 1024 }, (error, stdout, stderr) => {
                    if (stdout) { process.stdout.write(stdout); }
                    if (error) { reject(new Error("rcedit-native failed: " + (stderr || error.message))); } else { resolve(); }
                });
            });
        }`,
  "rcedit-native.js",
  "winpackager-rcedit-native",
);

if (applied === 0) {
  console.log("[patch-electron-builder] nothing to do");
}
