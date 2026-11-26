#include "mf_encoder.hpp"

#include <mferror.h>
#include <propvarutil.h>

#include <algorithm>
#include <cstring>

#include "api/video/encoded_image.h"
#include "api/video_codecs/h264_profile_level_id.h"
#include "common.hpp"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/include/video_error_codes.h"

namespace linkshell {

using Microsoft::WRL::ComPtr;

namespace {

bool IsStartCode3(const uint8_t* p, size_t rem) {
  return rem >= 3 && p[0] == 0 && p[1] == 0 && p[2] == 1;
}

bool IsStartCode4(const uint8_t* p, size_t rem) {
  return rem >= 4 && p[0] == 0 && p[1] == 0 && p[2] == 0 && p[3] == 1;
}

struct NalSpan {
  size_t start_with_code;
  size_t nal_offset;
  size_t end;
};

std::vector<NalSpan> SplitAnnexB(const uint8_t* data, size_t len) {
  std::vector<NalSpan> spans;
  size_t i = 0;
  while (i + 3 <= len) {
    size_t code_len = 0;
    if (IsStartCode4(data + i, len - i)) code_len = 4;
    else if (IsStartCode3(data + i, len - i)) code_len = 3;
    if (code_len > 0) {
      if (!spans.empty()) spans.back().end = i;
      spans.push_back({i, i + code_len, len});
      i += code_len;
    } else {
      ++i;
    }
  }
  return spans;
}

void AppendWithStartCode(std::vector<uint8_t>& dst, const std::vector<uint8_t>& nal) {
  if (nal.empty()) return;
  static constexpr uint8_t kSc[4] = {0, 0, 0, 1};
  dst.insert(dst.end(), kSc, kSc + 4);
  dst.insert(dst.end(), nal.begin(), nal.end());
}

void SetCodecU32(ICodecAPI* api, const GUID& key, UINT32 value) {
  if (!api) return;
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_UI4;
  v.ulVal = value;
  api->SetValue(&key, &v);
}

void SetCodecBool(ICodecAPI* api, const GUID& key, bool value) {
  if (!api) return;
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_BOOL;
  v.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  api->SetValue(&key, &v);
}

std::string FriendlyMftName(IMFActivate* act) {
  wchar_t* raw = nullptr;
  UINT32 len = 0;
  if (SUCCEEDED(act->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &raw, &len)) && raw) {
    std::string out = WideToUtf8(std::wstring(raw, len));
    CoTaskMemFree(raw);
    return out;
  }
  return "MFEncoder";
}

}  // namespace

std::vector<uint8_t> MediaFoundationVideoEncoder::BuildFusionSeiNal(const std::string& layout_json, bool hevc) {
  // Exact byte-for-byte parity with apps/mac/Sources/LinkShell/Fusion/FusionMetadata.swift.
  static constexpr char kUuid[16] = {'L','i','n','k','S','h','e','l','l','F','u','s','i','o','n','1'};
  std::vector<uint8_t> payload;
  payload.reserve(16 + layout_json.size());
  payload.insert(payload.end(), kUuid, kUuid + 16);
  payload.insert(payload.end(), layout_json.begin(), layout_json.end());

  std::vector<uint8_t> rbsp;
  rbsp.push_back(5);  // user_data_unregistered
  size_t size = payload.size();
  while (size >= 255) {
    rbsp.push_back(255);
    size -= 255;
  }
  rbsp.push_back(static_cast<uint8_t>(size));
  rbsp.insert(rbsp.end(), payload.begin(), payload.end());
  rbsp.push_back(0x80);

  std::vector<uint8_t> sei;
  if (hevc) {
    sei = {0, 0, 0, 1, static_cast<uint8_t>(39 << 1), 1};
  } else {
    sei = {0, 0, 0, 1, 6};
  }
  int zeros = 0;
  for (uint8_t b : rbsp) {
    if (zeros >= 2 && b <= 3) {
      sei.push_back(3);
      zeros = 0;
    }
    sei.push_back(b);
    zeros = (b == 0) ? (zeros + 1) : 0;
  }
  return sei;
}

