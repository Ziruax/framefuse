// AUTO-GENERATED from FFmpeg n7.1 headers (libavcodec 61 / libavutil 59).
#![allow(dead_code)]
pub const AVFRAME_DATA: usize = 0;
pub const AVFRAME_LINESIZE: usize = 64;
pub const AVFRAME_EXTENDED_DATA: usize = 96;
pub const AVFRAME_WIDTH: usize = 104;
pub const AVFRAME_HEIGHT: usize = 108;
pub const AVFRAME_NB_SAMPLES: usize = 112;
pub const AVFRAME_FORMAT: usize = 116;
pub const AVFRAME_PTS: usize = 136;
pub const AVFRAME_CH_LAYOUT: usize = 408;
pub const AVFRAME_SAMPLE_RATE: usize = 192;
pub const AVFRAME_SIZE: usize = 440;
pub const AVPACKET_PTS: usize = 8;
pub const AVPACKET_DTS: usize = 16;
pub const AVPACKET_DATA: usize = 24;
pub const AVPACKET_SIZE: usize = 32;
pub const AVPACKET_STREAM_INDEX: usize = 36;
pub const AVPACKET_FLAGS: usize = 40;
pub const AVPACKET_DURATION: usize = 64;
pub const AVPACKET_SIZEOF: usize = 104;
pub const AVCC_WIDTH: usize = 116;
pub const AVCC_HEIGHT: usize = 120;
pub const AVCC_PIX_FMT: usize = 140;
pub const AVCC_TIME_BASE: usize = 84;
pub const AVCC_FRAMERATE: usize = 100;
pub const AVCC_SAMPLE_RATE: usize = 344;
pub const AVCC_CH_LAYOUT: usize = 352;
pub const AVCC_SAMPLE_FMT: usize = 348;
pub const AVCC_FRAME_SIZE: usize = 376;
pub const AVCC_FLAGS: usize = 64;
pub const AVCC_GOP_SIZE: usize = 332;
pub const AVCC_THREAD_COUNT: usize = 656;
pub const AVCC_THREAD_TYPE: usize = 660;
pub const AVCC_BIT_RATE: usize = 56;
pub const AVCC_MAX_B_FRAMES: usize = 200;
pub const AVCC_SIZEOF: usize = 864;
pub const AVCP_CODEC_TYPE: usize = 0;
pub const AVCP_CODEC_ID: usize = 4;
pub const AVCP_WIDTH: usize = 72;
pub const AVCP_HEIGHT: usize = 76;
pub const AVCP_FORMAT: usize = 44;
pub const AVCP_SAMPLE_RATE: usize = 152;
pub const AVCP_CH_LAYOUT: usize = 128;
pub const AVCP_SIZEOF: usize = 176;
pub const AVSTREAM_INDEX: usize = 8;
pub const AVSTREAM_CODECPAR: usize = 16;
pub const AVSTREAM_TIME_BASE: usize = 32;
pub const AVSTREAM_AVG_FRAME_RATE: usize = 88;
pub const AVFMTCTX_STREAMS: usize = 48;
pub const AVFMTCTX_NB_STREAMS: usize = 44;
pub const AVFMTCTX_OFORMAT: usize = 16;
pub const AVFMTCTX_PB: usize = 32;
// v0.4.1 CRITICAL FIX: FFmpeg 7.0 REMOVED the deprecated `char filename[1024]`
// field from AVFormatContext — every field after `streams` shifted DOWN by
// 1032 bytes. The old offset (1096, generated from pre-7.0 headers that still
// carried filename[1024]) read HEAP GARBAGE. v0.4's audio_duration_sec made
// that read behavior-driving for the first time (the decoded-size gate +
// loudnorm measurement seeks): garbage durations routed every source down the
// streaming path with absurd seek targets — the Windows CI SEGFAULT (demuxer
// seek overflow) and the loudnorm Δ=0dB failure (measurement seek missed).
// Empirically pinned on the engine's ABI family (FFmpeg 7.1: Debian 7.1.5 +
// upstream n7.1 = the BtbN Windows DLLs): duration sits at 104 with bit_rate
// immediately after at 112 — the header's own field order (…, start_time,
// duration, bit_rate) confirms the anchor.
pub const AVFMTCTX_DURATION: usize = 104;
pub const AVOFMT_FLAGS: usize = 44;
pub const AVCHANNELLAYOUT_ORDER: usize = 0;
pub const AVCHANNELLAYOUT_NB_CHANNELS: usize = 4;
pub const AVCHANNELLAYOUT_U_MASK: usize = 8;
pub const AVCHANNELLAYOUT_SIZEOF: usize = 24;
pub const AVMEDIA_TYPE_VIDEO: i32 = 0;
pub const AVMEDIA_TYPE_AUDIO: i32 = 1;
pub const AV_PIX_FMT_YUV420P: i32 = 0;
pub const AV_PIX_FMT_RGBA: i32 = 26;
pub const AV_PIX_FMT_BGRA: i32 = 28;
pub const AV_PIX_FMT_NV12: i32 = 23;
pub const AV_SAMPLE_FMT_FLT: i32 = 3;
pub const AV_SAMPLE_FMT_FLTP: i32 = 8;
pub const AVFMT_GLOBALHEADER: i32 = 64;
pub const AV_CODEC_FLAG_GLOBAL_HEADER: i32 = 4194304;
pub const AVSEEK_FLAG_BACKWARD: i32 = 1;
pub const AVIO_FLAG_WRITE: i32 = 2;
pub const SWS_BILINEAR: i32 = 2;
pub const AV_LOG_QUIET: i32 = -8;
pub const AV_LOG_ERROR: i32 = 16;
pub const AV_LOG_WARN: i32 = 24;
pub const AV_LOG_INFO: i32 = 32;
pub const AVERROR_EOF: i32 = -541478725;
pub const AVERROR_EAGAIN: i32 = -11;
pub const AVERROR_INVALIDDATA: i32 = -1094995529;
pub const AVERROR_ENOMEM: i32 = -12;
pub const AVERROR_ENOENT: i32 = -2;
pub const AV_PKT_FLAG_KEY: i32 = 1;
pub const AV_CHANNEL_ORDER_UNSPEC: i32 = 0;
pub const AV_CHANNEL_ORDER_NATIVE: i32 = 1;
pub const AV_CH_LAYOUT_MONO: i32 = 4;
pub const AV_CH_LAYOUT_STEREO: i32 = 3;
pub const FF_THREAD_FRAME: i32 = 1;
pub const FF_THREAD_SLICE: i32 = 2;
pub const AV_CODEC_ID_AAC: i32 = 86018;
pub const AV_CODEC_ID_H264: i32 = 27;
