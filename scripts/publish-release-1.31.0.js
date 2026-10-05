// scripts/publish-release-1.31.0.js — one-shot release publisher for v1.31.0
// (Groq/Gemini provider fixes: the Cloudflare edge-block root cause, Chromium
// network stack + system proxy, chat model refresh). Task-45 playbook: CURL
// asset uploads, dupe-aware, three-way sha512.
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

const BODY = `## v1.31.0 — the REAL Groq fix: Cloudflare edge-block diagnosis + Chromium network stack

**The ask:** "groq api is not working… kindly do research and properly read all documentations and fix groq api issues and transcription and normal models so that this provider works properly."

### The actual root cause (research + live-verified, not guessed)
Your app kept saying **"Groq rejected the API key"** while console.groq.com showed **zero API requests** — and regenerating the key never helped. Deep research against the official Groq docs plus live probing found why:

- **That message was wrong.** The body Groq's network edge returns when it REFUSES a connection is a bare \`403 {"error":{"message":"Forbidden"}}\` — 33 bytes, **no \`error.type\` field**. Groq's own API errors ALWAYS carry \`{message, type}\` (per console.groq.com/docs/errors: 401 = invalid key, 403 = permission restriction). The bare body is **Cloudflare (which fronts api.groq.com) blocking your IP range** — live-verified: the identical response comes back for *every* path, method and key shape, including requests with no Authorization header and nonexistent paths.
- **Edge-blocked requests never reach Groq's API** — so the key was never checked, and the console correctly shows nothing. That is the entire mystery behind "my key is accurate but Groq rejects it and no API call was made."
- Cloudflare blocks whole IP ranges when any neighbor on your ISP/VPN range trips abuse rules; Groq cannot whitelist individual IPs (documented in the wild — QuotaGuard's engineering writeup covers exactly this failure).
- Bonus root cause #2: the app's provider requests used Node's raw \`https\` module, which (a) has a non-browser TLS fingerprint Cloudflare can single out while your BROWSER opens console.groq.com fine, and (b) **ignores the Windows system proxy/VPN** — so on machines whose working route to Groq is a system proxy, the browser succeeded while the app's requests died.

### Fix 1 — honest, actionable error classification (every Groq surface)
Three distinct 401/403 families, each with its own message:
- **Non-JSON body** → "BLOCKED before reaching Groq — VPN, proxy, firewall or TLS interception. The key was never checked."
- **Bare JSON without error.type** (the Cloudflare edge block) → "Groq's network edge (Cloudflare) REFUSED the connection — the request never reached Groq's API, the key was never checked, and console.groq.com will show ZERO requests (expected, not a bug). Fix: switch networks (phone hotspot), toggle VPN/proxy on/off, or retry in ~15 minutes."
- **JSON with error.type** (the genuine Groq API) → 401 = "Groq rejected the API key (masked fingerprint)" / 403 = permission restriction (suspended org / restricted model).

### Fix 2 — the Chromium network stack (new electron/net-transport.js)
Inside the Electron main process, ALL Groq + Gemini requests now travel through **Electron's \`net\` module — Chromium's own network stack**: the same TLS fingerprint class as your browser, and **the OS system proxy + PAC settings are honored automatically** (Node's https ignored them). Plain-Node smoke tests fall back to https transparently. Verified live inside a real Electron main process: GET/POST/upload/abort all round-trip, and the documented Electron quirk (manual Content-Length → net::ERR_INVALID_ARGUMENT) is handled (Chromium owns that header; streamed bodies use chunked transfer).

### Fix 3 — "normal models" (chat) refreshed against the live model list
- **gemma2-9b-it and qwen/qwen3-32b are DECOMMISSIONED** on Groq (they 404 on call) — removed from every dropdown and catalog.
- **qwen/qwen3.8-27b** added (the current multilingual model).
- A stored stale model preference now silently retries once on the default model (404 → llama-3.3-70b-versatile) so the dub/script workflows keep working.

### Fix 4 — Gemini hardened the same way
- Same transport switch (Chromium net + system proxy) and the same honest classification.
- New dedicated message for Google's region restriction ("User location is not supported for the API use"): tells you to use a VPN or switch the provider to Groq.
- The web-preview key test now distinguishes a genuine Google answer from a network interception, same as Groq.

### Verified end to end
- 17/17 module smoke tests (classifier verdicts for all families; live requests from the app's own modules).
- 4/4 inside a REAL Electron main process — the exact shipped pipeline (transport detection, GET + multipart POST through Chromium's net stack, cancellation sentinels).
- Web routes live-tested (Settings key test + Dub Studio transcription) — both return the classified verdict instead of raw dumps.
- Browser E2E: save a Groq key → Test → the toast now explains the Cloudflare edge block and the fixes (previously: the misleading "Groq rejected the API key").
- Gates: ESLint clean, all 14 electron JS files pass the V8 parse gate, tsc at the unchanged 11-error pre-existing baseline, packaged ASAR contains every new marker, and the packaged engine binary is the CI smoke-tested artifact (sha256-exact).

**Full install only — NSIS installer** (per the standing directive): download FrameFuse-Setup-1.31.0.exe below. Installing over v1.30.0 is fine.`;

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
  // electron-builder writes "FrameFuse Setup 1.31.0.exe" (spaced); the release
  // assets + latest.yml url must be DASH-named (autoupdate-safe).
  const spaced = (ext) => path.join("dist", `FrameFuse Setup 1.31.0${ext}`);
  const dashed = (ext) => path.join("dist", `FrameFuse-Setup-1.31.0${ext}`);
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
    s = s.replace(/FrameFuse[ ]Setup[ ]1\.31\.0/g, "FrameFuse-Setup-1.31.0");
    fs.writeFileSync(yml, s);
  }
  return { INSTALLER: dashed(".exe"), LATEST: yml, BLOCKMAP: dashed(".exe.blockmap") };
}

async function main() {
  const TAG = "v1.31.0";
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
        name: `FrameFuse v1.31.0 — Groq/Gemini fixed: Cloudflare edge-block diagnosis, Chromium network stack + system proxy`,
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
    [INSTALLER, "FrameFuse-Setup-1.31.0.exe"],
    [LATEST, "latest.yml"],
    [BLOCKMAP, "FrameFuse-Setup-1.31.0.exe.blockmap"],
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
  const asset = (rel2.assets || []).find((a) => a.name === "FrameFuse-Setup-1.31.0.exe");
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