bool MediaFoundationVideoEncoder::HasHardwareMft(bool hevc) {
  MFT_REGISTER_TYPE_INFO out_info{};
  out_info.guidMajorType = MFMediaType_Video;
  out_info.guidSubtype = hevc ? MFVideoFormat_HEVC : MFVideoFormat_H264;
  IMFActivate** activates = nullptr;
  UINT32 count = 0;
  HRESULT hr = MFTEnumEx(
      MFT_CATEGORY_VIDEO_ENCODER,
      MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
      nullptr,
      &out_info,
      &activates,
      &count);
  bool found = SUCCEEDED(hr) && count > 0;
  if (activates) {
    for (UINT32 i = 0; i < count; ++i) activates[i]->Release();
    CoTaskMemFree(activates);
  }
  return found;
}

MediaFoundationVideoEncoder::MediaFoundationVideoEncoder(
    std::shared_ptr<D3DContext> d3d,
    const webrtc::SdpVideoFormat& format,
    LogFn log)
    : d3d_(std::move(d3d)), format_(format), log_(std::move(log)) {
  std::string name = format.name;
  for (char& c : name) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  hevc_ = (name == "H265" || name == "HEVC");
  auto it = format.parameters.find("profile-level-id");
  if (it != format.parameters.end() && it->second.size() >= 2) {
    std::string p = it->second.substr(0, 2);
    if (p == "64") h264_profile_ = eAVEncH264VProfile_High;
    else if (p == "42") h264_profile_ = eAVEncH264VProfile_Base;
    else h264_profile_ = eAVEncH264VProfile_Main;
  }
  auto pm = format.parameters.find("packetization-mode");
  if (pm != format.parameters.end() && pm->second == "0") {
    packetization_ = webrtc::H264PacketizationMode::SingleNalUnit;
  }
}

MediaFoundationVideoEncoder::~MediaFoundationVideoEncoder() {
  Release();
}

int MediaFoundationVideoEncoder::InitEncode(
    const webrtc::VideoCodec* codec_settings,
    const VideoEncoder::Settings& settings) {
  (void)settings;
  if (!codec_settings || codec_settings->width <= 0 || codec_settings->height <= 0) {
    return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
  }

  std::lock_guard<std::mutex> lock(mu_);
  DestroyMft();

  width_ = (codec_settings->width / 2) * 2;
  height_ = (codec_settings->height / 2) * 2;
  fps_ = std::clamp(static_cast<int>(codec_settings->maxFramerate > 0 ? codec_settings->maxFramerate : 60), 1, 120);
  bitrate_bps_ = std::max(300'000, static_cast<int>(codec_settings->startBitrate) * 1000);
  frame_index_ = 0;
  key_wanted_ = true;
  cached_vps_.clear();
  cached_sps_.clear();
  cached_pps_.clear();
  send_queue_.Reset();
  send_queue_.SetEncoderRate(static_cast<double>(bitrate_bps_), NowSeconds());
  queue_skipped_ = 0;
  queue_longest_ = 0.0;
  queue_since_ = 0.0;

  bool ok = false;
  if (d3d_ && !d3d_->is_warp()) {
    ok = CreateMft(width_, height_, fps_, bitrate_bps_, /*try_hardware=*/true);
  }
  if (!ok && !hevc_) {
    ok = CreateMft(width_, height_, fps_, bitrate_bps_, /*try_hardware=*/false);
  }
  if (!ok) {
    if (log_) log_(std::string("MF encoder init failed for ") + (hevc_ ? "HEVC" : "H264") + " " +
                   std::to_string(width_) + "x" + std::to_string(height_));
    return WEBRTC_VIDEO_CODEC_ERROR;
  }
  if (log_) {
    log_("MF encoder ready: " + impl_name_ + " (" + (hevc_ ? "HEVC" : "H264") + ", " +
         (is_hardware_ ? "GPU zero-copy" : "software") + ", " +
         std::to_string(width_) + "x" + std::to_string(height_) + "@" + std::to_string(fps_) +
         ", start=" + std::to_string(bitrate_bps_ / 1000) + " kbps)");
  }
  return WEBRTC_VIDEO_CODEC_OK;
}

bool MediaFoundationVideoEncoder::CreateMft(int width, int height, int fps, int bitrate_bps, bool try_hardware) {
  MFT_REGISTER_TYPE_INFO out_info{};
  out_info.guidMajorType = MFMediaType_Video;
  out_info.guidSubtype = hevc_ ? MFVideoFormat_HEVC : MFVideoFormat_H264;

  UINT32 flags = try_hardware
                     ? (MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER)
                     : (MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER);

  IMFActivate** activates = nullptr;
  UINT32 count = 0;
  HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, nullptr, &out_info, &activates, &count);
  if (FAILED(hr) || count == 0 || !activates) return false;

  bool success = false;
  for (UINT32 i = 0; i < count && !success; ++i) {
    ComPtr<IMFTransform> mft;
    if (FAILED(activates[i]->ActivateObject(IID_PPV_ARGS(&mft))) || !mft) continue;

    std::string friendly = FriendlyMftName(activates[i]);
    mft_ = mft;
    is_hardware_ = try_hardware;
    impl_name_ = std::string(try_hardware ? "LinkShellMF-HW:" : "LinkShellMF-SW:") + friendly;

    if (ConfigureMft(width, height, fps, bitrate_bps)) {
      success = true;
    } else {
      DestroyMft();
      activates[i]->ShutdownObject();
    }
  }

  for (UINT32 i = 0; i < count; ++i) activates[i]->Release();
  CoTaskMemFree(activates);
  return success;
}

