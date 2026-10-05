// scripts/publish-release-1.33.0.js — one-shot release publisher for v1.33.0
// (TTS system-proxy tunnel + Groq 404 interceptor failover). Task-45 playbook:
// CURL asset uploads, dupe-aware, three-way sha512.
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

const BODY = `## v1.33.0 — official SDKs (edge-tts-universal + groq-sdk), audio validation, structured errors

**The brief:** "Fix Edge TTS Synthesis and Groq Transcription" — adopt the maintained implementations, validate audio at every boundary, return distinguishable structured errors, and never treat a successful connection as proof that audio processing works.

### Root cause found while integrating (live-verified)
**Microsoft's speech service has DROPPED the \`mstts:express-as\` element.** Every styled SSML request is closed with \`1007 "SSML is invalid"\` — with both namespace forms. This was a pre-existing silent break (no app surface sends styles; the TTS Studio presets are pure prosody). Style requests now degrade ONCE to the styleless SSML and the result carries a visible \`warnings\` entry — never silent, never a hard failure.

### Part 1 — Edge TTS: the maintained package engine
- **edge-tts-universal@1.4.0** is now the PRIMARY synthesis engine (Node.js implementation, exactly as the brief specifies): word boundaries via WordBoundary chunks, proxy-URL support, dual CJS/ESM.
- The v1.32 raw client stays as the **fallback engine** (it owns the SOCKS5 tunnel and the style SSML), and the package's ORIGINAL error is captured and logged before any fallback fires (brief requirement: never lose the first failure's cause).
- **Output validation:** every result must be ≥100 bytes AND carry a valid MP3 signature (ID3 or MPEG frame sync) before success is reported. **Atomic writes:** unique temp file per job → fsync → rename — concurrent jobs can never collide or see half-written files.
- Empty text / invalid voice / oversized text are TERMINAL structured errors (\`TTS_EMPTY_TEXT\`, \`TTS_INVALID_VOICE\` with the voice named, \`TTS_TEXT_TOO_LONG\`) — never retried.

### Part 2 — Groq: the official SDK
- **groq-sdk@1.6.0** is the request engine for transcription, chat, the key probe and the model listing — in BOTH runtimes. Inside Electron it rides the app's Chromium net stack (OS-proxy-honoring) through a custom \`fetch\` adapter with upload progress and AbortSignal; the v1.32 interceptor-failover retry (direct Node https) survives at the SDK error layer.
- **\`GROQ_API_KEY\` environment fallback** (the SDK's own resolution order: Settings key → env) — server-side only, never a \`NEXT_PUBLIC_\` variable, never renderer code.
- The 25 MB upload cap is now **configurable** and enforced locally.

### Part 3 — Audio validation (before ANY network work)
The file must exist, be non-empty, sniff as REAL audio by **magic bytes** (MP3/WAV/OGG/FLAC/MP4/WebM — never the extension), and fit the cap — with distinct structured codes for missing / empty / unrecognized / unsupported / too-large. One implementation (\`electron/audio-format.js\`) serves the desktop app and the web routes.

### Part 4/5 — Architecture + structured errors
- The request paths are unchanged and consistent: React UI → Electron IPC (file paths, plain serializable objects) → Node audio service. No raw streams or Buffers cross IPC. Keys stay in the trusted Node processes.
- Every failure now carries \`{ service: "edge-tts" | "groq", code, message, retryable }\` — 12 Groq codes (\`GROQ_EDGE_BLOCK\`, \`GROQ_INTERCEPTED_404\`, \`GROQ_KEY_REJECTED\`, \`GROQ_MODEL_NOT_FOUND\`, \`GROQ_FILE_TOO_LARGE\`, …) and 10 TTS codes. The web routes return them in the error JSON; the Electron main process logs the full stack + code; the UI keeps the actionable text.
- Packaging: the SDKs ship as self-contained vendored bundles inside the ASAR (the app packs zero node_modules by design) — \`electron/vendor/\` (652 KB + 85 KB), same bundling approach as the GPU worker.

### Acceptance tests (all run, honestly reported)
- **Edge TTS:** EN + ES sentences, long narration (568 KB / 220 words), invalid voice (informative \`TTS_INVALID_VOICE\`), empty text, style degradation with surfaced warning, 3 simultaneous jobs (distinct files, zero temp leftovers) — and the generated audio **plays in the application's audio player** (verified: 4.06 s duration, currentTime advancing).
- **Groq:** validation matrix (corrupt → \`TRANSCRIPTION_FORMAT_UNRECOGNIZED\`, empty → \`TRANSCRIPTION_INVALID_FILE\`, missing → \`TRANSCRIPTION_FILE_MISSING\`, oversized → \`TRANSCRIPTION_FILE_TOO_LARGE\`); known-good MP3 + WAV proceed to a REAL SDK request. **From this sandbox the provider's network edge refuses all connections (Cloudflare IP-range block — documented in v1.31)**, so real transcription round-trips could NOT be verified here; the request contract is doc-audited, the SDK path is live-exercised to the edge, and the packaged app on a working network is where the real transcription test completes.
- **Electron dev mode:** 9/9 inside a REAL main process (SDK through electron-net, transport-failover marking, package engine + atomic writes).
- **Packaged app:** modules extracted from the shipped ASAR and live-smoked — validation, probe, TTS (real audio + word metadata), chat classification all pass from the exact packaged code, loading the vendor bundles.
- Gates: ESLint clean, 16 electron files pass the V8 parse gate, tsc at the unchanged 11-error pre-existing baseline, dub-studio smoke ALL PASSED.

**Full install only — NSIS installer** (per the standing directive): download FrameFuse-Setup-1.33.0.exe below. Installing over v1.32.0 is fine.`;

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
  // electron-builder writes "FrameFuse Setup 1.33.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.33.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.33.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.32\.0/g, "FrameFuse-Setup-1.33.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.33.0";
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
        name: `FrameFuse v1.33.0 — TTS synthesis fixed (system-proxy tunnel) + Groq 404 interceptor failover`,
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
    [INSTALLER, "FrameFuse-Setup-1.33.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.33.0.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.33.0.exe");
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
