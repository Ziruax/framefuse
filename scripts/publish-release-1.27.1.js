// scripts/publish-release-1.27.1.js — one-shot release publisher for v1.27.1
// (HOTFIX: v1.27.0 shipped a duplicate `const hasMusic` in export-graph.js
// — a parse-time SyntaxError that crashed the app at launch).
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

const BODY = `## v1.27.1 — Hotfix: launch crash on v1.27.0

**What happened:** v1.27.0 shipped a duplicate \`const hasMusic\` declaration inside \`buildConcatArgs\` (electron/export-graph.js) — a parse-time SyntaxError that crashed the main process the moment the app launched:

\`\`\`
SyntaxError: Identifier 'hasMusic' has already been declared
    at electron/export-graph.js:2042
\`\`\`

If v1.27.0 crashes for you on launch, install **v1.27.1** — that is the entire fix.

### Also in this build (guardrails)
- **New build gate:** \`scripts/check-electron-js.js\` runs \`node --check\` (a full V8 parse) over every \`electron/**/*.js\` file and fails the build before packaging. The bug class slipped through because ESLint ignores \`electron/**\`, \`next build\` never parses the folder (it is copied into the ASAR verbatim), and the web preview never loads these files — the installed app was the first thing to actually parse it. \`bun run lint\` now includes the same gate.
- The audio concat builder was regression-tested across 7 scenarios (legacy single music, multi-music clips, clip-audio amix, master-mux, silent project) — all pass, argv semantics unchanged.

Everything else is identical to v1.27.0 (same CI smoke-tested Rust engine, sha256 \`abbea0b1…\`; same features — Settings hub, Groq Whisper, word-to-word dub timing).

**Full install only — NSIS installer** (per the standing directive): download \`FrameFuse-Setup-1.27.1.exe\` below. If you have v1.27.0 installed, just run this installer over it (same install dir) — or uninstall first if you prefer.`;

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
  // electron-builder writes "FrameFuse Setup 1.27.1.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.27.1${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.27.1${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.27\.1/g, "FrameFuse-Setup-1.27.1");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.27.1";
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
        name: `FrameFuse v1.27.1 — launch-crash hotfix`,
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
    [INSTALLER, "FrameFuse-Setup-1.27.1.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.27.1.exe.blockmap"],
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
  const m = ymlTxt.match(/sha512:\s*([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error("latest.yml has no sha512");
  if (m[1] !== local) throw new Error(`sha512 MISMATCH local vs latest.yml`);
  const redl = await fetch(
    `https://github.com/${REPO}/releases/download/${TAG}/FrameFuse-Setup-1.27.1.exe`,
    { headers: { Authorization: `token ${TOKEN}`, "User-Agent": "ship-script" } },
  );
  if (!redl.ok) throw new Error(`re-download failed: ${redl.status}`);
  const buf = Buffer.from(await redl.arrayBuffer());
  const remote = crypto.createHash("sha512").update(buf).digest("base64");
  if (remote !== local) throw new Error(`sha512 MISMATCH local vs re-downloaded`);
  if (buf.length !== fs.statSync(INSTALLER).size) throw new Error("size MISMATCH");
  console.log(`[ship] THREE-WAY sha512 VERIFIED (${local.slice(0, 12)}…, size exact)`);
  console.log(`[ship] LIVE: https://github.com/${REPO}/releases/tag/${TAG}`);
}

main().catch((e) => {
  console.error("[ship] FAILED:", e.message);
  process.exit(1);
});
