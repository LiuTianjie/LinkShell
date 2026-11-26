#include "screen_session.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/media_types.h"
#include "api/rtp_parameters.h"
#include "api/rtp_transceiver_direction.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/stats/rtc_stats_collector_callback.h"
#include "api/stats/rtcstats_objects.h"

namespace linkshell {

namespace {

std::string ConnectionStateString(webrtc::PeerConnectionInterface::PeerConnectionState s) {
  switch (s) {
    case webrtc::PeerConnectionInterface::PeerConnectionState::kNew: return "new";
    case webrtc::PeerConnectionInterface::PeerConnectionState::kConnecting: return "connecting";
    case webrtc::PeerConnectionInterface::PeerConnectionState::kConnected: return "connected";
    case webrtc::PeerConnectionInterface::PeerConnectionState::kDisconnected: return "disconnected";
    case webrtc::PeerConnectionInterface::PeerConnectionState::kFailed: return "failed";
    case webrtc::PeerConnectionInterface::PeerConnectionState::kClosed: return "closed";
  }
  return "new";
}

std::string Upper(std::string s) {
  for (char& c : s) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  return s;
}

std::vector<webrtc::RtpCodecCapability> OrderCodecs(
    const std::string& wanted,
    const std::vector<webrtc::RtpCodecCapability>& caps,
    bool* out_found) {
  std::string target = (wanted == "hevc") ? "H265" : "H264";
  bool found = false;
  auto rank = [&](const webrtc::RtpCodecCapability& c) -> int {
    std::string u = Upper(c.name);
    if (u == "RTX" || u == "RED" || u == "ULPFEC" || u == "FLEXFEC-03") return 9;
    if (u == target) {
      found = true;
      auto it = c.parameters.find("profile-level-id");
      if (it != c.parameters.end() && it->second.rfind("64", 0) == 0) return 0;
      if (it != c.parameters.end() && it->second.rfind("4d", 0) == 0) return 1;
      return 2;
    }
    if (u == "H264") {
      auto it = c.parameters.find("profile-level-id");
      if (it != c.parameters.end() && it->second.rfind("64", 0) == 0) return 3;
      if (it != c.parameters.end() && it->second.rfind("4d", 0) == 0) return 4;
      return 5;
    }
    return 6;
  };
  std::vector<std::pair<int, size_t>> indices;
  indices.reserve(caps.size());
  for (size_t i = 0; i < caps.size(); ++i) indices.push_back({rank(caps[i]), i});
  std::stable_sort(indices.begin(), indices.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  std::vector<webrtc::RtpCodecCapability> out;
  out.reserve(caps.size());
  for (const auto& [r, i] : indices) out.push_back(caps[i]);
  if (out_found) *out_found = found;
  return out;
}

webrtc::PeerConnectionInterface::IceServers ParseIceServers(const json& request) {
  webrtc::PeerConnectionInterface::IceServers servers;
  if (!request.contains("iceServers") || !request["iceServers"].is_array()) return servers;
  for (const auto& entry : request["iceServers"]) {
    if (!entry.is_object()) continue;
    webrtc::PeerConnectionInterface::IceServer s;
    if (entry.contains("urls")) {
      if (entry["urls"].is_array()) {
        for (const auto& u : entry["urls"]) {
          if (u.is_string()) s.urls.push_back(u.get<std::string>());
        }
      } else if (entry["urls"].is_string()) {
        s.urls.push_back(entry["urls"].get<std::string>());
      }
    }
    if (s.urls.empty()) continue;
    if (entry.contains("username") && entry["username"].is_string()) s.username = entry["username"].get<std::string>();
    if (entry.contains("credential") && entry["credential"].is_string()) s.password = entry["credential"].get<std::string>();
    servers.push_back(std::move(s));
  }
  return servers;
}

class CreateOfferAdapter : public webrtc::CreateSessionDescriptionObserver {
 public:
  using SuccessFn = std::function<void(webrtc::SessionDescriptionInterface*)>;
  using FailFn = std::function<void(const std::string&)>;
  CreateOfferAdapter(SuccessFn ok, FailFn fail) : ok_(std::move(ok)), fail_(std::move(fail)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override { if (ok_) ok_(desc); }
  void OnFailure(webrtc::RTCError error) override { if (fail_) fail_(error.message()); }
 private:
  SuccessFn ok_;
  FailFn fail_;
};

class SetLocalAdapter : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  using DoneFn = std::function<void(webrtc::RTCError)>;
  explicit SetLocalAdapter(DoneFn fn) : fn_(std::move(fn)) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override { if (fn_) fn_(std::move(error)); }
 private:
  DoneFn fn_;
};

class SetRemoteAdapter : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  using DoneFn = std::function<void(webrtc::RTCError)>;
  explicit SetRemoteAdapter(DoneFn fn) : fn_(std::move(fn)) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override { if (fn_) fn_(std::move(error)); }
 private:
  DoneFn fn_;
};

}  // namespace

class ScreenSession::PcObserver : public webrtc::PeerConnectionObserver {
 public:
  explicit PcObserver(ScreenSession* owner) : owner_(owner) {}
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override { owner_->OnIceCandidate(candidate); }
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) override {
    owner_->OnConnectionState(state);
  }
 private:
  ScreenSession* owner_;
};

