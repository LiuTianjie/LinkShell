#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "api/data_channel_interface.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "audio_capturer.hpp"
#include "capture_source.hpp"
#include "common.hpp"
#include "d3d_context.hpp"
#include "display_info.hpp"
#include "input_cursor.hpp"
#include "lan_floor.hpp"
#include "vdd_control.hpp"

namespace linkshell {

// Full Mac-parity ScreenSession over native C++ libwebrtc PeerConnection.
class ScreenSession {
 public:
  ScreenSession(
      std::string viewer_id,
      webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
      std::shared_ptr<D3DContext> d3d,
      IpcChannel* ipc);
  ~ScreenSession();

  bool Open(const json& request);
  void HandleAnswer(const std::string& sdp);
  void HandleIce(const json& msg);
  void HandleConfigure(const json& msg);
  void SetAudio(bool enabled);
  void Close();

  const std::string& viewer_id() const { return viewer_id_; }

 private:
  class PcObserver;
  class DcObserver;
  class SdpObserver;
  class StatsCallback;

  void CreateOffer(bool ice_restart);
  void ApplySenderParameters();
  void OnConnectionState(webrtc::PeerConnectionInterface::PeerConnectionState state);
  void OnIceCandidate(const webrtc::IceCandidate* candidate);
  void OnDataChannelMessage(const std::string& label, const webrtc::DataBuffer& buffer);
  void OnStats(const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report);
  void MonitorLoop();
  void SendCursor(double x, double y);
  void SendShape(const CursorShapePayload& shape, bool force_full);
  void SendAudioPacket(const uint8_t* data, size_t size);
  int CurrentCeilingBps() const;
  void Fail(const std::string& message);

  std::string viewer_id_;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  std::shared_ptr<D3DContext> d3d_;
  IpcChannel* ipc_;

  std::mutex mu_;
  std::atomic<bool> closed_{false};
  std::atomic<bool> paused_{false};
  std::atomic<bool> ever_connected_{false};
  std::atomic<bool> connected_{false};

  DisplayInfo display_{};
  int requested_screen_ = 0;
  int max_width_ = tuning::kDefaultMaxWidth;
  int max_fps_ = tuning::kFullFps;
  std::optional<int> fixed_fps_;
  std::string wanted_codec_ = "h264";
  int relay_kbps_ = tuning::kRelayDefaultKbps;
  int pic_w_ = 1920;
  int pic_h_ = 1080;
  int frame_rate_ = tuning::kFullFps;
  std::optional<int> eased_bps_;
  bool relayed_ = false;
  bool audio_enabled_ = false;
  int ice_restarts_ = 0;
  int64_t offer_sent_ms_ = 0;
  int64_t last_activity_ms_ = -10'000;
  std::string last_path_desc_;
  int cursor_seq_ = 0;

  // Previous stats counters for per-second deltas.
  bool has_prev_stats_ = false;
  uint64_t prev_bytes_sent_ = 0;
  uint32_t prev_frames_encoded_ = 0;
  double prev_encode_time_ = 0.0;
  double prev_send_delay_ = 0.0;
  uint64_t prev_packets_sent_ = 0;

  std::unique_ptr<FrameRateController> fps_ctrl_;
  LanFloor lan_floor_;
  std::unique_ptr<AwakeGuard> awake_;
  std::unique_ptr<VddController> vdd_;
  std::unique_ptr<InputCursorController> input_;
  std::unique_ptr<AudioCapturer> audio_;

  std::unique_ptr<PcObserver> pc_observer_;
  std::vector<std::unique_ptr<DcObserver>> dc_observers_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  webrtc::scoped_refptr<ScreenVideoTrackSource> source_;
  webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> ch_cursor_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> ch_shape_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> ch_audio_;
  std::vector<webrtc::scoped_refptr<webrtc::DataChannelInterface>> channels_;

  std::thread monitor_;
};

}  // namespace linkshell
