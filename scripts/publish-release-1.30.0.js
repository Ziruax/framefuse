// scripts/publish-release-1.30.0.js — one-shot release publisher for v1.30.0
// (voiceover roles + loop-to-fill timeline, audio-extended exports, key-truth
// key testing, dub resilience — every fix E2E-verified in the browser + real
// ffmpeg). Task-45 playbook: CURL asset uploads, dupe-aware, three-way sha512.
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

const BODY = `## v1.30.0 — Groq transcription fixed: real end-to-end key testing + honest failures

**The ask:** "groq transcription is not working" — the failure message said Groq rejected the API key, but the Groq console showed no API call at all, so there was no way to tell a bad key from a broken network from a working key. The implementation was audited line-by-line against the official Groq Speech-to-Text documentation and live-tested against the real endpoint.

### Fixed — the web-preview error was raw and useless
- The Dub Studio transcription failure in the web preview printed the raw server response (Groq Whisper 403 {"error":{"message":"Forbidden"}}, HTTP 502). It now returns an **actionable, classified error with the masked key fingerprint** (Groq rejected the API key (gsk_AbC…9xY2) — re-save a valid key from console.groq.com → API Keys) and the right status code. Verified end-to-end in the browser: import video → Dub Studio → Transcribe → classified toast.

### New — the Test button now runs a REAL transcription
- Testing a Groq key used to only call GET /models (it proves the key *authenticates*, not that *transcription works*). The Test button now ALSO posts a tiny 1-second silent MP3 to /openai/v1/audio/transcriptions with your **selected Whisper model** — the exact same endpoint, auth header and multipart contract production transcription uses.
- Three distinct outcomes, each with its own message:
  - **Key works — real transcription verified end to end** (the full pipeline passed),
  - **Groq rejected the API key (gsk_AbC…9xY2)** (Groq's own 403 JSON — see below),
  - **The key authenticates, but a real transcription test failed: …** (auth is fine; the failure is transcription-specific — model access, rate limit, etc.).
- Works everywhere: the desktop app (main-process HTTPS) and the web preview (the Settings tab test), with the selected Whisper model riding the request.

### New — the "no API call in my Groq console" mystery, solved
- **Groq's auth failures are a bare 403 {"error":{"message":"Forbidden"}} — and rejected requests NEVER appear in the Groq console's request logs.** An empty console page can't confirm or deny a key problem; that's Groq's behavior, not a missing request.
- **A 401/403 with a NON-JSON body is now classified as what it actually is: a block in front of Groq** (VPN, proxy, firewall, or a Cloudflare challenge page) — the request never reached Groq, so the key was never checked. Previously this was mislabeled "Groq rejected the API key," which is exactly what sent you to a console that can't show it.
- Both classifications are live-verified against the real api.groq.com (bogus key → JSON 403; HTML 403 → blocked-before-Groq), and every Groq/Gemini call site now shares the same classifier (desktop Whisper, desktop chat, web transcription, web key test, web chat).

### Audited against the official docs (console.groq.com/docs/speech-to-text)
- Endpoint POST https://api.groq.com/openai/v1/audio/transcriptions, Authorization: Bearer, multipart file + model + response_format=verbose_json + timestamp_granularities[]=word,segment + optional ISO-639-1 language — all conformant (verified with a live request from the app's own module).
- Model ids (whisper-large-v3-turbo default, whisper-large-v3), the 25 MB request cap (bitrate-ladder compression + time-chunking), and verbose_json response parsing (words/segments/language/duration) all match the documented contract.
- Rate limits, 404 model-access, 413 too-large, 429 and 5xx all carry specific, actionable messages; retries stay automatic for network/429/5xx only.

### Engineering notes
- Rust native engine unchanged (the exact CI smoke-tested v2.1 binary, sha256 d03e5d84…); every electron/**/*.js passes the V8 parse gate; lint + tsc clean (no new errors); the Dub Studio smoke suite (transcribe → script → dub, legacy + single-voice) still passes; packaged ASAR contains all new markers and the extracted module live-smokes correctly.
- Back-compat: the key test payload gained an optional model field; old callers (and the legacy one-shot test) behave exactly as before.

**Full install only — NSIS installer** (per the standing directive): download FrameFuse-Setup-1.30.0.exe below. Installing over v1.30.0 is fine.`;

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
  // electron-builder writes "FrameFuse Setup 1.30.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.30.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.30.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.29\.0/g, "FrameFuse-Setup-1.30.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.30.0";
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
        name: `FrameFuse v1.30.0 — voiceover roles, loop-to-fill, honest key errors, dub fix`,
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
    [INSTALLER, "FrameFuse-Setup-1.30.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.30.0.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.30.0.exe");
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
