// compositor/shaders/yuv.wgsl — v2 GPU color pipeline.
//
// RGBA composite → planar YUV 4:2:0 on the GPU, writing a TIGHTLY-PACKED
// storage buffer (no 256-byte row padding — the texture-copy alignment rule
// does not apply to storage writes). BT.601 LIMITED range: the exact matrix
// sws_scale uses by default for RGBA→YUV420P/NV12, so the GPU path and the
// CPU sws path produce visually identical frames (the CLI pipeline rides
// sws too — parity preserved).
//
// Layout: one invocation covers a 8×2 pixel block (4 chroma 2×2 macro-pixels
// in a row). It writes:
//   YUV420P: 2×2 u32 Y writes (row y0, row y0+1 — 8 bytes each) + 1 u32 U
//            (4 chroma samples) + 1 u32 V.
//   NV12:    same Y writes + 2 u32 of interleaved U,V,U,V,U,V,U,V.
// Each u32 region is written by EXACTLY ONE invocation — no write races.
//
// Plane strides are padded so every 8-byte invocation stripe lands inside
// its row (tail bytes in the padding are garbage, skipped by the consumer's
// per-row memcpy):
//   y_stride  = ceil(w / 8) * 8       (8-aligned: one stripe = 8 Y bytes)
//   c_stride  = 4 * ceil(w / 8)       (one stripe = 4 chroma bytes)
//   yuv420p:  y_stride*h + c_stride*(h/2) * 2
//   nv12:     y_stride*h + y_stride*(h/2)

