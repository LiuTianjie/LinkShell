#include <winsock2.h>
#include <mfapi.h>
#include <objbase.h>
#include <roapi.h>
#include <shellscalingapi.h>
#include <windows.h>

#include <iostream>
#include <map>
#include <memory>
#include <string>

#include "api/audio/create_audio_device_module.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_peerconnection_factory.h"
#include "api/environment/environment_factory.h"
#include "api/field_trials_view.h"
#include "api/video/video_frame.h"
#include "api/video_codecs/video_decoder_factory.h"
#include "common.hpp"
#include "d3d_context.hpp"
#include "display_info.hpp"
#include "dxgi_capturer.hpp"
#include "fusion_session.hpp"
#include "mf_encoder.hpp"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "screen_session.hpp"
#include "vdd_control.hpp"
#include "wgc_capturer.hpp"

namespace {

using namespace linkshell;

json DisplaysJson() {
  json list = json::array();
  for (const auto& d : EnumerateDisplays()) {
    list.push_back({
        {"screen", d.screen},
        {"name", d.name},
        {"w", d.width},
        {"h", d.height},
        {"hz", d.refresh_hz},
        {"main", d.main},
        {"activeMonitor", d.has_active_monitor},
        {"virtual", d.is_virtual},
    });
  }
  return list;
}

json VddStatusJson() {
  auto st = VddController::QueryStatus();
  return {
      {"installed", st.installed},
      {"enabled", st.enabled},
      {"active", st.active},
      {"deviceId", st.device_id},
      {"virtualMonitors", st.virtual_monitors},
  };
}

class LinkShellFieldTrials : public webrtc::FieldTrialsView {
 public:
  std::string Lookup(absl::string_view key) const override {
    if (key == "WebRTC-ForceSendPlayoutDelay") return "min_ms:0,max_ms:0";
    if (key == "WebRTC-FlexFEC-03-Advertised") return "Disabled";
    if (key == "WebRTC-FlexFEC-03") return "Disabled";
    return "";
  }
  std::unique_ptr<webrtc::FieldTrialsView> CreateCopy() const override {
    return std::make_unique<LinkShellFieldTrials>();
  }
};

class NullVideoDecoderFactory : public webrtc::VideoDecoderFactory {
 public:
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override { return {}; }
  std::unique_ptr<webrtc::VideoDecoder> Create(
      const webrtc::Environment&,
      const webrtc::SdpVideoFormat&) override {
    return nullptr;
  }
};

struct WebRtcRuntime {
  std::unique_ptr<webrtc::Thread> network;
  std::unique_ptr<webrtc::Thread> worker;
  std::unique_ptr<webrtc::Thread> signaling;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;

  bool Init(std::shared_ptr<D3DContext> d3d, IpcChannel* ipc) {
    webrtc::InitializeSSL();
    network = webrtc::Thread::CreateWithSocketServer();
    worker = webrtc::Thread::Create();
    signaling = webrtc::Thread::Create();
    if (!network->Start() || !worker->Start() || !signaling->Start()) return false;

    // Exact Mac-parity low-latency field trials: zero jitter buffer playout delay + FlexFEC.
    auto trials = std::make_unique<LinkShellFieldTrials>();

    auto adm = webrtc::CreateAudioDeviceModule(
        webrtc::CreateEnvironment(),
        webrtc::AudioDeviceModule::kDummyAudio);

    factory = webrtc::CreatePeerConnectionFactory(
        network.get(),
        worker.get(),
        signaling.get(),
        adm,
        webrtc::CreateBuiltinAudioEncoderFactory(),
        webrtc::CreateBuiltinAudioDecoderFactory(),
        std::make_unique<ScreenVideoEncoderFactory>(
            std::move(d3d),
            [ipc](const std::string& m) { if (ipc) ipc->Log(m); }),
        std::make_unique<NullVideoDecoderFactory>(),
        nullptr,
        nullptr,
        nullptr,
        std::move(trials));
    return factory != nullptr;
  }

  void Shutdown() {
    factory = nullptr;
    if (signaling) signaling->Stop();
    if (worker) worker->Stop();
    if (network) network->Stop();
    webrtc::CleanupSSL();
  }
};

}  // namespace

