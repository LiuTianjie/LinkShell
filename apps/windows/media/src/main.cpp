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
#include "api/video_codecs/video_decoder_factory.h"
#include "common.hpp"
#include "d3d_context.hpp"
#include "display_info.hpp"
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
    if (key == "WebRTC-FlexFEC-03-Advertised") return "Enabled";
    if (key == "WebRTC-FlexFEC-03") return "Enabled";
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
    WebRtcRuntime rtc;
    bool rtc_ok = d3d && rtc.Init(d3d, nullptr);
    json out = {
        {"ok", d3d != nullptr && rtc_ok},
        {"adapter", d3d ? d3d->adapter_name() : ""},
        {"vendorId", d3d ? d3d->vendor_id() : 0},
        {"warp", d3d ? d3d->is_warp() : true},
        {"d3dError", d3d_err},
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
    return (d3d != nullptr && rtc_ok) ? 0 : 1;
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

    if (type == "status") {
      emit_status();
    } else if (type == "displays") {
      // Ensure cold-boot headless PC wakes virtual display if VDD is installed and 0 displays exist.
      if (EnumerateDisplays().empty()) {
        VddController vdd([&ipc](const std::string& m) { ipc.Log(m); });
        vdd.EnsureHeadlessDisplay();
      }
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
