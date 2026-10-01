//! wgpu GPU compositor — v2 "full-potential" pipeline.
//!
//! Frame loop (ONE command encoder + ONE submit per frame):
//!   1. upload layer bitmaps — static content (images / rasterized text /
//!      watermark) is keyed by Bitmap.id in an LRU cache; VIDEO frames
//!      (a fresh id per decoded frame) land in a size-keyed SLOT pool whose
//!      texture+bindgroup are allocated ONCE and updated in place with
//!      write_texture — no per-frame texture/view/bindgroup churn.
//!   2. ONE render pass: per layer, set_bind_group(uniform@dyn-offset) +
//!      draw(0..6) — all layers batched (the v1 code submitted one
//!      encoder + queue.submit PER LAYER).
//!   3. compute pass: RGBA target → planar YUV420P / NV12 (BT.601 limited —
//!      sws_scale's default matrix) into a TIGHTLY-PACKED storage buffer
//!      (no 256-byte row padding, 1.5 B/px instead of 4).
//!   4. copy_buffer_to_buffer → map-read staging → map_async → poll(Wait)
//!      → memcpy planes. The encoder consumes the planes directly — the
//!      CPU sws RGBA→YUV pass is GONE on this path.
//!
//! The map-wait makes render_frame synchronous, which is exactly what the
//! v2 export pipeline wants: the decode-ahead producer thread keeps
//! compositing while the GPU runs.

use super::{Compositor, Layer, OutputFormat, TextLayer, YuvMode};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Arc;

const UNIFORM_SIZE: u64 = 96;
const MAX_LAYERS: usize = 96;
const STATIC_CACHE_CAP: usize = 64; // LRU — never a clear-all wipe
const DYNAMIC_SLOTS_CAP: usize = 24;

struct TexEntry {
    #[allow(dead_code)] // owned for the bind group's lifetime
    texture: wgpu::Texture,
    #[allow(dead_code)] // owned for the bind group's lifetime
    view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
    w: u32,
    h: u32,
    /// Reusable padded staging rows for write_texture uploads.
    staging: Vec<u8>,
    src_row: usize,
}

pub struct GpuCompositor {
    _instance: wgpu::Instance,
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter_name: String,
    #[allow(dead_code)] // owned for target_view's lifetime
    target: wgpu::Texture,
    target_view: wgpu::TextureView,
    pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    uniform: wgpu::Buffer,
    uniform_slot: u32,
    uniform_scratch: Vec<u8>,
    bgl: wgpu::BindGroupLayout,
    // GPU YUV conversion
    yuv_pipeline: Option<wgpu::ComputePipeline>,
    yuv_bgl: wgpu::BindGroupLayout,
    yuv_params: wgpu::Buffer,
    yuv_store: wgpu::Buffer,
    yuv_readback: wgpu::Buffer,
    yuv_bg: Option<wgpu::BindGroup>,
    yuv_mode: YuvMode,
    yuv_bytes: usize,
    y_stride: usize,
    c_stride: usize,
    // caches
    static_cache: HashMap<u64, TexEntry>,
    static_lru: Vec<u64>,
    dynamic_slots: Vec<TexEntry>,
    dynamic_ids: Vec<u64>,
    dynamic_used: Vec<bool>,
    out: Vec<u8>,
    width: u32,
    height: u32,
}

