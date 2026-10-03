// scripts/publish-release-1.23.0.js — one-shot release publisher for v1.23.0
// (Flow: the complete from-scratch UI rebuild — INSTALLER ONLY per the
// standing directive). Task-45 playbook: CURL asset uploads, dupe-aware,
// three-way sha512 check.
const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TOKEN = execSync("git remote get-url origin").toString().match(/:(\w+)@/)[1];
const REPO = "Ziruax/framefuse";
const API = `https://api.github.com/repos/${REPO}`;
const HDRS = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ship-script",
};

const BODY = `## v1.23.0 — Flow: the complete from-scratch UI rebuild

**The ask:** the previous "redesign" only changed colors on the same layout. This release rebuilds the interface from scratch — new layout, new navigation model, new visual system, new landing page.

### A completely different studio
- **Light "Paper Studio" workspace** — a warm paper canvas with white floating cards (rounded, soft shadows) replaces the full-bleed dark panels. The only dark surface is the preview itself: the **cinema card**, a rounded dark stage that frames your video like a screening room.
- **Left navigation rail** — six phases (Media · Canvas · Captions · Effects · Audio · Export) drive ONE contextual dock, replacing the old two-sided layout (left library + right tabbed settings). Click the active phase to collapse the dock for a full-width cinema + timeline workspace.
- **Timeline as a floating white card**, restyled lanes/ruler/tooltips; the cyan playhead keeps its long-standing scrub identity.
- **Slim glass toolbar** with the tangerine Export action, honest engine badges (Rust engine / FFmpeg CLI + reason), live ETA, and export telemetry chips.
- **Brand-new landing page** — split hero with a CSS-built studio mockup, feature bento, and a friendly "why desktop" strip.
- Every panel (media, captions incl. the kinetic gallery, effects, audio incl. script writer + dubbing, export incl. engine diagnostics) swept to the light system with readable contrast; video/caption/waveform **content colors untouched**.

### Engineering notes
- SettingsPanel gained a controlled-tab mode (the shell rail drives the sections; the internal tab rail is hidden) — all logic, props, ids and a11y preserved.
- The dock section + open state persists per browser; Whisper transcription auto-surfaces the Captions phase.
- tsc: zero new errors (the 9 pre-existing baselines unchanged); ESLint clean; browser-verified end to end (all six sections, sample storyboard, playback, timeline selection, transition tiles, shortcuts overlay, compact drawer, footer behavior).
- The shipped Rust engine binary is the exact CI smoke-tested artifact (rust-gpu, 150-frame h264+aac E2E, sha256 \`aebab2cf…\`).

**Full install only — NSIS installer** (per the standing directive): download \`FrameFuse-Setup-1.23.0.exe\` below.`;

function sha512File(p) {
  return crypto.createHash("sha512").update(fs.readFileSync(p)).digest("base64");
}

async function gh(pathname, init) {
  const r = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { ...HDRS, ...(init?.headers || {}), ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
  return r;
}

function curlUpload(file, name, releaseId) {
  const url = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  execSync(
    `curl -sfL -X POST -H "Authorization: token ${TOKEN}" -H "Content-Type: application/octet-stream" --data-binary @"${file}" "${url}"`,
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  console.log(`[ship] uploaded (curl): ${name}`);
}

function normDist() {
  // electron-builder writes "FrameFuse Setup 1.23.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.23.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.23.0${ext}`);
  const moves = [
    [spaced(".exe"), dashed(".exe")],
    [spaced(".exe.blockmap"), dashed(".exe.blockmap")],
  ];
  for (const [from, to] of moves) {
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
  }
  const yml = path.join("dist", "latest.yml");
  if (fs.existsSync(yml)) {
    let s = fs.readFileSync(yml, "utf8");
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.23\.0/g, "FrameFuse-Setup-1.23.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.23.0";
  const TARGET = execSync("git rev-parse HEAD").toString().trim();
  const { INSTALLER, LATEST, BLOCKMAP } = normDist();
  for (const f of [INSTALLER, LATEST, BLOCKMAP]) {
    if (!fs.existsSync(f)) throw new Error(`missing asset: ${f}`);
  }
  const size = fs.statSync(INSTALLER).size;
  console.log(`[ship] ${TAG}: installer ${(size / 1e6).toFixed(1)} MB (commit ${TARGET.slice(0, 7)})`);

  // 1. find-or-create the release (targeted at the release commit)
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
        target_commitish: TARGET,
        name: `FrameFuse ${TAG} — Flow: complete from-scratch UI rebuild`,
        body: BODY,
        draft: false,
        prerelease: false,
      }),
    });
    if (post.status !== 201) throw new Error(`release create failed: ${post.status} ${await post.text()}`);
    rel = await post.json();
    console.log(`[ship] release created: ${rel.id}`);
  }

  // 2. upload assets (dupe-aware: delete an existing name first)
  const wanted = [
    [INSTALLER, "FrameFuse-Setup-1.23.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.23.0.exe.blockmap"],
  ];
  for (const asset of rel.assets || []) {
    if (wanted.some(([, name]) => name === asset.name)) {
      const del = await gh(`/releases/assets/${asset.id}`, { method: "DELETE" });
      console.log(`[ship] deleted stale asset ${asset.name} (${del.status})`);
    }
  }
  for (const [file, name] of wanted) {
    curlUpload(file, name, rel.id);
  }

  // 3. three-way sha512 verification (local == latest.yml == re-downloaded)
  const local = sha512File(INSTALLER);
  const ymlTxt = fs.readFileSync(LATEST, "utf8");
  const m = ymlTxt.match(/sha512:\s*([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error("latest.yml has no sha512");
  if (m[1] !== local) throw new Error(`sha512 MISMATCH local vs latest.yml`);
  const redl = await fetch(
    `https://github.com/${REPO}/releases/download/${TAG}/FrameFuse-Setup-1.23.0.exe`,
    { headers: { Authorization: `token ${TOKEN}`, "User-Agent": "ship-script" } },
  );
  if (!redl.ok) throw new Error(`re-download failed: ${redl.status}`);
  const buf = Buffer.from(await redl.arrayBuffer());
  const remote = crypto.createHash("sha512").update(buf).digest("base64");
  if (remote !== local) throw new Error(`sha512 MISMATCH local vs re-downloaded`);
  if (buf.length !== fs.statSync(INSTALLER).size) throw new Error("size MISMATCH");
  console.log(`[ship] THREE-WAY sha512 VERIFIED (${local.slice(0, 12)}…, size exact)`);
  console.log(`[ship] LIVE: https://github.com/${REPO}/releases/tag/${TAG}`);
}

main().catch((e) => {
  console.error("[ship] FAILED:", e.message);
  process.exit(1);
});