bool MediaFoundationVideoEncoder::ConfigureMft(int width, int height, int fps, int bitrate_bps) {
  ComPtr<IMFAttributes> attrs;
  if (SUCCEEDED(mft_->GetAttributes(&attrs)) && attrs) {
    UINT32 async_flag = 0;
    is_async_ = SUCCEEDED(attrs->GetUINT32(MF_TRANSFORM_ASYNC, &async_flag)) && async_flag != 0;
    if (is_async_) {
      if (FAILED(attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE))) return false;
      if (FAILED(mft_.As(&event_gen_)) || !event_gen_) return false;
    }
    if (is_hardware_ && d3d_ && d3d_->dxgi_manager()) {
      UINT32 d3d11_aware = 0;
      if (SUCCEEDED(attrs->GetUINT32(MF_SA_D3D11_AWARE, &d3d11_aware)) && d3d11_aware != 0) {
        HRESULT hr = mft_->ProcessMessage(
            MFT_MESSAGE_SET_D3D_MANAGER,
            reinterpret_cast<ULONG_PTR>(d3d_->dxgi_manager()));
        if (FAILED(hr)) return false;
      } else {
        // Hardware MFT without D3D11 support: skip in hardware mode to avoid hidden CPU copies.
        return false;
      }
    }
  }

  mft_.As(&codec_api_);
  if (codec_api_) {
    SetCodecBool(codec_api_.Get(), CODECAPI_AVLowLatencyMode, true);
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncCommonMeanBitRate, static_cast<UINT32>(bitrate_bps));
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncCommonBufferSize, static_cast<UINT32>(std::max(65536, bitrate_bps / 4)));
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncMPVGOPSize, static_cast<UINT32>(fps * 10));
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncCommonQualityVsSpeed, 33);
    if (!hevc_) {
      SetCodecBool(codec_api_.Get(), CODECAPI_AVEncH264CABACEnable, h264_profile_ != eAVEncH264VProfile_Base);
    }
  }

  // Output type MUST be set before input type on MF video encoders.
  ComPtr<IMFMediaType> out_type;
  if (FAILED(MFCreateMediaType(&out_type))) return false;
  out_type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  out_type->SetGUID(MF_MT_SUBTYPE, hevc_ ? MFVideoFormat_HEVC : MFVideoFormat_H264);
  out_type->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrate_bps));
  out_type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  MFSetAttributeSize(out_type.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(width), static_cast<UINT32>(height));
  MFSetAttributeRatio(out_type.Get(), MF_MT_FRAME_RATE, static_cast<UINT32>(fps), 1);
  MFSetAttributeRatio(out_type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (hevc_) {
    out_type->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH265VProfile_Main_420_8);
  } else {
    out_type->SetUINT32(MF_MT_MPEG2_PROFILE, h264_profile_);
  }

  HRESULT hr = mft_->SetOutputType(0, out_type.Get(), 0);
  if (FAILED(hr) && !hevc_) {
    // Retry without explicit profile if vendor driver prefers default Main profile.
    out_type->DeleteItem(MF_MT_MPEG2_PROFILE);
    hr = mft_->SetOutputType(0, out_type.Get(), 0);
  }
  if (FAILED(hr)) return false;

  // Input type: NV12 with BT.709 color tags.
  ComPtr<IMFMediaType> in_type;
  if (FAILED(MFCreateMediaType(&in_type))) return false;
  in_type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  in_type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  in_type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  in_type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
  in_type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
  in_type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  in_type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  MFSetAttributeSize(in_type.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(width), static_cast<UINT32>(height));
  MFSetAttributeRatio(in_type.Get(), MF_MT_FRAME_RATE, static_cast<UINT32>(fps), 1);
  MFSetAttributeRatio(in_type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);

  hr = mft_->SetInputType(0, in_type.Get(), 0);
  if (FAILED(hr)) return false;

  MFT_OUTPUT_STREAM_INFO out_stream_info{};
  if (SUCCEEDED(mft_->GetOutputStreamInfo(0, &out_stream_info))) {
    output_provides_samples_ =
        (out_stream_info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
    output_buffer_size_ = std::max<DWORD>(out_stream_info.cbSize, 1024 * 1024);
  }

  // Re-apply low-latency & bitrate after media types are locked (required by Intel QSV & AMD AMF).
  if (codec_api_) {
    SetCodecBool(codec_api_.Get(), CODECAPI_AVLowLatencyMode, true);
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncCommonMeanBitRate, static_cast<UINT32>(bitrate_bps));
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
  }

  mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
  mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
  return true;
}

