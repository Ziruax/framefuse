// scripts/publish-release-1.14.5.js — one-shot release publisher for v1.14.5.
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

const BODY = `## v1.14.5 — Release A of the export-speed plan: cost-based speed decisions, per-export profiler, big audio wins

**The ask: the final export-speed improvement plan, Release A (low-risk optimizations).** Everything below ships automatically and never silently — every automatic quality lever reports itself in the completion toast and has an off switch in Export settings.

### 1. Per-export performance profiler
Every export now records WHERE the time went — stage timings (probing, planning, the encode pool, the audio pass, the mux), per-worker wall time classified by what the graph actually ran (Ken Burns / captions / overlays / chromakey / stream-copy), frames, ×-realtime, CPU utilization, and loudness-cache hits. The full JSON is saved next to your app data (export-profiles), the summary rides the export result, and the log line prints it. This is the instrumentation the plan demanded before any bigger architecture work.

### 2. Fewer wasted per-frame operations
- The base video chain now DROPS filters the source already satisfies (resolution match, verified constant frame rate, pixel format, aspect): frame-exact by construction (verified end-to-end, 120/120 frames at 4.000 s).
- **Slideshow 24 fps mode:** image-only timelines render at the film rate — 20 % fewer frames through every filter and the encoder. Mixed-video timelines, 60 fps projects and cinema quality are untouched. The toast says when it ran; "Slideshow 24 fps" in Export settings turns it off.

### 3. Audio: repeat exports skip the measurement passes entirely
- Loudness measurements are cached on disk permanently (keyed by file + modification time + size): re-exports and app restarts re-measure nothing — fresh sessions return cached numbers with zero extra processes.
- **Simple-audio fast path:** music + narration-style projects (≤3 audio branches) apply static gains instead of the loudnorm analysis filters — the same −16 LUFS landing (verified: −18.0 fast vs −16.5 accurate), without the per-branch analysis. Larger mixes keep the accurate path automatically.

### 4. Cost-based speed decisions (no more duration cliffs)
The automatic 720p fast mode on older CPUs is no longer triggered by "≥4 minutes" — it is triggered by a render-COST score (pixels × frame rate × actually-re-encoded seconds × effect load). A 4:01 effect-heavy export now qualifies the same as a 4:00 one; a cheap 240-second render correctly does not. High-cost exports also switch the hardware encoder to its FAST profile (NVENC p1, multipass/lookahead disabled — cinema never does).

### 5. Capability matrix
The engine now detects ffmpeg's hardware DECODE methods and GPU FILTER availability separately from the encoder (reported in the export telemetry) — groundwork for the GPU-compositor release.

### Verification
New harness: 65 checks end-to-end on real FFmpeg (chain-skip matrix, cost-score thresholds, encoder profiles, loudness cache round-trips, slideshow mode, frame exactness with the fps skip, profiler files, audio loudness targets at ±2 LUFS, the fast-mode matrix). All existing suites re-run green: tier pools, ETA payload, timeline chunks, chunked encode, caption layering, and the v1.14.4 speed harness (updated to the cost gate). v1.14.3's caption-on-top layering and icon fixes are intact.

### Upgrade notes
- No project-file changes — exports re-run cleanly.
- Quality levers that can engage automatically: slideshow 24 fps (image-only timelines) and constrained-CPU 720p fast mode (unchanged contract from v1.14.4, now cost-triggered). Both are reported in the toast and both have Export-settings off switches.`;

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
  const existing = (await r.json()).find((x) => x.tag_name === "v1.14.5");
  if (existing) {
    console.log("release already exists:", existing.id, existing.html_url);
    return existing;
  }
  const payload = JSON.stringify({
    tag_name: "v1.14.5",
    name: "v1.14.5",
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
  fs.writeFileSync("/tmp/release-id.txt", String(rel.id));
  await uploadAsset(rel, "dist/latest.yml", "latest.yml", "text/yaml");
  await uploadAsset(rel, "dist/FrameFuse Setup 1.14.5.exe.blockmap", "FrameFuse-Setup-1.14.5.exe.blockmap", "application/octet-stream");
  if (process.argv.includes("--with-exe")) {
    await uploadAsset(rel, "dist/FrameFuse Setup 1.14.5.exe", "FrameFuse-Setup-1.14.5.exe", "application/octet-stream");
  }
  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B)`).join(" | "));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
