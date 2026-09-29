//! wgpu GPU compositor — hardware-accelerated layer compositing that lives
//! ENTIRELY outside Chromium (no browser TDR surface, DIRECTIVE 6 rule 2:
//! render offscreen → buffer readback → system-memory encode; NO CUDA
//! interop in v0.1).
//!
//! Frame loop: upload layer bitmaps to cached textures → per layer:
//! write uniforms → render pass (blend) → after the last layer, copy the
//! target texture to a staging buffer → map → read RGBA back to RAM →
//! hand to the runtime-FFmpeg sws_scale/encoder.

use super::{Compositor, Layer, OutputFormat, TextLayer};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Arc;

const UNIFORM_SIZE: u64 = 96;
const MAX_TEX_CACHE: usize = 32;

#[allow(dead_code)] // texture/view must stay OWNED for the bind group's lifetime
struct TexEntry {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
}

pub struct GpuCompositor {
    _instance: wgpu::Instance,
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter_name: String,
    target: wgpu::Texture,
    target_view: wgpu::TextureView,
    pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    uniform: wgpu::Buffer,
    bgl: wgpu::BindGroupLayout,
    readback: wgpu::Buffer,
    row_bytes: u32,
    width: u32,
    height: u32,
    tex_cache: HashMap<u64, TexEntry>,
    out: Vec<u8>,
}

impl GpuCompositor {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
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
                        has_dynamic_offset: false,
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

        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC;
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

        let row_bytes = align256(width * 4);
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("composite-readback"),
            size: (row_bytes * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("layer-uniform"),
            size: UNIFORM_SIZE,
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
            bgl,
            readback,
            row_bytes,
            width,
            height,
            tex_cache: HashMap::new(),
            out: vec![0; width as usize * height as usize * 4],
        })
    }

    pub fn adapter_info(&self) -> String {
        self.adapter_name.clone()
    }

    fn ensure_texture(&mut self, layer: &super::Bitmap) -> Result<(), String> {
        let key = layer.id;
        if self.tex_cache.contains_key(&key) {
            return Ok(());
        }
        if self.tex_cache.len() >= MAX_TEX_CACHE {
            self.tex_cache.clear();
        }
        let w = layer.w.max(1);
        let h = layer.h.max(1);
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
            // rows must be 256-aligned for texture uploads
            let src_row = w as usize * 4;
            let data: Vec<u8> = if src_row % 256 == 0 {
                layer.data.as_ref().clone()
            } else {
                let mut padded = vec![0u8; align256(src_row as u32) as usize * h as usize];
                for y in 0..h as usize {
                    let src = y * src_row;
                    let dst = y * align256(src_row as u32) as usize;
                    padded[dst..dst + src_row].copy_from_slice(&layer.data[src..src + src_row]);
                }
                padded
            };
            self.queue.write_texture(
                wgpu::ImageCopyTexture {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &data,
                wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(align256(src_row as u32)),
                    rows_per_image: None,
                },
                wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            );
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
                        resource: self.uniform.as_entire_binding(),
                    },
                ],
            });
            self.tex_cache.insert(key, TexEntry { texture, view, bind_group });
        Ok(())
    }

    /// One render pass for one layer. Immutable borrows only (the cache
    /// lookup, encoder, and submit all take &self), so it can follow
    /// `ensure_texture(&mut self)` without borrow conflicts.
    fn submit_pass(&self, tex_key: u64, clear: Option<wgpu::Color>, is_last: bool) {
        let entry = match self.tex_cache.get(&tex_key) {
            Some(e) => e,
            None => return,
        };
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("layer-pass"),
        });
        let load = match clear {
            Some(c) => wgpu::LoadOp::Clear(c),
            None => wgpu::LoadOp::Load,
        };
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("layer-render"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.target_view,
                    resolve_target: None,
                    ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            rpass.set_pipeline(&self.pipeline);
            rpass.set_bind_group(0, &entry.bind_group, &[]);
            rpass.draw(0..6, 0..1);
        }
        if is_last {
            encoder.copy_texture_to_buffer(
                self.target.as_image_copy(),
                wgpu::ImageCopyBuffer {
                    buffer: &self.readback,
                    layout: wgpu::ImageDataLayout {
                        offset: 0,
                        bytes_per_row: Some(self.row_bytes),
                        rows_per_image: None,
                    },
                },
                wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
            );
        }
        self.queue.submit(Some(encoder.finish()));
    }

    /// No layers at all: still produce a cleared frame + readback.
    fn submit_empty(&self, clear: wgpu::Color) {
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("empty-pass"),
        });
        {
            let _rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("empty-render"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.target_view,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(clear), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }
        encoder.copy_texture_to_buffer(
            self.target.as_image_copy(),
            wgpu::ImageCopyBuffer {
                buffer: &self.readback,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(self.row_bytes),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
        );
        self.queue.submit(Some(encoder.finish()));
    }

    fn write_uniform(&self, layer: &Layer) {
        let (dx, dy, dw, dh) = layer.dest;
        // column-major mat3x3: [c0, c1, c2]
        let m: [f32; 9] = [
            2.0 * dw,
            0.0,
            0.0,
            0.0,
            -2.0 * dh,
            0.0,
            2.0 * dx - 1.0,
            1.0 - 2.0 * dy,
            1.0,
        ];
        let mut u = [0u8; UNIFORM_SIZE as usize];
        u[0..36].copy_from_slice(bytemuck_of(&m));
        let alpha = layer.alpha.clamp(0.0, 1.0);
        u[48..52].copy_from_slice(bytemuck_of(&[alpha]));
        let (key, similar, smooth) = if let Some(ch) = &layer.chroma {
            let rgb = super::parse_hex_color(&ch.color);
            let (r, g, b) = (
                rgb[0] as f32 / 255.0,
                rgb[1] as f32 / 255.0,
                rgb[2] as f32 / 255.0,
            );
            let (y, uv, v) = super::rgb_to_yuv601(r, g, b);
            ([y, uv, v], ch.similarity.clamp(0.0, 1.0), ch.smoothness.clamp(0.0, 1.0))
        } else {
            ([0.0, 0.0, 0.0], -1.0, 0.0)
        };
        u[64..76].copy_from_slice(bytemuck_of(&key));
        u[76..80].copy_from_slice(bytemuck_of(&[similar as f32]));
        u[80..84].copy_from_slice(bytemuck_of(&[smooth as f32]));
        let texel = [1.0 / (layer.bitmap.w.max(1) as f32), 1.0 / (layer.bitmap.h.max(1) as f32)];
        u[88..96].copy_from_slice(bytemuck_of(&texel));
        self.queue.write_buffer(&self.uniform, 0, &u);
    }

    fn write_text_uniform(&self, text: &TextLayer) {
        // text layers are pixel-space quads sharing the same shape
        let (dx, dy, dw, dh) = (
            text.dest_px.0 as f32 / self.width as f32,
            text.dest_px.1 as f32 / self.height as f32,
            text.dest_px.2 as f32 / self.width as f32,
            text.dest_px.3 as f32 / self.height as f32,
        );
        let m: [f32; 9] = [
            2.0 * dw,
            0.0,
            0.0,
            0.0,
            -2.0 * dh,
            0.0,
            2.0 * dx - 1.0,
            1.0 - 2.0 * dy,
            1.0,
        ];
        let mut u = [0u8; UNIFORM_SIZE as usize];
        u[0..36].copy_from_slice(bytemuck_of(&m));
        let alpha = text.alpha.clamp(0.0, 1.0);
        u[48..52].copy_from_slice(bytemuck_of(&[alpha]));
        let similar: f32 = -1.0;
        u[76..80].copy_from_slice(bytemuck_of(&[similar as f32]));
        self.queue.write_buffer(&self.uniform, 0, &u);
    }
}

