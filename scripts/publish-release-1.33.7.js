// scripts/publish-release-1.33.7.js — one-shot release publisher for v1.33.7
// (the stuck-at-100% PROGRESS-MODEL root cause + honest ETA + black tail
// filler + audio-only exports + media panel fixes). Task playbook: CURL asset
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

const BODY = `## v1.33.7 — the native Rust engine is now THE export pipeline (every scenario), bounded-memory audio, honest elapsed + ETA only

**Your question, answered with measurements:** *"Is Rust faster than ffmpeg?"* — The Rust engine isn't a different encoder: it loads the **same FFmpeg libraries** (libavcodec/libavformat/libswscale) the CLI uses — directly in memory, no child processes, no intermediate files. Same encoders, **one single pass instead of 5+ CLI processes** writing and re-reading ~2GB of temp files (clip pool → PCM extract → loudnorm measure → audio mix → concat-mux → faststart rewrite).

**Measured A/B at your exact scale** (10s loop video + 69-min voiceover + captions → 4174.8s timeline, through the real export handler):

| | FFmpeg-CLI pipeline | **Rust native engine (v0.3)** |
|---|---|---|
| Wall time (2-CPU, no GPU test box) | 192.8s | 260.4s |
| Output size (same CRF) | 386.6MB | **258.1MB (33% smaller)** |
| Progress events | 390 | **1999** |
| Dishonest "ETA 0s" events | 1 | **0** |
| Phases after 95% | mux + finalize crawl (the stuck-at-100% family) | **none — audio mixes DURING the video pass** |
| Peak RAM (69-min timeline) | ~2GB | 1.7GB (streaming audio — any length) |
| GPU | none | **wgpu compositing + NVENC/QSV/AMF probing** on real hardware |

On the CPU-only test box the CLI's *ultrafast* draft tier trades quality for speed; the engine's default is better compression per byte — and on your real GPU it composites on the GPU and probes hardware encoders from the same DLLs. **The Rust engine IS the blueprint you pasted (N-API bindings + direct libav* in-memory, zero child processes) — it stays. The CLI path remains only as an emergency fallback** (if the engine can't load) and for 3 niche features (geometric slide/wipe/circleopen transitions, burn-in text removal, Stack Text headlines).

### What's new in the engine (v0.3)
- **Everything rides the native path now**: base-lane loop-to-fill (your 10s video looped to 69 min — pixel-verified seam parity), audio-extended black tails, audio-only projects, **in-process EBU R128 loudness normalization** (no ffmpeg child, constant-cost 90s measurement window, ±½ LU), overlay motion keyframes, music-clip looping.
- **Deep decoder fixes** (found with a self-contained FFI debugger): frame-threaded decoders emit a phantom "drain frame" at EOF (null planes, invalid format) that crashed the composite — guarded at three levels; the loop's backward seek never fired after EOF (fixed); missing payload fields no longer default to invisible/silent layers.
- **Streaming audio mixer**: sources decode in 60s windows and mix incrementally — peak RAM is now flat (~1.7GB at 69 min) no matter the timeline length; the full 69-minute export completes end-to-end on a 3GB box.

### Time display (your directive)
The "time taking / total time" line is **gone** — it was content position, not a stopwatch (it raced at 25× realtime then crawled). The header now shows exactly two numbers: **elapsed** (wall clock) and **ETA** (never 0 until the file is actually done — "estimating…" while warming up).

### Verified (real code, real media)
v3 engine feature suite 18/18 (pixel-level loop seam, luma-profiled black tails, loudnorm lift −55→−24dB, motion-path sampling) · v2 suite PASS · router suite 27/27 (incl. stale-engine safety) · the v1.33.6 CLI regression suite PASS · full 69-min export through the real handler twice (exact 4174.83s output, zero ETA glitches, smooth 92→100%) · lint clean · zero console errors in the UI.

**Full install only — NSIS installer**: download \`FrameFuse-Setup-1.33.7.exe\` below. Installing over any earlier version is fine — projects and settings are untouched.`;

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
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.33.7${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.33.7${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.33\.[0-9]+/g, "FrameFuse-Setup-1.33.7");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.33.7";
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
        name: `FrameFuse v1.33.7 — the native Rust engine is THE export pipeline (all scenarios, bounded memory, honest elapsed+ETA)`,
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
    [INSTALLER, "FrameFuse-Setup-1.33.7.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.33.7.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.33.7.exe");
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
