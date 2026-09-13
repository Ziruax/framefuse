#!/usr/bin/env node
// scripts/rcedit-native.js — FrameFuse v1.1 CI build tool.
//
// A pure-JS replacement for the `rcedit` Windows executable (which
// electron-builder runs under WINE on Linux). This sandbox's seccomp
// policy kills wine with SIGSYS (bad system call) — every rcedit
// invocation dies — so the exe's version resource + icon are edited
// NATIVELY with the `resedit` library (the same wine-free approach
// electron-builder 26+ adopted upstream; resedit is already present as
// a transitive dependency).
//
// CLI contract (a subset of rcedit's, sufficient for winPackager's args):
//   node rcedit-native.js <exe> [--set-version-string NAME VALUE]...
//                                 [--set-file-version X.Y.Z[.W]]
//                                 [--set-product-version X.Y.Z[.W]]
//                                 [--set-icon path.ico]
//
// Exits non-zero on any parse/write error. Version-resource edits and
// icon edits are both idempotent replacements of the existing entries.

"use strict";

const fs = require("fs");
const path = require("path");

// resedit is a transitive dep (electron-builder ecosystem); resolve
// against the project's node_modules from the repo root (script lives
// in <root>/scripts/).
const root = path.resolve(__dirname, "..");
const resedit = require(path.join(root, "node_modules", "resedit"));
const { NtExecutable, NtExecutableResource, Data, Resource } = resedit;

function fail(msg) {
  console.error(`rcedit-native: ${msg}`);
  process.exit(1);
}

function parseVersionParts(str) {
  const parts = String(str).split(".").map((n) => {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v)) fail(`invalid version component in "${str}"`);
    return Math.max(0, Math.min(65535, v));
  });
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) fail("usage: rcedit-native.js <exe> [rcedit options...]");

  const exePath = argv[0];
  if (!fs.existsSync(exePath)) fail(`no such file: ${exePath}`);

  const stringValues = {};
  let fileVersion = null;
  let productVersion = null;
  let iconPath = null;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set-version-string") {
      const name = argv[i + 1];
      const value = argv[i + 2];
      if (name === undefined || value === undefined) fail("--set-version-string needs NAME VALUE");
      stringValues[name] = value;
      i += 2;
    } else if (a === "--set-file-version") {
      fileVersion = argv[++i];
      if (fileVersion === undefined) fail("--set-file-version needs a version");
    } else if (a === "--set-product-version") {
      productVersion = argv[++i];
      if (productVersion === undefined) fail("--set-product-version needs a version");
    } else if (a === "--set-icon") {
      iconPath = argv[++i];
      if (iconPath === undefined) fail("--set-icon needs a path");
    } else {
      // Unknown flags (e.g. --set-requested-execution-level) are ignored
      // with a warning — the sandbox build does not need them.
      console.warn(`rcedit-native: ignoring unsupported option ${a}`);
      // Skip the flag's value if it looks like one (next token does not
      // start with --; only for known value-taking prefixes).
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && /--set-/.test(a)) {
        i += 1;
      }
    }
  }

  // Normalise rcedit's empty OriginalFilename to a sane value (rcedit
  // itself writes the empty string; resedit handles it fine either way).
  const exe = NtExecutable.from(fs.readFileSync(exePath));
  const res = NtExecutableResource.from(exe);

  // ── VERSION resource (RT_VERSION = 16) ──────────────────────────────
  const fv = fileVersion ? parseVersionParts(fileVersion) : [1, 0, 0, 0];
  const pv = productVersion ? parseVersionParts(productVersion) : fv.slice();
  const vi = Resource.VersionInfo.create({
    lang: 1033,
    fixedInfo: {
      fileVersionMS: (fv[0] << 16) | fv[1],
      fileVersionLS: (fv[2] << 16) | fv[3],
      productVersionMS: (pv[0] << 16) | pv[1],
      productVersionLS: (pv[2] << 16) | pv[3],
      fileFlagsMask: 0,
      fileFlags: 0,
      fileOS: 0x40004, // VOS_NT_WINDOWS32
      fileType: 1,     // VFT_APP
      fileSubtype: 0,
      fileDateMS: 0,
      fileDateLS: 0,
    },
    strings: [{
      lang: 1033,
      codepage: 1200,
      values: {
        // rcedit auto-fills FileVersion/ProductVersion from the numeric
        // versions when not given explicitly — mirror that.
        FileVersion: fv.join("."),
        ProductVersion: pv.join("."),
        ...stringValues,
      },
    }],
  });
  vi.outputToResourceEntries(res.entries);

  // ── ICON resources (RT_ICON = 3 / RT_GROUP_ICON = 14) ──────────────
  if (iconPath) {
    if (!fs.existsSync(iconPath)) fail(`no such icon: ${iconPath}`);
    const fileIcons = Data.IconFile.from(fs.readFileSync(iconPath)).icons;
    if (!fileIcons.length) fail(`no images inside ${iconPath}`);
    // Each IconFileItem already carries a RawIconItem in `.data` (the
    // icon bytes untouched — PNG-compressed entries pass through
    // byte-exact; Windows Vista+ loads PNG icons natively).
    const icons = fileIcons.map((ic) => ic.data);
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
  }

  res.outputResource(exe);
  const out = Buffer.from(exe.generate());
  fs.writeFileSync(exePath, out);
  console.log(
    `rcedit-native: ${path.basename(exePath)} — version ${fv.join(".")}, ` +
    `${Object.keys(stringValues).length} strings${iconPath ? ", icon replaced" : ""} ` +
    `(${out.length} bytes)`,
  );
}

main();
