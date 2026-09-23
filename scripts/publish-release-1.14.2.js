// scripts/publish-release-1.14.2.js — one-shot release publisher for v1.14.2.
// Task-42/43 playbook: node-built JSON (never shell heredocs), token from the
// git remote, asset upload with 504-aware re-list.
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

const BODY = `## v1.14.2 — faster exports, an honest ETA, and a clear desktop-first answer

### Export speed (the real fix)
- The smart-render **audio bus ran serially after the video pool** — its whole runtime was added to every export wall clock. It now runs **concurrent with the video workers** (progress bands unchanged: video 0–92 / audio 92–96 / mux 96.5–100, driven by one combined fraction).
- Bench: the disclaimer-scenario fixture drops **1772 → 1420 ms (≈ −20%)** — and the serial tail scales with timeline length, so longer projects win more.
- Full root-cause analysis in \`docs/EXPORT_PERF.md\` § v1.14.2. (The v1.13 pool-shape and CPU-topology regressions were already fixed in v1.14.1.)

### Exact export time (ETA)
- The progress payload now carries **elapsed / total / phase / rate**; the ETA unlocks at 2% + 2 s and blends the all-run average with the recent ~6 s slope (clamped so startup extrapolation cannot spike).
- The header chip shows an **always-visible ETA** with an explicit **"estimating…"** state, **"@ 00:12 / 00:42"** context, the live phase, and the ×-rate (the fps slot had been a hardcoded 0 since v1.2).

### Desktop-only clarity
- Browser sessions now get a **Windows landing page** (download CTA, features, requirements). The studio remains reachable in-browser as a preview only (dev bypass: sessionStorage \`ff.studioPreview\`).
- The browser MediaRecorder export path is **removed** — exports are a desktop capability by design.

### Also in this release
- Docs: \`docs/export-engine-blueprint.md\` and \`docs/tauri-migration-plan.md\` (Tauri v2 migration plan saved, execution deferred — see the plan file for the rationale).`;

async function gh(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...HDRS, ...(opts.headers || {}) },
  });
  return r;
}

async function listReleases() {
  const r = await gh("/releases?per_page=20");
  return r.json();
}

async function createRelease() {
  const existing = await listReleases();
  const found = existing.find((x) => x.tag_name === "v1.14.2");
  if (found) {
    console.log("release already exists:", found.id, found.html_url);
    return found;
  }
  const payload = JSON.stringify({
    tag_name: "v1.14.2",
    name: "v1.14.2",
    body: BODY,
    draft: false,
    prerelease: false,
  });
  const r = await gh("/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`create failed ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  console.log("release created:", j.id, j.html_url);
  return j;
}

async function listAssets(rel) {
  const r = await gh(`/releases/${rel.id}/assets`);
  return r.json();
}

async function uploadAsset(rel, file, name, contentType) {
  const assets = await listAssets(rel);
  const dupe = assets.find((a) => a.name === name);
  if (dupe) {
    console.log(`asset ${name} already exists (id ${dupe.id}, ${dupe.size} B) — skipping upload`);
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
  await uploadAsset(rel, "dist/FrameFuse Setup 1.14.2.exe.blockmap", "FrameFuse-Setup-1.14.2.exe.blockmap", "application/octet-stream");
  const args = process.argv.slice(2);
  if (args.includes("--with-exe")) {
    await uploadAsset(rel, "dist/FrameFuse Setup 1.14.2.exe", "FrameFuse-Setup-1.14.2.exe", "application/octet-stream");
  }
  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B)`).join(" | "));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
