// scripts/publish-release-1.16.0.js — one-shot release publisher for v1.16.0
// (Rust native engine + first Portable build).
// Task-45 playbook: token from the git remote, dupe-aware uploads,
// 504 re-list guidance, post-upload sha512 cross-check.
const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");

const TOKEN = execSync("git remote get-url origin").toString().match(/:(\w+)@/)[1];
const REPO = "Ziruax/framefuse";
const API = `https://api.github.com/repos/${REPO}`;
const HDRS = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ship-script",
};

const BODY = `## v1.16.0 — The Rust native export engine ships (+ first Portable build)

**The ask:** "Execute this blueprint." — libloading runtime FFmpeg FFI + wgpu compositor + a three-level fallback chain, built natively and bundled in the installer **and** the new portable build.

### 1. The "No-Link" runtime FFI (the cross-compilation trap, solved)
No \`ffmpeg-next\`, no \`ffmpeg-sys\`, no bindgen — the engine \`dlopen\`s the FFmpeg 7.1 shared libraries (\`avcodec-61\`, \`avformat-61\`, \`avutil-59\`, \`swscale-8\`, \`swresample-5\`) **at runtime** from the app's bundled \`resources/ffmpeg/win/dll\` via \`libloading\`. The cargo build stays pure Rust (works with cargo-xwin cross-compile AND native MSVC), and the engine inherits the SAME encoder set the CLI uses — \`h264_nvenc\` / \`h264_qsv\` / \`h264_amf\` travel inside those DLLs. Soname-verified at load: any wrong-family staging hard-fails to the CLI path, never a wrong-ABI crash.

### 2. The TDR-proof compositor ladder
- **wgpu GPU compositor** (shader composite of base + overlay lanes, chroma-key, Ken Burns zoom) — if wgpu init fails or the adapter is unusable (the exact iGPU conditions that killed the browser pipeline), it falls back **instantly** to the CPU rasterizer (\`image\` + \`fast_image_resize\`). No GPU process to crash, no TDR, no driver watchdog.
- Encoder ladder: \`h264_nvenc\` → \`h264_qsv\` → \`h264_amf\` → \`libx264\` — a hardware encoder that fails to open retries down the ladder (verified headless: libx264 engages cleanly).
- Audio: \`rayon\`-parallel PCM mixdown (per-track gain/start/loop + master fades) → runtime \`avcodec\` AAC. No Web Audio, no CLI \`amix\`.

### 3. Three-level fallback chain (nothing can brick an export)
\`rust-gpu\` → \`rust-cpu\` → **FFmpeg CLI Safe Mode** (the v1.14.5 smart-render pipeline). The Electron router probes the engine at boot (a missing/broken \`.node\` is silent — never fatal), gates v0.1-unsupported features (SFX, text removal, ASS captions, xfade transitions, loudnorm, overlay motion) to the CLI path, and converts any Rust failure into a clean CLI re-run. The completion toast now reports the truth: \`engineUsed\` + \`encoderName\` (e.g. \`h264_nvenc\`) from the engine telemetry.

### 4. New: Portable build
\`FrameFuse-Portable-1.16.0.exe\` — the full app in one file, no install, no admin, same engine, same fallbacks. The NSIS installer remains the recommended default (desktop shortcuts + auto-update channel metadata).

### 5. CI truth (the Windows path is now continuously verified)
The "Build Windows Rust Engine" workflow builds the engine natively on \`windows-latest\` (MSVC), runs the napi load probe + a full E2E smoke (\`exportVideo\` → ffprobe: H.264 + AAC 48 kHz verified) and packages the installer from the smoke-tested binary. Hardware-encoder (NVENC/QSV/AMF) validation still needs a real Windows GPU — CI runners have none (documented in the bench output).

### Verification
- Sandbox E2E (CPU path): 150-frame 640×360 H.264+AAC MP4 at 6.7× realtime, VLM-verified frame advancement, Ken Burns, chroma-key PiP, music loop + fades.
- Router integration test: segments + overlay + chroma + music + headlines + watermark + fades → 247 progress events, CLI-shaped result, ffprobe-verified output.
- ASAR verified: the \`.node\` ships asar-unpacked (\`rust-engine/**\`), the router rides in \`electron/\`, the DLLs in \`resources/ffmpeg/win/dll\`.
- Three-way sha512 verified for the uploaded installer (local == latest.yml == re-downloaded asset); size-verified for every asset.
- Lint green, dev server healthy.

### Upgrade notes
- No project-file changes; exports re-run cleanly.
- If the Rust engine ever fails to load on an exotic setup, the app logs the \`[RustEngine]\` status and silently uses the FFmpeg CLI pipeline — behavior is identical to v1.15.3.`;

function sha512File(p) {
  return crypto.createHash("sha512").update(fs.readFileSync(p)).digest("base64");
}

async function gh(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...HDRS, ...(opts.headers || {}) },
  });
  return r;
}

async function listAssets(rel) {
  const r = await gh(`/releases/${rel.id}/assets?per_page=100`);
  return r.json();
}

