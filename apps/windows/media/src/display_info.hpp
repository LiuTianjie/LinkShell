#pragma once

#include <windows.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace linkshell {

struct DisplayInfo {
  int screen = 0;            // 0-based stable index (primary first, then left-to-right)
  HMONITOR hmonitor = nullptr;
  std::wstring device_name;  // e.g. L"\\\\.\\DISPLAY1"
  std::string name;          // human-friendly label
  std::string adapter_name;  // GPU/driver DeviceString
  RECT bounds{};             // virtual desktop pixel coordinates
  int width = 0;
  int height = 0;
  int refresh_hz = 60;
  bool main = false;
  bool has_active_monitor = false;
  bool is_virtual = false;   // MttVDD / IddCx virtual display
  int dxgi_adapter = -1;
  int dxgi_output = -1;
};

std::vector<DisplayInfo> EnumerateDisplays();
std::optional<DisplayInfo> FindDisplay(int screen);
std::pair<int, int> ComputePictureSize(int src_w, int src_h, int max_width);
bool IsDefaultDesktopActive();
void NudgeDesktopForCapture();

}  // namespace linkshell
