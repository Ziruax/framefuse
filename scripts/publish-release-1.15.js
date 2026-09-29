// scripts/publish-release-1.15.js — one-shot release publisher for v1.15.0.
// Task-45 playbook: node-built JSON, token from the git remote, dupe-aware
// uploads, 504 re-list guidance.
const { execSync } = require("child_process");
const fs = require("fs");

const TOKEN = execSync("git remote get-url origin").toString().match(/:(\w+)@/)[1];
const REPO = "Ziruax/framefuse";
const API = `https://api.github.com/repos/${REPO}`;
const HDRS = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ship-script",
};

const BODY = `## v1.15.0 — Fullscreen preview, Groq Whisper captions, text removal, 36% smaller installer

**The ask: "fix fullscreen preview; captions via Groq Whisper with my own key; stop bundling faster-whisper by default; detect and remove burned-in text — off by default; keep auto-format + sync as default behavior."**

### 1. Fullscreen preview — fixed
The preview stage now goes TRUE fullscreen: a dedicated button in the preview bar, double-click the stage, or press F. Esc (or F) exits. Works in the desktop app and the browser preview alike. (Root cause: there was no fullscreen code at all — the old Maximize button only matched the project aspect ratio.)

### 2. Captions: Groq Whisper API with YOUR key
- Paste your Groq API key in Settings — it is stored ONLY on this device (0600 user file) and is sent to nobody but api.groq.com for transcription calls.
- Two models: whisper-large-v3 and whisper-large-v3-turbo — **turbo is the default (the fast one)**.
- Engine chain: Groq first, automatic local fallback on failure / no key / offline.

### 3. Installer is 135 MB (36%) smaller
faster-whisper is no longer bundled (377.7 MB → 242.5 MB). Captions still work offline out of the box via the bundled ONNX tiny model. Building from source and want the local large-model engine back? One command stages it: npm run electron:build:fw, then build as usual.

### 4. Burned-in text detection & removal — default OFF
New Text Removal panel (right side): OCR scans a frame and boxes burned-in text (channel names, watermarks, subtitles). Export removes the regions via **inpaint** (content-aware fill), **blur**, or **pixel cover** — per-region toggles, preview visualization, frame-exact output with pixel-level verification. Nothing changes for existing projects until you turn it on.

### 5. Export engine: budget-aware parallel windows
Parallel dirty-window queue with script+input budgets (queue lanes instead of a fixed pool), two-step single-decode image graphs, widened Tier-1 filter pool, fast mode for weak-CPU+GPU machines, chunk faststart drop — a 260-image Ken Burns slideshow renders ~18x realtime on a 2-core box. Export stage timings are now surfaced in the completion toast and log.

### Verification
Browser-verified end to end: fullscreen enter/exit (button, double-click, Esc, F), Groq engine card round-trips (key persists locally, model picker, fallback chain live-tested against api.groq.com), OCR found burned-in text in a real video and removal exported frame-exact with pixel-level proof. All suites green: release-A 65/65, timeline-chunks 35/35, chunked-encode 36/36, export-speed 35/35, caption parity 8/8, overlay z-order 9/9, image single-decode 6/6, text-removal 8/8. Installer: ASAR feature markers verified, icons 7/7 on app + installer, sha512 three-way match (local exe = latest.yml = re-downloaded asset).

### Upgrade notes
- No project-file changes; exports re-run cleanly.
- Text Removal stays OFF — your exports are byte-for-byte unaffected unless you enable it.
- Offline captions keep working (bundled tiny model); add a Groq key for large-v3 speed and accuracy.
- Ken Burns remains the only default-on effect; auto-format and A/V sync behavior are unchanged.`;

async function gh(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...HDRS, ...(opts.headers || {}) },
  });
  return r;
}

async function listAssets(rel) {
  const r = await gh(`/releases/${rel.id}/assets`);
  return r.json();
}

async function createRelease() {
  const r = await gh("/releases?per_page=30");
  const existing = (await r.json()).find((x) => x.tag_name === "v1.15.0");
  if (existing) {
    console.log("release already exists:", existing.id, existing.html_url);
    return existing;
  }
  const payload = JSON.stringify({
    tag_name: "v1.15.0",
    name: "v1.15.0 — Fullscreen preview · Groq Whisper · Text Removal",
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
  fs.writeFileSync("/tmp/release-id-115.txt", String(rel.id));
  await uploadAsset(rel, "dist/latest.yml", "latest.yml", "text/yaml");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.15.0.exe.blockmap", "FrameFuse-Setup-1.15.0.exe.blockmap", "application/octet-stream");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.15.0.exe", "FrameFuse-Setup-1.15.0.exe", "application/octet-stream");
  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B, ${a.state})`).join(" | "));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
