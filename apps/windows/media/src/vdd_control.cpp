#include "vdd_control.hpp"

#include <cfgmgr32.h>
#include <devguid.h>
#include <setupapi.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <thread>

#include "common.hpp"
#include "dxgi_capturer.hpp"

namespace linkshell {

namespace {

bool ContainsI(const std::wstring& hay, const wchar_t* needle) {
  std::wstring h = hay;
  std::wstring n = needle;
  for (auto& c : h) c = static_cast<wchar_t>(towlower(c));
  for (auto& c : n) c = static_cast<wchar_t>(towlower(c));
  return h.find(n) != std::wstring::npos;
}

std::optional<std::pair<int, int>> ComputeTargetPixels(const MatchRequest& wanted, int current_w, int current_h) {
  if (wanted.width < 800 || wanted.height < 500 || wanted.width < wanted.height) return std::nullopt;
  double scale = (wanted.scale >= 1.25 && wanted.width <= 2560) ? std::min(2.0, wanted.scale) : 1.0;
  double target_w = wanted.width * scale;
  double target_h = wanted.height * scale;
  double shrink = std::min({1.0, 3840.0 / target_w, 2400.0 / target_h});
  int w = std::max(800, (static_cast<int>(std::llround(target_w * shrink)) / 2) * 2);
  int h = std::max(500, (static_cast<int>(std::llround(target_h * shrink)) / 2) * 2);
  if (std::abs(w - current_w) <= 2 && std::abs(h - current_h) <= 2) return std::nullopt;
  return std::make_pair(w, h);
}

}  // namespace

VddController::VddController(LogFn log) : log_(std::move(log)) {}

VddController::~VddController() {
  EndMatch();
}

VddStatus VddController::QueryStatus() {
  VddStatus status;
  HDEVINFO info = SetupDiGetClassDevsW(&GUID_DEVCLASS_DISPLAY, nullptr, nullptr, DIGCF_PRESENT);
  if (info != INVALID_HANDLE_VALUE) {
    SP_DEVINFO_DATA dev{};
    dev.cbSize = sizeof(dev);
    for (DWORD i = 0; SetupDiEnumDeviceInfo(info, i, &dev); ++i) {
      wchar_t hwid[512] = {};
      wchar_t friendly[256] = {};
      SetupDiGetDeviceRegistryPropertyW(info, &dev, SPDRP_HARDWAREID, nullptr, reinterpret_cast<PBYTE>(hwid), sizeof(hwid), nullptr);
      SetupDiGetDeviceRegistryPropertyW(info, &dev, SPDRP_DEVICEDESC, nullptr, reinterpret_cast<PBYTE>(friendly), sizeof(friendly), nullptr);
      if (ContainsI(hwid, L"mttvdd") || ContainsI(friendly, L"Virtual Display Driver") ||
          ContainsI(friendly, L"IddSampleDriver")) {
        status.installed = true;
        wchar_t inst_id[256] = {};
        if (CM_Get_Device_IDW(dev.DevInst, inst_id, ARRAYSIZE(inst_id), 0) == CR_SUCCESS) {
          status.device_id = WideToUtf8(inst_id);
        }
        ULONG dev_status = 0, problem = 0;
        if (CM_Get_DevNode_Status(&dev_status, &problem, dev.DevInst, 0) == CR_SUCCESS) {
          status.enabled = (problem == 0) && ((dev_status & DN_STARTED) != 0);
        }
        break;
      }
    }
    SetupDiDestroyDeviceInfoList(info);
  }

  for (const auto& d : EnumerateDisplays()) {
    if (d.is_virtual) {
      status.virtual_monitors += 1;
      status.active = true;
    }
  }
  return status;
}

bool VddController::CallServiceVdd(const std::string& mode, int width, int height, int hz, int count) {
  std::string token = GdiAndSecureCapturer::ReadServiceToken();
  if (token.empty()) return false;

  HANDLE h = CreateFileW(
      L"\\\\.\\pipe\\LinkShellScreenServiceV1",
      GENERIC_READ | GENERIC_WRITE,
      0,
      nullptr,
      OPEN_EXISTING,
      0,
      nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;

  json req = {
      {"token", token},
      {"mode", mode},
      {"w", width},
      {"h", height},
      {"fps", hz},
      {"count", count},
  };
  std::string line = req.dump() + "\n";
  DWORD written = 0;
  bool ok = WriteFile(h, line.data(), static_cast<DWORD>(line.size()), &written, nullptr) && written == line.size();
  if (ok) {
    char resp[512] = {};
    DWORD read = 0;
    if (ReadFile(h, resp, sizeof(resp) - 1, &read, nullptr) && read > 0) {
      std::string s(resp, read);
      ok = s.find("\"ok\":true") != std::string::npos;
    } else {
      ok = false;
    }
  }
  CloseHandle(h);
  return ok;
}

bool VddController::EnsureHeadlessDisplay() {
  auto displays = EnumerateDisplays();
  if (!displays.empty()) return true;
  auto st = QueryStatus();
  if (!st.installed) return false;
  if (log_) log_("0 displays detected on headless host; waking Virtual Display Driver (1920x1080@60)");
  if (!CallServiceVdd("vdd-enable", 1920, 1080, 60, 1)) return false;
  for (int i = 0; i < 20; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    if (!EnumerateDisplays().empty()) {
      enabled_vdd_for_session_ = true;
      return true;
    }
  }
  return false;
}

bool VddController::SaveTopology() {
  UINT32 path_count = 0, mode_count = 0;
  if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &path_count, &mode_count) != ERROR_SUCCESS) return false;
  saved_paths_.resize(path_count);
  saved_modes_.resize(mode_count);
  if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &path_count, saved_paths_.data(), &mode_count, saved_modes_.data(), nullptr) != ERROR_SUCCESS) {
    saved_paths_.clear();
    saved_modes_.clear();
    return false;
  }
  saved_paths_.resize(path_count);
  saved_modes_.resize(mode_count);
  has_saved_topology_ = !saved_paths_.empty();
  return has_saved_topology_;
}

