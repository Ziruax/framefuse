const fs = require("fs");
const path = require("path");
const engine = require("/home/z/my-project/rust-engine/framefuse-engine.linux-x64.node");
const DIR = __dirname;
const tl = JSON.parse(fs.readFileSync(path.join(DIR, "tl-c.json"), "utf8"));
const OUT = path.join(DIR, "diag-out.mp4");
let peak = { rss: 0, label: "" };
const timer = setInterval(() => {
  try {
    const st = fs.readFileSync("/proc/self/status", "utf8");
    const r = /VmRSS:\s+(\d+) kB/.exec(st);
    if (r && parseInt(r[1], 10) / 1024 > peak.rss) peak = { rss: parseInt(r[1], 10) / 1024, label: new Date().toISOString() };
  } catch {}
}, 200);
engine.exportVideo(JSON.stringify(tl), OUT, "", (e, p) => { if (!e && p && p.phase === "audio") peak.label += " (audio phase)"; })
  .then(() => {
    clearInterval(timer);
    // snapshot during... too late — report peak + dump current smaps sections >10MB
    const lines = fs.readFileSync("/proc/self/smaps", "utf8").split("\n");
    let hdr = null, out = [];
    for (const l of lines) {
      if (/^[0-9a-f]+-[0-9a-f]+ /.test(l)) { hdr = { l: l.slice(0, 90), rss: 0, sd: 0, pd: 0, pc: 0 }; out.push(hdr); }
      else if (hdr) {
        let m = /^Rss:\s+(\d+)/.exec(l); if (m) hdr.rss = +m[1];
        m = /^Private_Dirty:\s+(\d+)/.exec(l); if (m) hdr.pd = +m[1];
        m = /^Private_Clean:\s+(\d+)/.exec(l); if (m) hdr.pc = +m[1];
      }
    }
    console.log("PEAK RSS:", peak.rss.toFixed(0), "MB at", peak.label);
    console.log("Post-completion VMAs > 10MB resident:");
    for (const v of out.filter((x) => x.rss > 10240)) console.log(`  ${ (v.rss / 1024).toFixed(0) }MB rss  pd=${(v.pd / 1024).toFixed(0)}MB pc=${(v.pc / 1024).toFixed(0)}MB  ${v.l}`);
    process.exit(0);
  }).catch((e) => { console.error("ERR", e.message); process.exit(1); });
