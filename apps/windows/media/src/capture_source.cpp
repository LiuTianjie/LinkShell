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
  running_.store(true);

  bool started_wgc = false;
  if (WgcCapturer::IsSupported() && display.hmonitor && IsDefaultDesktopActive()) {
    std::string wgc_err;
    wgc_ = std::make_unique<WgcCapturer>(
        d3d_,
        [this](ID3D11Texture2D* tex, int cw, int ch) { OnWgcFrame(tex, cw, ch); },
        [this](const std::string& reason) {
          if (log_) log_("WGC monitor closed: " + reason);
        });
    if (wgc_->StartMonitor(display.hmonitor, &wgc_err)) {
      started_wgc = true;
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

  worker_ = std::thread([this, started_wgc]() {
    (void)started_wgc;
    WorkerLoop();
  });
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
    running_.store(false);
    if (error) *error = wgc_err;
    return false;
  }
  if (log_) {
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
  latest_nv12_.Reset();
  latest_w_ = 0;
  latest_h_ = 0;
}

void ScreenVideoTrackSource::OnWgcFrame(ID3D11Texture2D* tex, int content_w, int content_h) {
  if (!running_.load() || paused_.load() || !tex || !d3d_) return;
  wgc_frames_.fetch_add(1);

  int64_t now_ms = NowMillis();
  int fps = target_fps_.load();
  // Pace with Mac-parity 1.1x slack so 60fps targets do not fall short on 120/144Hz panels.
  double min_gap_ms = 1000.0 / (std::max(1, fps) * 1.12);
  {
    std::lock_guard<std::mutex> lock(latest_mu_);
    if (last_emit_ms_ > 0 && static_cast<double>(now_ms - last_emit_ms_) < min_gap_ms * 0.85) {
      return;
    }
  }

  bool is_win = false;
  int dst_w = 0, dst_h = 0;
  {
    std::lock_guard<std::mutex> lock(state_mu_);
    is_win = window_mode_;
    dst_w = dst_w_;
    dst_h = dst_h_;
  }

  ComPtr<ID3D11Texture2D> nv12 = d3d_->ConvertBgraToNv12(
      tex, content_w, content_h, dst_w, dst_h,
      is_win, content_w, content_h);
  if (!nv12) return;
  EmitNv12(std::move(nv12), dst_w, dst_h, true);
}

void ScreenVideoTrackSource::EmitNv12(ComPtr<ID3D11Texture2D> nv12, int width, int height, bool fresh_capture) {
  if (!running_.load() || paused_.load() || !nv12) return;

  std::string layout;
  {
    std::lock_guard<std::mutex> lock(state_mu_);
    layout = fusion_layout_;
  }

  int64_t now_us = NowMicros();
  int64_t now_ms = now_us / 1000;
  {
    std::lock_guard<std::mutex> lock(latest_mu_);
    if (fresh_capture) {
      latest_nv12_ = nv12;
      latest_w_ = width;
      latest_h_ = height;
      last_fresh_ms_ = now_ms;
    }
    last_emit_ms_ = now_ms;
  }

  int out_w = width, out_h = height, crop_w = width, crop_h = height, crop_x = 0, crop_y = 0;
  if (!AdaptFrame(width, height, now_us, &out_w, &out_h, &crop_w, &crop_h, &crop_x, &crop_y)) {
    return;
  }

  auto buffer = webrtc::make_ref_counted<D3D11TextureBuffer>(d3d_, std::move(nv12), width, height, std::move(layout));
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> final_buf = buffer;
  if (out_w != width || out_h != height || crop_w != width || crop_h != height) {
    auto scaled = buffer->CropAndScale(crop_x, crop_y, crop_w, crop_h, out_w, out_h);
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
  bool wgc_fallback_checked = !wgc_;
  std::vector<uint8_t> cpu_bgra;

  while (running_.load()) {
    if (paused_.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }

    int64_t now_ms = NowMillis();

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
            wgc_fallback_checked = false;
            std::lock_guard<std::mutex> lock(state_mu_);
            backend_name_ = "wgc";
            if (log_) log_("restored GPU WGC capture after returning from secure desktop");
            NudgeDesktopForCapture();
          } else {
            wgc_.reset();
            wgc_fallback_checked = true;
          }
        }
      }
    }

    // 2. Active Secure Desktop pipe frame read.
    if (using_secure) {
      int sw = 0, sh = 0;
      if (gdi_secure.ReadSecureFrame(&cpu_bgra, &sw, &sh)) {
        auto nv12 = d3d_->UploadBgraToNv12(cpu_bgra.data(), sw, sh, sw * 4, dst_w, dst_h);
        if (nv12) EmitNv12(std::move(nv12), dst_w, dst_h, true);
      } else {
        using_secure = false;
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
      }
      continue;
    }

    // 3. If WGC is active, check 1.8s first-frame watchdog (e.g. completely static desktop or broken driver)
    //    and perform Mac-parity settle (100ms) / idle (500ms) frame repeats so PLI and text sharpening work immediately.
    if (wgc_ && wgc_->running()) {
      if (!wgc_fallback_checked && wgc_frames_.load() == 0 && (now_ms - started_ms) > 1200) {
        if (!is_window) {
          // Static monitor: seed one GDI frame so the viewer gets an instant picture even before any pixel changes.
          int gw = 0, gh = 0;
          if (gdi_secure.CaptureGdi(display.bounds, &cpu_bgra, &gw, &gh)) {
            auto nv12 = d3d_->UploadBgraToNv12(cpu_bgra.data(), gw, gh, gw * 4, dst_w, dst_h);
            if (nv12) EmitNv12(std::move(nv12), dst_w, dst_h, true);
          }
        }
        wgc_fallback_checked = true;
      }

      ComPtr<ID3D11Texture2D> repeat_tex;
      int rw = 0, rh = 0;
      bool should_repeat = false;
      {
        std::lock_guard<std::mutex> lock(latest_mu_);
        if (latest_nv12_) {
          int64_t since_fresh = now_ms - last_fresh_ms_;
          int64_t since_emit = now_ms - last_emit_ms_;
          int interval = since_fresh < tuning::kSettleWindowMs ? tuning::kSettleRepeatMs : tuning::kIdleRepeatMs;
          if (since_emit >= interval) {
            repeat_tex = latest_nv12_;
            rw = latest_w_;
            rh = latest_h_;
            should_repeat = true;
          }
        }
      }
      if (should_repeat && repeat_tex) {
        EmitNv12(std::move(repeat_tex), rw, rh, false);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      continue;
    }

    if (is_window) {
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
        auto nv12 = d3d_->ConvertBgraToNv12(tex.Get(), tw, th, dst_w, dst_h);
        if (nv12) EmitNv12(std::move(nv12), dst_w, dst_h, true);
      } else if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        ComPtr<ID3D11Texture2D> repeat_tex;
        int rw = 0, rh = 0;
        {
          std::lock_guard<std::mutex> lock(latest_mu_);
          if (latest_nv12_ && (NowMillis() - last_emit_ms_) >= tuning::kIdleRepeatMs) {
            repeat_tex = latest_nv12_;
            rw = latest_w_;
            rh = latest_h_;
          }
        }
        if (repeat_tex) EmitNv12(std::move(repeat_tex), rw, rh, false);
      } else {
        dxgi.Close();
        using_dxgi = false;
        using_gdi = true;
        std::lock_guard<std::mutex> lock(state_mu_);
        backend_name_ = "gdi";
        if (log_) log_("DXGI duplication lost (" + std::to_string(hr) + "); switching to GDI");
      }
    } else if (using_gdi) {
      int fps = std::clamp(target_fps_.load(), 1, 30);
      int64_t frame_start = NowMillis();
      int gw = 0, gh = 0;
      if (gdi_secure.CaptureGdi(display.bounds, &cpu_bgra, &gw, &gh)) {
        auto nv12 = d3d_->UploadBgraToNv12(cpu_bgra.data(), gw, gh, gw * 4, dst_w, dst_h);
        if (nv12) EmitNv12(std::move(nv12), dst_w, dst_h, true);
      }
      int elapsed = static_cast<int>(NowMillis() - frame_start);
      int sleep_ms = std::max(5, (1000 / fps) - elapsed);
      std::this_thread::sleep_for(std::chrono::milliseconds(sleep_ms));
    }
  }

  gdi_secure.CloseSecurePipe();
  dxgi.Close();
}

}  // namespace linkshell