void VddController::RestoreTopology() {
  if (has_saved_mode_ && !modified_device_.empty()) {
    ChangeDisplaySettingsExW(modified_device_.c_str(), &saved_mode_, nullptr, CDS_UPDATEREGISTRY, nullptr);
    has_saved_mode_ = false;
    modified_device_.clear();
  }
  if (has_saved_topology_ && !saved_paths_.empty()) {
    SetDisplayConfig(
        static_cast<UINT32>(saved_paths_.size()), saved_paths_.data(),
        static_cast<UINT32>(saved_modes_.size()), saved_modes_.data(),
        SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES);
    has_saved_topology_ = false;
    saved_paths_.clear();
    saved_modes_.clear();
  }
}

bool VddController::SwitchMonitorMode(const std::wstring& device_name, int width, int height, int hz) {
  DEVMODEW current{};
  current.dmSize = sizeof(current);
  if (!EnumDisplaySettingsW(device_name.c_str(), ENUM_CURRENT_SETTINGS, &current)) return false;

  // Pick exact (w, h) with best matching refresh rate <= wanted_hz (or closest available).
  DEVMODEW best{};
  bool found = false;
  int best_hz_diff = 100000;
  DEVMODEW mode{};
  mode.dmSize = sizeof(mode);
  for (DWORD i = 0; EnumDisplaySettingsW(device_name.c_str(), i, &mode); ++i) {
    if (static_cast<int>(mode.dmPelsWidth) == width && static_cast<int>(mode.dmPelsHeight) == height &&
        mode.dmBitsPerPel == 32) {
      int diff = std::abs(static_cast<int>(mode.dmDisplayFrequency) - hz);
      if (!found || diff < best_hz_diff) {
        best = mode;
        best_hz_diff = diff;
        found = true;
      }
    }
  }
  if (!found) return false;

  best.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_BITSPERPEL;
  LONG res = ChangeDisplaySettingsExW(device_name.c_str(), &best, nullptr, CDS_UPDATEREGISTRY, nullptr);
  if (res != DISP_CHANGE_SUCCESSFUL) return false;

  if (!has_saved_mode_) {
    saved_mode_ = current;
    modified_device_ = device_name;
    has_saved_mode_ = true;
  }
  return true;
}

