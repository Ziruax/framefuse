// scripts/publish-release-1.15.2.js — one-shot release publisher for v1.15.2.
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

const BODY = `## v1.15.2 — GPU export engine in a Web Worker (the UI never lags), engine telemetry, real-hardware A/B bench

**The ask:** export must never freeze the editor; give me the numbers that decide the v1.16 GPU-compositor migration; prove it on real hardware.

### 1. The entire GPU export engine now runs in a dedicated Web Worker
OffscreenCanvas compositor, VideoDecoder/VideoEncoder and mp4-muxer all moved off the main thread into a self-contained prebuilt worker (\`public/gpu-worker.js\`, spawned document-relative — immune to the v5.0 whisper-worker asar/file:// chunk landmine). The main thread only relays throttled progress (3 Hz), muxed chunks and logs. Measured during a 1200-frame export: the engine contributes **zero main-thread longtasks** — tabs, effects and settings stay clickable mid-export.

### 2. Audio: the spec-forced design
Web Audio is \`[Exposed=Window]\` spec-wide (live-verified — \`OfflineAudioContext\` does not exist in dedicated workers), so the audio arm runs on the main thread **by design**: the client prebuilds the track list + SFX WAVs, the worker's muxer pulls the mix through a cross-thread \`audioProvider\`, and encoded chunks stream back in batches (48 chunks / 25 ms). Rendering rides the audio thread pool; \`AudioEncoder\` rides its own threads — the main thread only relays.

### 3. New telemetry for the v1.16 decision
\`ExportResult\` / \`LastExport\` now carry \`jsCompositorOverheadMs\` (pure JS compositing — the number the v1.16 GLSL/WebGPU migration would attack), \`gpuDecodeWaitMs\` (decoder wait) and \`workerRuntime\` (worker vs main-thread fallback). Shown in the completion toast and the Header tooltip: "GPU engine in worker · 1200 frames · 28.2 ms/frame render · 0.2 ms/frame JS compositor".

### 4. Real-hardware A/B bench protocol — headless numbers are not proof
\`scripts/ab-export-bench.js\` generates a 60 s 1080p fixture timeline (4 distinct clips + image + looping music), forces the FFmpeg arm onto NVENC, runs the WebCodecs GPU arm through its worker, and prints the wall-clock table + speedup median with all GPU telemetry columns. On a Windows GPU box:

\`\`\`
node scripts/ab-export-bench.js --exe "C:\\Users\\<you>\\AppData\\Local\\Programs\\FrameFuse\\FrameFuse.exe"
\`\`\`

(Or from the repo: \`npm run bench:ab\` after \`npm run build\`.) The sandbox's headless 1.38×-software result stays explicitly labeled as non-proof.

### Verification
Browser E2E on the exact shipped worker bundle: 1200/1200 frames exact, sha256 page↔disk match, fMP4 box walk valid, UI interactive mid-export, engine zero main-thread longtasks, lint green. ASAR verified: \`out/gpu-worker.js\` ships in the archive carrying the v2 protocol (audio-mix / audio-chunks / sink-chunk); bench mode + the audio arm are present in the packaged \`electron/main.js\` and preload.

### Upgrade notes
- No project-file changes; exports re-run cleanly.
- The GPU engine remains the **opt-in** Export-settings toggle (default OFF) — FFmpeg smart-render stays the default path until the field data says otherwise.
- Windows-only build as before; installer ~242 MB (faster-whisper still opt-in: \`npm run electron:build:fw\` from source; bundled ONNX tiny keeps offline captions working).`;

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
  const existing = (await r.json()).find((x) => x.tag_name === "v1.15.2");
  if (existing) {
    console.log("release already exists:", existing.id, existing.html_url);
    return existing;
  }
  const payload = JSON.stringify({
    tag_name: "v1.15.2",
    name: "v1.15.2 — GPU export in a Worker · engine telemetry · real-hardware A/B bench",
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
  const rel = await createRelease();
  fs.writeFileSync("/tmp/release-id-1152.txt", String(rel.id));
  await uploadAsset(rel, "dist/latest.yml", "latest.yml", "text/yaml");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.15.2.exe.blockmap", "FrameFuse-Setup-1.15.2.exe.blockmap", "application/octet-stream");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.15.2.exe", "FrameFuse-Setup-1.15.2.exe", "application/octet-stream");

  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B, ${a.state})`).join(" | "));

  // Three-way sha512: local exe vs latest.yml vs the uploaded asset record.
  const localHash = sha512File("dist/FrameFuse Setup 1.15.2.exe");
  const yml = fs.readFileSync("dist/latest.yml", "utf8");
  const ymlHash = (yml.match(/sha512:\s*(\S+)/) || [])[1];
  const exeAsset = final.find((a) => a.name === "FrameFuse-Setup-1.15.2.exe");
  console.log("sha512 local :", localHash.slice(0, 24) + "…");
  console.log("sha512 yml  :", (ymlHash || "MISSING").slice(0, 24) + "…");
  console.log("sha512 GH   :", (exeAsset && exeAsset.digest ? exeAsset.digest : "(api digest field not returned)") + ` (size match: ${exeAsset && exeAsset.size === fs.statSync("dist/FrameFuse Setup 1.15.2.exe").size})`);
  const ok = localHash && ymlHash === localHash && exeAsset && exeAsset.size === fs.statSync("dist/FrameFuse Setup 1.15.2.exe").size;
  console.log(ok ? "VERIFIED: local == latest.yml, GitHub asset size == local size" : "MISMATCH — investigate before announcing");
  if (!ok) process.exit(2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