int32_t MediaFoundationVideoEncoder::RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* callback) {
  std::lock_guard<std::mutex> lock(mu_);
  callback_ = callback;
  return WEBRTC_VIDEO_CODEC_OK;
}

int32_t MediaFoundationVideoEncoder::Release() {
  std::lock_guard<std::mutex> lock(mu_);
  DestroyMft();
  return WEBRTC_VIDEO_CODEC_OK;
}

void MediaFoundationVideoEncoder::DestroyMft() {
  if (mft_) {
    mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    mft_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
  }
  event_gen_.Reset();
  codec_api_.Reset();
  mft_.Reset();
  is_async_ = false;
  is_hardware_ = false;
  pending_need_input_ = 0;
}

void MediaFoundationVideoEncoder::SetRates(const RateControlParameters& parameters) {
  std::lock_guard<std::mutex> lock(mu_);
  uint32_t total_bps = parameters.bitrate.get_sum_bps();
  if (total_bps == 0) return;
  int next_bps = std::clamp(static_cast<int>(total_bps), 200'000, 35'000'000);
  int next_fps = std::clamp(static_cast<int>(parameters.framerate_fps > 0 ? parameters.framerate_fps : fps_), 1, 120);
  bitrate_bps_ = next_bps;
  fps_ = next_fps;
  send_queue_.SetEncoderRate(static_cast<double>(next_bps), NowSeconds());

  // Live in-place rate change: ZERO encoder restart, ZERO freeze!
  if (codec_api_) {
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncCommonMeanBitRate, static_cast<UINT32>(next_bps));
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncCommonBufferSize, static_cast<UINT32>(std::max(65536, next_bps / 4)));
  }
}