class ScreenSession::DcObserver : public webrtc::DataChannelObserver {
 public:
  DcObserver(ScreenSession* owner, std::string label) : owner_(owner), label_(std::move(label)) {}
  void OnStateChange() override {}
  void OnMessage(const webrtc::DataBuffer& buffer) override { owner_->OnDataChannelMessage(label_, buffer); }
 private:
  ScreenSession* owner_;
  std::string label_;
};

class ScreenSession::StatsCallback : public webrtc::RTCStatsCollectorCallback {
 public:
  explicit StatsCallback(ScreenSession* owner) : owner_(owner) {}
  void OnStatsDelivered(const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report) override {
    owner_->OnStats(report);
  }
 private:
  ScreenSession* owner_;
};

ScreenSession::ScreenSession(
    std::string viewer_id,
    webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
    std::shared_ptr<D3DContext> d3d,
    IpcChannel* ipc)
    : viewer_id_(std::move(viewer_id)),
      factory_(std::move(factory)),
      d3d_(std::move(d3d)),
      ipc_(ipc),
      vdd_(std::make_unique<VddController>([ipc](const std::string& m) { ipc->Log(m); })),
      input_(std::make_unique<InputCursorController>([ipc](const std::string& m) { ipc->Log(m); })) {}

ScreenSession::~ScreenSession() {
  Close();
}

