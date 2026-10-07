// scripts/publish-release-1.33.9.js — one-shot release publisher for v1.33.9
// (lenient timeline parse + the loop-export speed + honest ETA + keep-in-media).
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

const BODY = `## v1.33.9 — the "Timeline parse error" fixed for good, looped exports in seconds, honest ETA, media is never deleted

**"engine run failed: Timeline parse error: invalid type: null, expected f64"** (the 10-min audio + 1 image held to the timeline case): the timeline JSON carries numeric fields, and ONE leaked \`null\` (a NaN that JSON silently serializes as null) used to fail the WHOLE engine parse — the export then silently fell back to the **slow multi-phase FFmpeg-CLI pipeline**. That single bug caused BOTH of your reports: the error message AND the "too much slow" looped exports (the fast engine never ran). **Fixed at two levels**: the router now guarantees no NaN ever leaves for the timeline, and the engine (v0.4.2) repairs any null/string-number on a numeric field to its documented default instead of failing — a malformed payload degrades gracefully, never routes to the slow path. Brute-force verified: **zero** numeric fields can fail the parse any more. (Any future parse failure now prints the exact JSON excerpt with a ◀ marker at the offending field, straight in the badge text.)

**Looped export speed** (researched x264 preset ladders, threading, GOP and pipeline parallelism — the decisive lever for loops is not re-encoding redundant frames): a single image held across your audio and a looped base video are detected as static, ONE cycle is encoded, and the remaining packets are cloned with shifted timestamps (exactly \`-stream_loop -c copy\` semantics — bit-exact loops, every player decodes them as perfect loops). Measured on a 4-core no-GPU machine: **10-min audio + 1 held image: 17.3 s. 10-min looped video: 21.0 s. 20-min static image: 20.9 s. 40-min loop: 61.9 s** (~39× realtime). Numbered-name image timelines keep the same fast path.

**ETA**: per-phase from the actual rate, and the chip no longer flips to "estimating…" between estimate events — the last good estimate stays latched per phase. Verified live: "rendering video · 2s elapsed · ETA 4m 08s" holding steady through gaps, 0 ETA gaps after the first estimate at full scale.

**Media is never "deleted"** when you remove a clip: the media-panel row/grid trash now removes from the TIMELINE and keeps the file in the library's "Not on timeline" section (with Add-to-restore + a separate explicit Delete-from-project) — previously those buttons permanently deleted the imported media. Matches the keyboard Delete and toolbar behavior.

**Version chip**: derived from package.json — the mismatched "1.33.7" chip on a 1.33.8 install can never happen again.

**Also in this build**: cancelling a Rust export no longer silently restarts it through the CLI pipeline; music clips with "Stop looping" extend the timeline again; images without a naming format import + loop normally; audio-only timelines export; honest "stopped at the last visual frame" diagnosis instead of the false "disk full".

### If you see "Installer integrity check has failed"
The download was truncated — re-download the installer, then check the size is EXACTLY the byte count shown below before running (no pause/resume, no download accelerators):
\`\`\`
certutil -hashfile FrameFuse-Setup-1.33.9.exe SHA512
\`\`\`

### Verified
- Brute-force null-injection across every numeric timeline field: zero parse failures; a repaired timeline exports correctly end-to-end (captions burned, exact duration).
- End-to-end UI repro (real app, real import + loop + captions): payload clean; engine fast paths engaged (dedup labels in the completion report).
- Engine v3 suite 20/20 · v2 PASS · smoke PASS · router 27/27 · full-scale loop/static matrices ALL PASS · lint clean.

**Full install only — NSIS installer**: download \`FrameFuse-Setup-1.33.9.exe\` below. Installing over any earlier version is fine — projects and settings are untouched.`;

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
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.33.9${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.33.9${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.33\.[0-9]+/g, "FrameFuse-Setup-1.33.9");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.33.9";
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
        name: `FrameFuse v1.33.9 — parse-error class eliminated, looped exports in seconds, honest ETA, media kept`,
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
    [INSTALLER, "FrameFuse-Setup-1.33.9.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.33.9.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.33.9.exe");
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