std::optional<DisplayInfo> VddController::BeginMatch(int watching_screen, const MatchRequest& wanted, int wanted_hz) {
  EndMatch();
  auto current = FindDisplay(watching_screen);
  if (!current) return std::nullopt;

  auto target = ComputeTargetPixels(wanted, current->width, current->height);
  if (!target) return std::nullopt;

  int req_w = target->first;
  int req_h = target->second;
  int req_hz = std::clamp(wanted_hz > 0 ? wanted_hz : 60, 30, 120);

  SaveTopology();

  // Path 1: If a virtual display is already active or MttVDD is installed, configure & switch it.
  auto st = QueryStatus();
  if (st.installed) {
    // First try direct mode switch if the watched display is already a virtual monitor and has the mode.
    if (current->is_virtual && SwitchMonitorMode(current->device_name, req_w, req_h, req_hz)) {
      matched_ = true;
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      if (log_) log_("ScreenMatch: virtual display switched to " + std::to_string(req_w) + "x" + std::to_string(req_h) + "@" + std::to_string(req_hz));
      return FindDisplay(watching_screen);
    }

    // If LinkShellScreenService is available, inject the exact custom resolution into vdd_settings.xml and wake/reload MttVDD.
    if (CallServiceVdd("vdd-configure", req_w, req_h, req_hz, 1)) {
      bool was_enabled = st.enabled;
      for (int i = 0; i < 25; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        auto all = EnumerateDisplays();
        for (const auto& d : all) {
          if (d.is_virtual) {
            SwitchMonitorMode(d.device_name, req_w, req_h, req_hz);
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            matched_ = true;
            enabled_vdd_for_session_ = !was_enabled;
            if (log_) log_("ScreenMatch: virtual display ready at " + std::to_string(req_w) + "x" + std::to_string(req_h) + "@" + std::to_string(req_hz));
            auto refreshed = EnumerateDisplays();
            for (const auto& r : refreshed) {
              if (r.is_virtual) return r;
            }
            return d;
          }
        }
      }
    }
  }

  // Path 2: No VDD installed or unavailable — try switching the watched display directly if it supports the mode.
  if (SwitchMonitorMode(current->device_name, req_w, req_h, req_hz)) {
    matched_ = true;
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    if (log_) log_("ScreenMatch: display switched to native mode " + std::to_string(req_w) + "x" + std::to_string(req_h) + "@" + std::to_string(req_hz));
    return FindDisplay(watching_screen);
  }

  has_saved_topology_ = false;
  saved_paths_.clear();
  saved_modes_.clear();
  return std::nullopt;
}

void VddController::EndMatch() {
  if (!matched_ && !enabled_vdd_for_session_) return;
  bool should_disable_vdd = enabled_vdd_for_session_;
  matched_ = false;
  enabled_vdd_for_session_ = false;
  RestoreTopology();
  if (should_disable_vdd) {
    // Only disable the on-demand virtual display if physical monitors exist so a headless PC isn't left blind.
    int physical = 0;
    for (const auto& d : EnumerateDisplays()) {
      if (!d.is_virtual) physical += 1;
    }
    if (physical > 0) {
      CallServiceVdd("vdd-disable", 0, 0, 0, 0);
    }
  }
  if (log_) log_("ScreenMatch: restored original display configuration");
}

}  // namespace linkshell