int32_t MediaFoundationVideoEncoder::Encode(
    const webrtc::VideoFrame& frame,
    const std::vector<webrtc::VideoFrameType>* frame_types) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!mft_ || !callback_) return WEBRTC_VIDEO_CODEC_UNINITIALIZED;

  bool requested_key = key_wanted_;
  if (frame_types) {
    for (auto t : *frame_types) {
      if (t == webrtc::VideoFrameType::kVideoFrameKey) requested_key = true;
    }
  }

  // Mac-parity SendQueue admission: skip encoding while earlier frames wait > 50 ms in libwebrtc pacer.
  double now_sec = NowSeconds();
  double wait_sec = send_queue_.WaitSeconds(now_sec);
  if (wait_sec * 1000.0 > tuning::kSendQueueAdmitMs) {
    if (requested_key) key_wanted_ = true;
    if (queue_skipped_ == 0) queue_since_ = now_sec;
    queue_skipped_ += 1;
    queue_longest_ = std::max(queue_longest_, wait_sec);
    if (now_sec - queue_since_ >= 5.0) {
      if (log_) {
        char buf[160];
        std::snprintf(buf, sizeof(buf),
                      "%d pictures were not encoded while earlier ones waited to be sent (up to %.0f ms)",
                      queue_skipped_, queue_longest_ * 1000.0);
        log_(buf);
      }
      queue_skipped_ = 0;
      queue_longest_ = 0.0;
    }
    return WEBRTC_VIDEO_CODEC_OK;
  }

  // Handle dynamic resolution change cleanly (e.g. libwebrtc VideoStreamAdapter scale-down).
  if (frame.width() != width_ || frame.height() != height_) {
    int new_w = (frame.width() / 2) * 2;
    int new_h = (frame.height() / 2) * 2;
    if (new_w > 0 && new_h > 0) {
      DestroyMft();
      width_ = new_w;
      height_ = new_h;
      bool ok = (d3d_ && !d3d_->is_warp()) ? CreateMft(width_, height_, fps_, bitrate_bps_, true) : false;
      if (!ok && !hevc_) ok = CreateMft(width_, height_, fps_, bitrate_bps_, false);
      if (!ok) return WEBRTC_VIDEO_CODEC_ERROR;
      requested_key = true;
    }
  }

  // Build input IMFSample (GPU zero-copy DXGI surface buffer when hardware MFT + D3D11TextureBuffer).
  ComPtr<IMFSample> in_sample;
  if (FAILED(MFCreateSample(&in_sample))) return WEBRTC_VIDEO_CODEC_ERROR;

  std::string fusion_layout;
  auto fb = frame.video_frame_buffer();
  if (fb->type() == webrtc::VideoFrameBuffer::Type::kNative) {
    auto* d3d_buf = static_cast<D3D11TextureBuffer*>(fb.get());
    fusion_layout = d3d_buf->fusion_layout();
    if (is_hardware_ && d3d_buf->texture()) {
      ComPtr<IMFMediaBuffer> dxgi_buf;
      if (FAILED(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), d3d_buf->texture(), 0, FALSE, &dxgi_buf))) {
        return WEBRTC_VIDEO_CODEC_ERROR;
      }
      ComPtr<IMF2DBuffer> buf2d;
      if (SUCCEEDED(dxgi_buf.As(&buf2d)) && buf2d) {
        DWORD len = 0;
        if (SUCCEEDED(buf2d->GetContiguousLength(&len))) dxgi_buf->SetCurrentLength(len);
      }
      in_sample->AddBuffer(dxgi_buf.Get());
    }
  }

  // Software MFT or non-native frame: provide contiguous NV12 memory buffer.
  DWORD buf_count = 0;
  in_sample->GetBufferCount(&buf_count);
  if (buf_count == 0) {
    auto i420 = fb->ToI420();
    if (!i420) return WEBRTC_VIDEO_CODEC_ERROR;
    size_t y_bytes = static_cast<size_t>(width_) * static_cast<size_t>(height_);
    size_t uv_bytes = y_bytes / 2;
    ComPtr<IMFMediaBuffer> mem_buf;
    if (FAILED(MFCreateMemoryBuffer(static_cast<DWORD>(y_bytes + uv_bytes), &mem_buf))) return WEBRTC_VIDEO_CODEC_ERROR;
    BYTE* dst = nullptr;
    if (FAILED(mem_buf->Lock(&dst, nullptr, nullptr))) return WEBRTC_VIDEO_CODEC_ERROR;
    // Copy Y plane
    for (int row = 0; row < height_; ++row) {
      std::memcpy(dst + static_cast<size_t>(row) * width_, i420->DataY() + row * i420->StrideY(), width_);
    }
    // Interleave U/V into NV12 UV plane
    uint8_t* uv_dst = dst + y_bytes;
    int half_w = width_ / 2;
    int half_h = height_ / 2;
    for (int row = 0; row < half_h; ++row) {
      const uint8_t* u_row = i420->DataU() + row * i420->StrideU();
      const uint8_t* v_row = i420->DataV() + row * i420->StrideV();
      uint8_t* out_row = uv_dst + static_cast<size_t>(row) * width_;
      for (int col = 0; col < half_w; ++col) {
        out_row[col * 2] = u_row[col];
        out_row[col * 2 + 1] = v_row[col];
      }
    }
    mem_buf->Unlock();
    mem_buf->SetCurrentLength(static_cast<DWORD>(y_bytes + uv_bytes));
    in_sample->AddBuffer(mem_buf.Get());
  }

  int64_t duration_100ns = 10'000'000 / std::max(1, fps_);
  int64_t pts_100ns = frame_index_ * duration_100ns;
  frame_index_ += 1;
  in_sample->SetSampleTime(pts_100ns);
  in_sample->SetSampleDuration(duration_100ns);

  if (requested_key && codec_api_) {
    SetCodecU32(codec_api_.Get(), CODECAPI_AVEncVideoForceKeyFrame, 1);
  }
  key_wanted_ = false;

  int64_t encode_start_ms = NowMillis();

  if (is_async_) {
    // Wait for METransformNeedInput (preserving any extra NeedInput tokens received during output drain).
    for (int tries = 0; tries < 64 && pending_need_input_ <= 0; ++tries) {
      ComPtr<IMFMediaEvent> ev;
      HRESULT hr = event_gen_->GetEvent(0, &ev);
      if (FAILED(hr) || !ev) return WEBRTC_VIDEO_CODEC_ERROR;
      MediaEventType type = MEUnknown;
      ev->GetType(&type);
      if (type == METransformNeedInput) {
        pending_need_input_ += 1;
      } else if (type == METransformHaveOutput) {
        DrainAsyncOutput(frame, fusion_layout, requested_key, encode_start_ms);
      } else if (type == MEError) {
        return WEBRTC_VIDEO_CODEC_ERROR;
      }
    }
    if (pending_need_input_ <= 0) return WEBRTC_VIDEO_CODEC_ERROR;
    pending_need_input_ -= 1;
    if (FAILED(mft_->ProcessInput(0, in_sample.Get(), 0))) return WEBRTC_VIDEO_CODEC_ERROR;

    // Wait for METransformHaveOutput (low-latency 1-in-1-out; remember extra METransformNeedInput tokens!).
    for (int tries = 0; tries < 32; ++tries) {
      ComPtr<IMFMediaEvent> ev;
      HRESULT hr = event_gen_->GetEvent(0, &ev);
      if (FAILED(hr) || !ev) break;
      MediaEventType type = MEUnknown;
      ev->GetType(&type);
      if (type == METransformHaveOutput) {
        DrainAsyncOutput(frame, fusion_layout, requested_key, encode_start_ms);
        break;
      } else if (type == METransformNeedInput) {
        pending_need_input_ += 1;
        // 1-frame pipeline prime on very first frame: return OK and keep the credit for the next Encode().
        break;
      } else if (type == MEError) {
        return WEBRTC_VIDEO_CODEC_ERROR;
      }
    }
    return WEBRTC_VIDEO_CODEC_OK;
  }

  // Synchronous MFT path (Microsoft SW H.264 encoder).
  HRESULT hr = mft_->ProcessInput(0, in_sample.Get(), 0);
  if (FAILED(hr) && hr != MF_E_NOTACCEPTING) return WEBRTC_VIDEO_CODEC_ERROR;

  for (;;) {
    MFT_OUTPUT_DATA_BUFFER out_buf{};
    ComPtr<IMFSample> alloc_sample;
    if (!output_provides_samples_) {
      MFCreateSample(&alloc_sample);
      ComPtr<IMFMediaBuffer> mb;
      MFCreateMemoryBuffer(output_buffer_size_, &mb);
      alloc_sample->AddBuffer(mb.Get());
      out_buf.pSample = alloc_sample.Get();
    }
    DWORD status = 0;
    HRESULT ohr = mft_->ProcessOutput(0, 1, &out_buf, &status);
    if (out_buf.pEvents) out_buf.pEvents->Release();
    if (ohr == MF_E_TRANSFORM_NEED_MORE_INPUT) break;
    if (ohr == MF_E_TRANSFORM_STREAM_CHANGE) {
      ComPtr<IMFMediaType> new_type;
      if (SUCCEEDED(mft_->GetOutputAvailableType(0, 0, &new_type))) {
        mft_->SetOutputType(0, new_type.Get(), 0);
      }
      continue;
    }
    if (FAILED(ohr)) break;
    if (out_buf.pSample) {
      EmitSample(out_buf.pSample, frame, fusion_layout, requested_key, encode_start_ms);
      if (output_provides_samples_) out_buf.pSample->Release();
    }
  }
  return WEBRTC_VIDEO_CODEC_OK;
}