bool ScreenSession::Open(const json& request) {
  requested_screen_ = request.value("screen", 0);
  max_width_ = std::clamp(request.value("maxWidth", tuning::kDefaultMaxWidth), tuning::kNarrowestPicture, tuning::kWidestPicture);
  int req_max_fps = request.value("maxFps", tuning::kFullFps);
  max_fps_ = (req_max_fps == 30 || req_max_fps == 60 || req_max_fps == 120) ? req_max_fps : tuning::kFullFps;
  if (request.contains("fps") && request["fps"].is_number_integer()) {
    fixed_fps_ = std::clamp(request["fps"].get<int>(), tuning::kMinFps, tuning::kMaxFps);
  }
  wanted_codec_ = (request.value("codec", std::string("h264")) == "hevc") ? "hevc" : "h264";
  relay_kbps_ = std::clamp(request.value("relayKbps", tuning::kRelayDefaultKbps), 300, 50'000);
  audio_enabled_ = request.value("audio", false);

  // If cold-boot headless PC has 0 displays and MttVDD is installed, wake a virtual display first.
  vdd_->EnsureHeadlessDisplay();

  // Optional Mac-parity ScreenMatch when viewer requests its own screen geometry.
  std::optional<DisplayInfo> chosen;
  if (request.contains("match") && request["match"].is_object()) {
    const auto& m = request["match"];
    MatchRequest mr;
    mr.width = m.value("w", 0.0);
    mr.height = m.value("h", 0.0);
    mr.scale = m.value("scale", 1.0);
    chosen = vdd_->BeginMatch(requested_screen_, mr, max_fps_);
  }
  if (!chosen) chosen = FindDisplay(requested_screen_);
  if (!chosen) {
    Fail("没有找到可以捕获的显示器");
    return false;
  }

  display_ = *chosen;
  auto [pw, ph] = ComputePictureSize(display_.width, display_.height, max_width_);
  pic_w_ = pw;
  pic_h_ = ph;
  frame_rate_ = fixed_fps_.value_or(tuning::FullRate(max_fps_, display_.refresh_hz));
  if (!fixed_fps_ && frame_rate_ > 30) {
    fps_ctrl_ = std::make_unique<FrameRateController>(frame_rate_, frame_rate_ > 60 ? 60 : 30, 30);
  }

  awake_ = std::make_unique<AwakeGuard>();
  input_->SetDisplay(display_);

  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  config.servers = ParseIceServers(request);
  config.bundle_policy = webrtc::PeerConnectionInterface::kBundlePolicyMaxBundle;
  config.rtcp_mux_policy = webrtc::PeerConnectionInterface::kRtcpMuxPolicyRequire;
  config.continual_gathering_policy = webrtc::PeerConnectionInterface::GATHER_CONTINUALLY;
  config.disable_link_local_networks = true;
  config.set_dscp(true);

  pc_observer_ = std::make_unique<PcObserver>(this);
  webrtc::PeerConnectionDependencies deps(pc_observer_.get());
  auto pc_or = factory_->CreatePeerConnectionOrError(config, std::move(deps));
  if (!pc_or.ok()) {
    Fail(std::string("PeerConnection creation failed: ") + pc_or.error().message());
    return false;
  }
  pc_ = pc_or.MoveValue();

  source_ = webrtc::make_ref_counted<ScreenVideoTrackSource>(d3d_, [this](const std::string& m) { ipc_->Log(m); });
  auto track = factory_->CreateVideoTrack(source_, "screen");

  webrtc::RtpTransceiverInit init;
  init.direction = webrtc::RtpTransceiverDirection::kSendOnly;
  init.stream_ids = {"screen"};
  webrtc::RtpEncodingParameters enc;
  enc.max_bitrate_bps = CurrentCeilingBps();
  enc.max_framerate = static_cast<double>(frame_rate_);
  enc.network_priority = webrtc::Priority::kHigh;
  init.send_encodings.push_back(enc);

  auto tx_or = pc_->AddTransceiver(track, init);
  if (!tx_or.ok()) {
    Fail(std::string("AddTransceiver failed: ") + tx_or.error().message());
    return false;
  }
  transceiver_ = tx_or.MoveValue();

  // Apply codec preference (HEVC if requested and available, else H.264 High -> Main -> Baseline).
  auto caps = factory_->GetRtpSenderCapabilities(webrtc::MediaType::VIDEO).codecs;
  bool codec_found = false;
  auto ordered = OrderCodecs(wanted_codec_, caps, &codec_found);
  if (!codec_found) ipc_->Log(wanted_codec_ + " unavailable; offering H264");
  transceiver_->SetCodecPreferences(ordered);

  ApplySenderParameters();

  webrtc::BitrateSettings bwe;
  bwe.start_bitrate_bps = tuning::kStartBitrateBps;
  pc_->SetBitrate(bwe);

  // Create the 5 LinkShell DataChannels (exact Mac parity).
  struct ChanSpec { const char* label; bool lossy; };
  constexpr ChanSpec kSpecs[] = {
      {"input", false},
      {"pointer", true},
      {"cursor", true},
      {"shape", false},
      {"audio", true},
  };
  for (const auto& sp : kSpecs) {
    webrtc::DataChannelInit dci;
    if (sp.lossy) {
      dci.ordered = false;
      dci.maxRetransmits = 0;
    } else {
      dci.ordered = true;
    }
    auto dc_or = pc_->CreateDataChannelOrError(sp.label, &dci);
    if (!dc_or.ok()) continue;
    auto dc = dc_or.MoveValue();
    auto obs = std::make_unique<DcObserver>(this, sp.label);
    dc->RegisterObserver(obs.get());
    if (std::string(sp.label) == "cursor") ch_cursor_ = dc;
    else if (std::string(sp.label) == "shape") ch_shape_ = dc;
    else if (std::string(sp.label) == "audio") ch_audio_ = dc;
    channels_.push_back(std::move(dc));
    dc_observers_.push_back(std::move(obs));
  }

  // Start GPU capture immediately so the first frame is ready the instant ICE connects.
  std::string cap_err;
  if (!source_->StartDisplay(display_, pic_w_, pic_h_, frame_rate_, &cap_err)) {
    Fail("屏幕捕获启动失败：" + cap_err);
    return false;
  }

  if (audio_enabled_) {
    audio_ = std::make_unique<AudioCapturer>(
        [this](const uint8_t* data, size_t len) { SendAudioPacket(data, len); },
        [this](const std::string& m) { ipc_->Log(m); });
    audio_->Start();
  }

  ipc_->Log("capturing display " + std::to_string(display_.screen) + " (" +
            std::to_string(display_.width) + "x" + std::to_string(display_.height) + "@" +
            std::to_string(display_.refresh_hz) + "Hz) as " +
            std::to_string(pic_w_) + "x" + std::to_string(pic_h_) + " at " +
            std::to_string(frame_rate_) + " fps (codec=" + wanted_codec_ + ")");

  CreateOffer(false);
  monitor_ = std::thread([this]() { MonitorLoop(); });
  return true;
}

int ScreenSession::CurrentCeilingBps() const {
  int base = eased_bps_.value_or(tuning::MaxBitrateBps(pic_w_, pic_h_, frame_rate_));
  return relayed_ ? std::min(base, relay_kbps_ * 1000) : base;
}

void ScreenSession::ApplySenderParameters() {
  if (!transceiver_) return;
  auto sender = transceiver_->sender();
  if (!sender) return;
  auto params = sender->GetParameters();
  params.degradation_preference = webrtc::DegradationPreference::MAINTAIN_FRAMERATE;
  for (auto& enc : params.encodings) {
    enc.max_bitrate_bps = CurrentCeilingBps();
    enc.max_framerate = static_cast<double>(frame_rate_);
    enc.network_priority = webrtc::Priority::kHigh;
  }
  sender->SetParameters(params);
}

void ScreenSession::CreateOffer(bool ice_restart) {
  if (closed_.load() || !pc_) return;
  offer_sent_ms_ = NowMillis();
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions opts;
  opts.ice_restart = ice_restart;

  auto obs = webrtc::make_ref_counted<CreateOfferAdapter>(
      [this](webrtc::SessionDescriptionInterface* desc) {
        if (closed_.load() || !pc_ || !desc) {
          delete desc;
          return;
        }
        std::string sdp;
        desc->ToString(&sdp);
        auto set_obs = webrtc::make_ref_counted<SetLocalAdapter>([this, sdp](webrtc::RTCError err) {
          if (closed_.load()) return;
          if (!err.ok()) {
            Fail(std::string("SetLocalDescription failed: ") + err.message());
            return;
          }
          ipc_->Emit({{"t", "rtc.offer"}, {"v", viewer_id_}, {"sdp", sdp}});
        });
        pc_->SetLocalDescription(std::unique_ptr<webrtc::SessionDescriptionInterface>(desc), set_obs);
      },
      [this](const std::string& err) {
        if (!closed_.load()) Fail("CreateOffer failed: " + err);
      });
  pc_->CreateOffer(obs.get(), opts);
}

void ScreenSession::HandleAnswer(const std::string& sdp) {
  if (closed_.load() || !pc_) return;
  webrtc::SdpParseError parse_err;
  auto desc = webrtc::CreateSessionDescription(webrtc::SdpType::kAnswer, sdp, &parse_err);
  if (!desc) {
    Fail("Invalid answer SDP: " + parse_err.description);
    return;
  }
  auto obs = webrtc::make_ref_counted<SetRemoteAdapter>([this](webrtc::RTCError err) {
    if (!err.ok() && !closed_.load()) {
      Fail(std::string("SetRemoteDescription failed: ") + err.message());
    }
  });
  pc_->SetRemoteDescription(std::move(desc), obs);
}

void ScreenSession::HandleIce(const json& msg) {
  if (closed_.load() || !pc_) return;
  std::string cand = msg.value("candidate", std::string{});
  if (cand.empty()) return;
  std::string mid = msg.contains("sdpMid") && msg["sdpMid"].is_string() ? msg["sdpMid"].get<std::string>() : "";
  int mline = msg.contains("sdpMLineIndex") && msg["sdpMLineIndex"].is_number_integer() ? msg["sdpMLineIndex"].get<int>() : 0;
  webrtc::SdpParseError err;
  auto ice = webrtc::IceCandidate::Create(mid, mline, cand, &err);
  if (ice) {
    pc_->AddIceCandidate(std::move(ice), [](webrtc::RTCError) {});
  }
}

void ScreenSession::HandleConfigure(const json& msg) {
  if (closed_.load()) return;
  int req_id = msg.value("requestId", 0);
  int next_screen = msg.value("screen", requested_screen_);
  int next_max_w = std::clamp(msg.value("maxWidth", max_width_), tuning::kNarrowestPicture, tuning::kWidestPicture);
  int next_max_fps = msg.value("maxFps", max_fps_);
  if (next_max_fps != 30 && next_max_fps != 60 && next_max_fps != 120) next_max_fps = max_fps_;
  bool next_paused = msg.value("paused", false);
  std::optional<int64_t> next_gen;
  if (msg.contains("inputGeneration") && msg["inputGeneration"].is_number_integer()) {
    next_gen = msg["inputGeneration"].get<int64_t>();
  }

  auto chosen = FindDisplay(next_screen);
  if (!chosen) {
    ipc_->Emit({{"t", "rtc.configure.error"}, {"v", viewer_id_}, {"requestId", req_id}, {"message", "所选显示器已断开"}});
    return;
  }

  std::lock_guard<std::mutex> lock(mu_);
  input_->SetSuspended(true);
  input_->ReleaseAll();

  requested_screen_ = next_screen;
  max_width_ = next_max_w;
  max_fps_ = next_max_fps;
  display_ = *chosen;
  auto [pw, ph] = ComputePictureSize(display_.width, display_.height, max_width_);
  pic_w_ = pw;
  pic_h_ = ph;
  frame_rate_ = fixed_fps_.value_or(tuning::FullRate(max_fps_, display_.refresh_hz));
  fps_ctrl_ = (!fixed_fps_ && frame_rate_ > 30)
                  ? std::make_unique<FrameRateController>(frame_rate_, frame_rate_ > 60 ? 60 : 30, 30)
                  : nullptr;
  eased_bps_.reset();
  has_prev_stats_ = false;

  input_->SetDisplay(display_);
  input_->SetGeneration(next_gen);

  paused_.store(next_paused);
  if (next_paused) {
    source_->SetPaused(true);
    awake_.reset();
  } else {
    awake_ = std::make_unique<AwakeGuard>();
    std::string cap_err;
    if (!source_->StartDisplay(display_, pic_w_, pic_h_, frame_rate_, &cap_err)) {
      ipc_->Emit({{"t", "rtc.configure.error"}, {"v", viewer_id_}, {"requestId", req_id}, {"message", "屏幕捕获失败：" + cap_err}});
      return;
    }
    ApplySenderParameters();
    input_->SetSuspended(false);
  }

  json ack = {
      {"t", "rtc.configured"},
      {"v", viewer_id_},
      {"requestId", req_id},
      {"screen", requested_screen_},
      {"width", pic_w_},
      {"height", pic_h_},
      {"maxFps", max_fps_},
      {"paused", next_paused},
  };
  if (next_gen) ack["generation"] = *next_gen;
  ipc_->Emit(ack);
}

void ScreenSession::SetAudio(bool enabled) {
  std::lock_guard<std::mutex> lock(mu_);
  audio_enabled_ = enabled;
  if (enabled) {
    if (!audio_) {
      audio_ = std::make_unique<AudioCapturer>(
          [this](const uint8_t* data, size_t len) { SendAudioPacket(data, len); },
          [this](const std::string& m) { ipc_->Log(m); });
    }
    audio_->Start();
  } else if (audio_) {
    audio_->Stop();
  }
}

void ScreenSession::OnIceCandidate(const webrtc::IceCandidate* candidate) {
  if (closed_.load() || !candidate) return;
  ipc_->Emit({
      {"t", "rtc.ice"},
      {"v", viewer_id_},
      {"candidate", candidate->ToString()},
      {"sdpMid", candidate->sdp_mid()},
      {"sdpMLineIndex", candidate->sdp_mline_index()},
  });
}

void ScreenSession::OnConnectionState(webrtc::PeerConnectionInterface::PeerConnectionState state) {
  if (closed_.load()) return;
  bool is_conn = (state == webrtc::PeerConnectionInterface::PeerConnectionState::kConnected);
  connected_.store(is_conn);
  if (is_conn) ever_connected_.store(true);
  ipc_->Emit({{"t", "rtc.state"}, {"v", viewer_id_}, {"connection", ConnectionStateString(state)}});
}

void ScreenSession::OnDataChannelMessage(const std::string& label, const webrtc::DataBuffer& buffer) {
  if (closed_.load()) return;
  if (label != "input" && label != "pointer") return;
  if (buffer.binary || buffer.data.size() > tuning::kMaxEventBytes) return;
  std::string raw(reinterpret_cast<const char*>(buffer.data.data()), buffer.data.size());
  auto parsed = json::parse(raw, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_object()) return;

  bool accepted = input_->HandleEvent(parsed, /*lossy=*/label == "pointer");
  if (accepted) {
    int64_t now = NowMillis();
    if (now - last_activity_ms_ >= 5000) {
      last_activity_ms_ = now;
      ipc_->Emit({{"t", "rtc.activity"}, {"v", viewer_id_}});
    }
  }
}

void ScreenSession::SendCursor(double x, double y) {
  if (!ch_cursor_ || ch_cursor_->state() != webrtc::DataChannelInterface::kOpen) return;
  if (ch_cursor_->buffered_amount() > 16384) return;
  json msg = {{"t", "cursor"}, {"x", x}, {"y", y}, {"i", ++cursor_seq_}};
  ch_cursor_->Send(webrtc::DataBuffer(msg.dump()));
}

void ScreenSession::SendShape(const CursorShapePayload& shape, bool force_full) {
  if (!ch_shape_ || ch_shape_->state() != webrtc::DataChannelInterface::kOpen) return;
  if (ch_shape_->buffered_amount() > 262'144) return;
  json msg = {{"t", "shape"}, {"id", shape.id}};
  if (!shape.png_base64.empty() || force_full) {
    msg["png"] = shape.png_base64;
    msg["w"] = shape.w;
    msg["h"] = shape.h;
    msg["hotX"] = shape.hot_x;
    msg["hotY"] = shape.hot_y;
    msg["scale"] = shape.scale;
    msg["displayW"] = shape.display_w;
    msg["displayH"] = shape.display_h;
  }
  ch_shape_->Send(webrtc::DataBuffer(msg.dump()));
}

void ScreenSession::SendAudioPacket(const uint8_t* data, size_t size) {
  if (closed_.load() || paused_.load() || !ch_audio_) return;
  if (ch_audio_->state() != webrtc::DataChannelInterface::kOpen) return;
  if (ch_audio_->buffered_amount() > 262'144) return;
  webrtc::CopyOnWriteBuffer buf(data, size);
  ch_audio_->Send(webrtc::DataBuffer(buf, /*binary=*/true));
}

void ScreenSession::OnStats(const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report) {
  if (closed_.load() || !report) return;

  std::optional<LanFloor::Endpoint> local_ep;
  std::optional<LanFloor::Endpoint> remote_ep;
  std::optional<double> rtt_ms;
  std::optional<double> avail_bps;
  std::optional<double> fraction_lost;
  std::optional<double> send_delay_ms;
  std::optional<double> encoded_fps;
  std::optional<double> sent_share;
  std::optional<std::string> limitation;
  std::string encoder_impl;
  int sent_w = 0, sent_h = 0;
  double bitrate_kbps = 0.0;
  bool is_relayed = false;

  std::string local_id, remote_id;
  for (const auto* pair : report->GetStatsOfType<webrtc::RTCIceCandidatePairStats>()) {
    if (pair->nominated.value_or(false) && pair->state.value_or("") == "succeeded") {
      if (pair->current_round_trip_time.has_value()) rtt_ms = (*pair->current_round_trip_time) * 1000.0;
      if (pair->available_outgoing_bitrate.has_value()) avail_bps = *pair->available_outgoing_bitrate;
      if (pair->local_candidate_id.has_value()) local_id = *pair->local_candidate_id;
      if (pair->remote_candidate_id.has_value()) remote_id = *pair->remote_candidate_id;
      break;
    }
  }
  if (!local_id.empty()) {
    if (const auto* s = report->GetAs<webrtc::RTCLocalIceCandidateStats>(local_id)) {
      local_ep = LanFloor::Endpoint{s->candidate_type.value_or(""), s->address.value_or("")};
      if (local_ep->type == "relay") is_relayed = true;
    }
  }
  if (!remote_id.empty()) {
    if (const auto* s = report->GetAs<webrtc::RTCRemoteIceCandidateStats>(remote_id)) {
      remote_ep = LanFloor::Endpoint{s->candidate_type.value_or(""), s->address.value_or("")};
      if (remote_ep->type == "relay") is_relayed = true;
    }
  }

  for (const auto* ri : report->GetStatsOfType<webrtc::RTCRemoteInboundRtpStreamStats>()) {
    if (ri->kind.value_or("") == "video" && ri->fraction_lost.has_value()) {
      fraction_lost = *ri->fraction_lost;
    }
  }

  for (const auto* out : report->GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>()) {
    if (out->kind.value_or("") != "video") continue;
    uint64_t bytes = out->bytes_sent.value_or(0);
    uint32_t frames = out->frames_encoded.value_or(0);
    double enc_time = out->total_encode_time.value_or(0.0);
    double delay = out->total_packet_send_delay.value_or(0.0);
    uint64_t pkts = out->packets_sent.value_or(0);
    sent_w = static_cast<int>(out->frame_width.value_or(0));
    sent_h = static_cast<int>(out->frame_height.value_or(0));
    encoder_impl = out->encoder_implementation.value_or("");
    if (out->quality_limitation_reason.has_value()) limitation = *out->quality_limitation_reason;

    if (has_prev_stats_) {
      bitrate_kbps = static_cast<double>(bytes - prev_bytes_sent_) * 8.0 / 1000.0;
      encoded_fps = static_cast<double>(frames - prev_frames_encoded_);
      uint64_t dp = pkts > prev_packets_sent_ ? (pkts - prev_packets_sent_) : 0;
      if (dp > 0) send_delay_ms = ((delay - prev_send_delay_) / static_cast<double>(dp)) * 1000.0;
      (void)enc_time;
    }
    prev_bytes_sent_ = bytes;
    prev_frames_encoded_ = frames;
    prev_encode_time_ = enc_time;
    prev_send_delay_ = delay;
    prev_packets_sent_ = pkts;
    has_prev_stats_ = true;
    break;
  }

  std::lock_guard<std::mutex> lock(mu_);
  if (closed_.load()) return;

  // Report path change (LAN / direct / TURN relay).
  if (local_ep && remote_ep) {
    std::string desc = LanFloor::Describe(*local_ep, *remote_ep);
    if (desc != last_path_desc_) {
      last_path_desc_ = desc;
      ipc_->Log("video path: " + desc);
    }
    if (is_relayed != relayed_) {
      relayed_ = is_relayed;
      ipc_->Emit({{"t", "rtc.path"}, {"v", viewer_id_}, {"relayed", relayed_}});
      ApplySenderParameters();
    }
  }

  // Clear one-second ease cap after frame-rate ramp-up.
  if (eased_bps_.has_value()) {
    eased_bps_.reset();
    ApplySenderParameters();
  }

  // Judge LAN floor (8 Mbps protection against Wi-Fi power-save BWE collapse).
  if (connected_.load() && !paused_.load()) {
    LanFloor::Second lf_sec{local_ep, remote_ep, rtt_ms, fraction_lost, send_delay_ms};
    auto action = lan_floor_.Judge(lf_sec, CurrentCeilingBps());
    if (action.kind == LanFloor::ActionKind::kApply) {
      webrtc::BitrateSettings bwe;
      bwe.min_bitrate_bps = action.floor_bps;
      pc_->SetBitrate(bwe);
      ipc_->Log("LAN bitrate floor applied: " + std::to_string(action.floor_bps / 1000) + " kbps");
    } else if (action.kind == LanFloor::ActionKind::kLift) {
      webrtc::BitrateSettings bwe;
      bwe.min_bitrate_bps = 0;
      pc_->SetBitrate(bwe);
      ipc_->Log("LAN bitrate floor lifted: " + action.reason);
    }

    // Judge adaptive frame rate (120 -> 60 -> 30 fps without tearing down encoder).
    if (fps_ctrl_) {
      double captured = static_cast<double>(source_->ConsumeCapturedFrames());
      if (sent_w > 0 && sent_h > 0 && pic_w_ > 0 && pic_h_ > 0) {
        sent_share = static_cast<double>(sent_w * sent_h) / static_cast<double>(pic_w_ * pic_h_);
      }
      FrameRateController::Second fr_sec{captured, encoded_fps, sent_share, limitation, avail_bps, send_delay_ms};
      auto verdict = fps_ctrl_->Judge(fr_sec);
      if (verdict.kind == FrameRateController::VerdictKind::kDown ||
          verdict.kind == FrameRateController::VerdictKind::kUp) {
        ipc_->Log("frame rate " + std::to_string(frame_rate_) + " -> " +
                  std::to_string(verdict.next_rate) + ": " + verdict.reason);
        if (verdict.kind == FrameRateController::VerdictKind::kUp) {
          eased_bps_ = std::max(static_cast<int>(bitrate_kbps * 1000.0 * tuning::kFrameRateEase),
                                tuning::kFrameRateEaseFloorBps);
        } else {
          eased_bps_.reset();
        }
        frame_rate_ = verdict.next_rate;
        source_->SetTargetFps(frame_rate_);
        ApplySenderParameters();
      }
    }
  }

  json stats = {
      {"t", "rtc.stats"},
      {"v", viewer_id_},
      {"width", sent_w > 0 ? sent_w : pic_w_},
      {"height", sent_h > 0 ? sent_h : pic_h_},
      {"fps", encoded_fps.value_or(0.0)},
      {"bitrateKbps", bitrate_kbps},
      {"encoder", encoder_impl},
      {"backend", source_->active_backend()},
  };
  if (rtt_ms) stats["rttMs"] = *rtt_ms;
  if (send_delay_ms) stats["sendDelayMs"] = *send_delay_ms;
  ipc_->Emit(stats);
}

void ScreenSession::MonitorLoop() {
  int64_t last_shape_ms = 0;
  int64_t last_stats_ms = NowMillis();

  while (!closed_.load()) {
    int64_t now = NowMillis();

    if (connected_.load() && !paused_.load()) {
      if (auto pos = input_->PollCursor(false)) {
        SendCursor(pos->first, pos->second);
      }
      if (now - last_shape_ms >= tuning::kShapeIntervalMs) {
        last_shape_ms = now;
        if (auto sh = input_->PollShape(false)) {
          SendShape(*sh, false);
        }
      }
    }

    if (now - last_stats_ms >= 1000) {
      last_stats_ms = now;
      if (pc_ && connected_.load()) {
        auto cb = webrtc::make_ref_counted<StatsCallback>(this);
        pc_->GetStats(cb.get());
      } else if (!ever_connected_.load() && offer_sent_ms_ > 0 &&
                 (now - offer_sent_ms_) >= tuning::kIceRestartAfterSeconds * 1000 &&
                 ice_restarts_ < tuning::kIceRestartLimit) {
        ice_restarts_ += 1;
        ipc_->Log("no path yet after " + std::to_string(tuning::kIceRestartAfterSeconds) +
                  " s: restarting ICE (attempt " + std::to_string(ice_restarts_) + ")");
        if (pc_) pc_->RestartIce();
        CreateOffer(true);
      }
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(tuning::kCursorIntervalMs));
  }
}

void ScreenSession::Fail(const std::string& message) {
  ipc_->Emit({{"t", "rtc.error"}, {"v", viewer_id_}, {"message", message}});
  Close();
}

void ScreenSession::Close() {
  if (closed_.exchange(true)) return;
  if (monitor_.joinable() && monitor_.get_id() != std::this_thread::get_id()) {
    monitor_.join();
  }
  if (audio_) {
    audio_->Stop();
    audio_.reset();
  }
  if (input_) {
    input_->ReleaseAll();
  }
  if (source_) {
    source_->Stop();
  }
  for (auto& ch : channels_) {
    if (ch) {
      ch->UnregisterObserver();
      ch->Close();
    }
  }
  channels_.clear();
  ch_cursor_ = nullptr;
  ch_shape_ = nullptr;
  ch_audio_ = nullptr;
  dc_observers_.clear();
  if (pc_) {
    pc_->Close();
    pc_ = nullptr;
  }
  transceiver_ = nullptr;
  source_ = nullptr;
  awake_.reset();
  if (vdd_) {
    vdd_->EndMatch();
  }
}

}  // namespace linkshell