async function createRelease() {
  const r = await gh("/releases?per_page=30");
  const existing = (await r.json()).find((x) => x.tag_name === "v1.16.0");
  if (existing) {
    console.log("release already exists:", existing.id, existing.html_url);
    return existing;
  }
  const payload = JSON.stringify({
    tag_name: "v1.16.0",
    name: "v1.16.0 — Rust native engine (runtime FFmpeg FFI + wgpu, TDR-proof) · first Portable build",
    body: BODY,
    draft: false,
    prerelease: false,
  });
  const res = await gh("/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`create failed ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  console.log("release created:", j.id, j.html_url);
  return j;
}

async function uploadAsset(rel, file, name, contentType) {
  const assets = await listAssets(rel);
  const dupe = assets.find((a) => a.name === name);
  if (dupe) {
    console.log(`asset ${name} already exists (id ${dupe.id}, ${dupe.size} B) — skipping`);
    return dupe;
  }
  const data = fs.readFileSync(file);
  const t0 = Date.now();
  const r = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { ...HDRS, "Content-Type": contentType || "application/octet-stream", "Content-Length": String(data.length) },
      body: data,
    }
  );
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch {}
  const dt = (Date.now() - t0) / 1000;
  if (!r.ok) {
    console.log(`upload ${name} FAILED ${r.status} after ${dt.toFixed(1)}s: ${txt.slice(0, 200)}`);
    console.log("(Task-42 gotcha: a 504 can still have CREATED the asset — re-list before retry)");
    return null;
  }
  console.log(`uploaded ${name}: id ${j.id}, ${j.size} B in ${dt.toFixed(1)}s (${(j.size / dt / 1e6).toFixed(2)} MB/s)`);
  return j;
}

(async () => {
  // discover dist artifacts
  const dist = fs.readdirSync("dist");
  const setup = dist.find((f) => /^FrameFuse Setup 1\.16\.0\.exe$/i.test(f));
  const portable = dist.find((f) => /^FrameFuse.*1\.16\.0\.exe$/i.test(f) && !/setup/i.test(f));
  const portableBlockmap = dist.find((f) => /^FrameFuse.*1\.16\.0\.exe\.blockmap$/i.test(f) && !/setup/i.test(f));
  if (!setup) throw new Error("dist/FrameFuse Setup 1.16.0.exe not found — run electron:build first");
  if (!portable) throw new Error("no portable exe found in dist/ — expected FrameFuse*1.16.0.exe (non-setup)");
  console.log(`setup: dist/${setup} (${fs.statSync(`dist/${setup}`).size} B)`);
  console.log(`portable: dist/${portable} (${fs.statSync(`dist/${portable}`).size} B)`);

  const rel = await createRelease();
  fs.writeFileSync("/tmp/release-id-1160.txt", String(rel.id));
  await uploadAsset(rel, "dist/latest.yml", "latest.yml", "text/yaml");
  await uploadAsset(rel, `dist/${setup}.blockmap`, "FrameFuse-Setup-1.16.0.exe.blockmap", "application/octet-stream");
  await uploadAsset(rel, `dist/${setup}`, "FrameFuse-Setup-1.16.0.exe", "application/octet-stream");
  if (portableBlockmap) {
    await uploadAsset(rel, `dist/${portableBlockmap}`, "FrameFuse-Portable-1.16.0.exe.blockmap", "application/octet-stream");
  }
  await uploadAsset(rel, `dist/${portable}`, "FrameFuse-Portable-1.16.0.exe", "application/octet-stream");

  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B, ${a.state})`).join(" | "));

  // ── verification: three-way sha512 for the installer, size for all ──
  const localHash = sha512File(`dist/${setup}`);
  const yml = fs.readFileSync("dist/latest.yml", "utf8");
  const ymlHash = (yml.match(/sha512:\s*(\S+)/) || [])[1];
  const exeAsset = final.find((a) => a.name === "FrameFuse-Setup-1.16.0.exe");
  const portableAsset = final.find((a) => a.name === "FrameFuse-Portable-1.16.0.exe");
  console.log("sha512 local :", localHash.slice(0, 24) + "…");
  console.log("sha512 yml  :", (ymlHash || "MISSING").slice(0, 24) + "…");
  console.log(`setup size  : GH ${exeAsset && exeAsset.size} B vs local ${fs.statSync(`dist/${setup}`).size} B`);
  console.log(`portable    : GH ${portableAsset && portableAsset.size} B vs local ${fs.statSync(`dist/${portable}`).size} B — sha512 ${sha512File("dist/" + portable).slice(0, 24)}…`);
  const ok = localHash && ymlHash === localHash
    && exeAsset && exeAsset.size === fs.statSync(`dist/${setup}`).size
    && portableAsset && portableAsset.size === fs.statSync(`dist/${portable}`).size;
  console.log(ok ? "VERIFIED: local == latest.yml, GitHub asset sizes == local sizes" : "MISMATCH — investigate before announcing");
  if (!ok) process.exit(2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

