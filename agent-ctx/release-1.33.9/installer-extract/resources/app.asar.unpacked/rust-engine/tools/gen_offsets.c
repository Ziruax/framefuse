// FFmpeg 7.1 (libavcodec 61) struct offsets — mechanically generated from
// the REAL n7.1 headers via offsetof(). Regenerate:
//   gcc -I<ffmpeg-7.1-headers> tools/gen_offsets.c -o /tmp/gen_offsets && /tmp/gen_offsets > src/ffi_offsets.rs
#include <stdio.h>
#include <stddef.h>
#include <libavutil/avutil.h>
#include <libavutil/frame.h>
#include <libavutil/channel_layout.h>
#include <libavutil/pixfmt.h>
#include <libavutil/samplefmt.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libavutil/error.h>
#include <libavcodec/packet.h>
#include <libavcodec/codec.h>
#include <libavcodec/avcodec.h>
#include <libavcodec/codec_par.h>
#include <libavformat/avformat.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

static void u(const char *name, size_t v) { printf("pub const %s: usize = %d;\n", name, (int)v); }
static void i(const char *name, long long v) { printf("pub const %s: i32 = %d;\n", name, (int)v); }

int main(void) {
    puts("// AUTO-GENERATED from FFmpeg n7.1 headers (libavcodec 61 / libavutil 59).");
    puts("#![allow(dead_code)]");

    u("AVFRAME_DATA", offsetof(AVFrame, data));
    u("AVFRAME_LINESIZE", offsetof(AVFrame, linesize));
    u("AVFRAME_EXTENDED_DATA", offsetof(AVFrame, extended_data));
    u("AVFRAME_WIDTH", offsetof(AVFrame, width));
    u("AVFRAME_HEIGHT", offsetof(AVFrame, height));
    u("AVFRAME_NB_SAMPLES", offsetof(AVFrame, nb_samples));
    u("AVFRAME_FORMAT", offsetof(AVFrame, format));
    u("AVFRAME_PTS", offsetof(AVFrame, pts));
    u("AVFRAME_CH_LAYOUT", offsetof(AVFrame, ch_layout));
    u("AVFRAME_SAMPLE_RATE", offsetof(AVFrame, sample_rate));
    u("AVFRAME_SIZE", sizeof(AVFrame));

    u("AVPACKET_PTS", offsetof(AVPacket, pts));
    u("AVPACKET_DTS", offsetof(AVPacket, dts));
    u("AVPACKET_DATA", offsetof(AVPacket, data));
    u("AVPACKET_SIZE", offsetof(AVPacket, size));
    u("AVPACKET_STREAM_INDEX", offsetof(AVPacket, stream_index));
    u("AVPACKET_FLAGS", offsetof(AVPacket, flags));
    u("AVPACKET_DURATION", offsetof(AVPacket, duration));
    u("AVPACKET_SIZEOF", sizeof(AVPacket));

    u("AVCC_WIDTH", offsetof(AVCodecContext, width));
    u("AVCC_HEIGHT", offsetof(AVCodecContext, height));
    u("AVCC_PIX_FMT", offsetof(AVCodecContext, pix_fmt));
    u("AVCC_TIME_BASE", offsetof(AVCodecContext, time_base));
    u("AVCC_FRAMERATE", offsetof(AVCodecContext, framerate));
    u("AVCC_SAMPLE_RATE", offsetof(AVCodecContext, sample_rate));
    u("AVCC_CH_LAYOUT", offsetof(AVCodecContext, ch_layout));
    u("AVCC_SAMPLE_FMT", offsetof(AVCodecContext, sample_fmt));
    u("AVCC_FRAME_SIZE", offsetof(AVCodecContext, frame_size));
    u("AVCC_FLAGS", offsetof(AVCodecContext, flags));
    u("AVCC_GOP_SIZE", offsetof(AVCodecContext, gop_size));
    u("AVCC_THREAD_COUNT", offsetof(AVCodecContext, thread_count));
    u("AVCC_THREAD_TYPE", offsetof(AVCodecContext, thread_type));
    u("AVCC_BIT_RATE", offsetof(AVCodecContext, bit_rate));
    u("AVCC_MAX_B_FRAMES", offsetof(AVCodecContext, max_b_frames));
    u("AVCC_SIZEOF", sizeof(AVCodecContext));

    u("AVCP_CODEC_TYPE", offsetof(AVCodecParameters, codec_type));
    u("AVCP_CODEC_ID", offsetof(AVCodecParameters, codec_id));
    u("AVCP_WIDTH", offsetof(AVCodecParameters, width));
    u("AVCP_HEIGHT", offsetof(AVCodecParameters, height));
    u("AVCP_FORMAT", offsetof(AVCodecParameters, format));
    u("AVCP_SAMPLE_RATE", offsetof(AVCodecParameters, sample_rate));
    u("AVCP_CH_LAYOUT", offsetof(AVCodecParameters, ch_layout));
    u("AVCP_SIZEOF", sizeof(AVCodecParameters));

    u("AVSTREAM_INDEX", offsetof(AVStream, index));
    u("AVSTREAM_CODECPAR", offsetof(AVStream, codecpar));
    u("AVSTREAM_TIME_BASE", offsetof(AVStream, time_base));
    u("AVSTREAM_AVG_FRAME_RATE", offsetof(AVStream, avg_frame_rate));
    u("AVFMTCTX_STREAMS", offsetof(AVFormatContext, streams));
    u("AVFMTCTX_NB_STREAMS", offsetof(AVFormatContext, nb_streams));
    u("AVFMTCTX_OFORMAT", offsetof(AVFormatContext, oformat));
    u("AVFMTCTX_PB", offsetof(AVFormatContext, pb));
    u("AVOFMT_FLAGS", offsetof(struct AVOutputFormat, flags));
    u("AVCHANNELLAYOUT_ORDER", offsetof(AVChannelLayout, order));
    u("AVCHANNELLAYOUT_NB_CHANNELS", offsetof(AVChannelLayout, nb_channels));
    u("AVCHANNELLAYOUT_U_MASK", offsetof(AVChannelLayout, u));
    u("AVCHANNELLAYOUT_SIZEOF", sizeof(AVChannelLayout));

    i("AVMEDIA_TYPE_VIDEO", AVMEDIA_TYPE_VIDEO);
    i("AVMEDIA_TYPE_AUDIO", AVMEDIA_TYPE_AUDIO);
    i("AV_PIX_FMT_YUV420P", AV_PIX_FMT_YUV420P);
    i("AV_PIX_FMT_RGBA", AV_PIX_FMT_RGBA);
    i("AV_PIX_FMT_BGRA", AV_PIX_FMT_BGRA);
    i("AV_PIX_FMT_NV12", AV_PIX_FMT_NV12);
    i("AV_SAMPLE_FMT_FLT", AV_SAMPLE_FMT_FLT);
    i("AV_SAMPLE_FMT_FLTP", AV_SAMPLE_FMT_FLTP);
    i("AVFMT_GLOBALHEADER", AVFMT_GLOBALHEADER);
    i("AV_CODEC_FLAG_GLOBAL_HEADER", AV_CODEC_FLAG_GLOBAL_HEADER);
    i("AVSEEK_FLAG_BACKWARD", AVSEEK_FLAG_BACKWARD);
    i("AVIO_FLAG_WRITE", AVIO_FLAG_WRITE);
    i("SWS_BILINEAR", SWS_BILINEAR);
    i("AV_LOG_QUIET", AV_LOG_QUIET);
    i("AV_LOG_ERROR", AV_LOG_ERROR);
    i("AV_LOG_WARN", AV_LOG_WARNING);
    i("AV_LOG_INFO", AV_LOG_INFO);
    i("AVERROR_EOF", AVERROR_EOF);
    i("AVERROR_EAGAIN", AVERROR(EAGAIN));
    i("AVERROR_INVALIDDATA", AVERROR_INVALIDDATA);
    i("AVERROR_ENOMEM", AVERROR(ENOMEM));
    i("AVERROR_ENOENT", AVERROR(ENOENT));
    i("AV_PKT_FLAG_KEY", AV_PKT_FLAG_KEY);
    i("AV_CHANNEL_ORDER_UNSPEC", AV_CHANNEL_ORDER_UNSPEC);
    i("AV_CHANNEL_ORDER_NATIVE", AV_CHANNEL_ORDER_NATIVE);
    i("AV_CH_LAYOUT_MONO", AV_CH_LAYOUT_MONO);
    i("AV_CH_LAYOUT_STEREO", AV_CH_LAYOUT_STEREO);
    i("FF_THREAD_FRAME", FF_THREAD_FRAME);
    i("FF_THREAD_SLICE", FF_THREAD_SLICE);
    i("AV_CODEC_ID_AAC", AV_CODEC_ID_AAC);
    i("AV_CODEC_ID_H264", AV_CODEC_ID_H264);
    return 0;
}
