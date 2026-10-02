// scripts/publish-release-1.19.0.js — one-shot release publisher for v1.19.0
// (professional kinetic typography caption system — INSTALLER ONLY per the
// standing user directive).
// Task-45 playbook, updated per the v1.18.0 lesson: asset uploads go through
// CURL (Node fetch upload 404'd on uploads.github.com last time), plus
// dupe-aware uploads + post-upload sha512 cross-check.
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

const BODY = `## v1.19.0 — Professional kinetic typography captions (24 presets, semantic engine, per-word ASS export)

**The ask:** a full kinetic-typography caption system — design + styles like the pasted directive: 24 presets, a semantic composition engine, style selection with memory, motion choreography, and burn-in export. (This replaces the earlier 8 generic stack styles, which missed the brief.)

### 1. The preset library — 24 presets × 5 families
Families: **Cinematic · Dramatic · Conflict · Conversational · High Intensity**.
Presets: editorial-stack, cinematic-stack, perspective-stack, whisper-type, progressive-stack, punch-stack, impact-word, highlight-stack, fullscreen-type, build-collapse, split-stack, type-collision, push-stack, opposing-stack, diagonal-stack, kinetic-sentence, word-cascade, mixed-weight, sliding-sentence, phrase-reveal, word-burst, collision, rapid-stack, fullscreen-impact.
Each preset declares fonts, tracking, leading, casing, alignment, accent, shadow, entrance/exit/emphasis motions, and energy — expressed through the intensity and motion profiles.

### 2. The semantic engine
- **12 semantic classifications** (normal-narration, setup, suspense, revelation, shock, conflict, accusation, realization, emotional, reflection, transition, climax) drive preset selection (semanticMatch §15), emphasis, accent color, and motion energy per word/phrase.
- **Style selection with memory**: repetition penalties keep consecutive compositions from reusing family/role/preset; a **deterministic seeded RNG** (seed 1337 default, editable in the UI) makes every project reproducible.
- **16:9 line density 5-12 words**, never-shrink segmentation (a word never splits across compositions), safe-area margins, responsive scaling.

### 3. The export pipeline (burn-in like the canvas preview)
- The renderer emits **composition plans + measured geometry**; \`electron/kinetic-ass.js\` turns them into **per-word ASS override-tag Dialogues** composited by libass: inline modes (fade-rise, word-pop, scale-slam, slide-y, clip-wipe, blur-focus, flash, push) and per-word modes (slide-x, burst, converge, typewriter) with \`\`\\\\move\`\`/\`\`\\\\t\`\` choreography, emphasis punch at the spoken moment, staggered entrances, and window-clipping continuity across chunk/segment cuts.
- The **Rust router honestly gates** kinetic exports to the CLI compositor (reason \`kinetic-captions\` — per-word font choreography has no Rust fontdue equivalent; the header badge says so during export).

### 4. The settings UI
Kinetic typography engine toggle + mode (auto style selection or a weighted manual preset mix), variation, intensity, word density, motion profile, seed — with an **animated live preview canvas** rendering the actual composition engine (same code as export). Turning kinetic off restores the classic word-mode caption controls.

### 5. Compatibility (nothing breaks)
Kinetic **off by default** on old projects: the legacy caption emission path is byte-identical (verified three ways — no args, empty array, disabled flag). Old payloads without compositions/geometry keep the legacy loop. Compositions without measured geometry emit nothing and fall back cleanly.

### Verification
- Harnesses: kinetic-ass emitter 45/45 · main.js integration 17/17 (byte-identical legacy, covered-cue skip, window re-clipping) · Rust router gate 8/8.
- Agent-browser end-to-end on the live app: word-timed .srt upload → storyboard → captions tab → kinetic ON → animated preview verified by pixel checksum; main preview scrubbed to t=2.2/5.7/8.4s — **VLM frame analysis confirms semantic emphasis picks exactly the directive's word classes** (negation "never", conflict "lie", revelation "suddenly the truth"), typographic hierarchy, and style switching between compositions.
- \`bun run lint\` clean; tsc errors = the documented pre-existing baseline (zero in kinetic/*).
- CI (windows-latest, MSVC, WARP GPU): Rust engine v2 smoke + color regression + feature tests green on the release commit before this installer was packaged from the smoke-tested .node.

### Upgrade notes
- No project-file changes. Kinetic captions ride the FFmpeg-CLI compositor path (libass) — the export header badge will honestly say "FFmpeg CLI" while kinetic is enabled; everything else stays on the native Rust engine.`;

function sha512File(p) {
  return crypto.createHash("sha512").update(fs.readFileSync(p)).digest("base64");
}

async function gh(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...HDRS, ...(opts.headers || {}) },
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
  // electron-builder writes "FrameFuse Setup 1.19.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe, matches every
  // previous release). Normalize + patch latest.yml if needed.
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.19.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.19.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.19\.0/g, "FrameFuse-Setup-1.19.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.19.0";
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
        name: `FrameFuse ${TAG} — Professional kinetic typography captions`,
        body: BODY,
        draft: false,
        prerelease: false,
      }),
    });
    if (post.status !== 201) throw new Error(`release create failed: ${post.status} ${await post.text()}`);
    rel = await post.json();
    console.log(`[ship] release created: ${rel.id}`);
  }

  // 2. dupe-aware asset upload (CURL — see the v1.18.0 note)
  const existing = new Set(rel.assets.map((a) => a.name));
  if (!existing.has("FrameFuse-Setup-1.19.0.exe")) curlUpload(INSTALLER, "FrameFuse-Setup-1.19.0.exe", rel.id);
  else console.log("[ship] asset exists, skipping: FrameFuse-Setup-1.19.0.exe");
  if (!existing.has("latest.yml")) curlUpload(LATEST, "latest.yml", rel.id);
  else console.log("[ship] asset exists, skipping: latest.yml");
  if (!existing.has("FrameFuse-Setup-1.19.0.exe.blockmap"))
    curlUpload(BLOCKMAP, "FrameFuse-Setup-1.19.0.exe.blockmap", rel.id);
  else console.log("[ship] asset exists, skipping: blockmap");

  // 3. three-way sha512 verification (local == latest.yml == re-downloaded)
  const ref = await gh(`/releases/tags/${TAG}`);
  rel = await ref.json();
  const installerAsset = rel.assets.find((a) => a.name === "FrameFuse-Setup-1.19.0.exe");
  const dl = await fetch(installerAsset.browser_download_url, { headers: HDRS });
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  const localHash = sha512File(INSTALLER);
  const dlHash = crypto.createHash("sha512").update(dlBytes).digest("base64");
  const yml = fs.readFileSync(LATEST, "utf8");
  const ymlHash = /sha512:\s*(\S+)/.exec(yml)?.[1];
  console.log(`[ship] sha512 local:    ${localHash.slice(0, 24)}…`);
  console.log(`[ship] sha512 yml:     ${String(ymlHash).slice(0, 24)}…`);
  console.log(`[ship] sha512 download:${dlHash.slice(0, 24)}…`);
  if (localHash !== dlHash) throw new Error("local != downloaded sha512");
  if (ymlHash && ymlHash !== localHash) throw new Error("latest.yml != local sha512");
  if (dlBytes.length !== size) throw new Error(`size mismatch: downloaded ${dlBytes.length} vs local ${size}`);
  console.log(`[ship] THREE-WAY VERIFIED ✓  https://github.com/${REPO}/releases/tag/${TAG}`);
}

main().catch((e) => {
  console.error("SHIP FAILED:", e.message);
  process.exit(1);
});