bool MediaFoundationVideoEncoder::DrainAsyncOutput(
    const webrtc::VideoFrame& frame,
    const std::string& fusion_layout,
    bool requested_key,
    int64_t encode_start_ms) {
  MFT_OUTPUT_DATA_BUFFER out_buf{};
  ComPtr<IMFSample> alloc_sample;
  if (!output_provides_samples_) {
    MFCreateSample(&alloc_sample);
    ComPtr<IMFMediaBuffer> mb;
    MFCreateMemoryBuffer(output_buffer_size_, &mb);
    alloc_sample->AddBuffer(mb.Get());
    out_buf.pSample = alloc_sample.Get();
  }
  DWORD status = 0;
  HRESULT hr = mft_->ProcessOutput(0, 1, &out_buf, &status);
  if (out_buf.pEvents) out_buf.pEvents->Release();
  if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
    ComPtr<IMFMediaType> new_type;
    if (SUCCEEDED(mft_->GetOutputAvailableType(0, 0, &new_type))) {
      mft_->SetOutputType(0, new_type.Get(), 0);
    }
    return false;
  }
  if (FAILED(hr) || !out_buf.pSample) return false;
  bool emitted = EmitSample(out_buf.pSample, frame, fusion_layout, requested_key, encode_start_ms);
  if (output_provides_samples_) out_buf.pSample->Release();
  return emitted;
}

