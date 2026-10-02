// scripts/publish-release-1.21.0.js — one-shot release publisher for v1.21.0
// (native Rust kinetic typography + bundled real fonts + live-preview font
// picker — INSTALLER ONLY per the standing directive).
// Task-45 playbook: CURL asset uploads, dupe-aware, three-way sha512 check.
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

const BODY = `## v1.21.0 — Native Rust kinetic typography, real bundled fonts, live-preview font picker

**The ask (4 fixes):** (1) kinetic captions still fell back to the FFmpeg-CLI pipeline; (2) kinetic captions had visibility issues; (3) font selection / predefined fonts did not match the pasted reference (the export payload literally never carried the picked font); (4) the \`export native zv is not defined\` IPC crash. Plus: a more user-friendly UI.

### 1. Kinetic typography captions render NATIVELY — no more FFmpeg-CLI fallback
New \`rust-engine/src/kinetic.rs\` ports the v1.18 motion engine **exactly** (a math-only port of \`kinetic/motion.ts\`): every entrance (fade-rise, word-pop, scale-slam, slide-x/y, burst, converge, push, flash, typewriter, …), emphasis events (scale-punch / pulse / shake / hold), hold behaviors (drift, active-word), push-out dimming, all exit variants, per-comp accent colors, 1080p-scaled offsets — solved per frame over the **renderer-measured geometry** (the same rects the preview paints) and blitted through the compositor's scaled text-layer path. The router gate is **gone**: kinetic exports badge **Rust engine**.
- Canvas-exact placement: strips anchor by \`fillText(wx, wy)\` + \`textBaseline="top"\` semantics (fontdue ascent from the SAME TTF), then the word transform maps the strip around the word-box center exactly like the painter's translate/scale math.
- Word strips rasterize once per (font, text, fill color, size) and cache — per-frame work is pure blit math; both the wgpu and CPU compositors scale them.

### 2. The \`zv\` IPC crash — fixed AND hardened
Root cause: a \`zv(o.volume)\` typo in \`rust-engine-router.js\` threw \`ReferenceError: zv is not defined\` **inside the export-native IPC handler**, which surfaced as \`Error invoking remote method 'export-native'\` and knocked the whole Rust path to the CLI. Fixed (the correct local \`zvPlain\`), and \`buildRustTimeline\` now runs inside a try/catch — **any** future timeline-mapping bug degrades to Safe Mode instead of failing the export.

### 3. Real fonts everywhere — preview = export = the reference designs
The five web families now ship as **24 static TTFs** inside the app (Inter, Roboto, Montserrat × 400–900, Bebas Neue, Playfair Display):
- **Preview**: \`@font-face\` + an explicit \`document.fonts.load()\` on app mount (canvas \`ctx.font\` alone never triggers a font download — that was the "designs don't look like the reference" bug).
- **Native Rust rendering**: fontdue reads the exact same files (family + weight resolved per word, snapped to the closest available weight).
- **libass CLI fallback**: the \`subtitles=\` filter now carries \`fontsdir\` → the bundled TTFs, so even the Safe-Mode pipeline burns the real faces.
- **The export payload bug**: \`FONT_OPTIONS.ffmpegName\` mapped Montserrat/Inter/Roboto → "Segoe UI" and Bebas/Playfair → "Impact"/"Georgia" — the export literally never received the user's font choice. Now they are the real family names, resolved bundled-TTF-first (Montserrat finally renders as Montserrat, not the old Arial-Bold stand-in).

### 4. More user-friendly UI
- **Live-preview font picker**: every option renders in its own typeface — you SEE the caption font before picking it. Full keyboard navigation (↑/↓/Home/End/Enter/Esc), slim custom scrollbar.
- **Human-language engine badge**: routing reasons read as words ("geometric transition", "stack-text headline", …) instead of tokens; the badge celebrates **Rust engine** for kinetic exports.

### Verification
- **Rust**: 13/13 cargo unit tests (the motion-solver port: entrance/exit windows, push-out dimming, supporting mute, emphasis punch, timeline deserialization).
- **Real end-to-end smoke through the actual router**: 15/15 PASS with pixel-level frame checks — no text outside the composition window, accent-red emphasis words, exit fade, text concentrated **exactly** in the measured block rect (block=10988 vs bottom=0), Bebas single-weight preset, word-pop dim→settled.
- Regressions: caption smoke 15/15 (v1.20 native captions intact), router gate harness 27/27 (kinetic with geometry ELIGIBLE; bundled Montserrat-800 chosen for weight 800).
- CI (windows-latest, MSVC): engine build + smoke + v2 + color tests green on the release commit; the installer ships **exactly** the smoke-tested .node (sha-verified inside app.asar.unpacked).
- Browser: 24 font faces loaded (\`document.fonts.check\` true for Inter/Montserrat/Bebas/Playfair), font-picker options each computing their own family, zero page errors. \`bun run lint\` exit 0; tsc = the documented pre-existing baseline (9, zero new).

### Upgrade notes
- Projects load unchanged. Kinetic captions + plain captions + headlines + dissolve/dip transitions + voiceover/dub/SFX all run the native engine now; the badge tells you when something still rides the CLI and what to change.
- Font files live in the app (resources/fonts) — nothing to install. Old exports re-export with the REAL fonts (expect the corrected typography).`;

function sha512File(p) {
  return crypto.createHash("sha512").update(fs.readFileSync(p)).digest("base64");
}

async function gh(p, opts = {}) {
  const r = await fetch(`${API}${p}`, {
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
  // electron-builder writes "FrameFuse Setup 1.21.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.21.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.21.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.21\.0/g, "FrameFuse-Setup-1.21.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.21.0";
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
        name: `FrameFuse ${TAG} — Native Rust kinetic typography, real bundled fonts`,
        body: BODY,
        draft: false,
        prerelease: false,
      }),
    });
    if (post.status !== 201) throw new Error(`release create failed: ${post.status} ${await post.text()}`);
    rel = await post.json();
    console.log(`[ship] release created: ${rel.id}`);
  }

  // 2. dupe-aware asset upload (CURL)
  const existing = new Set(rel.assets.map((a) => a.name));
  if (!existing.has("FrameFuse-Setup-1.21.0.exe")) curlUpload(INSTALLER, "FrameFuse-Setup-1.21.0.exe", rel.id);
  else console.log("[ship] asset exists, skipping: FrameFuse-Setup-1.21.0.exe");
  if (!existing.has("latest.yml")) curlUpload(LATEST, "latest.yml", rel.id);
  else console.log("[ship] asset exists, skipping: latest.yml");
  if (!existing.has("FrameFuse-Setup-1.21.0.exe.blockmap"))
    curlUpload(BLOCKMAP, "FrameFuse-Setup-1.21.0.exe.blockmap", rel.id);
  else console.log("[ship] asset exists, skipping: blockmap");

  // 3. three-way sha512 verification (local == latest.yml == re-downloaded)
  const ref = await gh(`/releases/tags/${TAG}`);
  rel = await ref.json();
  const installerAsset = rel.assets.find((a) => a.name === "FrameFuse-Setup-1.21.0.exe");
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
