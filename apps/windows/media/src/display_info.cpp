#include "display_info.hpp"

#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>

#include "common.hpp"

namespace linkshell {

using Microsoft::WRL::ComPtr;

namespace {

bool ContainsCaseInsensitive(const std::string& haystack, const char* needle) {
  std::string h = haystack;
  std::string n = needle;
  for (char& c : h) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  for (char& c : n) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return h.find(n) != std::string::npos;
}

bool IsVirtualAdapterName(const std::string& adapter) {
  return ContainsCaseInsensitive(adapter, "Virtual Display") ||
         ContainsCaseInsensitive(adapter, "IddSampleDriver") ||
         ContainsCaseInsensitive(adapter, "MttVDD") ||
         ContainsCaseInsensitive(adapter, "SudoVDA") ||
         ContainsCaseInsensitive(adapter, "Parsec Virtual");
}

struct MonitorCollect {
  std::vector<DisplayInfo> list;
};

BOOL CALLBACK EnumMonitorProc(HMONITOR hmon, HDC, LPRECT, LPARAM lparam) {
  auto* ctx = reinterpret_cast<MonitorCollect*>(lparam);
  MONITORINFOEXW mi{};
  mi.cbSize = sizeof(mi);
  if (!GetMonitorInfoW(hmon, &mi)) return TRUE;

  DisplayInfo info;
  info.hmonitor = hmon;
  info.device_name = mi.szDevice;
  info.bounds = mi.rcMonitor;
  info.width = mi.rcMonitor.right - mi.rcMonitor.left;
  info.height = mi.rcMonitor.bottom - mi.rcMonitor.top;
  info.main = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;

  DEVMODEW dm{};
  dm.dmSize = sizeof(dm);
  if (EnumDisplaySettingsW(mi.szDevice, ENUM_CURRENT_SETTINGS, &dm)) {
    if (dm.dmPelsWidth > 0 && dm.dmPelsHeight > 0) {
      info.width = static_cast<int>(dm.dmPelsWidth);
      info.height = static_cast<int>(dm.dmPelsHeight);
    }
    if (dm.dmDisplayFrequency > 1 && dm.dmDisplayFrequency <= 500) {
      info.refresh_hz = static_cast<int>(dm.dmDisplayFrequency);
    }
  }

  DISPLAY_DEVICEW adapter{};
  adapter.cb = sizeof(adapter);
  for (DWORD i = 0; EnumDisplayDevicesW(nullptr, i, &adapter, 0); ++i) {
    if (_wcsicmp(adapter.DeviceName, mi.szDevice) == 0) {
      info.adapter_name = WideToUtf8(adapter.DeviceString);
      info.is_virtual = IsVirtualAdapterName(info.adapter_name);
      break;
    }
  }

  DISPLAY_DEVICEW mon_dev{};
  mon_dev.cb = sizeof(mon_dev);
  for (DWORD i = 0; EnumDisplayDevicesW(mi.szDevice, i, &mon_dev, 0); ++i) {
    if ((mon_dev.StateFlags & DISPLAY_DEVICE_ACTIVE) != 0) {
      info.has_active_monitor = true;
      break;
    }
  }

  ctx->list.push_back(std::move(info));
  return TRUE;
}

void MatchDxgiOutputs(std::vector<DisplayInfo>& displays) {
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) || !factory) return;
  ComPtr<IDXGIAdapter1> adapter;
  for (UINT ai = 0; factory->EnumAdapters1(ai, &adapter) != DXGI_ERROR_NOT_FOUND; ++ai) {
    ComPtr<IDXGIOutput> output;
    for (UINT oi = 0; adapter->EnumOutputs(oi, &output) != DXGI_ERROR_NOT_FOUND; ++oi) {
      DXGI_OUTPUT_DESC desc{};
      if (SUCCEEDED(output->GetDesc(&desc)) && desc.AttachedToDesktop) {
        for (auto& d : displays) {
          if (d.hmonitor == desc.Monitor || _wcsicmp(d.device_name.c_str(), desc.DeviceName) == 0) {
            d.dxgi_adapter = static_cast<int>(ai);
            d.dxgi_output = static_cast<int>(oi);
          }
        }
      }
      output.Reset();
    }
    adapter.Reset();
  }
}

}  // namespace

std::vector<DisplayInfo> EnumerateDisplays() {
  MonitorCollect collect;
  EnumDisplayMonitors(nullptr, nullptr, EnumMonitorProc, reinterpret_cast<LPARAM>(&collect));

  std::sort(collect.list.begin(), collect.list.end(), [](const DisplayInfo& a, const DisplayInfo& b) {
    if (a.main != b.main) return a.main > b.main;
    if (a.bounds.left != b.bounds.left) return a.bounds.left < b.bounds.left;
    return a.bounds.top < b.bounds.top;
  });

  MatchDxgiOutputs(collect.list);

  for (size_t i = 0; i < collect.list.size(); ++i) {
    auto& d = collect.list[i];
    d.screen = static_cast<int>(i);
    if (d.is_virtual) {
      d.name = "虚拟屏幕 " + std::to_string(i + 1);
    } else if (d.main) {
      d.name = "主屏幕";
    } else {
      d.name = "屏幕 " + std::to_string(i + 1);
    }
  }
  return collect.list;
}

std::optional<DisplayInfo> FindDisplay(int screen) {
  auto list = EnumerateDisplays();
  if (list.empty()) return std::nullopt;
  for (const auto& d : list) {
    if (d.screen == screen) return d;
  }
  return list.front();
}

std::pair<int, int> ComputePictureSize(int src_w, int src_h, int max_width) {
  if (src_w <= 0 || src_h <= 0) return {1920, 1080};
  int clamped_max_w = std::clamp(max_width, tuning::kNarrowestPicture, tuning::kWidestPicture);
  double max_h = clamped_max_w > 2560 ? 2160.0 : (clamped_max_w > 1920 ? 1440.0 : 1080.0);
  // Preserve ultrawide/portrait displays cleanly without upscaling.
  double scale = std::min(1.0, std::min(static_cast<double>(clamped_max_w) / src_w, max_h / src_h));
  int w = std::max(2, (static_cast<int>(std::round(src_w * scale)) / 2) * 2);
  int h = std::max(2, (static_cast<int>(std::round(src_h * scale)) / 2) * 2);
  return {w, h};
}

bool IsDefaultDesktopActive() {
  HDESK desk = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desk) return false;
  wchar_t name[128] = {};
  DWORD needed = 0;
  bool is_default = GetUserObjectInformationW(desk, UOI_NAME, name, sizeof(name), &needed) != 0 &&
                    _wcsicmp(name, L"Default") == 0;
  CloseDesktop(desk);
  return is_default;
}

void NudgeDesktopForCapture() {
  SetThreadExecutionState(ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
  RedrawWindow(nullptr, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
}

}  // namespace linkshell
