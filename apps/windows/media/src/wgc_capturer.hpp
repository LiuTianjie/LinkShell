#pragma once

#include <d3d11.h>
#include <windows.h>
#include <wrl/client.h>

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "d3d_context.hpp"

namespace linkshell {

// Native Windows.Graphics.Capture (WGC) capturer via Windows SDK COM/WinRT ABI headers.
// Works for both physical monitors, unplugged/headless monitors, virtual displays, and
// individual Fusion HWNDs — keeping every frame on GPU ID3D11Texture2D with zero CPU copy.
class WgcCapturer {
 public:
  using FrameCallback = std::function<void(ID3D11Texture2D* texture, int content_w, int content_h)>;
  using ClosedCallback = std::function<void(const std::string& reason)>;

  static bool IsSupported();

  WgcCapturer(std::shared_ptr<D3DContext> d3d, FrameCallback on_frame, ClosedCallback on_closed);
  ~WgcCapturer();

  bool StartMonitor(HMONITOR hmonitor, std::string* error = nullptr);
  bool StartWindow(HWND hwnd, std::string* error = nullptr);
  void Stop();

  bool running() const { return running_.load(); }

 private:
  struct Impl;
  bool StartWithItem(void* raw_item_unknown, std::string* error);

  std::shared_ptr<D3DContext> d3d_;
  FrameCallback on_frame_;
  ClosedCallback on_closed_;
  std::atomic<bool> running_{false};
  std::shared_ptr<Impl> impl_;
};

}  // namespace linkshell