void MediaFoundationVideoEncoder::CacheParameterSets(
    const uint8_t* data,
    size_t len,
    bool* out_is_key,
    bool* out_has_ps) {
  bool is_key = false;
  bool has_sps = false;
  bool has_pps = false;
  bool has_vps = !hevc_;

  for (const auto& s : SplitAnnexB(data, len)) {
    if (s.nal_offset >= s.end) continue;
    size_t nlen = s.end - s.nal_offset;
    const uint8_t* nptr = data + s.nal_offset;
    if (hevc_) {
      uint8_t ntype = (nptr[0] >> 1) & 0x3F;
      if (ntype == 32) { cached_vps_.assign(nptr, nptr + nlen); has_vps = true; }
      else if (ntype == 33) { cached_sps_.assign(nptr, nptr + nlen); has_sps = true; }
      else if (ntype == 34) { cached_pps_.assign(nptr, nptr + nlen); has_pps = true; }
      else if (ntype >= 16 && ntype <= 21) { is_key = true; }
    } else {
      uint8_t ntype = nptr[0] & 0x1F;
      if (ntype == 7) { cached_sps_.assign(nptr, nptr + nlen); has_sps = true; }
      else if (ntype == 8) { cached_pps_.assign(nptr, nptr + nlen); has_pps = true; }
      else if (ntype == 5) { is_key = true; }
    }
  }

  *out_is_key = is_key;
  *out_has_ps = has_vps && has_sps && has_pps;
}

bool MediaFoundationVideoEncoder::EmitSample(
    IMFSample* sample,
    const webrtc::VideoFrame& frame,
    const std::string& fusion_layout,
    bool requested_key,
    int64_t encode_start_ms) {
  ComPtr<IMFMediaBuffer> buf;
  if (FAILED(sample->ConvertToContiguousBuffer(&buf)) || !buf) return false;
  BYTE* ptr = nullptr;
  DWORD len = 0;
  if (FAILED(buf->Lock(&ptr, nullptr, &len)) || !ptr || len == 0) return false;

  UINT32 clean_point = 0;
  sample->GetUINT32(MFSampleExtension_CleanPoint, &clean_point);

  bool is_key = false;
  bool has_ps = false;
  CacheParameterSets(ptr, len, &is_key, &has_ps);
  if (clean_point != 0) is_key = true;

  std::vector<uint8_t> out;
  out.reserve(len + 256);

  // Prefix Fusion layout SEI ahead of the access unit when present.
  if (!fusion_layout.empty()) {
    auto sei = BuildFusionSeiNal(fusion_layout, hevc_);
    out.insert(out.end(), sei.begin(), sei.end());
  }

  // Guarantee parameter sets precede every IDR so decoders never stall after packet loss.
  if (is_key && !has_ps) {
    if (hevc_) AppendWithStartCode(out, cached_vps_);
    AppendWithStartCode(out, cached_sps_);
    AppendWithStartCode(out, cached_pps_);
  }

  out.insert(out.end(), ptr, ptr + len);
  buf->Unlock();

  int64_t encode_finish_ms = NowMillis();
  send_queue_.Made(out.size(), NowSeconds());

  if (is_key && requested_key && log_) {
    log_("key frame: " + std::to_string(out.size() / 1024) + " KB (" +
         std::to_string(encode_finish_ms - encode_start_ms) + " ms, " +
         (hevc_ ? "HEVC" : "H264") + ")");
  }

  webrtc::EncodedImage image;
  image.SetEncodedData(webrtc::EncodedImageBuffer::Create(out.data(), out.size()));
  image._encodedWidth = static_cast<uint32_t>(width_);
  image._encodedHeight = static_cast<uint32_t>(height_);
  image.SetRtpTimestamp(frame.rtp_timestamp());
  image.capture_time_ms_ = frame.render_time_ms();
  image.ntp_time_ms_ = frame.ntp_time_ms();
  image.rotation_ = frame.rotation();
  image._frameType = is_key ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta;
  image.content_type_ = webrtc::VideoContentType::SCREENSHARE;
  image.SetEncodeTime(encode_start_ms, encode_finish_ms);

  webrtc::CodecSpecificInfo info{};
  if (hevc_) {
    info.codecType = webrtc::kVideoCodecH265;
  } else {
    info.codecType = webrtc::kVideoCodecH264;
    info.codecSpecific.H264.packetization_mode = packetization_;
    info.codecSpecific.H264.temporal_idx = 0xFF;  // kNoTemporalIdx
    info.codecSpecific.H264.idr_frame = is_key;
    info.codecSpecific.H264.base_layer_sync = false;
  }

  callback_->OnEncodedImage(image, &info);
  return true;
}

