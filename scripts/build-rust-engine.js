// scripts/build-rust-engine.js — build the Rust native engine (.node) and
// stage it where the loader (rust-engine/index.js) finds it.
//
// Local (this sandbox / Linux dev):
//   node scripts/build-rust-engine.js
//     → cargo build --release → rust-engine/framefuse-engine.linux-x64.node
//
// Windows (CI runs this natively — cargo + MSVC):
//   node scripts/build-rust-engine.js
//     → cargo build --release --target x86_64-pc-windows-msvc
//     → rust-engine/framefuse-engine.win32-x64.node
//
// The binary ships inside the app: package.json build.asarUnpack carries
// "rust-engine/**" (napi .node files cannot load from inside asar), and
// the loader also probes app.asar.unpacked/rust-engine for the packaged
// layout.
//
// Env knobs:
//   RUST_ENGINE_SKIP=1      → no-op (CI matrix legs without Rust)
//   RUST_ENGINE_NO_GPU=1    → build with --no-default-features (CPU-only,
//                             skips wgpu — useful for quick cross checks)

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENGINE_DIR = path.join(ROOT, "rust-engine");
const TARGET_TRIPLE =
  process.platform === "win32" ? "x86_64-pc-windows-msvc" : null;

function log(msg) {
  console.log(`[build-rust-engine] ${msg}`);
}

function resolveCargo() {
  const candidates = [process.env.CARGO, "cargo"].filter(Boolean);
  // rustup default install location (not on PATH for GUI/spawned processes)
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    candidates.push(path.join(home, ".cargo", "bin", "cargo"));
    candidates.push(path.join(home, ".cargo", "bin", "cargo.exe"));
  }
  for (const c of candidates) {
    try {
      const probe = spawnSync(c, ["--version"], { encoding: "utf8" });
      if (probe.status === 0) return c;
    } catch {}
  }
  throw new Error("cargo not found — install the Rust toolchain (https://rustup.rs)");
}

function main() {
  if (process.env.RUST_ENGINE_SKIP === "1") {
    log("RUST_ENGINE_SKIP=1 — skipping");
    return;
  }
  const cargo = resolveCargo();
  const args = ["build", "--release"];
  if (TARGET_TRIPLE) args.push("--target", TARGET_TRIPLE);
  if (process.env.RUST_ENGINE_NO_GPU === "1") args.push("--no-default-features");

  log(`cargo ${args.join(" ")} (cwd=${ENGINE_DIR})`);
  const res = spawnSync(cargo, args, { cwd: ENGINE_DIR, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`cargo build failed with status ${res.status}`);
  }

  // cdylib artifact → napi .node naming
  const outDir = path.join(
    ENGINE_DIR,
    "target",
    ...(TARGET_TRIPLE ? [TARGET_TRIPLE, "release"] : ["release"]),
  );
  const built = process.platform === "win32"
    ? path.join(outDir, "framefuse_engine.dll")
    : path.join(outDir, "libframefuse_engine.so");
  const dest = path.join(
    ENGINE_DIR,
    `framefuse-engine.${process.platform}-${process.arch}.node`,
  );
  if (!fs.existsSync(built)) {
    throw new Error(`cargo artifact missing: ${built}`);
  }
  fs.copyFileSync(built, dest);
  const size = fs.statSync(dest).size;
  log(`staged ${path.relative(ROOT, dest)} (${(size / 1024 / 1024).toFixed(1)} MB)`);

  // quick load probe — a broken binary must fail HERE, not in the app
  const probe = spawnSync(
    process.execPath,
    ["-e", "const e=require('./index.js'); if(!e.available()) { console.error('LOAD FAILED:', e.loadError()); process.exit(1);} console.log('probe ok:', e.engineVersion());"],
    { cwd: ENGINE_DIR, encoding: "utf8" },
  );
  if (probe.status !== 0) {
    throw new Error(`napi load probe failed: ${probe.stdout} ${probe.stderr}`);
  }
  log(probe.stdout.trim());
}

main();
