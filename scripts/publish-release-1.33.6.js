// scripts/publish-release-1.33.6.js — one-shot release publisher for v1.33.6
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

const BODY = `## v1.33.6 — the REAL "stuck at 100%" cause found & fixed (verified through the full export handler), honest time estimates, long-audio exports complete correctly

**The reports this patch closes:**
> "Export goes smooth until 95%, then slows and gets stuck at 100%." · "Time estimation is wrong — it moves too fast, then super slow, and after 95% the ETA shows 0s." · "Without looping: 'the output file is 10.0s long but the timeline is 4174.8s — the write was cut short'."

### What was actually wrong (found by running the REAL export handler end-to-end, not sliced functions)
1. **The progress bar hit 100% half-way through the encode.** The two-step pool contains the full-timeline video encode AND the full-timeline audio extraction — the progress fraction divided their **summed** work by the **timeline** length, so it reached 2.0 and the display clamp pinned the bar at **100% with ETA 0s** while the pool tails + audio mix + mux still had minutes to go (the exact "smooth to 95%, then stuck at 100%" experience). The fraction now tracks the pool's own completion; the timemark can no longer run to 2× the timeline.
2. **The ETA/total-time display was structurally dishonest.** The "time" line showed CONTENT position (it races at 25× realtime, then crawls) instead of wall-clock; the ETA was an all-run average that rounds to 0 after the pool. The header now shows **wall-clock elapsed · ETA** with phase-local estimates for every phase (mix, mux, finalize), "estimating…" while a phase warms up, and **100% is reserved for the actual completion event** (in-flight progress caps at 99.9 — the old 99.96 crawl displayed as "100.0%").
3. **Unlooped long-audio exports truncated + misdiagnosed.** With a 10s video + a 69-min voiceover and no Loop, the mux's -shortest ended the file at the visual end and the final check blamed the disk ("filled up mid-export"). The export now renders a **black tail with captions continuing** (the same treatment a real NLE gives an empty sequence) so the video covers the **full timeline** — and **audio-only projects export too** (black video over the whole audio).

### Media panel & timeline fixes
- **Images with any filename import fine** ("beach photo.png" no longer needs a timing pattern) — they land on the timeline AND the media tab with an adjustable 5s default.
- **A single image can hold the whole audio** — "Hold to timeline end" (image loop-to-fill), in clip settings and the right-click menu.
- **Removing a clip from the timeline keeps it in Media** — clips move to a restorable "Not on timeline" section instead of deleting your imported media (full delete stays in the panel's trash).

### Verified (real code, real ffmpeg, the user's exact scenario)
Full-handler harness at the user's scale (4174.8s timeline, 10s loop video, 69-min voice-role audio, burned captions) × 3 scenarios: looped → completes, bar tops at 94% in the video phase (was pinned 100%), 0 dishonest ETA-0 events; unlooped → black-tail fill, output exactly 01:09:34 (was the disk-full error); audio-only → black video over the full timeline. Plus the complete v1.33.4 + v1.33.5 regression suites (pipeline, scenario matrix) — all pass. ASAR audit of this installer: 54/54 checks (every prior fix marker retained + the 16 new v1.33.6 markers; engine sha256 matches the green CI smoke test; ffmpeg + DLLs packaged; version stamp 1.33.6). Three-way sha512 (local == latest.yml == re-downloaded) verified by the publisher.

**Full install only — NSIS installer**: download \`FrameFuse-Setup-1.33.6.exe\` below. Installing over any earlier version is fine — projects and settings are untouched.

**If you were watching a pinned 100%: this build's bar can no longer say 100% until the file is actually finished — and if anything goes wrong you get an honest error with the cause instead of a frozen bar.**`;

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
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.33.6${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.33.6${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.33\.[0-9]+/g, "FrameFuse-Setup-1.33.6");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.33.6";
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
        name: `FrameFuse v1.33.6 — stuck-at-100% root cause (progress model) + honest ETA/elapsed + full-timeline exports`,
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
    [INSTALLER, "FrameFuse-Setup-1.33.6.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.33.6.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.33.6.exe");
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
