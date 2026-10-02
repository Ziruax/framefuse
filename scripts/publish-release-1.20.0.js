// scripts/publish-release-1.20.0.js — one-shot release publisher for v1.20.0
// (native Rust captions + Groq-only STT + kinetic design gallery + single-voice
// dubbing + Gemini script writer — INSTALLER ONLY per the standing directive).
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

const BODY = `## v1.20.0 — Native Rust caption burn-in, Groq-only transcription, kinetic design gallery, single-voice dubbing, Gemini script writer

**The ask (5 fixes):** (1) exports kept "falling back to FFmpeg CLI" — the Rust engine was gated off by burned-in captions; (2) Groq Whisper kept falling back to local whisper; (3) the new kinetic typography designs weren't visible in the UI; (4) dubbing had multi-speaker but no single-voice option; (5) add Google Gemini for script writing with Gemini 3.5 Flash Lite as the default text model.

### 1. The Rust engine now burns captions NATIVELY (the FFmpeg-fallback fix)
Root cause: every captioned export (the default transcribe → captions ON → export flow) hit the router's \`captions\` gate and silently routed to the FFmpeg-CLI pipeline. That gate is **gone**:
- New \`rust-engine/src/captions.rs\`: the full v4.1 caption vocabulary renders through fontdue + the compositor text layers — **all word modes** (karaoke highlight / word-only / stack) and **all 24 kinetic animations** (pop-in, slam, bounce-in, squash, spotlight, color-cycle, heartbeat, …) as per-word rect-scale/offset/alpha transforms with the exact canvas math (captionAnimations.ts port).
- Layout mirrors the preview ground truth: balanced triangle wrap, 1.25 line height, position anchors, bg boxes, offset shadows, karaoke active-word highlight (activeWordIndex semantics).
- Word bitmaps rasterize once per (word, color-variant) and cache; per-frame work is pure blit math. The CPU compositor gained a bilinear text-scaling path; the GPU path already scaled via dest rects.
- **Bonus bug fix:** the glyph fill pass was suppressed by the outline pass's identical coverage (max-blend alpha equality) — text rendered outline-colored. Fixed in both captions.rs AND text.rs (headlines had rendered outline-colored since v1.16).
- Only the v1.18 kinetic-TYPOGRAPHY engine still rides the CLI/libass compositor — and now the header badge **says so**: \`FFmpeg CLI · kinetic-captions\` with the routing reason on every export (no more silent engine swaps).

### 2. Groq Cloud is the ONLY transcription engine
Local whisper is fully removed — the transformers.js worker, the faster-whisper Python sidecar, the onnxruntime utilityProcess, the staging scripts, the packaging, the "This device" UI toggle. Groq errors now **surface** (a clear toast with the API message) instead of silently falling back to a local model. A free Groq API key (console.groq.com) is the only requirement.

### 3. Kinetic typography design library (the 24 designs, VISIBLE)
The 24 kinetic presets were invisible in Auto mode. New **Design library gallery**: 25 tiles (Auto mix + all 24 presets grouped by family — Cinematic · Dramatic · Conflict · Conversational · High Intensity), each with a **mini canvas snapshot rendered through the real engine** (buildKineticPlan → drawKineticComposition). Click a tile to pin that design (single mode); the gallery is visible (dimmed) even before transcription with an unlock hint.

### 4. Single-voice dubbing
"One voice" mode in Translate & Dub: skips speaker detection entirely (no LLM pass) and synthesizes every segment with one Edge-TTS voice (any locale voice, previewable). Multi-speaker mode is unchanged.

### 5. AI Script Writer (Google Gemini + Groq)
New Script Writer section: generate narration scripts with **Gemini 3.5 Flash Lite** (default) or any other text model — Gemini family (3.5 Flash, 3.1 Flash Lite, 2.5 Flash, 2.5 Pro) + Groq models in one selector. Gemini key management mirrors the Groq key UX; tone / duration / language controls; editable output with word count and estimated read time.

### Verification
- **Rust captions: real end-to-end on the built engine** — 6 cargo unit tests + a 15-check pixel-level smoke harness (karaoke gold active-word highlight, staggered pop-in entrances, word-only, stack growth + dimming, purple bg box, after-cue cleanup) + v2-feature and yuv-color regression tests.
- Router gate harness: 24/24 (captions + animations + word modes all Rust-eligible; kinetic typography / stack text / geometric transitions / loudnorm still gated, reasons surfaced).
- CI (windows-latest, MSVC): engine build + smoke + v2 + color tests green on the release commit; the packaged installer ships **exactly** the smoke-tested .node (sha256-verified inside app.asar.unpacked).
- Browser-verified: Groq-only UI, 24 painted design tiles, tile pinning, zero page errors. \`bun run lint\` exit 0; tsc = the documented pre-existing baseline.

### Upgrade notes
- Projects load unchanged. Caption presets with word timing + animations now export through the native engine — check the header badge: it reads **Rust engine** even with burned-in captions (kinetic typography captions still read \`FFmpeg CLI · kinetic-captions\`).
- Transcription requires a saved Groq API key (Settings → Captions → Transcription). Script writing accepts a Gemini key (AI Script Writer) or reuses the Groq key.`;

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
  // electron-builder writes "FrameFuse Setup 1.20.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.20.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.20.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.20\.0/g, "FrameFuse-Setup-1.20.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.20.0";
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
        name: `FrameFuse ${TAG} — Native Rust captions, Groq-only STT, kinetic design gallery`,
        body: BODY,
        draft: false,
        prerelease: false,
      }),
    });
    if (post.status !== 201) throw new Error(`release create failed: ${post.status} ${await post.text()}`);
    rel = await post.json();
    console.log(`[ship] release created: ${rel.id}`);
  }

  // 2. dupe-aware asset upload (CURL)
  const existing = new Set(rel.assets.map((a) => a.name));
  if (!existing.has("FrameFuse-Setup-1.20.0.exe")) curlUpload(INSTALLER, "FrameFuse-Setup-1.20.0.exe", rel.id);
  else console.log("[ship] asset exists, skipping: FrameFuse-Setup-1.20.0.exe");
  if (!existing.has("latest.yml")) curlUpload(LATEST, "latest.yml", rel.id);
  else console.log("[ship] asset exists, skipping: latest.yml");
  if (!existing.has("FrameFuse-Setup-1.20.0.exe.blockmap"))
    curlUpload(BLOCKMAP, "FrameFuse-Setup-1.20.0.exe.blockmap", rel.id);
  else console.log("[ship] asset exists, skipping: blockmap");

  // 3. three-way sha512 verification (local == latest.yml == re-downloaded)
  const ref = await gh(`/releases/tags/${TAG}`);
  rel = await ref.json();
  const installerAsset = rel.assets.find((a) => a.name === "FrameFuse-Setup-1.20.0.exe");
  const dl = await fetch(installerAsset.browser_download_url, { headers: HDRS });
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  const localHash = sha512File(INSTALLER);
  const dlHash = crypto.createHash("sha512").update(dlBytes).digest("base64");
  const yml = fs.readFileSync(LATEST, "utf8");
  const ymlHash = /sha512:\s*(\S+)/.exec(yml)?.[1];
  console.log(`[ship] sha512 local:    ${localHash.slice(0, 24)}…`);
  console.log(`[ship] sha512 yml:     ${String(ymlHash).slice(0, 24)}…`);
  console.log(`[ship] sha512 download:${dlHash.slice(0, 24)}…`);
  if (localHash !== dlHash) throw new Error("local != downloaded sha512");
  if (ymlHash && ymlHash !== localHash) throw new Error("latest.yml != local sha512");
  if (dlBytes.length !== size) throw new Error(`size mismatch: downloaded ${dlBytes.length} vs local ${size}`);
  console.log(`[ship] THREE-WAY VERIFIED ✓  https://github.com/${REPO}/releases/tag/${TAG}`);
}

main().catch((e) => {
  console.error("SHIP FAILED:", e.message);
  process.exit(1);
});
