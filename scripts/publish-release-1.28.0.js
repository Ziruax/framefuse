// scripts/publish-release-1.28.0.js — one-shot release publisher for v1.28.0
// (provider honesty: Built-in Cloud removed, real Groq/Gemini everywhere;
// kinetic export/preview parity; rust engine v2.1 speed).
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

const BODY = `## v1.28.0 — Real providers only, kinetic parity, faster engine

**The ask:** the "Built-in Cloud" AI provider only worked on the dev box — never on user devices; the Groq key test failed even with a valid key; Gemini calls died with "Failed to fetch"; kinetic captions in exports didn't match the preview; and the native export should get faster.

### Fixed — AI providers now work on YOUR device
- **Built-in Cloud provider REMOVED** everywhere (Settings, Captions, Dub Studio). The real providers are **Groq** (Whisper transcription + script writing) and **Google Gemini** (script writing) — with YOUR keys.
- **Why your key test failed:** the v1.27 Settings tab tested keys through a web-only route that doesn't exist in the installed app (\`file://\` → "Failed to fetch"), and keys you saved in the Settings tab never reached the main process that actually makes the API calls. **Fixed with dual transport:**
  - Keys now save through the app itself (stored on your device, private) — the same key store the transcription/dubbing engine reads.
  - **Test** runs a real network check from the app process (no browser CORS, exact API errors: invalid key, rate limit, network).
  - The desktop's Dub Studio + one-shot dub now honor the provider AND model you pick in Settings (previously the desktop silently used its own defaults and dropped your selection).
- **One source of truth:** the whisper model you pick in Settings now drives every transcription surface (previously a second hidden legacy preference could override it).

### Fixed — kinetic typography export = preview
The exported kinetic captions now match the editor preview: same word timing (\`\\move\` rides the exact motion offsets), same base color (custom color rendered white in native exports before), same shadow-only stroke (no more heavy outline + letter-spacing re-flow), push/fade-rise/slide animations, fast-mode 720p geometry rescale, and the \`.ass\` sidecar now carries the full kinetic choreography (it exported plain captions before). Verified with a 2,727-assertion parity test against the real preview engine.

### Faster — Rust engine v2.1
- **RGBA buffer pool** — the per-frame 8 MB allocation storm (Windows VirtualAlloc commit + page-fault churn) is gone; buffers recycle between the decoder and encoder threads.
- **Held-frame cache** — frame-hold segments (source fps < output fps, slow-mo, EOF tail) skip the color conversion AND the GPU re-upload.
- **CPU scale-cache rebuild** — LRU + byte budget; cache hits are refcounts, not multi-megabyte clones; video frames no longer evict the static image/text entries (resize thrash bug).
- Measured on the A/B harness: **−4.6% to −6.1% wall time** with **byte-identical output** (sha256-verified on three test suites). The biggest wins (alloc churn removal, upload skip) land on the Windows GPU path.

### Engineering notes
- Every \`electron/**/*.js\` file now passes a full V8 parse gate (\`node --check\`) in BOTH \`bun run lint\` and \`electron:build\` — the v1.27.0 launch-crash class can never ship again.
- tsc / ESLint clean; browser-verified (Settings render + key flows, Dub Studio summaries, TTS voices/routes).
- The shipped Rust engine binary is the exact CI smoke-tested v2.1 artifact (rust-gpu, 150-frame h264+aac E2E, sha256 \`d03e5d84…\`).

**Full install only — NSIS installer** (per the standing directive): download \`FrameFuse-Setup-1.28.0.exe\` below. Installing over v1.27.x is fine.`;

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
  // electron-builder writes "FrameFuse Setup 1.28.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.28.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.28.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.28\.0/g, "FrameFuse-Setup-1.28.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.28.0";
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
        name: `FrameFuse v1.28.0 — real providers only, kinetic parity, faster engine`,
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
    [INSTALLER, "FrameFuse-Setup-1.28.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.28.0.exe.blockmap"],
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
    `https://github.com/${REPO}/releases/download/${TAG}/FrameFuse-Setup-1.28.0.exe`,
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
