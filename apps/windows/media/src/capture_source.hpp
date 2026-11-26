#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "d3d_context.hpp"
#include "display_info.hpp"
#include "dxgi_capturer.hpp"
#include "media/base/adapted_video_track_source.h"
#include "wgc_capturer.hpp"

namespace linkshell {

// Unified GPU-backed webrtc::VideoTrackSource for both full-screen capture (WGC -> DXGI -> GDI/SecureDesktop)
// and Fusion single-window fixed-canvas capture (WGC HWND -> GPU top-left blit + SEI layout attachment).
class ScreenVideoTrackSource : public webrtc::AdaptedVideoTrackSource {
 public:
  using LogFn = std::function<void(const std::string&)>;
  using StopFn = std::function<void(const std::string&)>;

  explicit ScreenVideoTrackSource(std::shared_ptr<D3DContext> d3d, LogFn log = {});
  ~ScreenVideoTrackSource() override;

  // VideoTrackSourceInterface overrides
  SourceState state() const override { return SourceState::kLive; }
  bool remote() const override { return false; }
  bool is_screencast() const override { return true; }
  std::optional<bool> needs_denoising() const override { return false; }

  // Full monitor capture (supports plugged-in, headless, virtual display, and UAC/Lock Screen handoff).
  bool StartDisplay(const DisplayInfo& display, int dst_w, int dst_h, int target_fps, std::string* error = nullptr);

  // Fusion single-window fixed-canvas capture (zero encoder restarts on window resize).
  bool StartWindow(HWND hwnd, int canvas_w, int canvas_h, int target_fps, std::string* error = nullptr);

  void SetFusionLayout(const std::string& layout_json);
  void SetTargetFps(int fps);
  void SetPaused(bool paused);
  void Stop();

  void SetOnStop(StopFn on_stop) { on_stop_ = std::move(on_stop); }

  uint64_t ConsumeCapturedFrames() { return captured_frames_.exchange(0); }
  std::string active_backend() const {
    std::lock_guard<std::mutex> lock(state_mu_);
    return backend_name_;
  }

 private:
  void OnWgcFrame(ID3D11Texture2D* tex, int content_w, int content_h);
  void EmitNv12(Microsoft::WRL::ComPtr<ID3D11Texture2D> nv12, int width, int height, bool fresh_capture);
  void WorkerLoop();

  std::shared_ptr<D3DContext> d3d_;
  LogFn log_;
  StopFn on_stop_;

  mutable std::mutex state_mu_;
  bool window_mode_ = false;
  DisplayInfo display_{};
  HWND hwnd_ = nullptr;
  int dst_w_ = 1920;
  int dst_h_ = 1080;
  std::atomic<int> target_fps_{60};
  std::atomic<bool> paused_{false};
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> captured_frames_{0};
  std::atomic<uint64_t> wgc_frames_{0};
  std::string backend_name_ = "none";
  std::string fusion_layout_;

  std::unique_ptr<WgcCapturer> wgc_;
  std::thread worker_;

  std::mutex latest_mu_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> latest_nv12_;
  int latest_w_ = 0;
  int latest_h_ = 0;
  int64_t last_fresh_ms_ = 0;
  int64_t last_emit_ms_ = 0;
};

}  // namespace linkshell
