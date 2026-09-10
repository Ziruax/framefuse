// src/lib/merger/chroma.ts — WebGL2 chroma-key (green-screen removal) keyer
// v4.10 (Task 5-b): keys a source (video / image / canvas) onto a 2D canvas
// with FFmpeg `chromakey` parity in mind — the fragment shader implements
// the filter's exact similarity/blend alpha ramp (in our documented YUV
// space) so the preview and a future `-vf chromakey` export agree on the
// numbers. Despill is a preview-side extra FFmpeg's chromakey lacks; set
// spill 0 for strict parity. Split like waveform.ts: a pure Node-testable
// core (hexToRgb / rgbToYuv / chromaDistance / sanitizeChromaKeySettings /
// detectKeyColor / coverRect) + a browser keyer whose GL/DOM access lives
// inside class methods — importing the module in Node is safe.
//
// YUV CONVENTION (one convention everywhere — JS, shader, harness):
//   inputs are 0–255 channel values (÷255 internally; the shader samples
//   normalized [0,1] texels directly):
//     y = 0.299·r' + 0.587·g' + 0.114·b'        BT.601 luma, ∈ [0, 1]
//     u = (b' − y) / 2,  v = (r' − y) / 2      simple chroma, ∈ [−0.5, 0.5]
//   Same signs, comparable magnitudes as FFmpeg's −0.169/−0.331/+0.5
//   coefficients, so similarity values land in the same ballpark.

export interface ChromaKeySettings {
  /** Key color hex like "#00FF00". */
  color: string;
  /** 0.01–0.5 — FFmpeg chromakey "similarity" (chroma distance). */
  similarity: number;
  /** 0–1 — FFmpeg chromakey "blend" (edge softness). */
  blend: number;
  /** 0–1 — despill strength (green spill suppression on kept pixels). */
  spill: number;
}

/** Studio green — bright, camera-friendly default key color. */
const DEFAULT_KEY_COLOR = "#00e000";

