// scripts/publish-release-1.14.6.js — one-shot release publisher for v1.14.6.
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

const BODY = `## v1.14.6 — Decode-once export pipeline + preview/export parity

**The ask: "if it's not used, don't run it, don't decode it; only Ken Burns on by default; make exports meaningfully faster by removing unnecessary steps — and the export must match the preview."** Every item below is that principle applied end-to-end, each verified by harnesses on real FFmpeg.

### 1. The 22-min/85-images vs 259-images mystery — fixed
Export cost scales with **total output frames** (duration × fps), not image count — that's why both took the same time. Worse, the *static* (motion-off) images were the expensive ones: every image was re-decoded at full resolution **once per output frame** (31,680 full-res JPEG decodes + scales for a 22-min slideshow). Now every image decodes **once**:
- **Motion-off slideshows:** one decode → cover-fit scale/crop ONCE → pure frame duplication (measured **6.2× faster** per still on a 12 MP image; 16 s of 1080p30 renders in 0.5 s).
- **Ken Burns slideshows:** one decode → zoompan emits the frames (the animated path was already single-decode).
- Static images now also render the **exact cover-fit frame the preview draws** — the export previously showed a ~10% tighter crop on motion-off images. Frame counts are exact (480/384/315-frame harnesses; a timebase subtlety that dropped one frame per segment boundary was root-caused and fixed with \`settb\`).

### 2. Ken Burns is now the ONLY effect enabled by default
Per the product decision: motion is the signature look, everything else stays opt-in. Existing installs get a **one-time re-enable** (turn it back off and it stays off — the switch remembers your choice). Transitions, fades, captions, watermark, loudness normalization and 2-pass measurement are all default-OFF.

### 3. Loudness normalization is fully OFF unless you turn it on
With normalize OFF: **zero measurement passes, zero loudnorm filters, zero master-mix renders** — provable in the export log and the completion toast. The remaining master limiter (clip safety) costs milliseconds. A missed fast-path flag on one legacy graph route was also closed (static gains instead of ebur128 analysis when ≤3 audio branches).

### 4. Image overlays (logos/stickers/PiP) decode once too
An image overlay was re-decoded at full resolution **every frame it was visible**. Now it decodes once and is duplicated with alpha intact — verified **byte-identical** composite output, **17.4× faster** on a 12 MP sticker. Overlay windows, chroma-key, motion paths and the chunk-boundary padding contract are unchanged.

### 5. Captions: export now matches the preview
The burned captions were rebuilt to the preview's exact semantics (box color/alpha/padding mapped to verified libass BorderStyle=3 behavior, resolution-scaled margins/outline/shadow, the preview's line wrapping, headline scaling, karaoke word colors). The Tier-3 quality clamp that made low-end exports look different from the preview is retired.

### 6. Already shipped in v1.14.5, still active
Satisfied-transform filter skips, slideshow 24 fps mode, permanent loudness cache, simple-audio static gains, cost-based fast mode, per-export profiler.

### Verification
Two new harnesses (image single-decode with exact frame counts; overlay single-decode with byte-identical A/B composites) plus the full battery re-run green: release-A 65/65, timeline-chunks 35/35, chunked-encode 36/36, export-speed 35/35, caption parity 8/8, overlay/caption z-order 9/9, tier pools 16/16, ETA payload 10/10, keyframe trims 22/22, capabilities OK. ESLint clean.

### Upgrade notes
- No project-file changes; exports re-run cleanly.
- If you previously had motion OFF and never touched the switch, Ken Burns comes back ON once (this release's default) — switch it off in Settings → Media and it stays off.
- Normalize stays OFF by default — exports after this release are measurably faster on every timeline with images.`;

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
  const existing = (await r.json()).find((x) => x.tag_name === "v1.14.6");
  if (existing) {
    console.log("release already exists:", existing.id, existing.html_url);
    return existing;
  }
  const payload = JSON.stringify({
    tag_name: "v1.14.6",
    name: "v1.14.6",
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
  fs.writeFileSync("/tmp/release-id-1146.txt", String(rel.id));
  await uploadAsset(rel, "dist/latest.yml", "latest.yml", "text/yaml");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.14.6.exe.blockmap", "FrameFuse-Setup-1.14.6.exe.blockmap", "application/octet-stream");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.14.6.exe", "FrameFuse-Setup-1.14.6.exe", "application/octet-stream");
  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B, ${a.state})`).join(" | "));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