impl GpuCompositor {
    pub fn new(width: u32, height: u32, yuv: YuvMode) -> Result<Self, String> {
        let width = width.max(1);
        let height = height.max(1);
        // blocking init inside the export worker thread is fine (one-shot)
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
        let adapter = poll_future(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        }))
        .ok_or_else(|| "no wgpu adapter (no Vulkan/DX12/GL device available)".to_string())?;
        let adapter_info = adapter.get_info();
        // v2: WARP / llvmpipe / software adapters are 4-20× SLOWER than the
        // CPU rasterizer (Microsoft's own WARP benchmarks) and would silently
        // dominate the wall clock — reject them and let the CPU path run.
        // CI sets FRAMEFUSE_ENGINE_ALLOW_SOFTWARE_GPU=1 so the GPUless
        // Windows runner still exercises the FULL GPU code path (compute
        // YUV, texture pool, single-submit) on WARP.
        let allow_software = std::env::var("FRAMEFUSE_ENGINE_ALLOW_SOFTWARE_GPU")
            .map(|v| v == "1")
            .unwrap_or(false);
        if !allow_software {
            if adapter_info.device_type == wgpu::DeviceType::Cpu {
                return Err(format!(
                    "wgpu adapter `{}` is a SOFTWARE device (WARP/llvmpipe) — CPU rasterizer is faster",
                    adapter_info.name
                ));
            }
            if adapter_info.name.contains("Microsoft Basic Render Driver") {
                return Err("wgpu adapter is Microsoft Basic Render Driver (software)".into());
            }
        }
        let (device, queue) = poll_future(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("framefuse-compositor"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
            },
            None,
        ))
        .map_err(|e| format!("wgpu device request failed: {}", e))?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("composite"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/composite.wgsl").into()),
        });

        let uniform_slot = device
            .limits()
            .min_uniform_buffer_offset_alignment
            .max(256);

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("layer-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(UNIFORM_SIZE),
                    },
                    count: None,
                },
            ],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("composite-pipeline"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("composite-pl"),
                bind_group_layouts: &[&bgl],
                push_constant_ranges: &[],
            })),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs",
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs",
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("layer-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        // The target is both the render attachment AND the compute source.
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("composite-target"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage,
            view_formats: &[],
        });
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

        // ── GPU YUV conversion resources ──────────────────────────────────
        // y_stride is 8-ALIGNED so every 8-byte invocation stripe stays
        // inside its row; c_stride = 4*ceil(w/2 /4) = 4*ceil(w/8) likewise.
        let y_stride = ((width as usize) + 7) / 8 * 8;
        let c_stride = (((width / 2) as usize) + 3) / 4 * 4;
        let h2 = ((height + 1) / 2) as usize;
        let yuv_bytes = match yuv {
            YuvMode::Yuv420p => y_stride * height as usize + c_stride * h2 * 2,
            YuvMode::Nv12 => y_stride * height as usize + y_stride * h2,
        };
        let yuv_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rgba-to-yuv"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/yuv.wgsl").into()),
        });
        let yuv_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("yuv-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let yuv_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("rgba-to-yuv-pipeline"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("yuv-pl"),
                bind_group_layouts: &[&yuv_bgl],
                push_constant_ranges: &[],
            })),
            module: &yuv_shader,
            entry_point: "main",
        });

        let y_plane = 0u32;
        let u_plane = ((y_stride * height as usize) / 4) as u32;
        let v_plane = ((y_stride * height as usize + c_stride * h2) / 4) as u32;
        let uv_plane = u_plane;
        // 9 u32 params (WGSL uniform: scalars keep 4-byte alignment)
        let mut params_data = Vec::with_capacity(40);
        params_data.extend_from_slice(&width.to_le_bytes());
        params_data.extend_from_slice(&height.to_le_bytes());
        params_data.extend_from_slice(&(y_stride as u32).to_le_bytes());
        params_data.extend_from_slice(&(c_stride as u32).to_le_bytes());
        params_data.extend_from_slice(&y_plane.to_le_bytes());
        params_data.extend_from_slice(&u_plane.to_le_bytes());
        params_data.extend_from_slice(&v_plane.to_le_bytes());
        params_data.extend_from_slice(&uv_plane.to_le_bytes());
        params_data.extend_from_slice(&match yuv {
            YuvMode::Yuv420p => 0u32.to_le_bytes(),
            YuvMode::Nv12 => 1u32.to_le_bytes(),
        });
        let yuv_params = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("yuv-params"),
            size: params_data.len() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let yuv_store = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("yuv-store"),
            size: yuv_bytes as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let yuv_readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("yuv-readback"),
            size: yuv_bytes as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        queue.write_buffer(&yuv_params, 0, &params_data);

        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("layer-uniforms"),
            size: uniform_slot as u64 * MAX_LAYERS as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Ok(GpuCompositor {
            _instance: instance,
            device,
            queue,
            adapter_name: adapter_info.name,
            target,
            target_view,
            pipeline,
            sampler,
            uniform,
            uniform_slot,
            uniform_scratch: vec![0u8; MAX_LAYERS * uniform_slot as usize],
            bgl,
            yuv_pipeline: Some(yuv_pipeline),
            yuv_bgl,
            yuv_params,
            yuv_store,
            yuv_readback,
            yuv_bg: None,
            yuv_mode: yuv,
            yuv_bytes,
            y_stride,
            c_stride,
            static_cache: HashMap::new(),
            static_lru: Vec::new(),
            dynamic_slots: Vec::new(),
            dynamic_ids: Vec::new(),
            dynamic_used: Vec::new(),
            out: vec![0; yuv_bytes],
            width,
            height,
        })
    }

    pub fn adapter_info(&self) -> String {
        self.adapter_name.clone()
    }

    /// Slot index for a bitmap this frame: static cache hit, dynamic slot
    /// reuse, or a fresh texture. `dynamic` = per-frame video content.
    fn ensure_texture(&mut self, id: u64, data: &Arc<Vec<u8>>, w: u32, h: u32, dynamic: bool) -> Result<usize, String> {
        if !dynamic {
            if let Some(_) = self.static_cache.get(&id) {
                // LRU touch
                if let Some(pos) = self.static_lru.iter().position(|&k| k == id) {
                    let last = self.static_lru.remove(pos);
                    self.static_lru.push(last);
                }
                return Ok(usize::MAX); // caller resolves the entry directly
            }
            self.prune_static();
            let entry = self.make_texture(id, data, w, h)?;
            self.static_cache.insert(id, entry);
            self.static_lru.push(id);
            return Ok(usize::MAX);
        }
        // dynamic: find a slot already holding this id, else an unused
        // same-size slot, else append (bounded by DYNAMIC_SLOTS_CAP →
        // evict the least recently used slot by resetting its id).
        for i in 0..self.dynamic_slots.len() {
            if self.dynamic_ids[i] == id && !self.dynamic_used[i] {
                self.dynamic_used[i] = true;
                return Ok(i);
            }
        }
        for i in 0..self.dynamic_slots.len() {
            if !self.dynamic_used[i]
                && self.dynamic_slots[i].w == w
                && self.dynamic_slots[i].h == h
            {
                // same size, different content → upload in place
                let slot = &mut self.dynamic_slots[i];
                upload_texture(&self.queue, slot, data, w, h);
                self.dynamic_ids[i] = id;
                self.dynamic_used[i] = true;
                return Ok(i);
            }
        }
        if self.dynamic_slots.len() >= DYNAMIC_SLOTS_CAP {
            // evict any unused slot (any size) by replacing it
            if let Some(i) = (0..self.dynamic_slots.len()).find(|&i| !self.dynamic_used[i]) {
                self.dynamic_slots.remove(i);
                self.dynamic_ids.remove(i);
                self.dynamic_used.remove(i);
                let entry = self.make_texture(id, data, w, h)?;
                self.dynamic_slots.insert(i, entry);
                self.dynamic_ids.insert(i, id);
                self.dynamic_used.insert(i, true);
                return Ok(i);
            }
            return Err("too many dynamic layers in one frame".into());
        }
        let entry = self.make_texture(id, data, w, h)?;
        self.dynamic_slots.push(entry);
        self.dynamic_ids.push(id);
        self.dynamic_used.push(true);
        Ok(self.dynamic_slots.len() - 1)
    }

    fn prune_static(&mut self) {
        while self.static_cache.len() >= STATIC_CACHE_CAP {
            match self.static_lru.first().copied() {
                Some(k) => {
                    self.static_lru.remove(0);
                    let _ = self.static_cache.remove(&k);
                }
                None => break,
            }
        }
    }

    fn make_texture(&mut self, _id: u64, data: &Arc<Vec<u8>>, w: u32, h: u32) -> Result<TexEntry, String> {
        let w = w.max(1);
        let h = h.max(1);
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("layer-tex"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("layer-bg"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    // EXPLICIT size — a dynamic-offset binding that takes
                    // the whole buffer validates "offset must be 0"
                    // (wgpu: "the maximum the binding can be offset is 0
                    // bytes"). Binding exactly one uniform slot per draw.
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.uniform,
                        offset: 0,
                        size: wgpu::BufferSize::new(UNIFORM_SIZE),
                    }),
                },
            ],
        });
        let mut entry = TexEntry {
            texture,
            view,
            bind_group,
            w,
            h,
            staging: Vec::new(),
            src_row: w as usize * 4,
        };
        upload_texture(&self.queue, &mut entry, data, w, h);
        Ok(entry)
    }

    /// Pack one layer's uniforms into scratch slot `i` (256-aligned stride).
    ///
    /// THE v1.16-v1.17 BLACK-FRAME BUG (found via llvmpipe GPU testing):
    /// WGSL's UNIFORM address space gives mat3x3<f32> 16-byte column strides
    /// (each vec3 column padded to vec4), i.e. col0@0..12, col1@16..28,
    /// col2@32..44. Writing the 9 floats PACKED (36 contiguous bytes) made
    /// the shader read col1/col2 from the wrong offsets — the transform
    /// degenerated to y'=0, w=0 (zero-area triangles) and the GPU
    /// compositor silently rendered BLACK FRAMES since v1.16.0 (CI only
    /// asserted frame counts, never pixel content).
    fn write_layer_uniform(&mut self, i: usize, transform: [f32; 9], alpha: f32, chroma: Option<(&str, f64, f64)>, tex_w: u32, tex_h: u32) {
        let slot = &mut self.uniform_scratch[i * self.uniform_slot as usize..];
        // strided columns: the WGSL uniform layout for mat3x3
        slot[0..12].copy_from_slice(bytemuck_of(&transform[0..3]));
        slot[16..28].copy_from_slice(bytemuck_of(&transform[3..6]));
        slot[32..44].copy_from_slice(bytemuck_of(&transform[6..9]));
        let a = alpha.clamp(0.0, 1.0);
        slot[48..52].copy_from_slice(bytemuck_of(&[a]));
        let (key, similar, smooth) = if let Some((color, similarity, smoothness)) = chroma {
            let rgb = super::parse_hex_color(color);
            let (r, g, b) = (
                rgb[0] as f32 / 255.0,
                rgb[1] as f32 / 255.0,
                rgb[2] as f32 / 255.0,
            );
            let (y, u, v) = super::rgb_to_yuv601(r, g, b);
            ([y, u, v], similarity.clamp(0.0, 1.0) as f32, smoothness.clamp(0.0, 1.0) as f32)
        } else {
            ([0.0, 0.0, 0.0], -1.0, 0.0)
        };
        slot[64..76].copy_from_slice(bytemuck_of(&key));
        slot[76..80].copy_from_slice(bytemuck_of(&[similar]));
        slot[80..84].copy_from_slice(bytemuck_of(&[smooth]));
        let texel = [1.0 / (tex_w.max(1) as f32), 1.0 / (tex_h.max(1) as f32)];
        slot[88..96].copy_from_slice(bytemuck_of(&texel));
    }

    fn layer_transform(dest: (f32, f32, f32, f32)) -> [f32; 9] {
        let (dx, dy, dw, dh) = dest;
        [
            2.0 * dw, 0.0, 0.0,
            0.0, -2.0 * dh, 0.0,
            2.0 * dx - 1.0, 1.0 - 2.0 * dy, 1.0,
        ]
    }

    fn text_transform_px(&self, dx: u32, dy: u32, dw: u32, dh: u32) -> [f32; 9] {
        let d = (
            dx as f32 / self.width as f32,
            dy as f32 / self.height as f32,
            dw as f32 / self.width as f32,
            dh as f32 / self.height as f32,
        );
        Self::layer_transform(d)
    }
}