export function defaultChromaKeySettings(): ChromaKeySettings {
  return { color: DEFAULT_KEY_COLOR, similarity: 0.32, blend: 0.08, spill: 0.6 };
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parse "#rgb" / "#rrggbb" (leading # optional) → 0–255 channels. Throws
 * on anything else — callers preferring a fallback should catch (or use
 * the HEX_RE test, like sanitizeChromaKeySettings). */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  if (typeof hex !== "string") {
    throw new Error(`hexToRgb: expected a hex string, got ${String(hex)}`);
  }
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new Error(`hexToRgb: invalid hex color "${hex}"`);
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** 0–255 floats → lowercase "#rrggbb" (clamped + rounded). */
function rgbToHex(r: number, g: number, b: number): string {
  const two = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}`;
}

/** BT.601 luma + simple chroma (header convention): inputs 0–255, y ∈ [0,1],
 * u,v ∈ [−0.5, 0.5]. Pure green → u < 0, v < 0. */
export function rgbToYuv(
  r: number, g: number, b: number,
): { y: number; u: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const y = 0.299 * rn + 0.587 * gn + 0.114 * bn;
  return { y, u: (bn - y) / 2, v: (rn - y) / 2 };
}

/** Euclidean distance of the (u, v) chroma components — the quantity
 * FFmpeg chromakey's "similarity" thresholds. Luma-independent: black vs
 * white is 0 (a chroma keyer ignores luma). */
export function chromaDistance(
  a: { r: number; g: number; b: number }, b2: { r: number; g: number; b: number },
): number {
  const ua = rgbToYuv(a.r, a.g, a.b);
  const ub = rgbToYuv(b2.r, b2.g, b2.b);
  return Math.hypot(ua.u - ub.u, ua.v - ub.v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Validate + clamp: similarity → [0.01, 0.5], blend/spill → [0, 1], color
 * must be valid hex (else default studio green). null/undefined → exact
 * defaults. Non-finite numbers keep the default value. */
export function sanitizeChromaKeySettings(
  s: Partial<ChromaKeySettings> | null | undefined,
): ChromaKeySettings {
  const d = defaultChromaKeySettings();
  if (!s || typeof s !== "object") return d;
  const out: ChromaKeySettings = { ...d };
  if (typeof s.color === "string" && HEX_RE.test(s.color.trim())) {
    out.color = s.color.trim();
  }
  if (typeof s.similarity === "number" && Number.isFinite(s.similarity)) {
    out.similarity = clamp(s.similarity, 0.01, 0.5);
  }
  if (typeof s.blend === "number" && Number.isFinite(s.blend)) {
    out.blend = clamp(s.blend, 0, 1);
  }
  if (typeof s.spill === "number" && Number.isFinite(s.spill)) {
    out.spill = clamp(s.spill, 0, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key-color auto-detection (pure — fed from an offscreen 2D snapshot)
// ---------------------------------------------------------------------------

type KeyCluster = "green" | "blue" | "magenta";
interface ClusterVote { count: number; r: number; g: number; b: number; }

/** 3×3 (edge-clamped) average around (x, y) — survives mild sensor noise. */
function avgBlock3x3(
  data: Uint8ClampedArray, w: number, h: number, x: number, y: number,
): { r: number; g: number; b: number } {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const i = (Math.min(h - 1, Math.max(0, y + dy)) * w +
        Math.min(w - 1, Math.max(0, x + dx))) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

/** Classify a sample pixel as a key-screen family. Grays (low saturation)
 * and non-standard hues (red/yellow/cyan) return null — subjects, not screens. */
function classifyKeyPixel(r: number, g: number, b: number): KeyCluster | null {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  if (Math.max(rn, gn, bn) - Math.min(rn, gn, bn) < 0.18) return null;
  if (gn - Math.max(rn, bn) > 0.15) return "green";
  if (bn - Math.max(rn, gn) > 0.15) return "blue";
  if (Math.min(rn, bn) - gn > 0.15) return "magenta";
  return null;
}

/** Auto-detect the dominant background key color from an offscreen snapshot
 * ({ data, width, height } — ImageData-like). Samples the 4 corners + 4
 * edge midpoints (a centered subject never touches those), votes each
 * 3×3-averaged sample into a green/blue/magenta cluster, and returns the
 * winning cluster's average color. Confidence = winning votes / 8; below
 * 0.5 means an ambiguous frame — keep the current key color. */
export function detectKeyColor(sample: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): { color: string; confidence: number } {
  const d = defaultChromaKeySettings();
  const data = sample?.data;
  const w = sample?.width ?? 0;
  const h = sample?.height ?? 0;
  if (!data || !(w > 0) || !(h > 0) || data.length < w * h * 4) {
    return { color: d.color, confidence: 0 };
  }
  const mid = (n: number) => Math.floor(n / 2);
  const points: Array<[number, number]> = [
    [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    [mid(w), 0], [mid(w), h - 1], [0, mid(h)], [w - 1, mid(h)],
  ];
  const votes: Record<KeyCluster, ClusterVote> = {
    green: { count: 0, r: 0, g: 0, b: 0 },
    blue: { count: 0, r: 0, g: 0, b: 0 },
    magenta: { count: 0, r: 0, g: 0, b: 0 },
  };
  for (const [x, y] of points) {
    const px = avgBlock3x3(data, w, h, x, y);
    const c = classifyKeyPixel(px.r, px.g, px.b);
    if (!c) continue;
    votes[c].count += 1;
    votes[c].r += px.r; votes[c].g += px.g; votes[c].b += px.b;
  }
  let best: KeyCluster | null = null;
  for (const k of Object.keys(votes) as KeyCluster[]) {
    if (votes[k].count === 0) continue;
    if (best === null || votes[k].count > votes[best].count) best = k;
  }
  if (best === null) return { color: d.color, confidence: 0 };
  const v = votes[best];
  return {
    color: rgbToHex(v.r / v.count, v.g / v.count, v.b / v.count),
    confidence: v.count / points.length,
  };
}

// ---------------------------------------------------------------------------
// ChromaKeyer — the browser keyer (all GL/DOM access inside methods).
// Pipeline: fullscreen-quad fragment keyer on an offscreen canvas sized
// dw×dh (dest res). The vertex stage maps quad UVs onto the cover-fit crop
// from coverRect() (uniform vec4 u_uvSrc); the fragment stage keys +
// despills and writes PREMULTIPLIED rgba (rgb·a, a) — the context uses the
// default premultipliedAlpha:true, so ctx.drawImage() + ctx.globalAlpha
// composite the blit losslessly.
// ---------------------------------------------------------------------------

const VERT_SRC = `
attribute vec2 a_pos;
uniform vec4 u_uvSrc; // (u0, v0, du, dv) — cover crop in flipped tex space
varying vec2 v_uv;
void main() {
  vec2 t = a_pos * 0.5 + 0.5; // fullscreen quad → [0,1]²
  v_uv = u_uvSrc.xy + t * u_uvSrc.zw;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_keyYuv;    // (y, u, v) of the key color — only .yz is used
uniform float u_similarity;
uniform float u_blend;
uniform float u_spill;

// Same convention as rgbToYuv() (header): normalized [0,1] channels.
vec3 yuvOf(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y, (c.b - y) * 0.5, (c.r - y) * 0.5);
}

void main() {
  vec4 px = texture2D(u_tex, v_uv);
  // FFmpeg chromakey alpha ramp: 0 below similarity, 1 above
  // similarity+blend, linear in between.
  float d = distance(yuvOf(px.rgb).yz, u_keyYuv.yz);
  float alpha;
  if (d < u_similarity) {
    alpha = 0.0;
  } else if (d < u_similarity + u_blend) {
    alpha = (d - u_similarity) / max(u_blend, 1e-6);
  } else {
    alpha = 1.0;
  }
  // Despill surviving pixels: pull green down to max(r, b), scaled by spill.
  vec3 rgb = px.rgb;
  if (u_spill > 0.0 && alpha > 0.0) {
    float capped = min(rgb.g, max(rgb.r, rgb.b));
    rgb.g = mix(rgb.g, capped, u_spill);
  }
  // Premultiplied output (context is premultipliedAlpha: true).
  float a = px.a * alpha;
  gl_FragColor = vec4(rgb * a, a);
}`;

interface GlUniforms {
  uvSrc: WebGLUniformLocation | null;
  keyYuv: WebGLUniformLocation | null;
  similarity: WebGLUniformLocation | null;
  blend: WebGLUniformLocation | null;
  spill: WebGLUniformLocation | null;
  tex: WebGLUniformLocation | null;
  aPos: number;
}

/** Intrinsic size of a TexImageSource (video/image/canvas duck-typing). */
function sourceDims(s: TexImageSource): { w: number; h: number } {
  const v = s as {
    videoWidth?: number; videoHeight?: number;
    naturalWidth?: number; naturalHeight?: number;
    width?: number; height?: number;
  };
  if (typeof v.videoWidth === "number" && v.videoWidth > 0) {
    return { w: v.videoWidth, h: v.videoHeight ?? 0 };
  }
  if (typeof v.naturalWidth === "number" && v.naturalWidth > 0) {
    return { w: v.naturalWidth, h: v.naturalHeight ?? 0 };
  }
  if (typeof v.width === "number" && typeof v.height === "number") {
    return { w: v.width, h: v.height };
  }
  return { w: 0, h: 0 };
}

/** Key color → YUV uniform triple (invalid hex → default green). */
function keyYuvOf(hex: string): { y: number; u: number; v: number } {
  let c: { r: number; g: number; b: number };
  try {
    c = hexToRgb(hex);
  } catch {
    c = hexToRgb(DEFAULT_KEY_COLOR);
  }
  return rgbToYuv(c.r, c.g, c.b);
}

function compileShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, src: string,
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function buildProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext, vert: string, frag: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vert);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs); // linked into the program — safe to drop
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

export class ChromaKeyer {
  private glCanvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private quad: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private uniforms: GlUniforms | null = null;
  private width = 0;
  private height = 0;
  private glFailed = false;
  private lost = false;

  /** Size of the WebGL offscreen canvas. Call when target dims change. */
  configure(width: number, height: number): void {
    this.width = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
    this.height = Number.isFinite(height) ? Math.max(1, Math.round(height)) : 1;
    const c = this.glCanvas;
    // Assigning canvas.width resets the drawing buffer — only on change.
    if (c && (c.width !== this.width || c.height !== this.height)) {
      c.width = this.width;
      c.height = this.height;
    }
  }

  /** Cover-fit geometry shared with drawFrame parity: the centered source
   * sub-rect of a sw×sh source that fills the dw×dh dest rect at (dx, dy)
   * without distortion, cropping the overflowing axis. The dest rect itself
   * is exactly (dx, dy, dw, dh) — dx/dy never affect the crop; they're in
   * the signature for call-site parity. 720×1280 → 960×540 crops top/bottom
   * (sh = 720·(540/960) = 405). */
  static coverRect(
    sw: number, sh: number, dx: number, dy: number, dw: number, dh: number,
  ): { sx: number; sy: number; sw: number; sh: number } {
    void dx; void dy; // (documented above — position-independent)
    if (!(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) {
      return { sx: 0, sy: 0, sw: 0, sh: 0 };
    }
    let cw = sw;
    let ch = (sw * dh) / dw;
    if (ch > sh) {
      ch = sh;
      cw = (sh * dw) / dh;
    }
    return { sx: (sw - cw) / 2, sy: (sh - ch) / 2, sw: cw, sh: ch };
  }

  /** Key `source` and composite onto the 2D `ctx` with object-fit cover into
   * (dx, dy, dw, dh); `opacity` (0–1) via ctx.globalAlpha. Returns false
   * when WebGL is unavailable / the context is lost / the frame isn't
   * decodable yet — the caller then falls back to a plain drawImage. */
  composite(
    ctx: CanvasRenderingContext2D, source: TexImageSource, settings: ChromaKeySettings,
    dx: number, dy: number, dw: number, dh: number, opacity = 1,
  ): boolean {
    if (typeof document === "undefined") return false; // SSR/Node → fallback
    if (!ctx || !(dw > 0) || !(dh > 0)) return false;
    const dims = sourceDims(source);
    if (dims.w <= 0 || dims.h <= 0) return false;
    const s = sanitizeChromaKeySettings(settings);
    const crop = ChromaKeyer.coverRect(dims.w, dims.h, dx, dy, dw, dh);
    if (crop.sw <= 0 || crop.sh <= 0) return false;
    if (!this.ensureContext()) return false;
    const gl = this.gl, canvas = this.glCanvas, program = this.program;
    const quad = this.quad, texture = this.texture, uniforms = this.uniforms;
    if (!gl || !canvas || !program || !quad || !texture || !uniforms) return false;
    if (gl.isContextLost()) return false; // fallback this frame

    this.configure(dw, dh); // offscreen canvas tracks the dest rect

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return false; // not-yet-decodable frame → fallback this tick
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const key = keyYuvOf(s.color);
    gl.uniform3f(uniforms.keyYuv, key.y, key.u, key.v);
    gl.uniform1f(uniforms.similarity, s.similarity);
    gl.uniform1f(uniforms.blend, s.blend);
    gl.uniform1f(uniforms.spill, s.spill);
    // u_uvSrc = (u0, v0, du, dv) of the cover crop in FLIPPED texture
    // space — UNPACK_FLIP_Y makes v=0 the image bottom, so the quad's
    // bottom edge (t=0) samples v0 = 1 − (sy + sh)/srcH.
    gl.uniform4f(uniforms.uvSrc, crop.sx / dims.w,
      1 - (crop.sy + crop.sh) / dims.h, crop.sw / dims.w, crop.sh / dims.h);
    gl.uniform1i(uniforms.tex, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(uniforms.aPos);
    gl.vertexAttribPointer(uniforms.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Composite onto the 2D target (house pattern: identity transform,
    // high-quality smoothing, globalAlpha restored afterwards).
    const prevAlpha = ctx.globalAlpha;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = Number.isFinite(opacity) ? clamp(opacity, 0, 1) : 1;
    ctx.drawImage(canvas, dx, dy, dw, dh);
    ctx.globalAlpha = prevAlpha;
    return true;
  }

  /** Drop the GL context + cached resources (the canvas is GC'd). */
  dispose(): void {
    const gl = this.gl;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.quad) gl.deleteBuffer(this.quad);
      if (this.texture) gl.deleteTexture(this.texture);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.gl = this.glCanvas = null;
    this.program = this.quad = this.texture = null;
    this.uniforms = null;
    this.glFailed = this.lost = false;
    this.width = this.height = 0;
  }

  /** Lazily create the offscreen canvas + GL context (WebGL2 → WebGL1 →
   * experimental-webgl). Context loss: preventDefault keeps the context
   * restorable; webglcontextrestored nulls the stale resources so the next
   * composite rebuilds them. False = caller falls back to plain drawImage. */
  private ensureContext(): boolean {
    if (this.glFailed || this.lost) return false;
    if (typeof document === "undefined") return false;
    if (this.glCanvas === null) {
      const canvas = document.createElement("canvas");
      const opts: WebGLContextAttributes = {
        alpha: true, // keyed pixels must stay transparent
        premultipliedAlpha: true, // shader writes rgb·a (see FRAG_SRC)
        preserveDrawingBuffer: true, // drawImage safety across frames
        antialias: false,
        depth: false,
        stencil: false,
      };
      const gl2 = canvas.getContext("webgl2", opts);
      const gl1 = gl2 ? null : (canvas.getContext("webgl", opts) ??
        canvas.getContext("experimental-webgl", opts)) as WebGLRenderingContext | null;
      const gl = (gl2 ?? gl1) as WebGLRenderingContext | WebGL2RenderingContext | null;
      if (!gl) {
        this.glFailed = true;
        return false;
      }
      this.glCanvas = canvas;
      this.gl = gl;
      canvas.addEventListener("webglcontextlost", (e: Event) => {
        e.preventDefault();
        this.lost = true;
      });
      canvas.addEventListener("webglcontextrestored", () => {
        this.lost = false;
        this.program = null; // stale handles — rebuild on next composite
        this.quad = null;
        this.texture = null;
        this.uniforms = null;
      });
    }
    if (this.program === null && !this.initResources()) return false;
    return true;
  }

  /** (Re)build program + quad buffer + texture — once per context. */
  private initResources(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const prog = buildProgram(gl, VERT_SRC, FRAG_SRC);
    const quad = gl.createBuffer();
    const tex = gl.createTexture();
    const aPos = prog ? gl.getAttribLocation(prog, "a_pos") : -1;
    if (!prog || !quad || !tex || aPos < 0) {
      if (prog) gl.deleteProgram(prog);
      if (quad) gl.deleteBuffer(quad);
      if (tex) gl.deleteTexture(tex);
      this.glFailed = true;
      return false;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // NPOT-safe sampling (valid in WebGL1 too): clamp + linear, no mips.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // v=0 = image bottom
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.program = prog;
    this.quad = quad;
    this.texture = tex;
    this.uniforms = {
      uvSrc: gl.getUniformLocation(prog, "u_uvSrc"),
      keyYuv: gl.getUniformLocation(prog, "u_keyYuv"),
      similarity: gl.getUniformLocation(prog, "u_similarity"),
      blend: gl.getUniformLocation(prog, "u_blend"),
      spill: gl.getUniformLocation(prog, "u_spill"),
      tex: gl.getUniformLocation(prog, "u_tex"),
      aPos,
    };
    return true;
  }
}