int main(int argc, char** argv) {
  // Per-monitor V2 DPI awareness ensures physical pixel coordinates for capture & input on 4K/HiDPI screens.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  SetConsoleOutputCP(CP_UTF8);

  // libwebrtc's PhysicalSocketServer requires WinSock 2.2 initialized before creating its network thread;
  // without WSAStartup, UDP socket creation fails with WSANOTINITIALISED and no UDP ICE candidates are gathered.
  WSADATA wsa_data{};
  const bool wsa_ok = (WSAStartup(MAKEWORD(2, 2), &wsa_data) == 0);
  struct WsaGuard {
    bool active;
    ~WsaGuard() { if (active) WSACleanup(); }
  } wsa_guard{wsa_ok};

  RoInitialize(RO_INIT_MULTITHREADED);
  MFStartup(MF_VERSION);

  std::string mode = "--engine";
  if (argc >= 2 && argv[1]) mode = argv[1];

  if (mode == "--displays") {
    std::cout << DisplaysJson().dump() << "\n" << std::flush;
    MFShutdown();
    RoUninitialize();
    return 0;
  }

  if (mode == "--vdd-status") {
    std::cout << VddStatusJson().dump() << "\n" << std::flush;
    MFShutdown();
    RoUninitialize();
    return 0;
  }

  if (mode == "--selftest") {
    std::string d3d_err;
    auto d3d = D3DContext::Create(-1, &d3d_err);
    bool wgc_ok = WgcCapturer::IsSupported();
    bool hw_h264 = MediaFoundationVideoEncoder::HasHardwareMft(false);
    bool hw_hevc = MediaFoundationVideoEncoder::HasHardwareMft(true);

    bool nv12_ok = false;
    bool nv12_gpu = false;
    std::string nv12_err;
    bool dxgi_ok = false;
    std::string dxgi_err;
    json h264_enc = {{"ok", false}, {"bytes", 0}, {"impl", ""}, {"hw", false}};
    json hevc_enc = {{"ok", false}, {"bytes", 0}, {"impl", ""}, {"hw", false}};

    if (d3d) {
      auto disp0 = FindDisplay(0);
      if (disp0 && disp0->has_active_monitor) {
        DxgiDuplicationCapturer probe_dxgi(d3d);
        dxgi_ok = probe_dxgi.Open(*disp0, &dxgi_err);
        probe_dxgi.Close();
      } else {
        dxgi_err = "no active monitor";
      }
      constexpr int kW = 640, kH = 360;
      std::vector<uint8_t> bgra(static_cast<size_t>(kW) * kH * 4);
      for (int y = 0; y < kH; ++y) {
        for (int x = 0; x < kW; ++x) {
          size_t idx = (static_cast<size_t>(y) * kW + x) * 4;
          bgra[idx + 0] = static_cast<uint8_t>((x * 255) / kW);
          bgra[idx + 1] = static_cast<uint8_t>((y * 255) / kH);
          bgra[idx + 2] = static_cast<uint8_t>(((x + y) * 127) / (kW + kH));
          bgra[idx + 3] = 255;
        }
      }
      auto frame_buf = d3d->UploadBgraToFrame(bgra.data(), kW, kH, kW * 4, kW, kH);
      nv12_err = d3d->last_error();
      if (frame_buf) {
        nv12_ok = true;
        nv12_gpu = (frame_buf->type() == webrtc::VideoFrameBuffer::Type::kNative) &&
                   static_cast<D3D11TextureBuffer*>(frame_buf.get())->is_gpu();

        auto test_codec = [&](const webrtc::SdpVideoFormat& fmt, webrtc::VideoCodecType ctype) -> json {
          struct Sink : public webrtc::EncodedImageCallback {
            size_t total_bytes = 0;
            int frames = 0;
            Result OnEncodedImage(const webrtc::EncodedImage& img, const webrtc::CodecSpecificInfo*) override {
              total_bytes += img.size();
              frames += 1;
              return Result(Result::OK);
            }
            void OnFrameDropped(uint32_t, int, bool) override {}
          } sink;
          std::vector<std::string> enc_logs;
          MediaFoundationVideoEncoder enc(d3d, fmt, [&](const std::string& m) { enc_logs.push_back(m); });
          webrtc::VideoCodec vc{};
          vc.codecType = ctype;
          vc.width = kW;
          vc.height = kH;
          vc.maxFramerate = 60;
          vc.startBitrate = 6000;
          vc.maxBitrate = 12000;
          vc.minBitrate = 500;
          webrtc::VideoEncoder::Settings st(webrtc::VideoEncoder::Capabilities(false), 2, 1200);
          int rc = enc.InitEncode(&vc, st);
          if (rc == 0) {
            enc.RegisterEncodeCompleteCallback(&sink);
            std::vector<webrtc::VideoFrameType> key_types = {webrtc::VideoFrameType::kVideoFrameKey};
            for (int i = 0; i < 4; ++i) {
              webrtc::VideoFrame vf = webrtc::VideoFrame::Builder()
                                          .set_video_frame_buffer(frame_buf)
                                          .set_timestamp_us(1000000 + i * 16667)
                                          .build();
              enc.Encode(vf, i == 0 ? &key_types : nullptr);
            }
          }
          auto info = enc.GetEncoderInfo();
          enc.Release();
          return {
              {"ok", rc == 0 && sink.total_bytes > 0},
              {"initRc", rc},
              {"frames", sink.frames},
              {"bytes", sink.total_bytes},
              {"impl", info.implementation_name},
              {"hw", info.is_hardware_accelerated},
              {"logs", enc_logs},
          };
        };

        h264_enc = test_codec(
            webrtc::SdpVideoFormat("H264", {{"profile-level-id", "640c34"}, {"packetization-mode", "1"}}),
            webrtc::kVideoCodecH264);
        if (hw_hevc && !d3d->is_warp()) {
          hevc_enc = test_codec(webrtc::SdpVideoFormat("H265", {{"profile-id", "1"}}), webrtc::kVideoCodecH265);
        }
      }
    }

    WebRtcRuntime rtc;
    bool rtc_ok = d3d && rtc.Init(d3d, nullptr);
    bool all_ok = d3d != nullptr && rtc_ok && nv12_ok && h264_enc.value("ok", false);
    json out = {
        {"ok", all_ok},
        {"adapter", d3d ? d3d->adapter_name() : ""},
        {"vendorId", d3d ? d3d->vendor_id() : 0},
        {"warp", d3d ? d3d->is_warp() : true},
        {"d3dError", d3d_err},
        {"nv12Ok", nv12_ok},
        {"nv12Gpu", nv12_gpu},
        {"nv12Error", nv12_err},
        {"dxgiOk", dxgi_ok},
        {"dxgiError", dxgi_err},
        {"h264Encode", h264_enc},
        {"hevcEncode", hevc_enc},
        {"wgcSupported", wgc_ok},
        {"hwH264", hw_h264},
        {"hwHevc", hw_hevc},
        {"webrtcReady", rtc_ok},
        {"displays", DisplaysJson()},
        {"vdd", VddStatusJson()},
    };
    std::cout << out.dump() << "\n" << std::flush;
    rtc.Shutdown();
    MFShutdown();
    RoUninitialize();
    return all_ok ? 0 : 1;
  }

  // Persistent JSON-lines engine mode (--engine): exact same architecture as LinkShell.app on macOS.
  IpcChannel ipc;
  std::string d3d_err;
  auto d3d = D3DContext::Create(-1, &d3d_err);
  if (!d3d) {
    ipc.Emit({{"t", "error"}, {"message", "D3D11 init failed: " + d3d_err}});
    MFShutdown();
    RoUninitialize();
    return 1;
  }

  WebRtcRuntime rtc;
  if (!rtc.Init(d3d, &ipc)) {
    ipc.Emit({{"t", "error"}, {"message", "libwebrtc PeerConnectionFactory init failed"}});
    MFShutdown();
    RoUninitialize();
    return 1;
  }

  bool hw_h264 = !d3d->is_warp() && MediaFoundationVideoEncoder::HasHardwareMft(false);
  bool hw_hevc = !d3d->is_warp() && MediaFoundationVideoEncoder::HasHardwareMft(true);

  auto emit_status = [&]() {
    ipc.Emit({
        {"t", "status"},
        {"recording", true},
        {"trusted", true},
        {"app", "LinkShell"},
        {"video", true},
        {"videoReconfigure", true},
        {"keys", true},
        {"hevc", hw_hevc},
        {"hwH264", hw_h264},
        {"adapter", d3d->adapter_name()},
        {"wgc", WgcCapturer::IsSupported()},
        {"vdd", VddStatusJson()},
    });
  };

  emit_status();

  std::map<std::string, std::unique_ptr<ScreenSession>> screen_sessions;
  std::map<std::string, std::unique_ptr<FusionSession>> fusion_sessions;

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    auto msg = json::parse(line, nullptr, false);
    if (msg.is_discarded() || !msg.is_object() || !msg.contains("t") || !msg["t"].is_string()) continue;
    std::string type = msg["t"].get<std::string>();

    try {
      if (type == "status") {
        emit_status();
      } else if (type == "displays") {
        // Wake virtual display if headless PC has no active monitor and MttVDD is installed.
        VddController vdd([&ipc](const std::string& m) { ipc.Log(m); });
        vdd.EnsureHeadlessDisplay();
        ipc.Emit({{"t", "displays"}, {"list", DisplaysJson()}});
      } else if (type == "rtc.open") {
        std::string v = msg.value("v", std::string{});
        if (v.empty()) continue;
        // One viewer owns the screen at a time, matching Mac ScreenSession.
        for (auto& [_, s] : screen_sessions) s->Close();
        screen_sessions.clear();
        auto session = std::make_unique<ScreenSession>(v, rtc.factory, d3d, &ipc);
        if (session->Open(msg)) screen_sessions[v] = std::move(session);
      } else if (type == "rtc.answer") {
        std::string v = msg.value("v", std::string{});
        if (auto it = screen_sessions.find(v); it != screen_sessions.end()) {
          it->second->HandleAnswer(msg.value("sdp", std::string{}));
        }
      } else if (type == "rtc.ice") {
        std::string v = msg.value("v", std::string{});
        if (auto it = screen_sessions.find(v); it != screen_sessions.end()) {
          it->second->HandleIce(msg);
        }
      } else if (type == "rtc.configure") {
        std::string v = msg.value("v", std::string{});
        if (auto it = screen_sessions.find(v); it != screen_sessions.end()) {
          it->second->HandleConfigure(msg);
        }
      } else if (type == "rtc.audio") {
        std::string v = msg.value("v", std::string{});
        if (auto it = screen_sessions.find(v); it != screen_sessions.end()) {
          it->second->SetAudio(msg.value("enabled", false));
        }
      } else if (type == "rtc.close") {
        std::string v = msg.value("v", std::string{});
        if (auto it = screen_sessions.find(v); it != screen_sessions.end()) {
          it->second->Close();
          screen_sessions.erase(it);
        }
      } else if (type == "fusion.open") {
        std::string id = msg.value("id", std::string{});
        if (id.empty()) continue;
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end()) {
          it->second->Close();
          fusion_sessions.erase(it);
        }
        auto fs = std::make_unique<FusionSession>(id, rtc.factory, d3d, &ipc);
        if (fs->Open(msg)) fusion_sessions[id] = std::move(fs);
      } else if (type == "fusion.stream.open") {
        std::string id = msg.value("id", std::string{});
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end()) it->second->OpenStream(msg);
      } else if (type == "fusion.stream.layout") {
        std::string id = msg.value("id", std::string{});
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end()) it->second->UpdateLayout(msg);
      } else if (type == "fusion.stream.close") {
        std::string id = msg.value("id", std::string{});
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end()) {
          it->second->CloseStream(msg.value("key", std::string{}));
        }
      } else if (type == "fusion.answer") {
        std::string id = msg.value("id", std::string{});
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end()) {
          it->second->HandleAnswer(msg.value("sdp", std::string{}));
        }
      } else if (type == "fusion.ice") {
        std::string id = msg.value("id", std::string{});
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end()) it->second->HandleIce(msg);
      } else if (type == "fusion.shape") {
        std::string id = msg.value("id", std::string{});
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end() && msg.contains("shape")) {
          it->second->SendShape(msg["shape"]);
        }
      } else if (type == "fusion.cursor") {
        std::string id = msg.value("id", std::string{});
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end()) {
          it->second->SendCursor(msg.value("x", 0.0), msg.value("y", 0.0));
        }
      } else if (type == "fusion.close") {
        std::string id = msg.value("id", std::string{});
        if (auto it = fusion_sessions.find(id); it != fusion_sessions.end()) {
          it->second->Close();
          fusion_sessions.erase(it);
        }
      } else if (type == "quit") {
        break;
      }
    } catch (const std::exception& e) {
      ipc.Log("IPC message error (" + type + "): " + e.what());
    } catch (...) {
      ipc.Log("IPC message error (" + type + "): unknown exception");
    }
  }

  for (auto& [_, s] : screen_sessions) s->Close();
  screen_sessions.clear();
  for (auto& [_, fs] : fusion_sessions) fs->Close();
  fusion_sessions.clear();

  rtc.Shutdown();
  MFShutdown();
  RoUninitialize();
  return 0;
}
