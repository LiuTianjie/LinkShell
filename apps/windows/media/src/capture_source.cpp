#include "capture_source.hpp"

#include <algorithm>
#include <chrono>

#include "api/make_ref_counted.h"
#include "api/video/video_frame.h"
#include "common.hpp"

namespace linkshell {

using Microsoft::WRL::ComPtr;

ScreenVideoTrackSource::ScreenVideoTrackSource(std::shared_ptr<D3DContext> d3d, LogFn log)
    : AdaptedVideoTrackSource(2), d3d_(std::move(d3d)), log_(std::move(log)) {}

ScreenVideoTrackSource::~ScreenVideoTrackSource() {
  Stop();
}

void ScreenVideoTrackSource::SetFusionLayout(const std::string& layout_json) {
  std::lock_guard<std::mutex> lock(state_mu_);
  fusion_layout_ = layout_json;
}

void ScreenVideoTrackSource::SetTargetFps(int fps) {
  target_fps_.store(std::clamp(fps, tuning::kMinFps, tuning::kMaxFps));
}

void ScreenVideoTrackSource::SetPaused(bool paused) {
  paused_.store(paused);
}

void ScreenVideoTrackSource::ResendLatest() {
  if (!running_.load() || paused_.load()) return;
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> buf;
  {
    std::lock_guard<std::mutex> lock(latest_mu_);
    buf = latest_frame_;
  }
  if (buf) EmitFrame(std::move(buf), false);
}

bool ScreenVideoTrackSource::StartDisplay(
    const DisplayInfo& display,
    int dst_w,
    int dst_h,
    int target_fps,
    std::string* error) {
  Stop();
  {
    std::lock_guard<std::mutex> lock(state_mu_);
    window_mode_ = false;
    display_ = display;
    hwnd_ = nullptr;
    dst_w_ = std::max(2, (dst_w / 2) * 2);
    dst_h_ = std::max(2, (dst_h / 2) * 2);
    backend_name_ = "initializing";
  }
  target_fps_.store(std::clamp(target_fps, tuning::kMinFps, tuning::kMaxFps));
  paused_.store(false);
  wgc_frames_.store(0);
  logged_first_frame_.store(false);
  logged_convert_err_.store(false);
  running_.store(true);

  if (WgcCapturer::IsSupported() && display.hmonitor && IsDefaultDesktopActive()) {
    std::string wgc_err;
    wgc_ = std::make_unique<WgcCapturer>(
        d3d_,
        [this](ID3D11Texture2D* tex, int cw, int ch) { OnWgcFrame(tex, cw, ch); },
        [this](const std::string& reason) {
          if (log_) log_("WGC monitor closed: " + reason);
        });
    if (wgc_->StartMonitor(display.hmonitor, &wgc_err)) {
      std::lock_guard<std::mutex> lock(state_mu_);
      backend_name_ = "wgc";
      if (log_) {
        log_("GPU WGC monitor capture started (" + std::to_string(display.width) + "x" +
             std::to_string(display.height) + " -> " + std::to_string(dst_w_) + "x" +
             std::to_string(dst_h_) + ", activeMonitor=" + (display.has_active_monitor ? "true" : "false") + ")");
      }
      NudgeDesktopForCapture();
    } else {
      wgc_.reset();
      if (log_) log_("WGC monitor unavailable (" + wgc_err + "); falling back to DXGI/GDI");
    }
  }

  worker_ = std::thread([this]() { WorkerLoop(); });
  return true;
}

bool ScreenVideoTrackSource::StartWindow(
    HWND hwnd,
    int canvas_w,
    int canvas_h,
    int target_fps,
    std::string* error) {
  Stop();
  if (!hwnd || !IsWindow(hwnd)) {
    if (error) *error = "window is closed";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(state_mu_);
    window_mode_ = true;
    hwnd_ = hwnd;
    dst_w_ = std::max(2, (canvas_w / 2) * 2);
    dst_h_ = std::max(2, (canvas_h / 2) * 2);
    backend_name_ = "wgc-window";
  }
  target_fps_.store(std::clamp(target_fps, tuning::kMinFps, tuning::kMaxFps));
  paused_.store(false);
  wgc_frames_.store(0);
  logged_first_frame_.store(false);
  logged_convert_err_.store(false);
  running_.store(true);

  std::string wgc_err;
  wgc_ = std::make_unique<WgcCapturer>(
      d3d_,
      [this](ID3D11Texture2D* tex, int cw, int ch) { OnWgcFrame(tex, cw, ch); },
      [this](const std::string& reason) {
        if (running_.load() && on_stop_) on_stop_(reason);
      });
  if (!wgc_->StartWindow(hwnd, &wgc_err)) {
    wgc_.reset();
    if (log_) {
      log_("WGC window capture unavailable (" + wgc_err + "); falling back to PrintWindow for hwnd=" +
           std::to_string(reinterpret_cast<uintptr_t>(hwnd)));
    }
  } else if (log_) {
    log_("GPU WGC window capture started (hwnd=" + std::to_string(reinterpret_cast<uintptr_t>(hwnd)) +
         ", canvas=" + std::to_string(dst_w_) + "x" + std::to_string(dst_h_) + ")");
  }
  worker_ = std::thread([this]() { WorkerLoop(); });
  return true;
}

void ScreenVideoTrackSource::Stop() {
  running_.store(false);
  // Join worker before tearing down WGC so WorkerLoop never races on wgc_.
  if (worker_.joinable()) worker_.join();
  if (wgc_) {
    wgc_->Stop();
    wgc_.reset();
  }
  std::lock_guard<std::mutex> lock(latest_mu_);
  latest_frame_ = nullptr;
}

void ScreenVideoTrackSource::OnWgcFrame(ID3D11Texture2D* tex, int content_w, int content_h) {
  if (!running_.load() || paused_.load() || !tex || !d3d_) return;
  wgc_frames_.fetch_add(1);

  // Microsecond-accurate pacing avoids beat-frequency judder at 60/120 Hz on 120/144/240 Hz panels.
  int64_t now_us = NowMicros();
  int fps = target_fps_.load();
  double min_gap_us = 1'000'000.0 / (std::max(1, fps) * 1.12);
  {
    std::lock_guard<std::mutex> lock(latest_mu_);
    if (last_emit_us_ > 0 && static_cast<double>(now_us - last_emit_us_) < min_gap_us * 0.85) {
      return;
    }
  }

  bool is_win = false;
  int dst_w = 0, dst_h = 0;
  std::string layout;
  {
    std::lock_guard<std::mutex> lock(state_mu_);
    is_win = window_mode_;
    dst_w = dst_w_;
    dst_h = dst_h_;
    layout = fusion_layout_;
  }

  auto buf = d3d_->ConvertBgraToFrame(
      tex, content_w, content_h, dst_w, dst_h,
      layout, is_win, content_w, content_h);
  if (!buf) {
    if (!logged_convert_err_.exchange(true) && log_) {
      log_("WGC BGRA->NV12 convert failed: " + d3d_->last_error());
    }
    return;
  }
  EmitFrame(std::move(buf), true);
}

void ScreenVideoTrackSource::EmitFrame(webrtc::scoped_refptr<webrtc::VideoFrameBuffer> buf, bool fresh_capture) {
  if (!running_.load() || paused_.load() || !buf) return;

  int width = buf->width();
  int height = buf->height();
  int64_t now_us = NowMicros();
  int64_t now_ms = now_us / 1000;
  {
    std::lock_guard<std::mutex> lock(latest_mu_);
    if (fresh_capture) {
      latest_frame_ = buf;
      last_fresh_ms_ = now_ms;
    }
    last_emit_us_ = now_us;
  }

  if (!logged_first_frame_.exchange(true) && log_) {
    bool is_gpu = (buf->type() == webrtc::VideoFrameBuffer::Type::kNative)
                      ? static_cast<D3D11TextureBuffer*>(buf.get())->is_gpu()
                      : false;
    std::string be = active_backend();
    std::string err = d3d_ ? d3d_->last_error() : "";
    log_("first frame captured: backend=" + be + " " + std::to_string(width) + "x" +
         std::to_string(height) + " gpu=" + (is_gpu ? "true" : "false") +
         (err.empty() ? "" : (" (note: " + err + ")")));
  }

  int out_w = width, out_h = height, crop_w = width, crop_h = height, crop_x = 0, crop_y = 0;
  if (!AdaptFrame(width, height, now_us, &out_w, &out_h, &crop_w, &crop_h, &crop_x, &crop_y)) {
    return;
  }

  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> final_buf = buf;
  if (out_w != width || out_h != height || crop_w != width || crop_h != height) {
    auto scaled = buf->CropAndScale(crop_x, crop_y, crop_w, crop_h, out_w, out_h);
    if (scaled) final_buf = std::move(scaled);
  }

  webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
                                 .set_video_frame_buffer(final_buf)
                                 .set_timestamp_us(now_us)
                                 .set_rotation(webrtc::kVideoRotation_0)
                                 .build();
  if (fresh_capture) captured_frames_.fetch_add(1);
  OnFrame(frame);
}

void ScreenVideoTrackSource::WorkerLoop() {
  const int64_t started_ms = NowMillis();
  bool is_window = false;
  DisplayInfo display{};
  int dst_w = 1920, dst_h = 1080;
  {
    std::lock_guard<std::mutex> lock(state_mu_);
    is_window = window_mode_;
    display = display_;
    dst_w = dst_w_;
    dst_h = dst_h_;
  }

  DxgiDuplicationCapturer dxgi(d3d_);
  GdiAndSecureCapturer gdi_secure;
  bool using_dxgi = false;
  bool using_gdi = false;
  bool using_secure = false;
  bool wgc_gdi_assist = false;
  int gdi_timing_samples = 0;
  int64_t gdi_cap_ms_sum = 0;
  int64_t gdi_up_ms_sum = 0;
  std::vector<uint8_t> cpu_bgra;

  while (running_.load()) {
    if (paused_.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }

    int64_t now_ms = NowMillis();
    std::string layout;
    {
      std::lock_guard<std::mutex> lock(state_mu_);
      layout = fusion_layout_;
    }

    // 1. Check for Secure Desktop (UAC / Lock Screen) transition on display capture.
    if (!is_window) {
      bool default_desk = IsDefaultDesktopActive();
      if (!default_desk && !using_secure) {
        if (wgc_) wgc_->Stop();
        dxgi.Close();
        using_dxgi = false;
        using_gdi = false;
        if (gdi_secure.OpenSecurePipe(display.screen, dst_w, dst_h, std::min(30, target_fps_.load()))) {
          using_secure = true;
          std::lock_guard<std::mutex> lock(state_mu_);
          backend_name_ = "secure-desktop";
          if (log_) log_("switched to LinkShellScreenService secure desktop capture (UAC/Lock Screen)");
        } else {
          std::this_thread::sleep_for(std::chrono::milliseconds(150));
          continue;
        }
      } else if (default_desk && using_secure) {
        gdi_secure.CloseSecurePipe();
        using_secure = false;
        if (WgcCapturer::IsSupported() && display.hmonitor) {
          std::string err;
          wgc_ = std::make_unique<WgcCapturer>(
              d3d_,
              [this](ID3D11Texture2D* tex, int cw, int ch) { OnWgcFrame(tex, cw, ch); },
              [this](const std::string& reason) {
                if (log_) log_("WGC monitor closed: " + reason);
              });
          if (wgc_->StartMonitor(display.hmonitor, &err)) {
            wgc_frames_.store(0);
            wgc_gdi_assist = false;
            std::lock_guard<std::mutex> lock(state_mu_);
            backend_name_ = "wgc";
            if (log_) log_("restored GPU WGC capture after returning from secure desktop");
            NudgeDesktopForCapture();
          } else {
            wgc_.reset();
          }
        }
      }
    }

    // 2. Active Secure Desktop pipe frame read.
    if (using_secure) {
      int sw = 0, sh = 0;
      if (gdi_secure.ReadSecureFrame(&cpu_bgra, &sw, &sh)) {
        auto buf = d3d_->UploadBgraToFrame(cpu_bgra.data(), sw, sh, sw * 4, dst_w, dst_h, layout);
        if (buf) EmitFrame(std::move(buf), true);
      } else {
        using_secure = false;
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
      }
      continue;
    }

    // 3. WGC active: monitor watchdog for headless/static screens + Mac-parity settle/idle repeats.
    if (wgc_ && wgc_->running()) {
      const int64_t wait_threshold_ms = is_window ? 250 : (display.has_active_monitor ? 1000 : 120);
      if (wgc_frames_.load() == 0 && (now_ms - started_ms) >= wait_threshold_ms) {
        if (!wgc_gdi_assist) {
          wgc_gdi_assist = true;
          if (log_) {
            log_(std::string("WGC produced 0 frames after ") + std::to_string(wait_threshold_ms) +
                 "ms; streaming " + (is_window ? "PrintWindow" : "GDI") + " live assist while keeping WGC armed");
          }
        }
        int64_t t0 = NowMillis();
        const uint8_t* ptr = nullptr;
        int gw = 0, gh = 0;
        if (is_window) {
          HWND win = nullptr;
          {
            std::lock_guard<std::mutex> lock(state_mu_);
            win = hwnd_;
          }
          if (!win || !IsWindow(win)) {
            if (running_.exchange(false) && on_stop_) on_stop_("window closed");
            break;
          }
          if (gdi_secure.CaptureWindowDirect(win, &ptr, &gw, &gh) && ptr) {
            auto buf = d3d_->UploadBgraToFrame(ptr, gw, gh, gw * 4, dst_w, dst_h, layout, true, gw, gh);
            if (buf) EmitFrame(std::move(buf), true);
          }
        } else {
          if (gdi_secure.CaptureGdiDirect(display.bounds, &ptr, &gw, &gh) && ptr) {
            int64_t t1 = NowMillis();
            auto buf = d3d_->UploadBgraToFrame(ptr, gw, gh, gw * 4, dst_w, dst_h, layout);
            int64_t t2 = NowMillis();
            if (gdi_timing_samples < 20) {
              gdi_cap_ms_sum += (t1 - t0);
              gdi_up_ms_sum += (t2 - t1);
              gdi_timing_samples += 1;
              if (gdi_timing_samples == 20 && log_) {
                log_("GDI live assist avg (20 frames): capture=" +
                     std::to_string(gdi_cap_ms_sum / 20) + "ms upload+nv12=" +
                     std::to_string(gdi_up_ms_sum / 20) + "ms (" + std::to_string(gw) + "x" + std::to_string(gh) + ")");
              }
            }
            if (buf) EmitFrame(std::move(buf), true);
          }
        }
        int fps = std::clamp(target_fps_.load(), 1, 60);
        int elapsed = static_cast<int>(NowMillis() - t0);
        int sleep_ms = std::max(1, (1000 / fps) - elapsed);
        std::this_thread::sleep_for(std::chrono::milliseconds(sleep_ms));
        continue;
      }

      webrtc::scoped_refptr<webrtc::VideoFrameBuffer> repeat_buf;
      bool should_repeat = false;
      {
        std::lock_guard<std::mutex> lock(latest_mu_);
        if (latest_frame_) {
          int64_t since_fresh = now_ms - last_fresh_ms_;
          int64_t since_emit = now_ms - (last_emit_us_ / 1000);
          int interval = since_fresh < tuning::kSettleWindowMs ? tuning::kSettleRepeatMs : tuning::kIdleRepeatMs;
          if (since_emit >= interval) {
            repeat_buf = latest_frame_;
            should_repeat = true;
          }
        }
      }
      if (should_repeat && repeat_buf) {
        EmitFrame(std::move(repeat_buf), false);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      continue;
    }

    if (is_window) {
      int64_t t0 = NowMillis();
      HWND win = nullptr;
      {
        std::lock_guard<std::mutex> lock(state_mu_);
        win = hwnd_;
      }
      if (!win || !IsWindow(win)) {
        if (running_.exchange(false) && on_stop_) on_stop_("window closed");
        break;
      }
      const uint8_t* ptr = nullptr;
      int gw = 0, gh = 0;
      if (gdi_secure.CaptureWindowDirect(win, &ptr, &gw, &gh) && ptr) {
        auto buf = d3d_->UploadBgraToFrame(ptr, gw, gh, gw * 4, dst_w, dst_h, layout, true, gw, gh);
        if (buf) EmitFrame(std::move(buf), true);
      }
      int fps = std::clamp(target_fps_.load(), 1, 60);
      int elapsed = static_cast<int>(NowMillis() - t0);
      std::this_thread::sleep_for(std::chrono::milliseconds(std::max(1, (1000 / fps) - elapsed)));
      continue;
    }

    if (!running_.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }

    // 4. Fallback chain when WGC is unavailable (older Win10 <1903): DXGI Desktop Duplication -> GDI.
    if (!using_dxgi && !using_gdi) {
      std::string derr;
      if (display.has_active_monitor && dxgi.Open(display, &derr)) {
        using_dxgi = true;
        std::lock_guard<std::mutex> lock(state_mu_);
        backend_name_ = "dxgi";
        if (log_) log_("GPU DXGI Desktop Duplication capture started");
      } else {
        using_gdi = true;
        std::lock_guard<std::mutex> lock(state_mu_);
        backend_name_ = "gdi";
        if (log_) log_("GDI desktop capture started (" + derr + ")");
      }
    }

    if (using_dxgi) {
      int fps = std::max(1, target_fps_.load());
      int wait_ms = std::clamp(1000 / fps, 8, 50);
      ComPtr<ID3D11Texture2D> tex;
      int tw = 0, th = 0;
      HRESULT hr = dxgi.Acquire(wait_ms, &tex, &tw, &th);
      if (SUCCEEDED(hr) && tex) {
        auto buf = d3d_->ConvertBgraToFrame(tex.Get(), tw, th, dst_w, dst_h, layout);
        if (buf) EmitFrame(std::move(buf), true);
      } else if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        webrtc::scoped_refptr<webrtc::VideoFrameBuffer> repeat_buf;
        {
          std::lock_guard<std::mutex> lock(latest_mu_);
          if (latest_frame_ && (NowMillis() - (last_emit_us_ / 1000)) >= tuning::kIdleRepeatMs) {
            repeat_buf = latest_frame_;
          }
        }
        if (repeat_buf) EmitFrame(std::move(repeat_buf), false);
      } else {
        dxgi.Close();
        using_dxgi = false;
        using_gdi = true;
        std::lock_guard<std::mutex> lock(state_mu_);
        backend_name_ = "gdi";
        if (log_) log_("DXGI duplication lost (" + std::to_string(hr) + "); switching to GDI");
      }
    } else if (using_gdi) {
      int fps = std::clamp(target_fps_.load(), 1, 60);
      int64_t frame_start = NowMillis();
      const uint8_t* ptr = nullptr;
      int gw = 0, gh = 0;
      if (gdi_secure.CaptureGdiDirect(display.bounds, &ptr, &gw, &gh) && ptr) {
        auto buf = d3d_->UploadBgraToFrame(ptr, gw, gh, gw * 4, dst_w, dst_h, layout);
        if (buf) EmitFrame(std::move(buf), true);
      }
      int elapsed = static_cast<int>(NowMillis() - frame_start);
      int sleep_ms = std::max(1, (1000 / fps) - elapsed);
      std::this_thread::sleep_for(std::chrono::milliseconds(sleep_ms));
    }
  }

  gdi_secure.CloseSecurePipe();
  dxgi.Close();
}

}  // namespace linkshell
