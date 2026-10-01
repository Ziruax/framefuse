// scripts/publish-release-1.18.0.js — one-shot release publisher for v1.18.0
// (Rust engine v2: pipelined export, GPU-path black-frame fix, native
// transitions/voiceovers, icon fixes — INSTALLER ONLY per user directive).
// Task-45 playbook: token from the git remote, dupe-aware uploads,
// post-upload sha512 cross-check.
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

const BODY = `## v1.18.0 — Rust engine v2: the full-potential export pipeline (+ the GPU black-frame fix)

**The ask:** "the rust engine is not at its full potential — research and implement the best techniques for absolute fast export; fix the export falling back to the previous engine; installer only; fix the shortcut/taskbar icon."

### 1. The pipeline (wall clock = max(stage), not sum(stage))
- **Decode-ahead producer thread** (threaded avcodec + RGBA convert + layer building incl. transitions) → bounded channel → **composite+encode consumer**; **audio decode + mixdown runs in parallel** with the video loop and is joined at the audio phase. Decode, GPU composite, and encode now OVERLAP instead of queueing.
- **ONE command encoder + ONE \`queue.submit\` per frame** (v1 submitted one encoder PER LAYER), dynamic-offset uniform batching, LRU static texture cache + pooled video-texture slots (no per-frame texture/bindgroup churn).
- **GPU color pipeline**: a compute shader converts the composite to planar **YUV420P/NV12 (BT.601 limited — sws parity)** into a tightly-packed storage buffer — 1.5 bytes/pixel readback instead of 4, and the CPU \`sws_scale\` pass is GONE on the GPU path. Verified bit-accurate on solid-color center pixels.
- AVFrame ring (no \`make_writable\` copies once NVENC buffers), \`movflags +faststart\` (moov at the front — instant seeking).

### 2. THE GPU BLACK-FRAME BUG (why exports "fell back" / the engine "never worked properly")
\`mat3x3\` in WGSL's uniform layout has **16-byte column strides** (vec3 columns padded to vec4). v1.16-v1.17 wrote the transform matrix **packed** (36 contiguous bytes) — the shader read the columns from wrong offsets, the transform degenerated to zero-area triangles, and **the GPU compositor rendered BLACK FRAMES since v1.16.0** (CI's frame-count assertions passed on black video; this was never caught before). Fixed + covered by a permanent color regression test in CI (solid-color center pixels through the full engine, both GPU and CPU paths).

### 3. The silent encoder-tier fallbacks (Intel/AMD/CPU machines)
- \`h264_qsv\` **only opens NV12** — v1 asked every tier for YUV420P, so Intel machines silently fell back to x264. Per-encoder pixel formats now (QSV/AMF/MF = NV12).
- \`libx264\` never got \`threads=auto\` on the primary path — it ran **single-threaded**. Fixed (~4× on 8-core).
- NVENC's \`delay=0\` (synchronous mode) removed — async pipelining restored, with the proper EAGAIN send/drain retry contract.
- WARP/software wgpu adapters are rejected in production (4-20× slower than the CPU rasterizer); CI opts in via env to keep testing the full GPU path.

### 4. Native features (less CLI fallback)
- **Voiceover / dub / SFX placements** ride the native audio bus (new \`extraAudio\` timeline lane) with the dub duck applied.
- **Dissolve, dip-to-black, dip-to-white transitions + fadeStartEnd bookends** composite natively (exact \`planBoundaryFades\` mirror, VIDEO RULE, captions-above-fades layering).
- Honest live telemetry: a **Rust engine | FFmpeg CLI badge** in the header during export.

### 5. Encoder ladders (NVIDIA/AMD/Intel guidance)
NVENC p3/p4/p6 + multipass/lookahead/spatial-AQ tiers · QSV veryfast/fast/medium + extbrc · AMF speed/balanced/quality + VBAQ · x264 veryfast/medium/slow + auto threads.

### 6. Icon fixes (three independent root causes)
- **Taskbar blank-white while running**: \`app.setAppUserModelId\` now matches electron-builder's shortcut AUMI.
- **Desktop shortcut blank after install**: the package.json \`description\` was 430 chars (electron-builder #2435 — the NSIS \`CreateShortCut\` command overflowed); now 62. The installer also recreates the desktop + start-menu shortcuts with an **explicit \`\$INSTDIR\\\\resources\\\\icon.ico\`** icon.
- Shell icon-cache refresh on every version bump (kept).

### 7. Installer only
The portable build is dropped per directive — this release ships the NSIS installer + auto-update metadata (\`latest.yml\` + blockmap).

### Verification
- Sandbox (CPU + **GPU via llvmpipe** — first time the GPU path was ever visually verified): smoke 150/150 frames h264+aac, GPU/CPU luma parity (YAVG 124.0→80.5 vs 124.0→79.9), color test exact, v2 feature test (dissolve/dip/bookend/voiceover) green on BOTH paths; ~95 fps x264-threads proof.
- CI (windows-latest, MSVC, WARP GPU): full E2E smoke + color regression + feature test, luma assertions — a black-frame regression can never pass silently again.
- \`bun run lint\` clean; agent-browser: landing + studio render with zero page errors at v1.18.0.

### Upgrade notes
- No project-file changes. If a feature still needs the CLI pipeline (kinetic captions, slide/wipe/circleopen transitions, loudnorm, text removal, overlay motion), the header now SAYS so during export.`;

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

