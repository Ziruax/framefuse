// scripts/publish-release-1.27.0.js — one-shot release publisher for v1.27.0
// (Settings tab + AI provider defaults + Groq Whisper + word-to-word dub
// timing; rolls up all unreleased work since v1.23.0: dark mode, TTS Studio,
// QWERTY Hindi/Urdu, multi-track timeline, Dub Studio, separate TTS tab).
// Task-45 playbook: CURL asset uploads, dupe-aware, three-way sha512 check.
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

const BODY = `## v1.27.0 — Settings hub, Groq Whisper, word-to-word dub timing

**The ask:** one place to pick AI providers and their default models, real word-level transcription timing, and dubbed audio that follows the original speaker word-by-word without wrecking the pacing. This release rolls up everything since v1.23.0 — the dark studio, the AI TTS Studio, and the full Dub Studio pipeline.

### New in v1.27.0
- **Settings tab (the single source of truth):** pick your **caption transcription** provider (Built-in cloud ASR or Groq Whisper with whisper-large-v3/large-v3-turbo) and your **dubbing script-writing** provider + model — Built-in Cloud AI (GLM 4.6 / 4.5 Air / …), Groq (Llama 3.3 70B / …) or Gemini (3.5 Flash Lite / …) — with key rows (masked display, save / test / remove). Every other panel now shows a read-only summary with a gear button that jumps straight here; the scattered per-tab provider pickers are gone.
- **Groq Whisper transcription:** real per-word timestamps (verbose_json + word granularity) — utterances come back as Groq segments with exact word windows, auto-chunked for long files under the 25 MB upload cap. The built-in cloud ASR stays keyless with estimated word timings.
- **Word-to-word dub timing (the big one):** each dubbed word is time-warped onto the original speaker's word timing — WSOLA time-stretch keeps speech natural, per-word rate changes are clamped to ±28%, pauses are inserted or trimmed as silence, and lines that are too far off get an Edge-TTS rate re-synthesis first. Every line ships an alignment report; the classic "fit the slot" dubbing stays as the fallback.
- **Duplicate VOICEOVER (TTS) card removed** from the TTS tab — the AI TTS Studio covers it.
- **Web preview caption generation:** captions no longer need the desktop app (the Built-in provider path now runs through the web speech API).

### Previously unreleased, now shipping (v1.24 – v1.26)
- **Dark studio** with a 4-phase dock, cinema preview and floating multi-track timeline.
- **AI Text-to-Speech Studio:** 200k-word chunked synthesis into one MP3, word-level timings, full Edge-TTS prosody (rate/pitch/volume), word-timing exports (SRT/VTT/JSON), save / add as narration / add as audio track / create word-level captions.
- **QWERTY Hindi/Urdu:** type Hinglish or Roman Urdu and get native Devanagari/Nastaliq in script writing, captions and TTS (plus burn-in fonts: Noto Sans Devanagari, Noto Nastaliq Urdu).
- **Multi-track audio lane:** N background-music clips with per-clip drag / trim / volume / loop / remove.
- **Dub Studio (3 stages):** transcribe (word-level) → script (target language, default Hindi, speaker detection 1–6) → dub (single or multi-voice with speaker→voice mapping) — works in the web preview too, via server-side speech APIs.
- **Simple TTS tab** with fixed language → voice pickers (322 Edge voices, 75 languages) and voice presets.

### Engineering notes
- Static export (Electron) no longer breaks on the web-preview API routes: \`scripts/build-next-electron.js\` moves \`src/app/api\` aside for the packaged build (the packaged app talks IPC) and restores it after — dev mode keeps the routes.
- The shipped Rust engine binary is the exact CI smoke-tested artifact (rust-gpu, 150-frame h264+aac E2E, sha256 \`abbea0b1…\`).
- tsc / ESLint clean; the full dub pipeline, Settings persistence, gear jumps and TTS dedupe browser-verified.

**Full install only — NSIS installer** (per the standing directive): download \`FrameFuse-Setup-1.27.0.exe\` below.`;

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
  // electron-builder writes "FrameFuse Setup 1.27.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.27.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.27.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.27\.0/g, "FrameFuse-Setup-1.27.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.27.0";
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
        name: `FrameFuse v1.27.0 — Settings hub, Groq Whisper, word-to-word dub timing`,
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
    [INSTALLER, "FrameFuse-Setup-1.27.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.27.0.exe.blockmap"],
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
    `https://github.com/${REPO}/releases/download/${TAG}/FrameFuse-Setup-1.27.0.exe`,
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
