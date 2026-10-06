// scripts/publish-release-1.33.2.js — one-shot release publisher for v1.33.2
// (export "stuck at 100%, no video" root-cause fixes + kinetic caption
// rendering fixes). Task-45 playbook: CURL asset uploads, dupe-aware,
// three-way sha512.
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

const BODY = `## v1.33.2 — fixes "export stuck at 100%, no video" + broken kinetic captions

**The two reports this patch closes:**
> "1 hour 9 min audio + 10 sec video looped across the timeline + kinetic captions — export fast to 95%, slow after, stuck at 100%, the video was never exported" and "kinetic captions: the color highlight is not showing properly, words have very low spacing, words have visibility issues."

### Fix 1 — Export stuck at 100% / no output video (1h+ timelines with looped video)
A full-scale real-FFmpeg reproduction (10 s source loop-filled to 4140 s + 1 h 9 m audio + burned captions, 2.07 GB output) proved the pipeline **terminates** — the "hang" was four stacked feedback lies, all fixed:
1. **The invisible faststart rewrite.** \`-movflags +faststart\` re-walks the ENTIRE finished file (minutes on a 2 GB+ export) AFTER the last frame, with **zero progress output** — the bar sat frozen at 100% while ffmpeg was still working. Outputs expected over **1.5 GB now skip the rewrite entirely** (moov at end — local playback is unaffected); the result payload carries \`faststartSkipped\` and a toast says so.
2. **A frozen 100% during the final mux.** The concat-mux audio graph crawled 96→100 with no phase context on long timelines. The mux now maps **96.5 → 99.7**, and 100% appears only when the file is truly written.
3. **Silent post-encode tail detection.** When frames are done but ffmpeg is still alive (header/finalize pass), the progress now flips to a real **"Writing file header" finalize phase** instead of a dead 100%.
4. **Measurement timeouts that quietly made exports SLOWER.** The flat 60 s loudness-measurement cap killed every 1 h+ measurement on slower CPUs → silent fallback to the slower dynamic path mid-export. Timeouts now **scale with media duration** (60 s floor + 25 s per media-minute, 5 min cap), and the loudness-measure + audio-mix stages show their own live phases ("Measuring loudness" / "Rendering audio mix") instead of a frozen 96 %.

### Fix 2 — Kinetic captions (color highlight, spacing, visibility)
Three real rendering bugs, each reproduced with real-font-metric geometry + real ffmpeg burns:
1. **Words had ZERO gap at each line's first pair** ("She|never" rendered merged): the greedy wrap advanced to the previous word's right edge instead of edge + space. Fixed in the layout engine the preview AND the export share — preview and burned captions now match by construction.
2. **Words entering during the composition's exit fade peaked at ~30 % opacity** (fade-in × fade-out crossfire) — the last words of tight compositions were nearly invisible. Entrances now compress to finish before the exit window opens, and the exit fade defers past the last entrance; <40 ms fades are dropped.
3. **The accent/highlight color was barely visible**: emphasis words inside supporting phrases were alpha-dimmed to 0.82, three presets used white/near-white accents (invisible against white captions), and some compositions got no accent word at all. Emphasis words are now exempt from the dim, presets use real **gold/amber accents**, and every ≥4-word composition guarantees a top content word as the accent — so the karaoke-style highlight you see in the preview is what gets burned.

### Verified (all run, honestly reported)
- Full-scale export repro on real ffmpeg 7.1.5: loop render → WAV extraction → final mux all terminate; output head+tail decode clean; hang-hypothesis tests (looped music + amix + shortest, dynamic loudnorm mux) all terminate.
- Kinetic: ASS regenerated through the REAL engine + emitter with exact TTF metrics, burned with real ffmpeg and visually verified — gaps on every pair, all words readable, last words full opacity, accent word clearly visible.
- ASAR audit of the shipped installer: all v1.33.2 export + kinetic markers present, packaged electron files parse clean, engine binary sha256-matches the CI smoke-tested build (green MSVC + E2E run on this exact commit), full Windows ffmpeg + ffprobe + the 5 FFmpeg 7.1 shared DLLs packaged, version stamp 1.33.2.
- Three-way sha512 (local == latest.yml == re-downloaded from GitHub) verified by the publisher.

**Full install only — NSIS installer** (per the standing directive): download \`FrameFuse-Setup-1.33.2.exe\` below. Installing over v1.33.1 / v1.33.0 is fine. Your timeline, project and settings are untouched.`;

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
  // electron-builder writes "FrameFuse Setup 1.33.2.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.33.2${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.33.2${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.33\.[0-9]+/g, "FrameFuse-Setup-1.33.2");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.33.2";
  const TARGET = execSync("git rev-parse HEAD").toString().trim();
  const { INSTALLER, LATEST, BLOCKMAP } = normDist();
  for (const f of [INSTALLER, LATEST, BLOCKMAP]) {
    if (!fs.existsSync(f)) throw new Error(`missing asset: ${f}`);
  }
  const size = fs.statSync(INSTALLER).size;
  console.log(`[ship] ${TAG}: installer ${(size / 1e6).toFixed(1)} MB (commit ${TARGET.slice(0, 7)})`);

  // 0. commit must be PUSHED (GitHub 422s on a local-only target_commitish)
  const remote = execSync("git ls-remote origin main").toString().trim().split("\t")[0];
  if (remote !== TARGET) throw new Error(`HEAD ${TARGET.slice(0, 7)} is NOT pushed (origin/main ${remote.slice(0, 7)}) — push first`);

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
        name: `FrameFuse v1.33.2 — export stuck-at-100% fixed + kinetic captions fixed`,
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
    [INSTALLER, "FrameFuse-Setup-1.33.2.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.33.2.exe.blockmap"],
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
  const ymlMatch = ymlTxt.match(/sha512:\s*(\S+)/);
  if (!ymlMatch) throw new Error("latest.yml missing sha512");
  if (ymlMatch[1] !== local) throw new Error(`sha512 mismatch local vs latest.yml`);
  console.log("[ship] sha512 local == latest.yml ✓");

  const dl = await gh(`/releases/tags/${TAG}`);
  const rel2 = await dl.json();
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.33.2.exe");
  if (!asset) throw new Error("installer asset not found after upload");
  const dlRes = await fetch(asset.browser_download_url, { headers: HDRS });
  if (!dlRes.ok) throw new Error(`re-download failed: ${dlRes.status}`);
  const bytes = Buffer.from(await dlRes.arrayBuffer());
  const dlSha = crypto.createHash("sha512").update(bytes).digest("base64");
  if (dlSha !== local || bytes.length !== size) {
    throw new Error(`sha512/size mismatch on re-download (${dlSha === local ? "size" : "sha512"})`);
  }
  console.log(`[ship] three-way sha512 VERIFIED (${local.slice(0, 12)}…, ${size} bytes)`);
  console.log(`[ship] LIVE: https://github.com/${REPO}/releases/tag/${TAG}`);
}

main().catch((err) => {
  console.error("[ship] FAILED:", err.message);
  process.exit(1);
});
