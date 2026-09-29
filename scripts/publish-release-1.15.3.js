// scripts/publish-release-1.15.3.js — one-shot release publisher for v1.15.3.
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

const BODY = `## v1.15.3 — The WebCodecs lie detector: prove hardware encode, kill the silent software trap

**The ask:** "If WebCodecs is slow as hell it has fallen into the Software Encoding Fallback or the Canvas Readback Penalty. Force it to tell the truth." — the full 4-step diagnostic plan, implemented.

### 1. The lie detector (Step 1) — with one honest correction
\`hardwareAcceleration: "require-hardware"\` **is not a valid enum value in ANY Chromium today** (verified against HeadlessChrome 153 — newer than this app's Electron 33/Chromium 130 — it throws on the enum). The engine therefore implements the probe **defensively**: if your runtime ever accepts it, hardware is PROVEN and the ladder pins it; on every current Chromium it logs the truth — \`require-hardware unknown — falling back to the prefer-hardware ladder (hardware unverifiable)\` — instead of silently pretending. The ladder then reports the rung that actually configured the encoder (\`enc rung: …\` in the tooltip, \`hw=\` in the bench, \`SOFTWARE encoder\` in the toast), and a hardware-probe rejection is logged LOUD with the platform's own DOMException reason.
**Driver-side ground truth:** the app now dumps the GPU-process video-encode summary at startup (\`[gpu-info] …\` in the log — vendor/driver + every video-encode field Chromium exposes, the chrome://gpu "Video Acceleration" twin) and rides it into the A/B bench results.

### 2. Electron GPU flags (Step 2) — the actual likely root cause
The app previously set **zero** GPU command-line switches — Electron can leave D3D11 video encode (NVENC/QSV/AMF) disabled or blacklisted on Windows, which makes the WebCodecs arm silently crawl on software. Now applied before app ready:
- Windows: \`enable-features=D3D11VideoEncoder,CanvasOopRasterization\`
- Linux: \`enable-features=VaapiVideoEncoder\` (dev twin)
- All: \`ignore-gpu-blocklist\`, \`enable-gpu-rasterization\`

### 3. Canvas readback penalty (Step 3)
The export surfaces now acquire their 2D context with \`alpha:false + desynchronized:true + willReadFrequently:false\` (the GPU-resident low-latency path; the only read is the VideoFrame construction, which takes the fast texture route). VideoFrame close discipline was already frame-exact (the VRAM rule — re-verified: 1200/1200 frames, zero leaks).

### 4. Encoder queue backpressure (Step 4)
Queue cap 30 → **5** with a tight 2 ms yield — a deep queue only balloons VRAM/pixel storage without adding throughput; the stall watchdog still catches a wedged driver at 12 s.

### The verdict protocol (unchanged, now with better instruments)
The A/B bench (\`node scripts/ab-export-bench.js --exe "<install path>\\\\FrameFuse.exe"\`) now prints \`hw=<rung>\` + \`HW-REJECTED\` + the GPU line in every table, and warns when a speedup number was measured against a SOFTWARE WebCodecs run ("says NOTHING about WebCodecs GPU speed"). The GPU engine remains **opt-in, default OFF** — FFmpeg smart-render stays the default until field data says otherwise.

### Verification
Browser E2E on the shipped worker bundle: 1200/1200 frames exact, fMP4 box walk clean (ftyp/moov/25×moof+mdat/mfra), worker-ready line, the require-hardware probe line, truthful \`enc rung: software\` telemetry in the Header tooltip, zero console/page errors, lint green. ASAR verified: the probe + flags + telemetry ship in the archive.

### Upgrade notes
- No project-file changes; exports re-run cleanly.
- If the GPU UI misbehaves on an exotic driver, the flags block in \`electron/main.js\` is 3 lines — delete to revert (the engine's watchdog + FFmpeg fallback still cover everything).`;

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
  const existing = (await r.json()).find((x) => x.tag_name === "v1.15.3");
  if (existing) {
    console.log("release already exists:", existing.id, existing.html_url);
    return existing;
  }
  const payload = JSON.stringify({
    tag_name: "v1.15.3",
    name: "v1.15.3 — WebCodecs lie detector · Electron GPU flags · readback + backpressure fixes",
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
  fs.writeFileSync("/tmp/release-id-1153.txt", String(rel.id));
  await uploadAsset(rel, "dist/latest.yml", "latest.yml", "text/yaml");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.15.3.exe.blockmap", "FrameFuse-Setup-1.15.3.exe.blockmap", "application/octet-stream");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.15.3.exe", "FrameFuse-Setup-1.15.3.exe", "application/octet-stream");

  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B, ${a.state})`).join(" | "));

  const localHash = sha512File("dist/FrameFuse Setup 1.15.3.exe");
  const yml = fs.readFileSync("dist/latest.yml", "utf8");
  const ymlHash = (yml.match(/sha512:\s*(\S+)/) || [])[1];
  const exeAsset = final.find((a) => a.name === "FrameFuse-Setup-1.15.3.exe");
  console.log("sha512 local :", localHash.slice(0, 24) + "…");
  console.log("sha512 yml  :", (ymlHash || "MISSING").slice(0, 24) + "…");
  console.log("sha512 GH   :", (exeAsset && exeAsset.digest ? exeAsset.digest : "(api digest field not returned)") + ` (size match: ${exeAsset && exeAsset.size === fs.statSync("dist/FrameFuse Setup 1.15.3.exe").size})`);
  const ok = localHash && ymlHash === localHash && exeAsset && exeAsset.size === fs.statSync("dist/FrameFuse Setup 1.15.3.exe").size;
  console.log(ok ? "VERIFIED: local == latest.yml, GitHub asset size == local size" : "MISMATCH — investigate before announcing");
  if (!ok) process.exit(2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
