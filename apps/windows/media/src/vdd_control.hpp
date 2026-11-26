#pragma once

#include <windows.h>

#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "display_info.hpp"

namespace linkshell {

struct MatchRequest {
  double width = 0;
  double height = 0;
  double scale = 1.0;
};

struct VddStatus {
  bool installed = false;
  bool enabled = false;
  bool active = false;
  std::string device_id;
  int virtual_monitors = 0;
};

// Manages optional Virtual Display Driver (MttVDD) integration and Mac-parity ScreenMatch
// (dynamic resolution matching + cold-boot headless virtual monitor wake + guaranteed restore).
class VddController {
 public:
  using LogFn = std::function<void(const std::string&)>;

  explicit VddController(LogFn log = {});
  ~VddController();

  static VddStatus QueryStatus();

  // If the PC booted with 0 usable displays and MttVDD is installed, wakes the virtual display via
  // LinkShellScreenService so remote desktop works even on a true cold-boot headless PC.
  bool EnsureHeadlessDisplay();

  // Applies viewer resolution matching (ScreenMatch):
  // - If MttVDD is installed (and either enabled or manageable via LinkShellScreenService),
  //   activates/sizes the virtual monitor to match the viewer's aspect ratio and DPI.
  // - Otherwise, if the watched display natively supports the requested mode, switches cleanly
  //   and restores the original mode on EndMatch().
  std::optional<DisplayInfo> BeginMatch(int watching_screen, const MatchRequest& wanted, int wanted_hz);

  // Restores exact original display mode / topology and disables on-demand virtual display.
  void EndMatch();

 private:
  static bool CallServiceVdd(const std::string& mode, int width, int height, int hz, int count);
  bool SaveTopology();
  void RestoreTopology();
  bool SwitchMonitorMode(const std::wstring& device_name, int width, int height, int hz);

  LogFn log_;
  bool matched_ = false;
  bool enabled_vdd_for_session_ = false;
  std::wstring modified_device_;
  DEVMODEW saved_mode_{};
  bool has_saved_mode_ = false;
  std::vector<DISPLAYCONFIG_PATH_INFO> saved_paths_;
  std::vector<DISPLAYCONFIG_MODE_INFO> saved_modes_;
  bool has_saved_topology_ = false;
};

}  // namespace linkshell
