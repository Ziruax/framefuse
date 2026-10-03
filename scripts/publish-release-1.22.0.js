// scripts/publish-release-1.22.0.js — one-shot release publisher for v1.22.0
// (engine diagnostics + self-test, Groq whisper resilience, Gemini dubbing,
// Ember Studio redesign — INSTALLER ONLY per the standing directive).
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

const BODY = `## v1.22.0 — Engine diagnostics & self-test, resilient Groq transcription, Gemini dubbing, all-new UI

**The ask (4 fixes):** (1) exports always fell back to FFmpeg — "why did we even build the Rust engine?"; (2) Groq Whisper errors while transcribing; (3) a complete, more user-friendly frontend redesign; (4) Gemini model selection in dubbing.

### 1. The engine can no longer fail silently — it tells you exactly what's wrong
- **New Engine diagnostics (Settings → Export → Engine):** the live load state (version, binary, path), the **last reason an export bypassed the Rust engine** (unsupported feature / timeline failure / **runtime engine error** — previously runtime failures silently became "FFmpeg CLI" with no explanation), and a **Run engine test** button that executes a REAL 36-frame mini export through the engine in this exact runtime (load path + FFmpeg DLL dir + GPU adapter) and reports the engine/encoder/adapter/wall-time — or the precise error.
- **The loader is hardened:** every candidate path is recorded with per-path errors; extra asar-unpacked / extraResources fallbacks mean a packaging regression can no longer hide the binary.
- The Header badge now threads runtime-failure reasons too, not just feature gates.
- **Repaired the packaging config**: a staging accident had deleted the electron-builder config (including the asar-unpack rule for the Rust engine binary!) — restored and verified.

### 2. Groq Whisper transcription resilience
- **Word-timestamp 400s auto-retry:** when the turbo model rejects word-level timestamps for an account, the transcription retries once with segment timing (still perfect captions, evenly-distributed word timing).
- **Model 404 / deprecation auto-fallback:** a decommissioned or unavailable whisper model id retries once with the other model (turbo ↔ v3).
- **Language hints can never 400:** full names ("english") and locales ("en-US") are normalized to strict ISO-639-1; unrecognizable values fall back to auto-detect.
- Error messages remain the classified, actionable Groq text (verified against the live API).

### 3. Gemini models in dubbing
- The Translate & Dub card now picks its **AI model provider**: **Groq (default)** or **Gemini** — the speaker-detection + translation phases run on your Gemini key (shared with the Script Writer) with a full Gemini model picker. Whisper transcription stays Groq either way.
- Gemini model ids **self-heal**: a 404 (stale/decommissioned id) auto-falls-back once to the stable 2.5 Flash, and the key test now returns the LIVE generateContent-capable model list so the pickers only ever offer what your key can call.

### 4. All-new "Ember Studio" interface
- Complete visual redesign across every surface: a warm dark studio theme with **amber** primary actions, stone surfaces, teal live indicators, restyled header/landing/panels/tabs/timeline, feature-card landing page, icon-labeled tab rail, refined hover/focus states.

### Verification
- **Real end-to-end through the actual router** (Linux, real hardware): the flagship transcription→captions flow runs **native Rust** — gate RUST-ELIGIBLE, captions burned (word karaoke + pop-in), engineUsed rust-cpu, valid MP4, karaoke gold highlight 0 px pre-cue → 2558 px mid-cue.
- Engine self-test through the router: PASS (36 frames, 159 ms). Regressions: smoke-test (exit 0), v2 feature test (PASS), YUV color test (OK ±10).
- CI (windows-latest, MSVC): engine build + smoke + v2 + color tests green on the release commit; the installer ships **exactly** the smoke-tested .node (sha-verified inside app.asar.unpacked).
- Browser: dub provider picker + Gemini model list + the Engine card self-test flow verified via the electron-stub harness; zero page/console errors. \`bun run lint\` exit 0; tsc = the documented pre-existing baseline (9, zero new).

### Upgrade notes
- Projects + settings load unchanged. If exports ever show "FFmpeg CLI" again, open Settings → Export → Engine — the reason and a one-click engine test are right there.`;

function sha512File(p) {
  return crypto.createHash("sha512").update(fs.readFileSync(p)).digest("base64");
}

async function gh(p, opts = {}) {
  const r = await fetch(`${API}${p}`, {
    ...opts,
    headers: { ...HDRS, ...(opts.headers || {}) },
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
  // electron-builder writes "FrameFuse Setup 1.22.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.22.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.22.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.22\.0/g, "FrameFuse-Setup-1.22.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.22.0";
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
        name: `FrameFuse ${TAG} — Engine diagnostics, resilient Groq, Gemini dubbing, new UI`,
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
    [INSTALLER, "FrameFuse-Setup-1.22.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.22.0.exe.blockmap"],
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
    `https://github.com/${REPO}/releases/download/${TAG}/FrameFuse-Setup-1.22.0.exe`,
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
