#include "fusion_session.hpp"

#include <algorithm>
#include <chrono>

#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/media_types.h"
#include "api/rtp_transceiver_direction.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "display_info.hpp"

namespace linkshell {

namespace {

std::string PcStateName(webrtc::PeerConnectionInterface::PeerConnectionState s) {
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

class FusionOfferAdapter : public webrtc::CreateSessionDescriptionObserver {
 public:
  using OkFn = std::function<void(webrtc::SessionDescriptionInterface*)>;
  using ErrFn = std::function<void(const std::string&)>;
  FusionOfferAdapter(OkFn ok, ErrFn err) : ok_(std::move(ok)), err_(std::move(err)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* d) override { if (ok_) ok_(d); }
  void OnFailure(webrtc::RTCError e) override { if (err_) err_(e.message()); }
 private:
  OkFn ok_;
  ErrFn err_;
};

class FusionSetLocalAdapter : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  explicit FusionSetLocalAdapter(std::function<void(webrtc::RTCError)> fn) : fn_(std::move(fn)) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError e) override { if (fn_) fn_(std::move(e)); }
 private:
  std::function<void(webrtc::RTCError)> fn_;
};

class FusionSetRemoteAdapter : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  explicit FusionSetRemoteAdapter(std::function<void(webrtc::RTCError)> fn) : fn_(std::move(fn)) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError e) override { if (fn_) fn_(std::move(e)); }
 private:
  std::function<void(webrtc::RTCError)> fn_;
};

}  // namespace

class FusionSession::PcObserver : public webrtc::PeerConnectionObserver {
 public:
  explicit PcObserver(FusionSession* owner) : owner_(owner) {}
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* c) override { owner_->OnIceCandidate(c); }
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState s) override {
    owner_->OnConnectionState(s);
  }
 private:
  FusionSession* owner_;
};

class FusionSession::DcObserver : public webrtc::DataChannelObserver {
 public:
  DcObserver(FusionSession* owner, std::string label) : owner_(owner), label_(std::move(label)) {}
  void OnStateChange() override {}
  void OnMessage(const webrtc::DataBuffer& buf) override { owner_->OnDataChannelMessage(label_, buf); }
 private:
  FusionSession* owner_;
  std::string label_;
};

FusionSession::FusionSession(
    std::string session_id,
    webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
    std::shared_ptr<D3DContext> d3d,
    IpcChannel* ipc)
    : session_id_(std::move(session_id)),
      factory_(std::move(factory)),
      d3d_(std::move(d3d)),
      ipc_(ipc) {}

FusionSession::~FusionSession() {
  Close();
}

bool FusionSession::Open(const json& request) {
  wanted_codec_ = (request.value("codec", std::string("h264")) == "hevc") ? "hevc" : "h264";

  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  config.bundle_policy = webrtc::PeerConnectionInterface::kBundlePolicyMaxBundle;
  config.rtcp_mux_policy = webrtc::PeerConnectionInterface::kRtcpMuxPolicyRequire;
  config.continual_gathering_policy = webrtc::PeerConnectionInterface::GATHER_CONTINUALLY;
  config.disable_link_local_networks = true;
  config.set_dscp(true);

  if (request.contains("iceServers") && request["iceServers"].is_array()) {
    for (const auto& entry : request["iceServers"]) {
      if (!entry.is_object()) continue;
      webrtc::PeerConnectionInterface::IceServer s;
      if (entry.contains("urls")) {
        if (entry["urls"].is_array()) {
          for (const auto& u : entry["urls"]) if (u.is_string()) s.urls.push_back(u.get<std::string>());
        } else if (entry["urls"].is_string()) {
          s.urls.push_back(entry["urls"].get<std::string>());
        }
      }
      if (s.urls.empty()) continue;
      if (entry.contains("username") && entry["username"].is_string()) s.username = entry["username"].get<std::string>();
      if (entry.contains("credential") && entry["credential"].is_string()) s.password = entry["credential"].get<std::string>();
      config.servers.push_back(std::move(s));
    }
  }

  pc_observer_ = std::make_unique<PcObserver>(this);
  webrtc::PeerConnectionDependencies deps(pc_observer_.get());
  auto pc_or = factory_->CreatePeerConnectionOrError(config, std::move(deps));
  if (!pc_or.ok()) {
    ipc_->Log(std::string("[fusion] PeerConnection failed: ") + pc_or.error().message());
    return false;
  }
  pc_ = pc_or.MoveValue();

  webrtc::BitrateSettings bwe;
  bwe.start_bitrate_bps = tuning::kStartBitrateBps;
  pc_->SetBitrate(bwe);

  struct ChanSpec { const char* label; bool lossy; };
  constexpr ChanSpec kSpecs[] = {{"input", false}, {"pointer", true}, {"cursor", true}, {"shape", false}};
  for (const auto& sp : kSpecs) {
    webrtc::DataChannelInit dci;
    if (sp.lossy) { dci.ordered = false; dci.maxRetransmits = 0; }
    else { dci.ordered = true; }
    auto dc_or = pc_->CreateDataChannelOrError(sp.label, &dci);
    if (!dc_or.ok()) continue;
    auto dc = dc_or.MoveValue();
    auto obs = std::make_unique<DcObserver>(this, sp.label);
    dc->RegisterObserver(obs.get());
    if (std::string(sp.label) == "cursor") ch_cursor_ = dc;
    else if (std::string(sp.label) == "shape") ch_shape_ = dc;
    channels_.push_back(std::move(dc));
    dc_observers_.push_back(std::move(obs));
  }

  WantOffer();
  worker_ = std::thread([this]() { NegotiateLoop(); });
  return true;
}

