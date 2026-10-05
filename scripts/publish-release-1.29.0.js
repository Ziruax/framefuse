// scripts/publish-release-1.29.0.js — one-shot release publisher for v1.29.0
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

const BODY = `## v1.29.0 — voiceovers, loop-to-fill, honest key errors, dub fix

**The ask:** imported audio always landed as looping background music with no voiceover option; the timeline locked you out of placing media; a 1h9m audio + 10s video got the audio auto-trimmed to 10s with no way to loop the video; the audio lane was invisible until images were added; transcription reported "Groq rejected the API key" while the Groq console showed no API call; the text remover needed real testing; and the full dubbing flow needed an end-to-end pass.

### New — audio roles (voiceover vs background music)
- Import audio as **Voiceover** (fixed length — the timeline runs to its end, never looped, never trimmed, Whisper transcribes it first) or **Background music** (loops to fill — the classic behavior). Two explicit buttons in the Media → Audio tab AND in Settings → Music & voiceover, plus a one-click role switch on any audio clip (timeline popover or the settings card).

### New — loop-to-fill for VIDEO clips
- Any base-lane video clip can now **Loop to fill the timeline** (clip settings toggle or right-click the clip). The "1 hour of audio + 10-second clip" case: import the audio as a voiceover, flip Loop on the video — the video repeats to cover the whole audio. Verified with a real FFmpeg render: a 10s source looping over 40s of audio produced exactly 40.000s with clean repetition (frame-level periodicity checked).

### Fixed — the timeline honors the audio's length
- **No more silent auto-trim:** a non-looping audio clip (any voiceover, or music with Loop off) now EXTENDS the timeline; the export length uses it (the export used to recompute the length from the visual clips only and cut the audio to the video).
- **Audio-only projects work:** the Audio lane and the transport (play / scrub / loop) render and play with zero images on the timeline.
- **Absolute-mode images place normally:** images without filename timing used to be SKIPPED in absolute mode — they now append after the last clip like videos (drag to reposition, same as everything else).
- The one-shot hint tells you when the audio outlives the visuals and how to loop a clip to fill them.

### Fixed — "Groq rejected the API key" (no API call in your console)
- **Root cause:** the Settings **Test** button tested one key (a browser-stored copy) while transcription used a DIFFERENT key stored on your device — the test passed, transcription sent the stale key, Groq rejected it, and auth-rejected requests never show up in the console's usage. **Fixed:**
  - On the desktop app, Test now always checks the key that transcription actually uses (the device key), never a browser copy.
  - If you ever saved a key in the web preview (or v1.27), it now migrates to the device automatically on first launch.
  - Rejection messages now include the masked key that was rejected (e.g. \`gsk_AbC…9xY2\`) so you can tell WHICH key is stale, plus the fix path (Settings → Default AI models).
  - Keys are validated before any network call (Groq keys start with \`gsk_\`; quotes/whitespace are stripped or rejected with a clear message).
- Same treatment for Gemini (including Google's 400 "API key not valid" shape, which used to print raw JSON).

### Fixed — dubbing: one bad line no longer kills the dub
- A punctuation-only script line (garbage transcript tokens like \`#\`) made Edge TTS return no audio, which failed the WHOLE dub run with a misleading "voice name is probably invalid" error. Un-speakable lines are now skipped with a warning — verified end to end (real speech → transcribe → script → synthesize → dub segments on the timeline), plus the Dub Studio pipeline smoke suite (transcribe → script → dub, legacy + single-voice paths).

### Tested — text remover (real FFmpeg)
- All three removal styles verified on a real render: **Inpaint** (delogo interpolation), **Blur** (region-limited boxblur), **Cover** (solid box) — output durations exact, region pixels changed, surrounding pixels untouched, payload sanitization edge cases clean. The OCR detector + region UI round-trips through project state.

### Engineering notes
- Rust native engine unchanged (the exact CI smoke-tested v2.1 binary, sha256 \`d03e5d84…\`); looping/extended-timeline exports route through the FFmpeg pipeline (the router gates \`base-loop\` / \`audio-extends-video\` and says why).
- Every \`electron/**/*.js\` passes the V8 parse gate; lint + tsc clean (no new errors); 2,727-check kinetic parity suite still green; the audio mix and loop argv regression-diffed byte-identical for untouched projects.
- Back-compat: old project files open unchanged (role/loop fields are optional).

**Full install only — NSIS installer** (per the standing directive): download \`FrameFuse-Setup-1.29.0.exe\` below. Installing over v1.28.x is fine.`;

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
  // electron-builder writes "FrameFuse Setup 1.29.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.29.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.29.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.29\.0/g, "FrameFuse-Setup-1.29.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.29.0";
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
        name: `FrameFuse v1.29.0 — voiceover roles, loop-to-fill, honest key errors, dub fix`,
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
    [INSTALLER, "FrameFuse-Setup-1.29.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.29.0.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.29.0.exe");
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
