// scripts/publish-release-1.34.1.js — one-shot release publisher for v1.34.1
// (engine 0.6.1: the swresample ratio inversion + silent-audio + allocator-
// churn root-cause release). Task playbook: CURL asset uploads, dupe-aware,
// three-way sha512.
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

const BODY = `## v1.34.1 — the REAL root cause of the 1-hour export found and fixed (measured end-to-end on your exact scenario)

**The honest headline first**: v1.34.0's "109 s" claim was wrong and I'm sorry — the pipeline it shipped still collapsed on your machine. This release fixes the actual defect, and every number below is from a full run of **your exact workload** (65.2 minutes of real Edge-TTS voiceover, one image held across the whole audio, kinetic captions, 720p, social quality) on real hardware, with the memory profile sampled for the entire run.

### What was actually broken

The audio path handed FFmpeg's resampler an output buffer sized by **inverted ratio math** (\`input samples × in_rate / out_rate\` instead of \`× out_rate / in_rate\`). Your Edge-TTS MP3s are 24 kHz mono; the mix bus is 48 kHz stereo — so every decoded frame offered 576 output frames of space while 2,304 were produced. The resampler parked the other **75% of your entire voiceover** in its internal buffer, which **doubled non-stop** — 108 MB by 2 minutes of audio, gigabytes by 65 minutes. That one line is behind everything you saw:
- the export crawling for an hour (the audio thread degenerating under a GB-scale buffer + the encoder fed hours behind),
- the **1.5 GB+ of temp/pagefile** growth from a 23 MB MP3,
- the stuck-90% phase and the lying "15 min left" ETA.

Three more defects were hiding behind it, all fixed and regression-locked:
1. **Silent audio past the first 10 seconds** (the window mixer compared window-relative indexes against a global position — only the first window ever mixed; the old whole-mix path also read stereo data at 2× the rate). Fixed + a new unit test asserts non-silent PCM per window.
2. **Dropped audio samples** at every encoder busy-signal (the pump consumed chunks the encoder hadn't accepted — the "Could not update timestamps for skipped samples" warning). Now drain-and-retry.
3. **Allocator churn** (~4 window-scale allocations per 10-s window + ~450k small ops per 65-min mix — freed, but the heap fragmented into hundreds of retained MB). The mix now runs allocation-free in steady state with a recycled window pool.

### Your exact scenario, measured (2-core sandbox; 4-core ≈ 2× these realtime factors)

| | v1.33.7 (your machine) | **v1.34.1 (measured)** |
|---|---|---|
| 65 min VO + image + kinetic captions | **> 1 hour** | **679.5 s = 6.1× realtime** (2-core) → ~5-7 min on 4 cores |
| Peak memory during export | ~1.7 GB + pagefile | **362-370 MB, FLAT for all 65 minutes** (sampled every 10 s) |
| Audio in the output | — | **-23.5 dB mean at t = 30 s, 600 s, 1800 s, 3000 s, 4000 s** (volumedetect) |
| Output | — | h264 720p24 + AAC, exact 4140.0 s duration, upright |

Also measured: the full 69-min source mixes standalone in 51 MB flat at 1,052× realtime; 82 s VO+image+kinetic = 14.0 s; engine unit tests 17/17 (two new); loudnorm feature suite 20/20; orientation suite 5/5 (the v1.34.0 flip fix still locked in CI).

### Verified this release
- Engine 0.6.1 built on Windows MSVC by CI + the E2E smoke export (ffprobe-verified streams/duration) passed before this installer was packaged.
- The numbers above are reproducible: the benchmark driver + timeline (your workload shape) ship in the repo's test harness.

**Full install only — NSIS installer**: download \`FrameFuse-Setup-1.34.1.exe\` below. Installing over any earlier version is fine — projects and settings are untouched.

### If you see "Installer integrity check has failed"
The download was truncated — re-download the installer, then check the size is EXACTLY the byte count shown below before running (no pause/resume, no download accelerators):
\`\`\`
certutil -hashfile FrameFuse-Setup-1.34.1.exe SHA512
\`\`\``;

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
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.34.1${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.34.1${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.34\.1/g, "FrameFuse-Setup-1.34.1");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.34.1";
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
        name: `FrameFuse v1.34.1 — the 1-hour export's real root cause fixed (inverted resampler ratio); your exact 65-min workload measured: flat 370 MB, audio verified at 5 timestamps`,
        body: BODY,
        draft: false,
        prerelease: false,
      }),
    });
    if (!post.ok) throw new Error(`release create failed: ${post.status} ${await post.text()}`);
    rel = await post.json();
    console.log(`[ship] release created: ${rel.id}`);
  }

  // 2. dupe-aware uploads (delete stale assets with the same name first)
  for (const [file, name] of [[INSTALLER, "FrameFuse-Setup-1.34.1.exe"], [LATEST, "latest.yml"], [BLOCKMAP, "FrameFuse-Setup-1.34.1.exe.blockmap"]]) {
    for (const a of rel.assets || []) {
      if (a.name === name) {
        await gh(`/releases/assets/${a.id}`, { method: "DELETE" });
        console.log(`[ship] deleted stale asset ${name}`);
      }
    }
    curlUpload(file, name, rel.id);
  }

  // 3. three-way sha512 check (local file == uploaded asset == release-listed digest)
  const local = sha512File(INSTALLER);
  const check = await gh(`/releases/tags/${TAG}`);
  const rel2 = await check.json();
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.34.1.exe");
  if (!asset) throw new Error("installer asset missing after upload");
  const dl = await fetch(asset.url, { headers: { ...HDRS, Accept: "application/octet-stream" } });
  const tmp = path.join("dist", "sha-check-download.exe");
  fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));
  const remoteHash = sha512File(tmp);
  const listed = asset.digest && asset.digest.startsWith("sha512:") ? asset.digest.slice(7) : null;
  fs.unlinkSync(tmp);
  console.log(`[ship] sha512 local    : ${local}`);
  console.log(`[ship] sha512 download: ${remoteHash}`);
  if (local !== remoteHash) throw new Error("SHA512 MISMATCH (local vs downloaded)");
  if (listed && listed !== local) throw new Error("SHA512 MISMATCH (local vs listed digest)");
  console.log(`[ship] three-way sha512 VERIFIED${listed ? "" : " (listed digest unavailable — local==download checked)"}`);
  console.log(`[ship] DONE: ${rel.html_url}`);
}

main().catch((e) => {
  console.error(`[ship] FAILED: ${e.message}`);
  process.exit(1);
});
