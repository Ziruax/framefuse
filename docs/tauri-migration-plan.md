# FrameFuse — Electron → Tauri v2 Migration Plan (SAVED, NOT YET EXECUTED)

> Saved per user request (Task 44 round). Status: **deferred** — see "Why deferred"
> at the bottom. This plan is the reference for the migration window.

## Objective

Migrate FrameFuse from Electron to Tauri v2.

Key goals:
1. Reduce package/installer size from ~377 MB to <50 MB (excluding bundled FFmpeg binaries).
2. Reduce idle RAM consumption from ~600 MB to <100 MB.
3. Replace Electron's Node runtime and IPC with Tauri v2 Rust commands and sidecar processes.
4. **CRITICAL GUARDRAIL:** Preserve all existing export intelligence: the 3-Tier Hardware Profiler, Smart-Rendering segment planner, keyframe-snapping math, temporal slice chunking, B-frame duration compensations, and concat demuxer assembly.

Execute in 6 sequential phases. Do not skip phases. Verify each phase before proceeding.

---

### Phase 1: Next.js Static Export Configuration (Zero Server Dependencies)

Tauri does not run a background Node.js server. The Next.js frontend must compile to pure static files (`out/`).

1. Update `next.config.mjs`:

```javascript
const isProd = process.env.NODE_ENV === 'production';
const internalHost = process.env.TAURI_DEV_HOST || 'localhost';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
  trailingSlash: true,
};

export default nextConfig;
```

2. Frontend code audit: scan `src/` for direct Node.js built-in imports; decouple into IPC calls. `npm run build` must generate `out/index.html` cleanly.

---

### Phase 2: Tauri v2 Scaffold & Plugin Setup

```bash
npm install --save-dev @tauri-apps/cli@^2.0.0
npm install @tauri-apps/api@^2.0.0 @tauri-apps/plugin-shell@^2.0.0 @tauri-apps/plugin-dialog@^2.0.0 @tauri-apps/plugin-opener@^2.0.0 @tauri-apps/plugin-fs@^2.0.0 @tauri-apps/plugin-os@^2.0.0
```

`npx tauri init`: app `framefuse`, window title `FrameFuse Studio`, assets `../out`,
devUrl `http://localhost:3000`, dev `npm run dev`, build `npm run build`.

`src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-opener = "2"
tauri-plugin-fs = "2"
tauri-plugin-os = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
sysinfo = "0.30"
```

`src-tauri/tauri.conf.json`:

```json
{
  "productName": "FrameFuse",
  "version": "1.13.0",
  "identifier": "com.ziruax.framefuse",
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:3000",
    "frontendDist": "../out"
  },
  "app": {
    "windows": [{
      "title": "FrameFuse Studio",
      "width": 1280, "height": 800, "minWidth": 960, "minHeight": 600,
      "resizable": true, "fullscreen": false, "decorations": true
    }],
    "security": { "csp": null, "capabilities": ["default"] }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "externalBin": ["binaries/ffmpeg", "binaries/ffprobe"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.ico"]
  }
}
```

`src-tauri/capabilities/default.json`:

```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default", "shell:default", "shell:allow-execute",
    "dialog:default", "opener:default", "fs:default", "os:default"
  ]
}
```

---

### Phase 3: External Binary Sidecars Setup (FFmpeg & FFprobe)

Sidecars need host target-triple naming. `scripts/prepare-sidecars.js` copies
`bin/ffmpeg(.exe)` + `bin/ffprobe(.exe)` to `src-tauri/binaries/<name>-<triple>(.exe)`
(host triple from `rustc -vV`).

```json
"scripts": {
  "prepare:sidecars": "node scripts/prepare-sidecars.js",
  "tauri:dev": "npm run prepare:sidecars && tauri dev",
  "tauri:build": "npm run prepare:sidecars && tauri build"
}
```

---

### Phase 4: Rust Backend Implementation (`src-tauri/src/`)

Keep timeline calculation logic in TypeScript; delegate process execution,
hardware profiling, and filesystem coordination to Rust.

- `system.rs`: `get_system_hardware` command via `sysinfo` (cpu_count, cpu_model,
  total_memory_mb).
- `ffmpeg.rs`: `run_ffmpeg_sidecar` command — spawns the sidecar, streams stderr
  lines to the frontend via `app.emit(channel, line)`, honors a `CANCEL_FLAG`
  AtomicBool (`cancel_export` command), exits non-zero → `Err(last_error_log)`.
- `main.rs`: builder with the 5 plugins + `generate_handler![system::get_system_hardware,
  ffmpeg::run_ffmpeg_sidecar, ffmpeg::cancel_export]`, `windows_subsystem = "windows"`.

Full Rust listings are in the original plan (kept verbatim in git history /
this doc's source message).

---

### Phase 5: Frontend IPC Bridge Replacement

Replace `window.electronAPI` with a unified Tauri client adapter
(`src/lib/ipc/tauriBridge.ts`):

- `getAppInfo()` — version + hardware via `invoke('get_system_hardware')`.
- `runFFmpeg(args, onProgress)` — unique `ffmpeg-progress-<ts>-<rand>` event
  channel, `listen()` before `invoke('run_ffmpeg_sidecar')`, unlisten in `finally`.
- `cancelExport()`, `showSaveDialog()` (save dialog w/ MP4 filter),
  `openFile()` (openPath), `showInFolder()` (revealItemInDir).

Adapt `src/lib/merger/native.ts`: swap `window.electronAPI.exportNative` /
`runJob` to `tauriBridge.runFFmpeg`; keep `planSmartSegments()` and timeline
chunking intact; parallel chunks via `Promise.all()` per active tier.
Header reads `tauriBridge.getAppInfo()`; ExportModal uses dialog/opener.

---

### Phase 6: Electron Removal & Final Verification

1. `npm uninstall electron electron-builder`
2. Delete `electron/` + preload scripts.
3. `npm run tauri:dev` boots with static assets; 19-minute export via parallel
   sidecar workers with clean audio sync.
4. `npm run tauri:build` → `src-tauri/target/release/bundle/` installer <50 MB
   (excluding FFmpeg).

### Why this approach is safest

- **Preserves Math & Timelines:** Rewriting 3,000 lines of delicate
  keyframe-snapping, B-frame math, and ASS subtitle generation into Rust in one
  go is where bugs happen. Keeping the planner in TypeScript and having Rust
  strictly manage the sidecar child processes gives the benefits of Tauri (zero
  Electron RAM bloat, small bundle size) with zero risk to the export
  calculations.

---

## Why deferred (Task 44 decision log)

1. **The user's acute pains are runtime-independent.** The export-speed complaint
   is an orchestration-shape issue inside `electron/main.js` /
   `electron/export-singlepass.js` (worker pool + audio-pass concurrency) — the
   same logic would run identically under Tauri sidecars. Fixing it first
   benefits users NOW; migrating shells first would just move the bug.
2. **This sandbox cannot produce a Windows Tauri build.** The dev box is Linux
   without the Rust/MSVC cross-compile chain; `tauri build` for
   `x86_64-pc-windows-msvc` from Linux is not supported. Shipping Windows
   installers (the product's only channel) would be blocked.
3. **The Node export engine is ~200 KB of battle-tested code** (singlepass
   planner, keyframe snapping, B-frame compensation, concat assembly, whisper
   staging). A one-session rewrite risks the exact export quality the user is
   currently complaining about.

**Sequencing decision (v1.14.2, Task 44):** fix speed + ETA + desktop-only
clarity in the Electron line first; execute this plan in a dedicated migration
window on a Windows-capable build machine.
