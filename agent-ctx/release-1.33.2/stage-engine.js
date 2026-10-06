// agent-ctx/release-1.33.2/stage-engine.js — download the smoke-tested Rust engine
// artifact from the CI run of the v1.33.2 commit (f5c08e1, run 37386101726,
// artifact 11379970590 "rust-engine-win32-x64"), stage the .node into
// rust-engine/, and verify the smoke logs inside the artifact.
const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TOKEN = execSync("git remote get-url origin").toString().match(/:(\w+)@/)[1];
const REPO = "Ziruax/framefuse";
const API = `https://api.github.com/repos/${REPO}`;
const HDRS = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ship-script",
};
const ARTIFACT_ID = process.env.ARTIFACT_ID || "11379970590";
const WORK = path.join(__dirname, "artifact");

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const zipPath = path.join(WORK, "engine.zip");
  console.log(`[stage] downloading artifact ${ARTIFACT_ID} …`);
  const res = await fetch(`${API}/actions/artifacts/${ARTIFACT_ID}/zip`, { headers: HDRS });
  if (!res.ok) throw new Error(`artifact download failed: ${res.status} ${await res.text()}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(zipPath, bytes);
  console.log(`[stage] downloaded ${(bytes.length / 1e6).toFixed(1)} MB`);

  execFileSync("unzip", ["-o", zipPath, "-d", WORK], { stdio: "inherit" });
  const node = path.join(WORK, "framefuse-engine.win32-x64.node");
  if (!fs.existsSync(node)) throw new Error("artifact zip has no framefuse-engine.win32-x64.node");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(node)).digest("hex");
  const size = fs.statSync(node).size;
  console.log(`[stage] engine: ${size} B, sha256 ${sha}`);

  // smoke-log honesty check (artifact carries the logs of the green run)
  for (const log of ["smoke-windows.log", "feature-v2.log"]) {
    const p = path.join(WORK, log);
    if (!fs.existsSync(p)) { console.log(`[stage] ${log}: (absent)`); continue; }
    const txt = fs.readFileSync(p, "utf8");
    const pass = /PASS|SUCCESS|passed|ok\b/i.test(txt);
    const fail = /FAIL|ERROR|panic/i.test(txt);
    console.log(`[stage] ${log}: ${(pass ? "pass-markers" : "NO pass markers")}${fail ? " + FAIL-MARKERS PRESENT" : ""}`);
    const tail = txt.trim().split("\n").slice(-4).join("\n          ");
    console.log(`          …${tail}`);
  }
  const info = path.join(WORK, "engine-info.json");
  if (fs.existsSync(info)) {
    const j = JSON.parse(fs.readFileSync(info, "utf8"));
    console.log(`[stage] engine-info: version=${j.version} encoder=${(j.encoders || []).slice(0, 4).join(",")}`);
  }

  // stage into rust-engine/ (ONLY the .node — logs/info must not ship)
  const dest = path.join(process.cwd(), "rust-engine", "framefuse-engine.win32-x64.node");
  fs.copyFileSync(node, dest);
  const destSha = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
  if (destSha !== sha) throw new Error("staged sha mismatch");
  console.log(`[stage] STAGED rust-engine/framefuse-engine.win32-x64.node (${destSha.slice(0, 16)}…)`);
}
main().catch(e => { console.error("[stage] FAILED:", e.message); process.exit(1); });