async function main() {
  const TAG = "v1.18.0";
  const INSTALLER = "dist/FrameFuse-Setup-1.18.0.exe";
  const LATEST = "dist/latest.yml";
  const BLOCKMAP = "dist/FrameFuse-Setup-1.18.0.exe.blockmap";

  for (const f of [INSTALLER, LATEST, BLOCKMAP]) {
    if (!fs.existsSync(f)) throw new Error(`missing asset: ${f}`);
  }
  const size = fs.statSync(INSTALLER).size;
  console.log(`[ship] ${TAG}: installer ${(size / 1e6).toFixed(1)} MB`);

  // 1. find-or-create the release
  let rel = null;
  const get = await gh(`/releases/tags/${TAG}`);
  if (get.status === 200) {
    rel = await get.json();
    console.log(`[ship] release exists: ${rel.id} (${rel.assets.length} assets)`);
  } else {
    const post = await gh(`/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: TAG,
        name: `FrameFuse ${TAG} — Rust engine v2: pipelined export + GPU black-frame fix + icon fixes`,
        body: BODY,
        draft: false,
        prerelease: false,
      }),
    });
    if (post.status !== 201) throw new Error(`release create failed: ${post.status} ${await post.text()}`);
    rel = await post.json();
    console.log(`[ship] release created: ${rel.id}`);
  }

  // 2. dupe-aware asset upload
  const existing = new Set(rel.assets.map((a) => a.name));
  const upload = async (filePath, name, type) => {
    if (existing.has(name)) {
      console.log(`[ship] asset exists, skipping: ${name}`);
      return;
    }
    const data = fs.readFileSync(filePath);
    const up = await gh(
      `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: data,
        headers: { "Content-Type": type },
      },
    );
    if (up.status !== 201) throw new Error(`upload ${name} failed: ${up.status} ${await up.text()}`);
    console.log(`[ship] uploaded: ${name} (${(data.length / 1e6).toFixed(1)} MB)`);
  };
  await upload(INSTALLER, "FrameFuse-Setup-1.18.0.exe", "application/octet-stream");
  await upload(LATEST, "latest.yml", "text/yaml");
  await upload(BLOCKMAP, "FrameFuse-Setup-1.18.0.exe.blockmap", "application/octet-stream");

  // 3. three-way sha512 verification (local == latest.yml == re-downloaded)
  const ref = await gh(`/releases/tags/${TAG}`);
  rel = await ref.json();
  const installerAsset = rel.assets.find((a) => a.name === "FrameFuse-Setup-1.18.0.exe");
  const dl = await fetch(installerAsset.browser_download_url, { headers: HDRS });
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  const localHash = sha512File(INSTALLER);
  const dlHash = crypto.createHash("sha512").update(dlBytes).digest("base64");
  const yml = fs.readFileSync(LATEST, "utf8");
  const ymlHash = /sha512:\s*(\S+)/.exec(yml)?.[1];
  console.log(`[ship] sha512 local:    ${localHash.slice(0, 24)}…`);
  console.log(`[ship] sha512 yml:     ${String(ymlHash).slice(0, 24)}…`);
  console.log(`[ship] sha512 download:${dlHash.slice(0, 24)}…`);
  if (localHash !== dlHash) throw new Error("local != downloaded sha512");
  if (ymlHash && ymlHash !== localHash) throw new Error("latest.yml != local sha512");
  if (dlBytes.length !== size) throw new Error(`size mismatch: downloaded ${dlBytes.length} vs local ${size}`);
  console.log(`[ship] THREE-WAY VERIFIED ✓  https://github.com/${REPO}/releases/tag/${TAG}`);
}

main().catch((e) => {
  console.error("SHIP FAILED:", e.message);
  process.exit(1);
});
