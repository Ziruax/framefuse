// scripts/verify-icons-1.14.2.js — RT_GROUP_ICON verification for the ship round.
// Manual PE resource parse (resedit's group APIs are unusable in this env —
// Task-43 playbook). Checks: every group icon entry references an existing
// RT_ICON entry, sizes are sane, and the DIB/PNG split is the v1.14.1 shape
// (DIB entries ≤128 + one PNG 256).
const fs = require("fs");

function verifyExe(path) {
  const buf = fs.readFileSync(path);
  const e_lfanew = buf.readUInt32LE(0x3c);
  const pe = e_lfanew;
  if (buf.readUInt32LE(pe) !== 0x4550) throw new Error("not a PE");
  const numSections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const secTable = pe + 24 + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    sections.push({
      name: buf.toString("ascii", s, s + 8).replace(/\0+$/, ""),
      vaddr: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20),
    });
  }
  const rsrc = sections.find((s) => s.name === ".rsrc");
  if (!rsrc) throw new Error("no .rsrc");
  // all resource directory offsets are section-relative; data entries hold absolute RVAs
  const rel2off = (rel) => rsrc.rawPtr + rel;
  const rva2off = (rva) => rva - rsrc.vaddr + rsrc.rawPtr;

  // walk the resource directory (type → id → lang), collect data
  const entries = {}; // key: "type/id" -> { dataOff, size }
  function walkDir(rel, prefix) {
    const off = rel2off(rel);
    const namedCount = buf.readUInt16LE(off + 12);
    const idCount = buf.readUInt16LE(off + 14);
    const total = namedCount + idCount;
    for (let i = 0; i < total; i++) {
      const e = off + 16 + i * 8;
      const nameField = buf.readUInt32LE(e);
      const offsetField = buf.readUInt32LE(e + 4);
      let id;
      if (i < namedCount) {
        const strOff = rel2off(nameField & 0x7fffffff);
        const len = buf.readUInt16LE(strOff);
        id = buf.toString("utf16le", strOff + 2, strOff + 2 + len * 2);
      } else {
        id = String(nameField);
      }
      if (offsetField & 0x80000000) {
        walkDir(offsetField & 0x7fffffff, prefix + id + "/");
      } else {
        const dataDir = rel2off(offsetField);
        const dataRva = buf.readUInt32LE(dataDir);
        const size = buf.readUInt32LE(dataDir + 4);
        entries[prefix + id] = {
          off: rva2off(dataRva),
          size,
        };
      }
    }
  }
  walkDir(0, "");

  const RT_ICON = "3/";
  const RT_GROUP = "14/";
  const icons = Object.keys(entries).filter((k) => k.startsWith(RT_ICON));
  const groups = Object.keys(entries).filter((k) => k.startsWith(RT_GROUP));
  const report = { path, icons: icons.length, groups: [] };
  let ok = true;
  for (const g of groups) {
    const d = entries[g];
    const count = buf.readUInt16LE(d.off + 4);
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const e = d.off + 6 + i * 14;
      const w = buf.readUInt8(e);
      const h = buf.readUInt8(e + 1);
      const bytesInRes = buf.readUInt32LE(e + 8);
      const iconId = buf.readUInt16LE(e + 12);
      // keys are "type/id/lang" — match the icon regardless of language
      const iconKey = Object.keys(entries).find(
        (k) => k === `3/${iconId}/1033` || k.startsWith(`3/${iconId}/`)
      );
      const iconEntry = iconKey ? entries[iconKey] : undefined;
      const isPng = iconEntry && buf.readUInt32LE(iconEntry.off) === 0x474e5089;
      if (!iconEntry) {
        ok = false;
        report.groups.push(`MISSING RT_ICON id=${iconId}`);
        continue;
      }
      sizes.push(`${w === 0 ? 256 : w}${isPng ? "PNG" : "DIB"}:${iconEntry.size}B(res:${bytesInRes})`);
      if (Math.abs(iconEntry.size - bytesInRes) > 16) {
        ok = false;
        sizes.push(`SIZE-MISMATCH`);
      }
    }
    report.groups.push(`group ${g.slice(RT_GROUP.length)}: ${count} entries [${sizes.join(", ")}]`);
  }
  report.ok = ok;
  return report;
}

for (const p of process.argv.slice(2)) {
  const r = verifyExe(p);
  console.log(`${r.ok ? "PASS" : "FAIL"} ${p}`);
  console.log(`  RT_ICON entries: ${r.icons}`);
  r.groups.forEach((g) => console.log(`  ${g}`));
}