struct Params {
    width: u32,
    height: u32,
    y_stride: u32,   // u32-aligned bytes per Y row
    c_stride: u32,   // u32-aligned bytes per U/V row
    y_plane: u32,    // u32 offset (in u32 ELEMENTS) of the Y plane start
    u_plane: u32,    // 420p only: U plane start (u32 elements)
    v_plane: u32,    // 420p only: V plane start
    uv_plane: u32,   // nv12 only: interleaved UV start (u32 elements)
    nv12: u32,       // 0 = planar YUV420P, 1 = NV12
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

// BT.601 limited-range (studio swing) — sws_scale's default matrix.
fn y_of(c: vec3<f32>) -> f32 {
    return clamp(0.257 * c.r + 0.504 * c.g + 0.098 * c.b + 16.0 / 255.0, 0.0, 1.0);
}
fn u_of(c: vec3<f32>) -> f32 {
    return clamp(-0.148 * c.r - 0.291 * c.g + 0.439 * c.b + 0.5, 0.0, 1.0);
}
fn v_of(c: vec3<f32>) -> f32 {
    return clamp(0.439 * c.r - 0.368 * c.g - 0.071 * c.b + 0.5, 0.0, 1.0);
}

fn byte(b: f32, shift: u32) -> u32 {
    return u32(clamp(b, 0.0, 1.0) * 255.0 + 0.5) << shift;
}

@compute @workgroup_size(4, 4, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let w = params.width;
    let h = params.height;
    // invocation (ix, iy) covers pixels x ∈ [8*ix, 8*ix+8), y ∈ [2*iy, 2*iy+2)
    let x0 = min(gid.x * 8u, w - 1u);
    let y0 = min(gid.y * 2u, h - 1u);
    let x1 = min(x0 + 1u, w - 1u);
    let x2 = min(x0 + 2u, w - 1u);
    let x3 = min(x0 + 3u, w - 1u);
    let x4 = min(x0 + 4u, w - 1u);
    let x5 = min(x0 + 5u, w - 1u);
    let x6 = min(x0 + 6u, w - 1u);
    let x7 = min(x0 + 7u, w - 1u);
    let ya = min(y0 + 1u, h - 1u);

    let ta = textureLoad(src, vec2<i32>(i32(x0), i32(y0)), 0).rgb;
    let tb = textureLoad(src, vec2<i32>(i32(x1), i32(y0)), 0).rgb;
    let tc = textureLoad(src, vec2<i32>(i32(x2), i32(y0)), 0).rgb;
    let td = textureLoad(src, vec2<i32>(i32(x3), i32(y0)), 0).rgb;
    let te = textureLoad(src, vec2<i32>(i32(x4), i32(y0)), 0).rgb;
    let tf = textureLoad(src, vec2<i32>(i32(x5), i32(y0)), 0).rgb;
    let tg = textureLoad(src, vec2<i32>(i32(x6), i32(y0)), 0).rgb;
    let th = textureLoad(src, vec2<i32>(i32(x7), i32(y0)), 0).rgb;
    let ba = textureLoad(src, vec2<i32>(i32(x0), i32(ya)), 0).rgb;
    let bb = textureLoad(src, vec2<i32>(i32(x1), i32(ya)), 0).rgb;
    let bc = textureLoad(src, vec2<i32>(i32(x2), i32(ya)), 0).rgb;
    let bd = textureLoad(src, vec2<i32>(i32(x3), i32(ya)), 0).rgb;
    let be = textureLoad(src, vec2<i32>(i32(x4), i32(ya)), 0).rgb;
    let bf = textureLoad(src, vec2<i32>(i32(x5), i32(ya)), 0).rgb;
    let bg = textureLoad(src, vec2<i32>(i32(x6), i32(ya)), 0).rgb;
    let bh = textureLoad(src, vec2<i32>(i32(x7), i32(ya)), 0).rgb;

    // ── Y plane: two rows × 2 u32 writes each ──
    let y_row0 = params.y_plane + (y0 * params.y_stride) / 4u;
    let y_row1 = params.y_plane + (ya * params.y_stride) / 4u;
    let xq = x0 / 4u; // x0 is a multiple of 8 (or clamped at the tail — the
                      // clamped path re-samples edge pixels into the padding,
                      // which the consumer skips; the u32 index stays inside
                      // the padded stride allocation)
    out[y_row0 + xq] = byte(y_of(ta), 0u) | byte(y_of(tb), 8u)
        | byte(y_of(tc), 16u) | byte(y_of(td), 24u);
    out[y_row0 + xq + 1u] = byte(y_of(te), 0u) | byte(y_of(tf), 8u)
        | byte(y_of(tg), 16u) | byte(y_of(th), 24u);
    out[y_row1 + xq] = byte(y_of(ba), 0u) | byte(y_of(bb), 8u)
        | byte(y_of(bc), 16u) | byte(y_of(bd), 24u);
    out[y_row1 + xq + 1u] = byte(y_of(be), 0u) | byte(y_of(bf), 8u)
        | byte(y_of(bg), 16u) | byte(y_of(bh), 24u);

    // ── chroma: average each 2×2 macro-pixel (cosited box — the standard
    //    4:2:0 subsample, matching sws's chroma siting closely) ──
    let c0 = (ta + ba + tb + bb) * 0.25;
    let c1 = (tc + bc + td + bd) * 0.25;
    let c2 = (te + be + tf + bf) * 0.25;
    let c3 = (tg + bg + th + bh) * 0.25;

    if params.nv12 == 1u {
        // interleaved UV rows use the Y stride: 8 bytes = 2 u32
        let uv_row = params.uv_plane + ((y0 / 2u) * params.y_stride) / 4u;
        out[uv_row + xq] = byte(u_of(c0), 0u) | byte(v_of(c0), 8u)
            | byte(u_of(c1), 16u) | byte(v_of(c1), 24u);
        out[uv_row + xq + 1u] = byte(u_of(c2), 0u) | byte(v_of(c2), 8u)
            | byte(u_of(c3), 16u) | byte(v_of(c3), 24u);
    } else {
        // planar U and V: one u32 of each per invocation (4 chroma samples)
        let cy = y0 / 2u;
        let u_row = params.u_plane + (cy * params.c_stride) / 4u;
        let v_row = params.v_plane + (cy * params.c_stride) / 4u;
        out[u_row + xq] = byte(u_of(c0), 0u) | byte(u_of(c1), 8u)
            | byte(u_of(c2), 16u) | byte(u_of(c3), 24u);
        out[v_row + xq] = byte(v_of(c0), 0u) | byte(v_of(c1), 8u)
            | byte(v_of(c2), 16u) | byte(v_of(c3), 24u);
    }
}
