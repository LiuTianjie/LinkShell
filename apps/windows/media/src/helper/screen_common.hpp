#pragma once

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "helper/helper_core.hpp"
#include "json.hpp"

namespace linkshell::helper {

using json = nlohmann::json;

struct HelperDisplay {
  RECT bounds{};
  bool primary = false;
  HMONITOR monitor = nullptr;
  std::wstring device_name;
  bool has_active_monitor = false;

  int width() const { return bounds.right - bounds.left; }
  int height() const { return bounds.bottom - bounds.top; }
};

struct CursorShapeSnapshot {
  std::string id;
  std::string png;
  double width = 0;
  double height = 0;
  double hot_x = 0;
  double hot_y = 0;
  double scale = 1.0;
};

// Monotonic clock & UTF-8 / UTF-16 helpers.
int64_t MonotonicMs();
std::string WideToUtf8(std::wstring_view w);
std::wstring Utf8ToWide(std::string_view s);

// Thread-safe JSON line writer to stdout (and pipe writer).
void WriteStdoutJson(const json& value);
void WriteStdoutLine(std::string_view line);
bool WriteAllBytes(HANDLE h, const void* data, size_t len);
bool ReadExactBytes(HANDLE h, void* data, size_t len);

// Environment, paths, and CNG cryptography (SHA-256 / CSPRNG).
std::wstring GetEnvWide(const wchar_t* name);
std::wstring UserHomeDirWide();
std::wstring CurrentExePathWide();
bool FileExistsWide(const std::wstring& path);
bool DirectoryExistsWide(const std::wstring& path);
bool EnsureDirectoryTreeWide(const std::wstring& path);
std::string ReadUtf8FileWide(const std::wstring& path);
bool WriteUtf8FileWide(const std::wstring& path, std::string_view content);
std::vector<uint8_t> Sha256Bytes(const void* data, size_t len);
std::string FileSha256HexWide(const std::wstring& path);
std::string GenerateRandomHex(size_t num_bytes);
bool IsRunningAsAdministrator();

// Sharing & Windows desktop station checks.
std::wstring DesktopNameOf(HDESK handle);
void EnsureSharingEnabled(bool dry_run = false);
bool IsServiceSharingEnabledWide(const std::wstring& home);
bool IsDefaultDesktopActive(bool dry_run = false);
bool WaitForDefaultDesktop(int max_wait_ms, const std::atomic<bool>& ended);
void EnsureDesktop(bool dry_run = false);
void NudgeDesktopForCapture();

// Display enumeration & DPI scaling.
bool DisplayHasActiveMonitor(const std::wstring& device_name);
std::vector<HelperDisplay> EnumerateHelperDisplays(bool probe_monitors = true);
HelperDisplay DisplayEntry(int index, bool probe_monitors = true, bool dry_run = false);
RECT DisplayBounds(int index, bool dry_run = false);
RECT DisplayBoundsAt(POINT pt);
RECT VirtualScreenBounds();
double MonitorScale(POINT at);

// GDI+ image encoders & cursor shape capture.
bool EnsureHelperGdiPlus();
bool EncodeRgbaToPng(const uint8_t* bgra, int width, int height, int stride, std::vector<uint8_t>* out_png);
bool EncodeBgr24ToJpeg(const uint8_t* bgr, int width, int height, int stride, int quality, std::vector<uint8_t>* out_jpeg);
std::optional<CursorShapeSnapshot> CaptureCursorShape(double fallback_scale);
json ShapeMessage(const CursorShapeSnapshot& shape, const RECT& display_bounds, double display_scale, bool include_png);

// Stateful Win32 SendInput controller (shared by `<screen>`, `--service-worker control`, and `--fusion`).
class InputState {
 public:
  void Handle(const json& e, const RECT& target_bounds);
  void Release(bool dry_run = false);
  bool IsKeyHeld(WORD vk) const { return held_keys_.count(vk) != 0; }
  void TapKey(WORD vk);

 private:
  void Post(const INPUT& input);
  void Mouse(DWORD flags, int x = 0, int y = 0, int data = 0);
  void Key(WORD vk, bool up, WORD scan = 0, bool unicode = false);
  void ScanKey(WORD scan, bool up, bool extended);

  std::set<WORD> held_keys_;
  std::set<uint32_t> held_scans_;
  bool left_down_ = false;
  bool right_down_ = false;
  bool middle_down_ = false;
};

// Modes implemented across helper translation units:
void RunControlMode(int screen_index, bool dry_run);
void RunCaptureJpegMode(int screen, int width, int fps, int quality);
void RunWatchShapeMode(int screen);
void RunCaptureAudioMode();
void RunCaptureVideoMode(int screen, int width, int fps, int bitrate, const std::wstring& executable);
void RunCaptureWindowVideoMode(int64_t hwnd_val, int canvas_w, int canvas_h, int fps, int bitrate, const std::wstring& executable);

// Virtual Display Driver (MttVDD) management (`vdd_installer.cpp`):
void PrintVddStatus();
void InstallVddDriver(const std::wstring& vdd_dir);
void UninstallVddDriver();
bool SetVddNodeEnabled(bool enable);
bool ConfigureVddFromService(const std::string& mode, int width, int height, int hz, int count);

// Elevated LocalSystem service & unprivileged pipe client (`screen_service.cpp`):
void ClearServiceLastError(const std::wstring& home);
void WriteServiceLastError(const std::wstring& home, std::string_view message);
void LogServiceEvent(std::string_view message);
bool IsElevatedServiceAvailable(bool dry_run = false);
void PrintElevatedServiceStatus();
void InstallElevatedService(const std::wstring& user_sid, const std::wstring& user_home);
void UninstallElevatedService(const std::wstring& user_home);
void RunElevatedWindowsService();
void RunElevatedServiceWorker(
    const std::wstring& pipe_name,
    const std::string& mode,
    int screen,
    int w,
    int h,
    int fps,
    int quality,
    const std::string& home_b64);

HANDLE ConnectElevatedServicePipe(const std::string& mode, int screen, int w, int h, int fps, int quality);
bool TryServiceDisplaysJson(std::string* out_json);
bool TryServiceDisplayBounds(int screen, RECT* out_rect);
bool TryRunElevatedControl(int screen, bool dry_run);
bool TryStreamSecureDesktopJpeg(int screen, int width, int fps, int quality, HANDLE stdout_handle, const std::atomic<bool>& ended);
bool TryStreamSecureDesktopVideo(
    HANDLE job,
    HANDLE destination,
    const std::wstring& executable,
    int screen,
    int w,
    int h,
    int fps,
    int bitrate,
    const std::string& preferred_encoder,
    bool framed,
    const std::atomic<bool>& ended);

// Fusion remote helper (`fusion_helper.cpp`):
void RunFusionMode();

}  // namespace linkshell::helper
