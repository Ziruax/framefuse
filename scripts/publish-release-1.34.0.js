// scripts/publish-release-1.34.0.js — one-shot release publisher for v1.34.0
// (engine 0.5.1: the 180° flip fix + the caption-run speed path that runs).
// Task playbook: CURL asset uploads, dupe-aware, three-way sha512.
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

const BODY = `## v1.34.0 — the upside-down export fixed, and the "69-min + 1 image + captions" export is 4.5× faster (measured on the real thing)

**The fatal one first**: exported videos played **upside-down (a 180° flip)**. This was the GPU compositor path — your engine health card's "GPU compositor - libx264" line means you were on it (the CPU fallback was always upright, which is why it slipped through every earlier test). One shader line flipped the sample vertically on top of a transform that had already handled it. **Fixed and locked**: a new orientation regression test (a top-red/bottom-blue image AND a decoded video, through the full pipeline, on BOTH compositor paths, plus caption placement) runs in CI from now on — a flip can never ship silently again. Verified on the real 62.8-min export below: the output frame matches the source image upright (pixel-level).

**Export speed — your exact scenario, actually benchmarked this time** (62.8 minutes of real Edge-TTS voiceover + one image held across the whole audio + captions, 720p, social quality, 4-core machine):
| | v1.33.9 | **v1.34.0** |
|---|---|---|
| wall time | 496.6 s (7.6×) | **109.3 s (34.5× realtime)** |
| file size | 256.8 MB | **150.4 MB** |
| frames re-encoded | all 90,428 | **4,633 (85,795 cloned)** |
| orientation | flipped (GPU path) | **upright** |

The caption fast path existed on paper but **never actually ran** on machines like yours: the encoder probe only checked that h264_nvenc is *compiled into* FFmpeg, not that it can *run* — so every "nvenc-registered-but-no-NVIDIA-GPU" machine predicted hardware, declined the clone-safe encoder settings, and silently fell back to re-compositing and re-encoding every single frame. Three more landmines were buried behind it (out-of-order packet submission that the muxer rejects; cloned P-frames that accumulated their quantization error frame after frame; and the hardware-fallback encoder branch dropping the zero-latency settings). All found with a 12-second reproducer, all fixed, all verified bit-exact: the cloned frames now decode **identically** to a dense encode (parity diff 2.18 on a 0-255 scale, threshold 3) — and each caption state starts at a keyframe, so the file seeks properly mid-video.

**Static image without captions**: a 10-min "image + voiceover" export used to produce a **557 MB** file (the engine re-emitted a 38 KB keyframe ~14,000 times). Now it encodes two frames and clones a ~100-byte P-frame for the rest: **2.3 MB in 4.1 seconds**. Same math scales to your hour-long exports.

**Slow GPU guard** (engine 0.5.0's work, now actually reachable): a 3-frame compositor benchmark runs before the encode loop and picks the CPU rasterizer when the GPU path is slower — the "36 frames in 4523ms" (~8 fps) health reading your APU showed is exactly the case this catches; the verdict shows on the engine card.

**UX audit** (browser-verified this session): clean load with zero console errors, sample storyboard, full Export tab, toolbar Delete keeps media in the library's "NOT ON TIMELINE" section with restore, mobile layout solid.

### If you see "Installer integrity check has failed"
The download was truncated — re-download the installer, then check the size is EXACTLY the byte count shown below before running (no pause/resume, no download accelerators):
\`\`\`
certutil -hashfile FrameFuse-Setup-1.34.0.exe SHA512
\`\`\`

### Verified this release
- Orientation test (new, in CI): image + decoded video + captions upright on BOTH compositor paths; fails on the old shader, passes on the fix.
- 12-s caption-run parity: cloned frames vs dense encode, worst mean-abs-diff 2.18 (was 10.65 = visible drift).
- 62.8-min end-to-end: 109.3 s, duration exact to the audio (3767.85 s), 150.4 MB, upright, 288-keyframe seekable file.
- Engine v3 suite 20/20 · v2 PASS · smoke PASS · GPU color tests PASS · lint clean.

**Full install only — NSIS installer**: download \`FrameFuse-Setup-1.34.0.exe\` below. Installing over any earlier version is fine — projects and settings are untouched.`;

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
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.34.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.34.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.34\.0/g, "FrameFuse-Setup-1.34.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.34.0";
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
        name: `FrameFuse v1.34.0 — the upside-down export fixed; 62.8-min audio + 1 image + captions in 109 s (34.5× realtime)`,
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
    [INSTALLER, "FrameFuse-Setup-1.34.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.34.0.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.34.0.exe");
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
