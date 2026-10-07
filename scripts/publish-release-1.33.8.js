// scripts/publish-release-1.33.8.js — one-shot release publisher for v1.33.8
// (the export OOM crash fix + static-loop packet dedup + honest ETA + the
// audio-extended disk-full honesty). Task playbook: CURL asset uploads,
// dupe-aware, three-way sha512.
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

const BODY = `## v1.33.8 — export crash fixed, looped exports 60-80 min → ~1-2 min, honest ETA

**The crash ("app closed itself at ~1.x GB")**: the audio mix for a 69-minute timeline is 1.6 GB, and the old code held it ALL in RAM as a plain allocation — plus it fully decoded any voiceover MP3 under 64 MB of *file* size (a 33 MB 69-min MP3 expands to 1.6 GB of decoded audio). Peak ~3.2 GB of incompressible memory = the app dies mid-export, and the slowdown you saw before the crash (ETA 60 → 80 min) was the machine paging itself to death. **Fixed**: long mixes now live in a file-backed mapping (the OS reclaims those pages under pressure — they can never OOM-kill the app), and sources are gated by their *decoded* size, streaming in 60-s windows (measured: peak memory on the exact repro dropped 1665 MB → 240 MB).

**The speed**: a 10-s video looped for 69 min renders 125,220 frames — of which exactly 300 are unique. The engine now detects a static loop, encodes ONE cycle, and re-emits its bitstream packets with shifted timestamps for every further cycle (this is precisely what \`-stream_loop -c copy\` produces — every player decodes it as a perfect loop; verified bit-exact). **Your exact scenario (10-s looped video + 69-min voiceover): 60-80 min → about a minute of video work + the audio pass.** The same trick applies to audio-extended timelines (video ends, audio continues — the black tail clones from one packet) and audio-only projects.

**The false "disk full" error** (output 10.0s vs timeline 4174.8s): the native engine already renders the full audio length; the check that fired it now distinguishes "stopped at the last visual frame" (fixed diagnosis: set Loop, or the engine handles it) from a genuine truncation.

**ETA**: computed per-phase from the ACTUAL current rate — it counts down honestly, never climbs while the machine pages, and never shows "0s" through the audio tail.

### Verified
- Full 69-min repro (10-s looped video + 69-min voiceover MP3): **73.5 s wall, exact 4174.805-s output, 125,244 frames, bit-exact loop (frame@5s == frame@3005s), spill file auto-removed, peak memory bounded**.
- Non-looped 69-min (the disk-full case): exact 4174.805-s output.
- Engine v3 feature suite 20/20 · v2 suite PASS · E2E smoke PASS · lint clean.

**Full install only — NSIS installer**: download \`FrameFuse-Setup-1.33.8.exe\` below. Installing over any earlier version is fine — projects and settings are untouched.`;

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
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.33.8${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.33.8${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.33\.[0-9]+/g, "FrameFuse-Setup-1.33.8");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.33.8";
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
        name: `FrameFuse v1.33.8 — export crash fixed, looped exports 60-80 min → minutes, honest ETA`,
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
    [INSTALLER, "FrameFuse-Setup-1.33.8.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.33.8.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.33.8.exe");
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
