// scripts/publish-release-1.14.3.js — one-shot release publisher for v1.14.3.
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

const BODY = `## v1.14.3 — captions are the topmost layer + blank-icon fix

### Captions above transitions (the reported "overlap covers captions")
- **Root cause**: image↔image boundaries crossfade (dissolve) and burn captions ON TOP of the blend — but VIDEO boundaries can only take dip-to-black/white transitions, whose fade applied AFTER the caption burn, so every dip darkened and covered the burned caption text. The preview had the same asymmetry.
- **The fix (layering contract, preview == export)**: \`base → overlays → watermark → transitions/fades → burned captions & headlines\` — subtitle text now stays fully readable through every dip (broadcast convention).
- Verified with a new real-FFmpeg pixel-classification harness (9/9): overlays (image/video/chroma) on video + image bases across the smart-render and parallel-pass engines, dissolve transitions with boundary-spanning cues, and the failing-then-fixed case (two videos + dip + spanning caption — caption renders full-white over the 50%-dipped frame).

### Blank desktop/shortcut icon after install
- The installed exe keeps its path across upgrades, so the Windows shell icon cache can keep showing the stale pre-v1.14.1 near-blank entry (the installer itself always shows its icon because each downloaded setup is a new file).
- The installer now notifies the shell and rebuilds the icon caches on install/uninstall (\`SHChangeNotify\` + \`ie4uinit\`), and the app does a one-time cache refresh on the first launch of each new version for upgrade-in-place users.

### Upgrade notes
- After installing, if a desktop icon still shows blank, press F5 on the desktop (or reboot) — the cache rebuild kicks in during install, but Explorer may need one refresh.
- Exports re-run cleanly: no project-file changes; the layering change is render-time only.`;

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
  const existing = (await r.json()).find((x) => x.tag_name === "v1.14.3");
  if (existing) {
    console.log("release already exists:", existing.id, existing.html_url);
    return existing;
  }
  const payload = JSON.stringify({
    tag_name: "v1.14.3",
    name: "v1.14.3",
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
  await uploadAsset(rel, "dist/FrameFuse Setup 1.14.3.exe.blockmap", "FrameFuse-Setup-1.14.3.exe.blockmap", "application/octet-stream");
  if (process.argv.includes("--with-exe")) {
    await uploadAsset(rel, "dist/FrameFuse Setup 1.14.3.exe", "FrameFuse-Setup-1.14.3.exe", "application/octet-stream");
  }
  const final = await listAssets(rel);
  console.log("assets now:", final.map((a) => `${a.name} (${a.size} B)`).join(" | "));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