/// Queue a bitmap upload into a texture slot (pads rows to 256 alignment,
/// reusing the slot's staging buffer — zero per-upload allocation after the
/// first frame).
fn upload_texture(queue: &wgpu::Queue, slot: &mut TexEntry, data: &Arc<Vec<u8>>, w: u32, h: u32) {
    let src_row = w as usize * 4;
    let padded_row = (src_row + 255) / 256 * 256;
    if slot.staging.len() != padded_row * h as usize {
        slot.staging.resize(padded_row * h as usize, 0);
        slot.src_row = src_row;
    }
    let staging = &mut slot.staging;
    if padded_row == src_row {
        // fast path: rows already aligned — copy straight into staging
        let n = (src_row * h as usize).min(data.len());
        staging[..n].copy_from_slice(&data[..n]);
    } else {
        for y in 0..h as usize {
            let src = y * src_row;
            let dst = y * padded_row;
            if src + src_row <= data.len() {
                staging[dst..dst + src_row].copy_from_slice(&data[src..src + src_row]);
            }
        }
    }
    queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &slot.texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &staging[..],
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(padded_row as u32),
            rows_per_image: None,
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
}

fn bytemuck_of(v: &[f32]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

fn poll_future<F: std::future::Future>(mut fut: F) -> F::Output {
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
    fn noop_raw_waker() -> RawWaker {
        RawWaker::new(std::ptr::null(), &NOOP_VTABLE)
    }
    static NOOP_VTABLE: RawWakerVTable = RawWakerVTable::new(
        |_| noop_raw_waker(),
        |_| {},
        |_| {},
        |_| {},
    );
    let waker = unsafe { Waker::from_raw(noop_raw_waker()) };
    let mut cx = Context::from_waker(&waker);
    let mut fut = unsafe { std::pin::Pin::new_unchecked(&mut fut) };
    loop {
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => return v,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

impl Compositor for GpuCompositor {
    fn name(&self) -> &'static str {
        "rust-gpu"
    }

    fn adapter_name(&self) -> Option<String> {
        Some(self.adapter_name.clone())
    }

    fn render_frame(
        &mut self,
        layers: &[Layer],
        texts: &[TextLayer],
        background: [u8; 4],
        _width: u32,
        _height: u32,
    ) -> Result<(), String> {
        let total = layers.len() + texts.len();
        if total > MAX_LAYERS {
            return Err(format!("too many layers ({}) for the GPU batch", total));
        }
        // reset dynamic claims from the previous frame
        for u in self.dynamic_used.iter_mut() {
            *u = false;
        }

        let clear = wgpu::Color {
            r: background[0] as f64 / 255.0,
            g: background[1] as f64 / 255.0,
            b: background[2] as f64 / 255.0,
            a: background[3] as f64 / 255.0,
        };

        // ── ensure textures + pack uniforms (slot i per draw) ────────────
        for (i, layer) in layers.iter().enumerate() {
            let dynamic = layer.dynamic;
            self.ensure_texture(layer.bitmap.id, &layer.bitmap.data, layer.bitmap.w, layer.bitmap.h, dynamic)?;
            let tr = Self::layer_transform(layer.dest);
            let chroma = layer.chroma.as_ref().map(|c| (c.color.as_str(), c.similarity, c.smoothness));
            self.write_layer_uniform(i, tr, layer.alpha, chroma, layer.bitmap.w, layer.bitmap.h);
        }
        for (j, text) in texts.iter().enumerate() {
            let i = layers.len() + j;
            let dynamic = false; // rasterized once — static id
            self.ensure_texture(text.bitmap.id, &text.bitmap.data, text.bitmap.w, text.bitmap.h, dynamic)?;
            let tr = self.text_transform_px(text.dest_px.0, text.dest_px.1, text.dest_px.2, text.dest_px.3);
            self.write_layer_uniform(i, tr, text.alpha, None, text.bitmap.w, text.bitmap.h);
        }
        // one write_buffer for the whole contiguous prefix
        if total > 0 {
            let used = total * self.uniform_slot as usize;
            self.queue.write_buffer(&self.uniform, 0, &self.uniform_scratch[..used]);
        }

        // ── ONE encoder: render pass (all layers) + compute + copy ──────
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("frame"),
        });
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.target_view,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(clear), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            rpass.set_pipeline(&self.pipeline);
            for (i, layer) in layers.iter().enumerate() {
                let bg = self.bind_group_of(layer.bitmap.id, layer.dynamic)?;
                rpass.set_bind_group(0, bg, &[i as u32 * self.uniform_slot]);
                rpass.draw(0..6, 0..1);
            }
            for (j, text) in texts.iter().enumerate() {
                let i = layers.len() + j;
                let bg = self.bind_group_of(text.bitmap.id, false)?;
                rpass.set_bind_group(0, bg, &[i as u32 * self.uniform_slot]);
                rpass.draw(0..6, 0..1);
            }
        }
        // compute: RGBA → YUV (planar/NV12) into the packed storage buffer
        if self.yuv_pipeline.is_some() {
            if self.yuv_bg.is_none() {
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("yuv-bg"),
                    layout: &self.yuv_bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&self.target_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &self.yuv_store,
                                offset: 0,
                                size: None,
                            }),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &self.yuv_params,
                                offset: 0,
                                size: None,
                            }),
                        },
                    ],
                });
                self.yuv_bg = Some(bg);
            }
            let yuv_bg = self.yuv_bg.as_ref().unwrap();
            // one invocation per 8x2 pixel stripe; workgroup_size(4,4,1)
            let inv_x = (self.width + 7) / 8;
            let inv_y = (self.height + 1) / 2;
            let gx = (inv_x + 3) / 4;
            let gy = (inv_y + 3) / 4;
            {
                let mut cp = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("rgba-to-yuv"),
                    timestamp_writes: None,
                });
                cp.set_pipeline(self.yuv_pipeline.as_ref().unwrap());
                cp.set_bind_group(0, &yuv_bg, &[]);
                cp.dispatch_workgroups(gx, gy, 1);
            }
            encoder.copy_buffer_to_buffer(&self.yuv_store, 0, &self.yuv_readback, 0, self.yuv_bytes as u64);
        }
        self.queue.submit(Some(encoder.finish()));

        // ── read back the packed YUV planes ──────────────────────────────
        let (tx, rx) = mpsc::channel();
        let map_size = self.yuv_bytes as u64;
        self.yuv_readback
            .slice(0..map_size)
            .map_async(wgpu::MapMode::Read, move |res| {
                let _ = tx.send(res);
            });
        let _ = self.device.poll(wgpu::Maintain::Wait);
        match rx.recv() {
            Ok(Ok(())) => {}
            _ => return Err("wgpu readback map failed (device lost?)".into()),
        }
        {
            let data = self.yuv_readback.slice(0..map_size).get_mapped_range();
            self.out[..].copy_from_slice(&data[..]);
        }
        self.yuv_readback.unmap();
        Ok(())
    }

    fn output_format(&self) -> OutputFormat {
        match self.yuv_mode {
            YuvMode::Yuv420p => OutputFormat::Yuv420p,
            YuvMode::Nv12 => OutputFormat::Nv12,
        }
    }

    fn output(&self) -> &[u8] {
        &self.out
    }

    fn yuv_strides(&self) -> (usize, usize) {
        (self.y_stride, self.c_stride)
    }
}

impl GpuCompositor {
    fn bind_group_of(&self, id: u64, dynamic: bool) -> Result<&wgpu::BindGroup, String> {
        if !dynamic {
            if let Some(e) = self.static_cache.get(&id) {
                return Ok(&e.bind_group);
            }
            return Err("static texture missing after ensure".into());
        }
        for i in 0..self.dynamic_slots.len() {
            if self.dynamic_ids[i] == id {
                return Ok(&self.dynamic_slots[i].bind_group);
            }
        }
        Err("dynamic texture slot missing after ensure".into())
    }
}

