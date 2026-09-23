// scripts/publish-release-1.14.4.js — one-shot release publisher for v1.14.4.
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

const BODY = `## v1.14.4 — export speed: the v1.12/v1.13 regressions fixed + a fast lane for older CPUs

**The report: "after version 12 and 13 export speed became terrible."** Four real causes were found, fixed, and measured:

### 1. Hardware-decode gate (the v1.12 regression)
v1.12 rode d3d11va GPU decode unless it was ≥1.5× SLOWER — on older integrated graphics with stock drivers the decode path measures 10–50 % slower than the CPU, and v1.12 rode it anyway on every export worker, dragging the whole pipeline. **v1.14.4 only uses hardware decode when it actually measured not-slower** on your files. (Our test bench caught the exact case: a source where GPU decode measured 1.26× slower — the old engine used it, the new one does not.)

### 2. Probe tax re-paid after every app restart
Every ≥20 s video source cost two 72-frame test decodes before the first frame exported — again after each app restart. Now 48 frames and the verdict is cached to disk for 24 h: a fresh session returns the verdict in ~1 ms with zero re-probes.

### 3. "Preparing…" stall before encoding
Source analysis ran one clip at a time (up to 0.3–1 s per clip on hard-drive machines — 20–60 s of dead time on a 20-clip timeline). It now runs 4 clips at a time.

### 4. Image-heavy exports: pool widened (the v1.14.1 gap)
Timelines with images + some clean video ran a 2-worker pool with double-oversubscribed threads while fully-dirty timelines got 4 single-thread workers. The widened 4×1 filter pool now applies to BOTH cases (verified on the AMD A8 shape: smart-render, 4 workers, 1 thread each).

### Plus: the constrained-CPU fast lane
A 1080p full re-encode on an older/dual-module CPU is limited by physics (~1× realtime). On such machines (Tier 3), long (≥4 min) mostly-dirty 1080p exports now render at the **720p-class resolution of the same aspect — ~2.2× less pixel work** — automatically, but **never silently**: the completion toast says exactly what happened and where to turn it off (Export settings → "Constrained-CPU fast mode"). Portrait/square exports map to 720×1280 / 720×720. Cinema-quality and explicitly-720p exports are untouched.

### Verification
New real-FFmpeg harness (35 checks): the decode-gate policy, the disk-persisted verdicts, the parallel probing, an A/B bench (same 240 s image+captions+music timeline at 720p vs 1080p — output dimensions, duration, and caption pixels verified), the full gate matrix, and the widened smart pool. All existing suites re-run green: tier pools 16/16, ETA payload 10/10, timeline chunks 35/35, chunked encode 36/36, caption layering 9/9.

### Upgrade notes
- No project-file changes — exports re-run cleanly.
- If you want full 1080p on an older CPU, turn off "Constrained-CPU fast mode" in Export settings (the toast also reminds you).`;

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
  const existing = (await r.json()).find((x) => x.tag_name === "v1.14.4");
  if (existing) {
    console.log("release already exists:", existing.id, existing.html_url);
    return existing;
  }
  const payload = JSON.stringify({
    tag_name: "v1.14.4",
    name: "v1.14.4",
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
  await uploadAsset(rel, "dist/FrameFuse Setup 1.14.4.exe.blockmap", "FrameFuse-Setup-1.14.4.exe.blockmap", "application/octet-stream");
  if (process.argv.includes("--with-exe")) {
    await uploadAsset(rel, "dist/FrameFuse Setup 1.14.4.exe", "FrameFuse-Setup-1.14.4.exe", "application/octet-stream");
  }
  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B)`).join(" | "));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
