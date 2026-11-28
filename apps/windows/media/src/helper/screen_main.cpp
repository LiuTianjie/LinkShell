#include "helper/screen_common.hpp"

#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

int ParseIntArg(const std::wstring& s, const char* label) {
  try {
    size_t idx = 0;
    int v = std::stoi(s, &idx, 10);
    if (idx != s.size()) throw std::invalid_argument("trailing");
    return v;
  } catch (...) {
    throw std::runtime_error(std::string("无效的参数：") + label);
  }
}

int64_t ParseInt64Arg(const std::wstring& s, const char* label) {
  try {
    size_t idx = 0;
    long long v = std::stoll(s, &idx, 10);
    if (idx != s.size()) throw std::invalid_argument("trailing");
    return static_cast<int64_t>(v);
  } catch (...) {
    throw std::runtime_error(std::string("无效的参数：") + label);
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  using namespace linkshell::helper;

  std::vector<std::wstring> args;
  args.reserve(static_cast<size_t>(std::max(0, argc - 1)));
  for (int i = 1; i < argc; ++i) {
    if (argv[i]) args.emplace_back(argv[i]);
  }

  bool is_service_mode = !args.empty() && (args[0] == L"--service" || args[0] == L"--service-worker");
  if (!is_service_mode) {
    SetConsoleCP(CP_UTF8);
    SetConsoleOutputCP(CP_UTF8);
  }

  bool dry_run = false;
  for (const auto& a : args) {
    if (a == L"--dry-run") dry_run = true;
  }

  if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
    SetProcessDPIAware();
  }

  HDESK attached_desktop = nullptr;
  auto close_desktop = [&]() {
    if (attached_desktop) {
      CloseDesktop(attached_desktop);
      attached_desktop = nullptr;
    }
  };

  try {
    if (args.size() == 1 && args[0] == L"--service") {
      RunElevatedWindowsService();
      return 0;
    }
    if (args.size() == 9 && args[0] == L"--service-worker") {
      RunElevatedServiceWorker(
          args[1],
          WideToUtf8(args[2]),
          ParseIntArg(args[3], "screen"),
          ParseIntArg(args[4], "width"),
          ParseIntArg(args[5], "height"),
          ParseIntArg(args[6], "fps"),
          ParseIntArg(args[7], "quality"),
          WideToUtf8(args[8]));
      return 0;
    }
    if (args.size() >= 2 && args[0] == L"--install-service") {
      std::wstring target_home = args.size() >= 3 ? args[2] : UserHomeDirWide();
      try {
        ClearServiceLastError(target_home);
        InstallElevatedService(args[1], target_home);
      } catch (const std::exception& err) {
        WriteServiceLastError(target_home, err.what());
        throw;
      }
      return 0;
    }
    if (args.size() >= 1 && args[0] == L"--uninstall-service") {
      std::wstring target_home = args.size() >= 2 ? args[1] : UserHomeDirWide();
      try {
        ClearServiceLastError(target_home);
        UninstallElevatedService(target_home);
      } catch (const std::exception& err) {
        WriteServiceLastError(target_home, err.what());
        throw;
      }
      return 0;
    }
    if (args.size() == 1 && args[0] == L"--service-status") {
      PrintElevatedServiceStatus();
      return 0;
    }
    if (args.size() == 1 && args[0] == L"--vdd-status") {
      PrintVddStatus();
      return 0;
    }
    if (args.size() >= 1 && args[0] == L"--install-vdd") {
      std::wstring vdd_dir = args.size() >= 2 ? args[1] : L"";
      std::wstring target_home = args.size() >= 3 ? args[2] : UserHomeDirWide();
      try {
        ClearServiceLastError(target_home);
        InstallVddDriver(vdd_dir);
      } catch (const std::exception& err) {
        WriteServiceLastError(target_home, err.what());
        throw;
      }
      return 0;
    }
    if (args.size() >= 1 && args[0] == L"--uninstall-vdd") {
      std::wstring target_home = args.size() >= 2 ? args[1] : UserHomeDirWide();
      try {
        ClearServiceLastError(target_home);
        UninstallVddDriver();
      } catch (const std::exception& err) {
        WriteServiceLastError(target_home, err.what());
        throw;
      }
      return 0;
    }
    if (args.size() >= 1 && (args[0] == L"--enable-vdd" || args[0] == L"--disable-vdd")) {
      bool en = (args[0] == L"--enable-vdd");
      if (!IsRunningAsAdministrator()) {
        throw std::runtime_error("切换虚拟显示器状态需要管理员权限");
      }
      SetVddNodeEnabled(en);
      return 0;
    }

    // Interactive desktop modes: verify/attach to Default desktop unless the elevated service handles it.
    bool service_available = IsElevatedServiceAvailable(dry_run);
    if (!dry_run) {
      attached_desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS);
      if (!attached_desktop) {
        if (!service_available) {
          throw std::runtime_error("无法访问当前 Windows 桌面：" + std::to_string(GetLastError()));
        }
      } else {
        std::wstring input_name = DesktopNameOf(attached_desktop);
        std::wstring own_name = DesktopNameOf(GetThreadDesktop(GetCurrentThreadId()));
        if (_wcsicmp(input_name.c_str(), L"Default") != 0) {
          if (!service_available) {
            throw std::runtime_error("请解锁 Windows 并关闭 UAC 提示后重试屏幕连接（" + WideToUtf8(input_name) + "）");
          }
        } else if (_wcsicmp(own_name.c_str(), input_name.c_str()) != 0 && !SetThreadDesktop(attached_desktop)) {
          if (!service_available) {
            throw std::runtime_error("无法连接 Windows 输入桌面：" + std::to_string(GetLastError()));
          }
        }
      }
    }

    if (args.size() == 1 && args[0] == L"--displays") {
      EnsureSharingEnabled(dry_run);
      if (!IsDefaultDesktopActive(dry_run)) {
        std::string svc_json;
        if (TryServiceDisplaysJson(&svc_json)) {
          WriteStdoutLine(svc_json);
          close_desktop();
          return 0;
        }
        EnsureDesktop(dry_run);
      }
      auto displays = EnumerateHelperDisplays(true);
      if (displays.empty()) {
        throw std::runtime_error(
            "这台 Windows 电脑未检测到可用显示器（无头模式）。请连接显示器、插入 HDMI/DP 欺骗器，或安装虚拟显示器驱动（Virtual Display Driver）后再试。");
      }
      json arr = json::array();
      for (size_t i = 0; i < displays.size(); ++i) {
        arr.push_back({
            {"screen", static_cast<int>(i)},
            {"name", displays[i].primary ? "主屏幕" : ("屏幕 " + std::to_string(i + 1))},
            {"w", displays[i].width()},
            {"h", displays[i].height()},
            {"main", displays[i].primary},
        });
      }
      WriteStdoutJson(arr);
      close_desktop();
      return 0;
    }

    if ((args.size() == 4 || args.size() == 5) && args[0] == L"--capture") {
      int screen = ParseIntArg(args[1], "display");
      int width = ParseIntArg(args[2], "width");
      int fps = ParseIntArg(args[3], "fps");
      int quality = args.size() == 5 ? ParseIntArg(args[4], "quality") : 85;
      RunCaptureJpegMode(screen, width, fps, quality);
      close_desktop();
      return 0;
    }

    if (args.size() == 1 && args[0] == L"--fusion") {
      RunFusionMode();
      close_desktop();
      return 0;
    }

    if (args.size() == 7 && args[0] == L"--fusion-video") {
      RunCaptureWindowVideoMode(
          ParseInt64Arg(args[1], "hwnd"),
          ParseIntArg(args[2], "width"),
          ParseIntArg(args[3], "height"),
          ParseIntArg(args[4], "fps"),
          ParseIntArg(args[5], "bitrate"),
          args[6]);
      close_desktop();
      return 0;
    }

    if (args.size() == 6 && args[0] == L"--video") {
      RunCaptureVideoMode(
          ParseIntArg(args[1], "display"),
          ParseIntArg(args[2], "width"),
          ParseIntArg(args[3], "fps"),
          ParseIntArg(args[4], "bitrate"),
          args[5]);
      close_desktop();
      return 0;
    }

    if (args.size() == 2 && args[0] == L"--shape") {
      RunWatchShapeMode(ParseIntArg(args[1], "display"));
      close_desktop();
      return 0;
    }

    if (args.size() == 1 && args[0] == L"--audio") {
      RunCaptureAudioMode();
      close_desktop();
      return 0;
    }

    if (!args.empty()) {
      int screen_index = ParseIntArg(args[0], "display");
      RunControlMode(screen_index, dry_run);
      close_desktop();
      return 0;
    }

    throw std::runtime_error("Expected --displays, --capture <display> <width> <fps>, or <display> [--dry-run]");
  } catch (const std::exception& err) {
    std::string msg = std::string(err.what()) + "\n";
    WriteAllBytes(GetStdHandle(STD_ERROR_HANDLE), msg.data(), msg.size());
    close_desktop();
    return 1;
  }
}
