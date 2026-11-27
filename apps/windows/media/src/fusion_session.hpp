#pragma once

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include "api/data_channel_interface.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "capture_source.hpp"
#include "common.hpp"
#include "d3d_context.hpp"
#include "lan_floor.hpp"

namespace linkshell {

// Native C++ libwebrtc multi-stream Fusion session: replaces FusionNodeMedia (werift + FFmpeg)
// on Windows with GPU zero-copy WGC window/monitor capture + Media Foundation H.264/HEVC +
// LinkShellFusion1 SEI metadata + native libwebrtc PacedSender/GCC/FlexFEC/playout-delay=0.
class FusionSession {
 public:
  FusionSession(
      std::string session_id,
      webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
      std::shared_ptr<D3DContext> d3d,
      IpcChannel* ipc);
  ~FusionSession();

  bool Open(const json& request);
  void OpenStream(const json& msg);
  void UpdateLayout(const json& msg);
  void CloseStream(const std::string& key);
  void HandleAnswer(const std::string& sdp);
  void HandleIce(const json& msg);
  void SendShape(const json& shape);
  void SendCursor(double x, double y);
  void Close();

 private:
  class PcObserver;
  class DcObserver;

  struct StreamEntry {
    std::string key;
    webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver;
    webrtc::scoped_refptr<ScreenVideoTrackSource> source;
    int max_bitrate_bps = 6'000'000;
    int fps = 60;
  };

  void WantOffer();
  void NegotiateLoop();
  void DoOffer();
  void OnIceCandidate(const webrtc::IceCandidate* candidate);
  void OnConnectionState(webrtc::PeerConnectionInterface::PeerConnectionState state);
  void OnDataChannelMessage(const std::string& label, const webrtc::DataBuffer& buffer);

  std::string session_id_;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  std::shared_ptr<D3DContext> d3d_;
  IpcChannel* ipc_;

  std::mutex mu_;
  std::mutex close_mu_;
  bool cleaned_up_ = false;
  struct Lifetime {
    std::mutex mu;
    bool alive = true;
  };
  std::shared_ptr<Lifetime> life_ = std::make_shared<Lifetime>();
  std::atomic<bool> closed_{false};
  std::atomic<bool> connected_{false};
  std::string wanted_codec_ = "h264";
  bool negotiating_ = false;
  bool offer_wanted_ = false;
  int64_t offer_deadline_ms_ = 0;
  int64_t offer_due_ms_ = 0;
  int cursor_seq_ = 0;
  std::unordered_set<std::string> useless_host_ips_;

  std::unique_ptr<PcObserver> pc_observer_;
  std::vector<std::unique_ptr<DcObserver>> dc_observers_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  std::map<std::string, StreamEntry> streams_;
  std::vector<webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>> spare_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> ch_cursor_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> ch_shape_;
  std::vector<webrtc::scoped_refptr<webrtc::DataChannelInterface>> channels_;
  std::thread worker_;
};

}  // namespace linkshell
