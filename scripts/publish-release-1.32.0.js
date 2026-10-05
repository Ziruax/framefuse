// scripts/publish-release-1.32.0.js — one-shot release publisher for v1.32.0
// (TTS system-proxy tunnel + Groq 404 interceptor failover). Task-45 playbook:
// CURL asset uploads, dupe-aware, three-way sha512.
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

const BODY = `## v1.32.0 — TTS synthesis fixed + the Groq 404 mystery solved (interceptor failover)

**The ask:** "tts syntasis failed along with that still facing groq error i.e key authentication works but real transcription failed facing 404 — fix both issues from root."

### Root cause 1 — "TTS synthesis failed" (the system-proxy blind spot)
The narration/voiceover engine talks to Microsoft's speech service over a **raw TLS WebSocket that Node's \`tls\` module dials directly** — and Node's \`tls\` **ignores the OS proxy**. On machines whose only working internet route is a system proxy (VPN client, corporate PAC file, antivirus "web protection"), the browser — and every browser-based feature — kept working while TTS synthesis could never even open its connection. That is the entire "TTS synthesis failed" family.

**Fix:** the WSS connection now asks **Chromium which proxy it would use** for the speech host (\`session.resolveProxy\` — PAC/VPN/AV-aware, the same verdict your browser gets) and tunnels through it:
- \`PROXY\`/\`HTTPS\` lines → an HTTP **CONNECT tunnel**, TLS over the tunnel
- \`SOCKS5\` lines → a minimal no-auth **SOCKS5 client**, TLS over it
- \`DIRECT\` → the direct connection, exactly as before
- Any tunnel failure **falls back to DIRECT**, so a broken proxy config can never behave worse than v1.31

Plus: synthesis attempts 2 → **3** (each regenerates the DRM token AND re-resolves the proxy — a flappy VPN gets three genuinely fresh chances), the handshake window 10s → 15s, and exhausted retries now carry **actionable hints** (toggle VPN/proxy, disable antivirus HTTPS-scanning for this app, check the system clock — the speech DRM token is time-based, region block).

### Root cause 2 — "key authentication works but real transcription returns 404"
That 404 **did not come from Groq**. A genuine Groq API error ALWAYS carries the documented error envelope (\`error.type\` / \`error.code\` — console.groq.com/docs/errors). A 404 **without** that envelope was answered by an **interceptor between this app and api.groq.com** — an OS proxy, VPN, or antivirus web-filter that scans HTTPS. Those same machines pass the small GET that the key test makes (the key "authenticates") but swallow the **multipart upload** the real transcription needs. That is precisely your signature.

**Fix — dual-path transport failover:**
- The first attempt rides **Chromium's net stack** (honors the OS proxy — same route your browser uses).
- An interceptor-shaped response (**401/403/404 with NO genuine Groq envelope**) triggers **one identical retry through plain Node https — direct, proxy-ignoring** — the request Groq actually receives.
- A **genuine** model-availability 404 (envelope present) retries once with the **other whisper model** (Groq decommissions models; a stored selection can age out) — across transcription, the Settings key probe, chat, and the web Dub Studio route.
- All five provider surfaces (desktop whisper / chat / key test, web key test, web transcription) now classify the two 404 families with the **exact fix steps**: "disable HTTPS/TLS scanning for this app in your antivirus, toggle the VPN/proxy, or use a different network" — instead of the old misleading "model not found".

### Verified end to end
- 19/19 classifier unit tests (genuine vs interceptor 404s, failover triggers, model alternates).
- **Real TTS synthesis live-verified** through the new proxied-TLS path (real MP3 + word boundaries, both the Node module and the web \`/api/tts/synthesize\` route).
- 3/3 transport tests inside a REAL Electron main process: default transport uses electron-net, forced \`transport:"node"\` bypasses it, and the probe orchestrates the interceptor-failover retry.
- Live Groq probe + Settings key test → the honest classified verdict (never a crash, never a raw dump).
- Browser E2E: TTS Studio → typed a script → Generate → **real audio rendered with the result card** (mp3, 10 word boundaries, chunk count) and the full action row; Groq key test toast shows the precise diagnosis.
- Gates: ESLint clean, 14 electron JS files pass the V8 parse gate, tsc at the unchanged 11-error pre-existing baseline, dub-studio smoke ALL PASSED.

**Full install only — NSIS installer** (per the standing directive): download FrameFuse-Setup-1.32.0.exe below. Installing over v1.31.0 is fine.`;

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
  // electron-builder writes "FrameFuse Setup 1.32.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.32.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.32.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.32\.0/g, "FrameFuse-Setup-1.32.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.32.0";
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
        name: `FrameFuse v1.32.0 — TTS synthesis fixed (system-proxy tunnel) + Groq 404 interceptor failover`,
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
    [INSTALLER, "FrameFuse-Setup-1.32.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.32.0.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.32.0.exe");
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
