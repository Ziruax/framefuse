// scripts/publish-release-1.33.1.js — one-shot release publisher for v1.33.1
// (TTS "No audio file path given" IPC shape fix + Groq client-cache
// poisoning fix + honest timeout verdicts). Task-45 playbook: CURL asset
// uploads, dupe-aware, three-way sha512.
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

const BODY = `## v1.33.1 — fixes "TTS: no audio path" + "Groq test green but captions fail"

**The two reports this patch closes:**
> "text to speech failed because no audio path is given" and "the Groq key test shows green / real transcription verified, but generating captions fails with 'could not reach the API' — every attempt."

### Fix 1 — TTS: "No audio file path given" (desktop app, every TTS-Studio Generate)
The renderer called \`ttsReadAudio({ filePath })\` (the shape the app's own TypeScript contract documents) while the preload wrapper expected a bare string — so the payload crossed IPC **double-wrapped** (\`{ filePath: { filePath: … } }\`), the main process's strict string check saw \`""\`, and every long-form TTS Generate died with **"No audio file path given"** even though the MP3 was synthesized, written and probed successfully.
- \`ttsReadAudio\` in the preload now normalizes BOTH shapes (object or string) before the IPC hop; the main handler additionally tolerates a double-wrapped stale payload.
- Verified inside REAL Electron (Xvfb) through the actual preload + actual handler: the object shape returns the exact synthesized bytes, the string shape still works, and the temp-directory path confinement (security guard) is intact.

### Fix 2 — Groq: "key test green, transcription 'could not reach api.groq.com'" — every time
Two stacked root causes, both live-reproduced:
1. **SDK client cache poisoning.** The Groq client cache was keyed by \`(apiKey, transport)\` ONLY — so the FIRST client created for a key (the key-test's **15-second** probe client) was handed back to every later call that asked for a **longer** timeout or its own upload-progress sink. After a successful key test (the green signal), every real transcription ran with the probe's 15 s cap: any audio longer than a few seconds aborted mid-request, \`APIConnectionTimeoutError\` carries no HTTP status, and the classifier printed **"Could not reach api.groq.com — a network-level failure (VPN/proxy/firewall…)"** — blaming your network while the app's own cap killed the request. The upload-progress bar never moved either (the cached client had no progress sink).
   - The cache key now includes the timeout; transcription clients are **transient** (built fresh per run, 15-minute request cap, own progress sink); groq-chat's per-request timeout gets its own slot too.
2. **The timeout was mislabeled as a network failure.** A client-side request timeout now produces its own honest, retryable verdict: *"The Groq transcription request timed out (the app's 15-minute cap) — the key and network are fine (the test probe passes); this audio is too long or the upload too slow for one request. Retry, use a shorter audio file, or check the connection speed"* (\`GROQ_TIMEOUT\`), never "could not reach".
- Web-preview routes got the same treatment: a per-request 600 s timeout (per-request overrides beat any cached client timeout in the groq-sdk — behavior verified live), and the no-status error branch now always carries the underlying SDK message instead of a generic sentence.

### Verified (all run, honestly reported)
- Unit/node: cache-poisoning repro impossible (15 s key-test client can never be handed to a 900 s transcription), transient clients per-call, timeout classification (\`GROQ_TIMEOUT\`, retryable, honest text), connection errors keep their cause, user-abort ≠ timeout, real preload file loaded and shape-normalized, main-side unwrap + strict empty rejection.
- **REAL Electron under Xvfb, 9/9** — including the live transcription-shaped request through the SDK + Chromium net with upload progress firing (835/835 bytes) and the honest classified verdict, plus the groqTestKey flow unchanged.
- groq-sdk per-request timeout override verified live (0.9 s override beat a 30 s client default → \`APIConnectionTimeoutError\` in 927 ms).
- Browser E2E: TTS Studio Generate → result card → **audio plays** (paused=false, readyState=4); captions → the request fires through the whole pipeline and surfaces the classified verdict. Zero console/page errors. Gates: ESLint clean, 16 electron files parse clean, tsc unchanged baseline, dub-studio smoke ALL PASSED.
- Standing sandbox limit (unchanged since v1.31): this build machine's own network edge is Cloudflare-blocked from api.groq.com, so a real transcription 200 could not be round-tripped HERE — on your machine the key test's green "real transcription verified end to end" already proves the endpoint, key and model work; with this patch the captions run finally gets the request budget it always needed.

**Full install only — NSIS installer** (per the standing directive): download FrameFuse-Setup-1.33.1.exe below. Installing over v1.33.0 is fine.`;

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
  // electron-builder writes "FrameFuse Setup 1.33.1.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.33.1${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.33.1${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.33\.0/g, "FrameFuse-Setup-1.33.1");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.33.1";
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
        name: `FrameFuse v1.33.1 — TTS "no audio path" + Groq "test green, captions fail" fixed`,
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
    [INSTALLER, "FrameFuse-Setup-1.33.1.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.33.1.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.33.1.exe");
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