webrtc::VideoEncoder::EncoderInfo MediaFoundationVideoEncoder::GetEncoderInfo() const {
  EncoderInfo info;
  info.implementation_name = impl_name_;
  info.is_hardware_accelerated = is_hardware_;
  // Disable QP-based automatic shrinking (same as Mac ScreenEncoderFactory):
  // text stays full resolution and FrameRateController lowers fps if needed.
  info.scaling_settings = ScalingSettings::kOff;
  info.supports_native_handle = true;
  info.supports_simulcast = false;
  return info;
}

// ── ScreenVideoEncoderFactory ───────────────────────────────────────────────

ScreenVideoEncoderFactory::ScreenVideoEncoderFactory(
    std::shared_ptr<D3DContext> d3d,
    MediaFoundationVideoEncoder::LogFn log)
    : d3d_(std::move(d3d)),
      log_(std::move(log)),
      hevc_available_(d3d_ && !d3d_->is_warp() && MediaFoundationVideoEncoder::HasHardwareMft(/*hevc=*/true)) {}

std::vector<webrtc::SdpVideoFormat> ScreenVideoEncoderFactory::GetSupportedFormats() const {
  std::vector<webrtc::SdpVideoFormat> formats;

  // Offer H.264 Constrained High, Main, and Constrained Baseline (Level 5.2 for 4K60 / 2K120).
  formats.emplace_back("H264", webrtc::CodecParameterMap{
                                   {"level-asymmetry-allowed", "1"},
                                   {"packetization-mode", "1"},
                                   {"profile-level-id", "640c34"}});
  formats.emplace_back("H264", webrtc::CodecParameterMap{
                                   {"level-asymmetry-allowed", "1"},
                                   {"packetization-mode", "1"},
                                   {"profile-level-id", "4d0034"}});
  formats.emplace_back("H264", webrtc::CodecParameterMap{
                                   {"level-asymmetry-allowed", "1"},
                                   {"packetization-mode", "1"},
                                   {"profile-level-id", "42e034"}});

  // Offer H.265 (HEVC) when a Windows hardware HEVC MFT is present (NVENC / AMF / QSV / Qualcomm).
  if (hevc_available_) {
    formats.emplace_back("H265", webrtc::CodecParameterMap{
                                     {"profile-id", "1"},
                                     {"tier-flag", "0"},
                                     {"level-id", "153"},
                                     {"tx-mode", "SRST"}});
  }
  return formats;
}

std::unique_ptr<webrtc::VideoEncoder> ScreenVideoEncoderFactory::Create(
    const webrtc::Environment&,
    const webrtc::SdpVideoFormat& format) {
  if (format.name == "H264" || format.name == "H265" || format.name == "HEVC") {
    return std::make_unique<MediaFoundationVideoEncoder>(d3d_, format, log_);
  }
  return nullptr;
}

}  // namespace linkshell
