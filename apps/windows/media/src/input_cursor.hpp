#pragma once

#include <windows.h>

#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>

#include "common.hpp"
#include "display_info.hpp"

namespace linkshell {

struct CursorShapePayload {
  std::string id;
  std::string png_base64;
  int w = 0;
  int h = 0;
  int hot_x = 0;
  int hot_y = 0;
  int scale = 1;
  int display_w = 0;
  int display_h = 0;
};

// Native Win32 SendInput + W3C physical keyboard codes (`keys: true`) + elevated service pipe
// forwarding for Admin/UAC windows + 60Hz cursor position + 5Hz PNG cursor shape capture.
class InputCursorController {
 public:
  using LogFn = std::function<void(const std::string&)>;

  explicit InputCursorController(LogFn log = {});
  ~InputCursorController();

  void SetDisplay(const DisplayInfo& display);
  void SetGeneration(std::optional<int64_t> generation);
  void SetSuspended(bool suspended);

  // Processes a validated JSON event from the "input" or "pointer" DataChannel.
  // Returns true if accepted & applied (counts as user activity).
  bool HandleEvent(const json& event, bool lossy);

  // Releases any currently held mouse buttons or physical keys.
  void ReleaseAll();

  // Returns normalized (x, y) in [0, 1] when the cursor moved since the last poll.
  std::optional<std::pair<double, double>> PollCursor(bool force = false);

  // Returns current cursor shape; full PNG only on first encounter of a shape id.
  std::optional<CursorShapePayload> PollShape(bool force = false);

 private:
  bool ShouldForwardElevated(bool force_refresh);
  bool ForwardToService(const json& event);
  void DrainServicePipe();
  void CloseServicePipe();

  void SendMouse(DWORD flags, int dx = 0, int dy = 0, DWORD data = 0);
  void SendVirtualKey(WORD vk, bool up, bool extended = false);
  void SendScanCode(WORD scan, bool up, bool extended);
  void SendUnicodeText(const std::string& utf8);

  static bool MapW3CCodeToScan(const std::string& code, WORD* out_scan, bool* out_extended);
  static WORD MapNamedKeyToVk(const std::string& name, bool* out_extended);

  LogFn log_;
  mutable std::mutex mu_;
  DisplayInfo display_{};
  bool suspended_ = false;
  std::optional<int64_t> active_generation_;
  int64_t newest_event_ = -1;

  bool left_down_ = false;
  bool right_down_ = false;
  bool middle_down_ = false;
  std::set<uint32_t> held_scans_;  // (extended << 16) | scan

  double last_cursor_x_ = -1.0;
  double last_cursor_y_ = -1.0;
  HCURSOR last_hcursor_ = nullptr;
  std::string last_shape_id_;
  std::unordered_map<std::string, CursorShapePayload> shape_cache_;

  HANDLE svc_pipe_ = INVALID_HANDLE_VALUE;
  int svc_screen_ = -1;
  std::string cached_svc_token_;
  int64_t cached_svc_token_ms_ = -60'000;
  bool cached_elevated_ = false;
  int64_t cached_elevated_ms_ = -60'000;
};

}  // namespace linkshell
