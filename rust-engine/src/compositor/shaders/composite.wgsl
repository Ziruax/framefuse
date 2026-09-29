// wgpu composite shader — one fullscreen quad per layer.
// transform maps quad-local (x, y ∈ 0..1) to clip space (col-major mat3x3).
// Chroma key uses the SAME BT.601 YUV-distance math as the CPU compositor
// (compositor::rgb_to_yuv601 / chroma_alpha) so both paths match.
// chroma_similar < 0.0 disables keying.

struct LayerUniforms {
  transform: mat3x3<f32>,
  alpha: f32,
  chroma_key: vec3<f32>,
  chroma_similar: f32,
  chroma_smooth: f32,
  texel_size: vec2<f32>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: LayerUniforms;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  );
  let p = quad[vi];
  let clip = u.transform * vec3<f32>(p, 1.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip.xy, 0.0, 1.0);
  out.uv = vec2<f32>(p.x, 1.0 - p.y);
  return out;
}

fn rgb_to_yuv601(c: vec3<f32>) -> vec3<f32> {
  let y = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  let u_ = dot(c, vec3<f32>(-0.147, -0.289, 0.436));
  let v = dot(c, vec3<f32>(0.615, -0.515, -0.100));
  return vec3<f32>(y, u_, v);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  var c = textureSample(tex, samp, in.uv);
  let a = c.a * u.alpha;
  if (u.chroma_similar >= 0.0) {
    let yuv = rgb_to_yuv601(c.rgb);
    let d = distance(yuv, u.chroma_key);
    let thresh = u.chroma_similar * 0.7;
    let soft = max(u.chroma_smooth * 0.7, 0.001);
    let k = clamp((d - thresh) / soft, 0.0, 1.0);
    return vec4<f32>(c.rgb, a * k);
  }
  return vec4<f32>(c.rgb, a);
}