void FusionSession::OpenStream(const json& msg) {
  std::lock_guard<std::mutex> lock(mu_);
  if (closed_.load() || !pc_) return;
  std::string key = msg.value("key", std::string{});
  if (key.empty() || streams_.count(key)) return;

  std::string kind = msg.value("kind", std::string("window"));
  int width = std::clamp(msg.value("width", 1920), 64, 3840);
  int height = std::clamp(msg.value("height", 1080), 64, 2160);
  int fps = std::clamp(msg.value("fps", 60), 1, 120);
  int bitrate = std::clamp(msg.value("bitrate", 6'000'000), 300'000, 24'000'000);
  std::string layout_json;
  if (msg.contains("layout") && !msg["layout"].is_null()) layout_json = msg["layout"].dump();

  auto source = webrtc::make_ref_counted<ScreenVideoTrackSource>(d3d_, [this](const std::string& m) { ipc_->Log("[fusion] " + m); });
  if (!layout_json.empty()) source->SetFusionLayout(layout_json);
  source->SetOnStop([this, key](const std::string& reason) {
    if (!closed_.load()) {
      ipc_->Emit({{"t", "fusion.error"}, {"id", session_id_}, {"key", key}, {"message", reason}});
    }
  });

  std::string err;
  bool started = false;
  if (kind == "monitor") {
    int screen = msg.value("screen", 0);
    auto disp = FindDisplay(screen);
    if (disp) {
      auto [pw, ph] = ComputePictureSize(disp->width, disp->height, width);
      started = source->StartDisplay(*disp, pw, ph, fps, &err);
    } else {
      err = "monitor not found";
    }
  } else {
    int64_t hwnd_val = msg.value("hwnd", int64_t{0});
    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd_val));
    started = source->StartWindow(hwnd, width, height, fps, &err);
  }
  if (!started) {
    ipc_->Emit({{"t", "fusion.error"}, {"id", session_id_}, {"key", key}, {"message", err.empty() ? "capture failed" : err}});
    return;
  }

  auto track = factory_->CreateVideoTrack(source, "fusion-" + key);
  webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> tx;
  if (!spare_.empty()) {
    tx = spare_.back();
    spare_.pop_back();
    tx->sender()->SetTrack(track.get());
    tx->SetDirectionWithError(webrtc::RtpTransceiverDirection::kSendOnly);
  } else {
    webrtc::RtpTransceiverInit init;
    init.direction = webrtc::RtpTransceiverDirection::kSendOnly;
    init.stream_ids = {"fusion"};
    webrtc::RtpEncodingParameters enc;
    enc.max_bitrate_bps = bitrate;
    enc.max_framerate = static_cast<double>(fps);
    enc.network_priority = webrtc::Priority::kHigh;
    init.send_encodings.push_back(enc);
    auto tx_or = pc_->AddTransceiver(track, init);
    if (!tx_or.ok()) {
      source->Stop();
      ipc_->Emit({{"t", "fusion.error"}, {"id", session_id_}, {"key", key}, {"message", tx_or.error().message()}});
      return;
    }
    tx = tx_or.MoveValue();
  }

  auto params = tx->sender()->GetParameters();
  params.degradation_preference = webrtc::DegradationPreference::MAINTAIN_FRAMERATE;
  for (auto& e : params.encodings) {
    e.max_bitrate_bps = bitrate;
    e.max_framerate = static_cast<double>(fps);
  }
  tx->sender()->SetParameters(params);

  streams_[key] = StreamEntry{key, tx, source, bitrate, fps};
  WantOffer();
}