fn align256(n: u32) -> u32 {
    (n + 255) / 256 * 256
}

fn bytemuck_of(v: &[f32]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

fn poll_future<F: std::future::Future>(mut fut: F) -> F::Output {
    // wgpu futures are not Send-safe to park on the tokio runtime from a
    // blocking worker; spin the executor inline (init happens once).
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
        // background as clear color of the first pass
        let clear = wgpu::Color {
            r: background[0] as f64 / 255.0,
            g: background[1] as f64 / 255.0,
            b: background[2] as f64 / 255.0,
            a: background[3] as f64 / 255.0,
        };
        let total = layers.len() + texts.len();
        let mut drawn = 0usize;

        for layer in layers {
            self.write_uniform(layer);
            let key = layer.bitmap.id;
            self.ensure_texture(&layer.bitmap)?;
            drawn += 1;
            self.submit_pass(key, if drawn == 1 { Some(clear) } else { None }, drawn == total);
        }
        for text in texts {
            self.write_text_uniform(text);
            let key = text.bitmap.id;
            let bmp = super::Bitmap {
                data: text.bitmap.data.clone(),
                w: text.bitmap.w,
                h: text.bitmap.h,
                id: text.bitmap.id,
            };
            self.ensure_texture(&bmp)?;
            drawn += 1;
            self.submit_pass(key, if drawn == 1 { Some(clear) } else { None }, drawn == total);
        }
        if total == 0 {
            self.submit_empty(clear);
        }

        // map + read back
        let (tx, rx) = mpsc::channel();
        let map_size = (self.row_bytes * self.height) as u64;
        self.readback
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
            let data = self.readback.slice(0..map_size).get_mapped_range();
            let src_row = self.width as usize * 4;
            let out = &mut self.out;
            for y in 0..self.height as usize {
                let src = y * self.row_bytes as usize;
                let dst = y * src_row;
                out[dst..dst + src_row].copy_from_slice(&data[src..src + src_row]);
            }
        }
        self.readback.unmap();
        Ok(())
    }

    fn output_format(&self) -> OutputFormat {
        OutputFormat::Rgba
    }

    fn output(&self) -> &[u8] {
        &self.out
    }
}
