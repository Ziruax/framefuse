// scripts/check-electron-js.js — V8 syntax gate for every main-process JS file.
//
// v1.27.0 shipped a duplicate `const hasMusic` in electron/export-graph.js
// (SyntaxError at parse time) and the installed app crashed on launch.
// NOTHING caught it: ESLint ignores electron/** (see eslint.config.mjs),
// tsc has ignoreBuildErrors and doesn't cover the plain-JS electron folder,
// `next build` never parses electron/ (the folder is copied into the asar
// verbatim), and the web preview never loads these files. The packaged app's
// first launch was the first time V8 parsed the file.
//
// This gate runs `node --check` (a full V8 parse — the exact error class the
// main process hits at require time) over every electron/**/*.js file, and
// fails the build BEFORE electron-builder packages anything.
const { readdirSync, statSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");

const root = join(__dirname, "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk(join(root, "electron")).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`[check-electron-js] FAIL ${f}\n${(r.stderr || r.stdout || "").trim()}`);
  }
}
if (failed > 0) {
  console.error(`[check-electron-js] ${failed} of ${files.length} file(s) have syntax errors — BUILD STOPPED`);
  process.exit(1);
}
console.log(`[check-electron-js] ${files.length} electron JS files parsed clean (node --check)`);
