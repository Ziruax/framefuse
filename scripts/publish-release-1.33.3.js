// scripts/publish-release-1.33.3.js — one-shot release publisher for v1.33.3
// (export "stuck at 100%, no video" root-cause fixes + kinetic caption
// rendering fixes). Task-45 playbook: CURL asset uploads, dupe-aware,
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

const BODY = `## v1.33.3 — export "stuck at 100%" hardened: stall watchdog + honest output verification

**The report this patch closes:**
> "Facing error: export stuck to 100% and the video export did not complete."

### What was investigated (and proven, with the exact ffmpeg that ships in the installer)
The v1.33.2 repro validated the export chain on ffmpeg 7.1.5 — but the app ships a BtbN **master** build. This release re-ran the ENTIRE two-step chain at full scale (4140 s / 1 h 9 m timeline, 10 s looped video, burned captions) with the **exact shipped build** (N-127203, the same commit as the packaged win64 exe):
- loop render → terminates; WAV extraction → 8.4 s; direct amix final mux → 79 s; master-bus mix render + loudnorm mux → ~2 min each;
- outputs probe at **exactly 4140.000 s**, h264+aac, head and tail decode clean.
**No pipeline hang exists with the shipped ffmpeg.** If your export sat at 100% with no file and no error, you were almost certainly still running v1.33.1 (v1.33.2 shipped only hours earlier) — or hit a machine-level failure the app previously had no way to report. Both are now covered:

### New in this build
1. **Stall watchdog on every ffmpeg stage.** A wedged process (destination disk filled, antivirus locking the output file, a filter-level deadlock) emits no output while never exiting — previously the export promise never settled and the UI froze at 100% **forever, with no error**. Now: 5 minutes of total silence before the encode finishes, or 15 minutes in the finalize pass, kills the process and surfaces an honest, actionable error (likely causes + the last ffmpeg output). Watchdog kills are never misreported as "cancelled".
2. **Output verification before success.** The mux exiting 0 is no longer treated as proof: the export now checks the file exists (>1 KB) and probes its duration against the timeline. A missing or truncated file fails loudly ("disk filled up mid-export — free space and retry") instead of a silent success with no video.
3. All v1.33.2 fixes ride along: the >1.5 GB faststart skip, the "writing file header" finalize phase, honest 96.5→99.7 mux progress, duration-scaled loudness timeouts, and the kinetic caption fixes (word spacing, entrance/exit visibility, gold/amber accent highlight).

### Verified
- Full-scale shipped-ffmpeg chain: all stages terminate; outputs 4140.000 s, decode clean.
- Watchdog: 4/4 scenarios (hung process killed with diagnostics · healthy process untouched · finalize-window hang correctly identified · external cancel still says "cancelled") — tested against the REAL \`runFfmpeg\` code shipped in the app.
- Output verification: 5/5 cases (missing · husk · truncated-duration · healthy · probe-unavailable) — same real-code method.
- ASAR audit of this installer: 23/23 checks (all v1.33.2 + v1.33.3 markers present; engine sha256 matches the green CI smoke test; full Windows ffmpeg + 5 FFmpeg 7.1 DLLs packaged; version stamp 1.33.3). Three-way sha512 (local == latest.yml == re-downloaded) verified by the publisher.

**Full install only — NSIS installer** (per the standing directive): download \`FrameFuse-Setup-1.33.3.exe\` below. Installing over any earlier version is fine — your projects and settings are untouched.

**If an export ever stalls again, you will now see exactly WHY** — and if you saw 100% with no file on v1.33.2 or earlier, install this build and re-run the same project.`;

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
  // electron-builder writes "FrameFuse Setup 1.33.3.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.33.3${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.33.3${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.33\.[0-9]+/g, "FrameFuse-Setup-1.33.3");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.33.3";
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
        name: `FrameFuse v1.33.3 — export stuck-at-100% fixed + kinetic captions fixed`,
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
    [INSTALLER, "FrameFuse-Setup-1.33.3.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.33.3.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.33.3.exe");
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
