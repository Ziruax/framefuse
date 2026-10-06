// agent-ctx/release-1.33.2/gh-check.js — query GitHub state (token read from git remote, never printed)
const { execSync } = require("child_process");
const TOKEN = execSync("git remote get-url origin").toString().match(/:(\w+)@/)[1];
const REPO = "Ziruax/framefuse";
const API = `https://api.github.com/repos/${REPO}`;
const HDRS = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ship-script",
};

async function main() {
  // 1. latest releases
  const rels = await (await fetch(`${API}/releases?per_page=3`, { headers: HDRS })).json();
  console.log("== releases (newest first) ==");
  for (const r of rels) {
    console.log(`${r.tag_name} | draft:${r.draft} | assets: ${(r.assets || []).map(a => a.name).join(", ")}`);
  }

  // 2. CI workflow runs on main
  const runs = await (await fetch(`${API}/actions/workflows/build-windows.yml/runs?branch=main&per_page=5`, { headers: HDRS })).json();
  console.log("\n== build-windows.yml runs (main, newest first) ==");
  for (const r of runs.workflow_runs || []) {
    console.log(`${r.id} | ${r.head_sha.slice(0, 7)} | ${r.status}/${r.conclusion} | ${r.created_at}`);
    const jobs = await (await fetch(`${API}/actions/runs/${r.id}/jobs?per_page=5`, { headers: HDRS })).json();
    for (const j of jobs.jobs || []) {
      console.log(`   job: ${j.name} => ${j.status}/${j.conclusion}`);
    }
  }

  // 3. artifacts for the newest runs
  const arts = await (await fetch(`${API}/actions/artifacts?per_page=8`, { headers: HDRS })).json();
  console.log("\n== recent artifacts ==");
  for (const a of arts.artifacts || []) {
    console.log(`${a.id} | ${a.name} | run:${a.workflow_run?.id ?? "?"} | ${a.size_in_bytes} B | expired:${a.expired}`);
  }
}
main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
