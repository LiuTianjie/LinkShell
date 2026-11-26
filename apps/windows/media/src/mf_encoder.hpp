#pragma once

#include <strmif.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wrl/client.h>

#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/video_encoder_factory.h"
#include "d3d_context.hpp"
#include "lan_floor.hpp"
#include "modules/video_coding/codecs/h264/include/h264_globals.h"

namespace linkshell {

// Native Windows Media Foundation Hardware MFT encoder (NVENC / AMF / QSV / Qualcomm ARM64)
// with D3D11 zero-copy GPU texture input, live zero-restart SetRates, instant PLI IDR,
// H.264 + HEVC (H.265) support, Mac-parity SendQueue admission, and Fusion SEI injection.
class MediaFoundationVideoEncoder : public webrtc::VideoEncoder {
 public:
  using LogFn = std::function<void(const std::string&)>;

  MediaFoundationVideoEncoder(
      std::shared_ptr<D3DContext> d3d,
      const webrtc::SdpVideoFormat& format,
      LogFn log = {});
  ~MediaFoundationVideoEncoder() override;

  int InitEncode(const webrtc::VideoCodec* codec_settings, const VideoEncoder::Settings& settings) override;
  int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* callback) override;
  int32_t Release() override;
  int32_t Encode(const webrtc::VideoFrame& frame, const std::vector<webrtc::VideoFrameType>* frame_types) override;
  void SetRates(const RateControlParameters& parameters) override;
  EncoderInfo GetEncoderInfo() const override;

  static bool HasHardwareMft(bool hevc);
  static std::vector<uint8_t> BuildFusionSeiNal(const std::string& layout_json, bool hevc);

 private:
  struct FrameMeta {
    uint32_t rtp_timestamp = 0;
    int64_t render_time_ms = 0;
    int64_t ntp_time_ms = 0;
    webrtc::VideoRotation rotation = webrtc::kVideoRotation_0;
    std::string fusion_layout;
    bool requested_key = false;
    int64_t encode_start_ms = 0;
  };

  bool CreateMft(int width, int height, int fps, int bitrate_bps, bool try_hardware);
  bool ConfigureMft(int width, int height, int fps, int bitrate_bps);
  bool DrainAsyncOutput();
  bool EmitSample(IMFSample* sample, const FrameMeta& meta);
  void CacheParameterSets(const uint8_t* data, size_t len, bool* out_is_key, bool* out_has_ps);
  void DestroyMft();

  std::shared_ptr<D3DContext> d3d_;
  webrtc::SdpVideoFormat format_;
  LogFn log_;
  bool hevc_ = false;
  uint32_t h264_profile_ = eAVEncH264VProfile_Main;
  webrtc::H264PacketizationMode packetization_ = webrtc::H264PacketizationMode::NonInterleaved;

  mutable std::mutex mu_;
  webrtc::EncodedImageCallback* callback_ = nullptr;
  Microsoft::WRL::ComPtr<IMFTransform> mft_;
  Microsoft::WRL::ComPtr<ICodecAPI> codec_api_;
  Microsoft::WRL::ComPtr<IMFMediaEventGenerator> event_gen_;
  bool is_async_ = false;
  bool is_hardware_ = false;
  bool output_provides_samples_ = false;
  int pending_need_input_ = 0;
  DWORD output_buffer_size_ = 0;
  std::string impl_name_ = "LinkShellMF";

  int width_ = 0;
  int height_ = 0;
  int fps_ = 60;
  int bitrate_bps_ = tuning::kStartBitrateBps;
  int64_t frame_index_ = 0;
  bool key_wanted_ = true;

  std::vector<uint8_t> cached_vps_;
  std::vector<uint8_t> cached_sps_;
  std::vector<uint8_t> cached_pps_;

  SendQueue send_queue_;
  int queue_skipped_ = 0;
  int queue_consecutive_skips_ = 0;
  double queue_longest_ = 0.0;
  double queue_since_ = 0.0;
  std::deque<FrameMeta> pending_meta_;
};

class ScreenVideoEncoderFactory : public webrtc::VideoEncoderFactory {
 public:
  ScreenVideoEncoderFactory(std::shared_ptr<D3DContext> d3d, MediaFoundationVideoEncoder::LogFn log = {});
  ~ScreenVideoEncoderFactory() override = default;

  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override;
  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment& env,
      const webrtc::SdpVideoFormat& format) override;

 private:
  std::shared_ptr<D3DContext> d3d_;
  MediaFoundationVideoEncoder::LogFn log_;
  bool hevc_available_ = false;
};

}  // namespace linkshell