void FusionSession::UpdateLayout(const json& msg) {
  std::lock_guard<std::mutex> lock(mu_);
  std::string key = msg.value("key", std::string{});
  auto it = streams_.find(key);
  if (it == streams_.end() || !it->second.source) return;
  if (msg.contains("layout") && !msg["layout"].is_null()) {
    it->second.source->SetFusionLayout(msg["layout"].dump());
  }
}

void FusionSession::CloseStream(const std::string& key) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = streams_.find(key);
  if (it == streams_.end()) return;
  if (it->second.source) it->second.source->Stop();
  if (it->second.transceiver) {
    it->second.transceiver->sender()->SetTrack(nullptr);
    it->second.transceiver->SetDirectionWithError(webrtc::RtpTransceiverDirection::kInactive);
    spare_.push_back(it->second.transceiver);
  }
  streams_.erase(it);
  WantOffer();
}

void FusionSession::WantOffer() {
  offer_wanted_ = true;
  if (offer_due_ms_ == 0) offer_due_ms_ = NowMillis() + 50;
}

void FusionSession::NegotiateLoop() {
  while (!closed_.load()) {
    bool should_offer = false;
    {
      std::lock_guard<std::mutex> lock(mu_);
      int64_t now = NowMillis();
      if (negotiating_ && offer_deadline_ms_ > 0 && now >= offer_deadline_ms_) {
        ipc_->Log("[fusion] media offer timed out; offering again");
        negotiating_ = false;
        offer_wanted_ = true;
        offer_due_ms_ = now;
      }
      if (!negotiating_ && offer_wanted_ && now >= offer_due_ms_) {
        offer_wanted_ = false;
        offer_due_ms_ = 0;
        negotiating_ = true;
        offer_deadline_ms_ = now + 10'000;
        should_offer = true;
      }
    }
    if (should_offer) DoOffer();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
}

void FusionSession::DoOffer() {
  if (closed_.load() || !pc_) return;
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions opts;
  auto obs = webrtc::make_ref_counted<FusionOfferAdapter>(
      [this](webrtc::SessionDescriptionInterface* desc) {
        if (closed_.load() || !pc_ || !desc) { delete desc; return; }
        std::string sdp;
        desc->ToString(&sdp);
        auto set_obs = webrtc::make_ref_counted<FusionSetLocalAdapter>([this, sdp](webrtc::RTCError err) {
          if (closed_.load()) return;
          if (!err.ok()) {
            std::lock_guard<std::mutex> lock(mu_);
            negotiating_ = false;
            ipc_->Log(std::string("[fusion] SetLocalDescription failed: ") + err.message());
            return;
          }
          // Emit mid mapping strictly before offer so the receiver maps incoming tracks immediately.
          json stream_map = json::array();
          {
            std::lock_guard<std::mutex> lock(mu_);
            for (const auto& [k, entry] : streams_) {
              if (entry.transceiver && entry.transceiver->mid().has_value()) {
                stream_map.push_back({{"k", k}, {"mid", *entry.transceiver->mid()}});
              }
            }
          }
          ipc_->Emit({{"t", "fusion.streams"}, {"id", session_id_}, {"streams", stream_map}});
          ipc_->Emit({{"t", "fusion.offer"}, {"id", session_id_}, {"sdp", sdp}});
        });
        pc_->SetLocalDescription(std::unique_ptr<webrtc::SessionDescriptionInterface>(desc), set_obs);
      },
      [this](const std::string& err) {
        std::lock_guard<std::mutex> lock(mu_);
        negotiating_ = false;
        ipc_->Log("[fusion] CreateOffer failed: " + err);
      });
  pc_->CreateOffer(obs.get(), opts);
}

void FusionSession::HandleAnswer(const std::string& sdp) {
  if (closed_.load() || !pc_) return;
  webrtc::SdpParseError err;
  auto desc = webrtc::CreateSessionDescription(webrtc::SdpType::kAnswer, sdp, &err);
  if (!desc) return;
  auto obs = webrtc::make_ref_counted<FusionSetRemoteAdapter>([this](webrtc::RTCError e) {
    std::lock_guard<std::mutex> lock(mu_);
    negotiating_ = false;
    offer_deadline_ms_ = 0;
    if (!e.ok()) ipc_->Log(std::string("[fusion] SetRemoteDescription failed: ") + e.message());
  });
  pc_->SetRemoteDescription(std::move(desc), obs);
}

void FusionSession::HandleIce(const json& msg) {
  if (closed_.load() || !pc_) return;
  std::string cand = msg.value("candidate", std::string{});
  if (cand.empty()) return;
  std::string mid = msg.contains("sdpMid") && msg["sdpMid"].is_string() ? msg["sdpMid"].get<std::string>() : "";
  int mline = msg.contains("sdpMLineIndex") && msg["sdpMLineIndex"].is_number_integer() ? msg["sdpMLineIndex"].get<int>() : 0;
  webrtc::SdpParseError err;
  auto ice = webrtc::IceCandidate::Create(mid, mline, cand, &err);
  if (ice) pc_->AddIceCandidate(std::move(ice), [](webrtc::RTCError) {});
}

void FusionSession::SendShape(const json& shape) {
  if (closed_.load() || !ch_shape_ || ch_shape_->state() != webrtc::DataChannelInterface::kOpen) return;
  if (ch_shape_->buffered_amount() > 262'144) return;
  json msg = shape;
  msg["t"] = "shape";
  ch_shape_->Send(webrtc::DataBuffer(msg.dump()));
}

void FusionSession::SendCursor(double x, double y) {
  if (closed_.load() || !ch_cursor_ || ch_cursor_->state() != webrtc::DataChannelInterface::kOpen) return;
  if (ch_cursor_->buffered_amount() > 16384) return;
  json msg = {{"t", "cursor"}, {"x", x}, {"y", y}, {"i", ++cursor_seq_}};
  ch_cursor_->Send(webrtc::DataBuffer(msg.dump()));
}

void FusionSession::OnIceCandidate(const webrtc::IceCandidate* c) {
  if (closed_.load() || !c) return;
  ipc_->Emit({
      {"t", "fusion.ice"},
      {"id", session_id_},
      {"candidate", c->ToString()},
      {"sdpMid", c->sdp_mid()},
      {"sdpMLineIndex", c->sdp_mline_index()},
  });
}

void FusionSession::OnConnectionState(webrtc::PeerConnectionInterface::PeerConnectionState state) {
  if (closed_.load()) return;
  bool is_conn = (state == webrtc::PeerConnectionInterface::PeerConnectionState::kConnected);
  connected_.store(is_conn);
  if (is_conn) {
    std::lock_guard<std::mutex> lock(mu_);
    for (auto& [k, entry] : streams_) {
      if (entry.source) entry.source->ResendLatest();
    }
  }
  ipc_->Emit({{"t", "fusion.state"}, {"id", session_id_}, {"connection", PcStateName(state)}});
}

void FusionSession::OnDataChannelMessage(const std::string& label, const webrtc::DataBuffer& buf) {
  if (closed_.load() || buf.binary || buf.data.size() > tuning::kMaxEventBytes) return;
  if (label != "input" && label != "pointer") return;
  std::string raw(reinterpret_cast<const char*>(buf.data.data()), buf.data.size());
  auto parsed = json::parse(raw, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_object()) return;
  ipc_->Emit({
      {"t", "fusion.input"},
      {"id", session_id_},
      {"lossy", label == "pointer"},
      {"message", parsed},
  });
}

void FusionSession::Close() {
  if (closed_.exchange(true)) return;
  if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (auto& [k, entry] : streams_) {
      if (entry.source) entry.source->Stop();
    }
    streams_.clear();
    spare_.clear();
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
  dc_observers_.clear();
  if (pc_) {
    pc_->Close();
    pc_ = nullptr;
  }
}

}  // namespace linkshell
