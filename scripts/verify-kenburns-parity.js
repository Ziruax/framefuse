// scripts/verify-kenburns-parity.js — geometry-level parity: zoompan vs scale+crop
// Lossless gbrp end-to-end (no YUV mixing); gradient fixture encodes x/y position.
// Derived mapping (zoompan → scale+crop), z ∈ [1.1, 1.1·zoomMax], supersample SW=1.1W:
//   dynamic (in/out): scale w='W*Z(t)':h='H*Z(t)':eval=frame  → crop W:H at
//     x' = W·(z−1)/2 (center) / pan variants with W·(z−1) amplitude
//   pan (const z=zMaxEff): static scale W·zMaxEff, crop x' = W·(zMaxEff−1)/2·(1±ease)
const { execFileSync } = require("child_process");
const fs = require("fs");
const FF = require("ffmpeg-static");
const T = "/tmp/fftest";
fs.mkdirSync(T, { recursive: true });

const W = 1280, H = 720, FPS = 30, FRAMES = 60;
const SW = Math.round(W * 1.1), SH = Math.round(H * 1.1);
const intensity = 50;
const zoomMax = 1.06 + (intensity / 100) * 0.18;
const zMaxEff = 1.1 * zoomMax;
const spanEff = (zMaxEff - 1.1).toFixed(6);
const zMaxStr = zMaxEff.toFixed(6);

execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", `gradients=s=${W}x${H}:c0=black:c1=white:x0=0:y0=0:x1=${W}:y1=0:duration=1`,
  "-frames:v", "1", "-vf", `format=gbrp,geq=r='X*255/${W}':g='Y*255/${H}':b=128,format=gbrp`, `${T}/grad.png`]);

function chains(dir) {
  const tOn = `on/${FRAMES - 1}`;
  const easeOn = `-((cos(PI*${tOn})-1)/2)`;
  const tT = `(t*${FPS})/${FRAMES - 1}`;
  const easeT = `-((cos(PI*${tT})-1)/2)`;
  const zDyn = `1.100000+(${easeT})*${spanEff}`;
  const maxX = "(iw-iw/zoom)", maxY = "(ih-ih/zoom)";
  let zOn, xOn, yOn, dynScale, xT, yT;
  if (dir === "in" || dir === "out") {
    const zz = dir === "in" ? `1.100000+(${easeOn})*${spanEff}` : `${zMaxStr}-(${easeOn})*${spanEff}`;
    zOn = zz; xOn = "iw/2-(iw/zoom/2)"; yOn = "ih/2-(ih/zoom/2)";
    dynScale = `scale=w='${W}*(${zDyn})':h='${H}*(${zDyn})':eval=frame:flags=bicubic`;
    xT = `${W}*((${zDyn})-1)/2`; yT = `${H}*((${zDyn})-1)/2`;
  } else {
    zOn = zMaxStr;
    if (dir === "right") { xOn = `${maxX}/2*(1+(${easeOn}))`; yOn = `${maxY}/2`; }
    else if (dir === "left") { xOn = `${maxX}/2*(1-(${easeOn}))`; yOn = `${maxY}/2`; }
    else if (dir === "down") { xOn = `${maxX}/2`; yOn = `${maxY}/2*(1+(${easeOn}))`; }
    else { xOn = `${maxX}/2`; yOn = `${maxY}/2*(1-(${easeOn}))`; }
    dynScale = `scale=${Math.round(W * zMaxEff)}:${Math.round(H * zMaxEff)}:flags=bicubic`;
    const amp = `${W}*${(zMaxEff - 1).toFixed(6)}/2`, ampY = `${H}*${(zMaxEff - 1).toFixed(6)}/2`;
    if (dir === "right") { xT = `${amp}*(1+(${easeT}))`; yT = ampY; }
    else if (dir === "left") { xT = `${amp}*(1-(${easeT}))`; yT = ampY; }
    else if (dir === "down") { xT = amp; yT = `${ampY}*(1+(${easeT}))`; }
    else { xT = amp; yT = `${ampY}*(1-(${easeT}))`; }
  }
  const zp = `scale=${SW}:${SH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${SW}:${SH},zoompan=z='${zOn}':x='${xOn}':y='${yOn}':d=${FRAMES}:s=${W}x${H}:fps=${FPS},setsar=1,format=gbrp`;
  const sc = `scale=${SW}:${SH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${SW}:${SH},${dynScale},crop=${W}:${H}:x='${xT}':y='${yT}',setsar=1,format=gbrp`;
  return { zp, sc };
}

console.log("dir       frame   zp_x    sc_x  errPx    zp_y    sc_y  errPx");
let worst = 0;
for (const dir of ["in", "out", "right", "left", "down", "up"]) {
  const { zp, sc } = chains(dir);
  const inArgs = ["-loop", "1", "-framerate", String(FPS), "-t", String(FRAMES / FPS), "-i", `${T}/grad.png`];
  execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", ...inArgs, "-filter_complex", `[0:v]${zp}[v]`, "-map", "[v]", "-frames:v", String(FRAMES), "-c:v", "libx264rgb", "-preset", "ultrafast", "-crf", "0", `${T}/kb_zp.mp4`]);
  execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", ...inArgs, "-filter_complex", `[0:v]${sc}[v]`, "-map", "[v]", "-frames:v", String(FRAMES), "-c:v", "libx264rgb", "-preset", "ultrafast", "-crf", "0", `${T}/kb_sc.mp4`]);
  for (const f of [0, 15, 30, 45, 59]) {
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-i", `${T}/kb_zp.mp4`, "-vf", `select='eq(n\\,${f})'`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gbrp", `${T}/f_zp.raw`]);
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-i", `${T}/kb_sc.mp4`, "-vf", `select='eq(n\\,${f})'`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gbrp", `${T}/f_sc.raw`]);
    const az = fs.readFileSync(`${T}/f_zp.raw`), as = fs.readFileSync(`${T}/f_sc.raw`);
    const sz = W * H;
    let rz = 0, gz = 0, rs = 0, gs = 0;
    // gbrp raw: plane0=G(y-grad), plane1=B(const), plane2=R(x-grad)
    for (let i = 0; i < sz; i++) { rz += az[2 * sz + i]; gz += az[i]; rs += as[2 * sz + i]; gs += as[i]; }
    const zpX = (rz / sz / 255) * W, scX = (rs / sz / 255) * W;
    const zpY = (gz / sz / 255) * H, scY = (gs / sz / 255) * H;
    const ex = Math.abs(scX - zpX), ey = Math.abs(scY - zpY);
    worst = Math.max(worst, ex, ey);
    console.log(`${dir.padEnd(8)} ${String(f).padStart(6)} ${zpX.toFixed(2).padStart(7)} ${scX.toFixed(2).padStart(7)} ${ex.toFixed(2).padStart(6)} ${zpY.toFixed(2).padStart(7)} ${scY.toFixed(2).padStart(7)} ${ey.toFixed(2).padStart(6)}`);
  }
}
console.log(`\nworst geometry drift: ${worst.toFixed(2)} px  (PASS ≤ 1.0)`);
process.exit(worst <= 1.0 ? 0 : 1);
