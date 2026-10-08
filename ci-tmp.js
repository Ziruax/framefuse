#!/usr/bin/env node
// CI status poller + release helper (v1.34.1)
const { execSync } = require("child_process");
const TOKEN = execSync("git remote get-url origin").toString().match(/:(\w+)@/)[1];
const REPO = "Ziruax/framefuse";
const API = `https://api.github.com/repos/${REPO}`;

async function jf(path) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `token ${TOKEN}`, "User-Agent": "ship", Accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

(async () => {
  const mode = process.argv[2] || "poll";
  if (mode === "poll") {
    const sha = process.argv[3] || execSync("git rev-parse HEAD").toString().trim();
    const runs = await jf(`/actions/runs?per_page=5&head_sha=${sha}`);
    for (const r of runs.workflow_runs || []) {
      console.log(`${r.status} ${r.conclusion || "(running)"} run=${r.id} "${r.display_title.slice(0, 60)}"`);
    }
    if (!runs.workflow_runs?.length) console.log("no runs for", sha);
  } else if (mode === "wait") {
    const runId = process.argv[3];
    for (;;) {
      const r = await jf(`/actions/runs/${runId}`);
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${r.status} ${r.conclusion || ""}`);
      if (r.status === "completed") {
        console.log("CONCLUSION:", r.conclusion);
        process.exit(r.conclusion === "success" ? 0 : 1);
      }
      await new Promise((res) => setTimeout(res, 45000));
    }
  } else if (mode === "runs") {
    const runs = await jf(`/actions/runs?per_page=4`);
    for (const r of runs.workflow_runs || []) console.log(r.id, r.status, r.conclusion || "-", r.head_sha.slice(0, 7));
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
