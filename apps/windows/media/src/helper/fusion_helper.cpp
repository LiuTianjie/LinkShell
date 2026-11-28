#include "helper/screen_common.hpp"

#include <algorithm>
using std::max;
using std::min;

#include <dwmapi.h>
#include <objidl.h>
#include <gdiplus.h>
#include <propsys.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <deque>
#include <iostream>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace linkshell::helper {

namespace {

using Microsoft::WRL::ComPtr;

// Explicit GUID and PROPERTYKEY constants so no INITGUID symbol collisions occur.
constexpr GUID kFolderIdAppsFolder = {
    0x1E87508D, 0x89C2, 0x42F0, {0x8A, 0x7E, 0x64, 0x5A, 0x0F, 0x50, 0xCA, 0x58}};
constexpr GUID kBhidEnumItems = {
    0x94F60519, 0x2850, 0x4924, {0xAA, 0x5A, 0xD1, 0x5E, 0x84, 0x86, 0x80, 0x39}};
constexpr PROPERTYKEY kPkeyAppUserModelId = {
    {0x9F4C2855, 0x9F79, 0x4B39, {0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3}}, 5};
constexpr PROPERTYKEY kPkeyLinkTargetParsingPath = {
    {0xB9B4B3FC, 0x2B51, 0x4A42, {0xB5, 0xD8, 0x32, 0x41, 0x46, 0xAF, 0xCF, 0x25}}, 2};
constexpr PROPERTYKEY kPkeyLinkArguments = {
    {0x436F2667, 0x14E2, 0x4FEB, {0xB3, 0x0A, 0x14, 0x6C, 0x53, 0xB5, 0xB6, 0x74}}, 100};

constexpr int kMaxClipboardBytes = 8 << 20;
constexpr int64_t kMaxFileClipboardBytes = 50LL << 20;
constexpr int64_t kLaunchWaitMs = 180'000;
constexpr int64_t kPostFirstWindowFollowUpMs = 30'000;

struct NtProcessBasicInformation {
  PVOID reserved1;
  PVOID peb_base_address;
  PVOID reserved2[2];
  ULONG_PTR unique_process_id;
  ULONG_PTR inherited_from_unique_process_id;
};

struct FusionWindow {
  HWND handle = nullptr;
  DWORD pid = 0;
  std::string app;
  std::string title;
  RECT frame{};
  int monitor = 0;
  bool popup = false;
  HWND owner = nullptr;
  bool minimized = false;
};

struct PendingLaunch {
  int64_t at_ms = 0;
  std::optional<int64_t> first_window_ms;
  std::unordered_set<HWND> before;
  HWND front_before = nullptr;
};

struct WindowAppCacheEntry {
  DWORD pid = 0;
  std::string app;
  int64_t at_ms = 0;
};

bool IsPopupClassName(const std::string& cls) {
  static const std::unordered_set<std::string> kPopups = {
      "#32768", "tooltips_class32", "ComboLBox", "DropDown", "Xaml_WindowedPopupClass", "Chrome_WidgetWin_2"};
  return kPopups.count(cls) != 0;
}

bool WindowVisibleFrame(HWND hwnd, RECT* out_frame) {
  if (!hwnd || !IsWindow(hwnd) || !out_frame) return false;
  RECT rc{};
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rc, sizeof(rc))) && rc.right > rc.left) {
    *out_frame = rc;
    return true;
  }
  return GetWindowRect(hwnd, out_frame) != FALSE;
}

std::string WindowClassUtf8(HWND hwnd) {
  wchar_t buf[256] = {};
  int len = GetClassNameW(hwnd, buf, ARRAYSIZE(buf));
  return len > 0 ? WideToUtf8(std::wstring_view(buf, static_cast<size_t>(len))) : std::string{};
}

std::string WindowTitleUtf8(HWND hwnd) {
  wchar_t buf[512] = {};
  int len = GetWindowTextW(hwnd, buf, ARRAYSIZE(buf));
  return len > 0 ? WideToUtf8(std::wstring_view(buf, static_cast<size_t>(len))) : std::string{};
}

std::string QueryWindowAppUserModelId(HWND hwnd) {
  ComPtr<IPropertyStore> store;
  if (FAILED(SHGetPropertyStoreForWindow(hwnd, IID_PPV_ARGS(&store))) || !store) return {};
  PROPVARIANT pv{};
  PropVariantInit(&pv);
  std::string result;
  if (SUCCEEDED(store->GetValue(kPkeyAppUserModelId, &pv))) {
    if (pv.vt == VT_LPWSTR && pv.pwszVal) {
      result = WideToUtf8(pv.pwszVal);
    }
  }
  PropVariantClear(&pv);
  return result;
}

std::string QueryProcessAumidOrExe(DWORD pid, const CiStringMap<std::string>& app_by_exe, std::mutex& catalog_mu) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return {};
  std::string result;

  using GetAumidFn = LONG(WINAPI*)(HANDLE, UINT32*, PWSTR);
  static auto get_aumid = reinterpret_cast<GetAumidFn>(
      GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetApplicationUserModelId"));
  if (get_aumid) {
    UINT32 len = 512;
    std::vector<wchar_t> buf(len, L'\0');
    if (get_aumid(proc, &len, buf.data()) == ERROR_SUCCESS && buf[0] != L'\0') {
      result = WideToUtf8(buf.data());
    }
  }
  if (result.empty()) {
    wchar_t exe_buf[1024] = {};
    DWORD exe_len = ARRAYSIZE(exe_buf);
    if (QueryFullProcessImageNameW(proc, 0, exe_buf, &exe_len) && exe_len > 0) {
      std::string exe = WideToUtf8(std::wstring_view(exe_buf, exe_len));
      std::lock_guard<std::mutex> lock(catalog_mu);
      auto it = app_by_exe.find(exe);
      result = (it != app_by_exe.end()) ? it->second : exe;
    }
  }
  CloseHandle(proc);
  return result;
}

DWORD QueryParentPid(DWORD pid) {
  using NtQueryInfoFn = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  static auto nt_query = reinterpret_cast<NtQueryInfoFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  if (!nt_query) return 0;

  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return 0;
  NtProcessBasicInformation pbi{};
  ULONG ret = 0;
  LONG status = nt_query(proc, 0 /* ProcessBasicInformation */, &pbi, sizeof(pbi), &ret);
  CloseHandle(proc);
  if (status != 0) return 0;
  uintptr_t parent = static_cast<uintptr_t>(pbi.inherited_from_unique_process_id);
  return (parent > 0 && parent <= 0xFFFFFFFFu) ? static_cast<DWORD>(parent) : 0;
}

bool IsProcessAlive(DWORD pid) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return false;
  DWORD exit_code = 0;
  bool alive = GetExitCodeProcess(proc, &exit_code) && exit_code == STILL_ACTIVE;
  CloseHandle(proc);
  return alive;
}

bool ProcessStartedRecently(DWORD pid, int64_t since_age_ms) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return false;
  FILETIME create_ft{}, exit_ft{}, kernel_ft{}, user_ft{}, now_ft{};
  bool recent = false;
  if (GetProcessTimes(proc, &create_ft, &exit_ft, &kernel_ft, &user_ft)) {
    GetSystemTimeAsFileTime(&now_ft);
    ULARGE_INTEGER c{}, n{};
    c.LowPart = create_ft.dwLowDateTime;
    c.HighPart = create_ft.dwHighDateTime;
    n.LowPart = now_ft.dwLowDateTime;
    n.HighPart = now_ft.dwHighDateTime;
    if (n.QuadPart >= c.QuadPart) {
      int64_t proc_age_ms = static_cast<int64_t>((n.QuadPart - c.QuadPart) / 10000ULL);
      recent = proc_age_ms <= (since_age_ms + 2000);
    } else {
      recent = true;
    }
  }
  CloseHandle(proc);
  return recent;
}

std::string ResolveKnownFolderAppPath(std::string_view id) {
  if (id.empty() || id.front() != '{') return {};
  size_t close = id.find('}');
  if (close == std::string_view::npos) return {};
  std::wstring guid_str = Utf8ToWide(id.substr(0, close + 1));
  GUID folder_guid{};
  if (FAILED(CLSIDFromString(guid_str.c_str(), &folder_guid))) return {};
  PWSTR folder_path = nullptr;
  if (FAILED(SHGetKnownFolderPath(folder_guid, 0, nullptr, &folder_path)) || !folder_path) return {};
  std::wstring base(folder_path);
  CoTaskMemFree(folder_path);
  std::string_view rel = id.substr(close + 1);
  while (!rel.empty() && (rel.front() == '\\' || rel.front() == '/')) rel.remove_prefix(1);
  if (rel.empty()) return WideToUtf8(base);
  return WideToUtf8(base + L"\\" + Utf8ToWide(rel));
}

std::string ResolveAppPathRegistry(std::string_view id) {
  if (id.empty() || id.find('\\') != std::string_view::npos || id.find('/') != std::string_view::npos) return {};
  std::string leaf = EndsWithIgnoreCaseAscii(id, ".exe") ? std::string(id) : (std::string(id) + ".exe");
  std::wstring subkey = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + Utf8ToWide(leaf);
  const HKEY roots[2] = {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
  for (HKEY root : roots) {
    wchar_t val[1024] = {};
    DWORD bytes = sizeof(val);
    DWORD type = 0;
    if (RegGetValueW(root, subkey.c_str(), nullptr, RRF_RT_REG_SZ, &type, val, &bytes) == ERROR_SUCCESS) {
      std::wstring s(val);
      while (!s.empty() && s.front() == L'"') s.erase(s.begin());
      while (!s.empty() && s.back() == L'"') s.pop_back();
      if (EndsWithIgnoreCaseAscii(WideToUtf8(s), ".exe") && FileExistsWide(s)) {
        return WideToUtf8(s);
      }
    }
  }
  return {};
}

class FusionController {
 public:
  void Run() {
    EnsureDesktop(false);
    clip_seen_ = GetClipboardSequenceNumber();

    shell_wake_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    cmd_wake_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);

    std::thread shell_thread([this]() { ShellWorker(); });
    std::thread stdin_thread([this]() { StdinReader(); });
    stdin_thread.detach();

    WriteMonitorsIfChanged();

    std::string last_windows_str;
    std::string last_shape_id;
    CiStringSet sent_shapes;
    int64_t monitors_at = MonotonicMs();
    int64_t scanned_at = MonotonicMs();
    int64_t shape_at = MonotonicMs();
    bool scanned = false;

    while (!ended_.load()) {
      for (;;) {
        json cmd;
        {
          std::lock_guard<std::mutex> lock(cmd_mu_);
          if (commands_.empty()) break;
          cmd = std::move(commands_.front());
          commands_.pop_front();
        }
        try {
          HandleCommand(cmd);
        } catch (const std::exception& err) {
          json err_msg = {{"t", "log"}, {"message", err.what()}};
          if (cmd.contains("rid")) err_msg["rid"] = cmd["rid"];
          WriteStdoutJson(err_msg);
        }
      }

      bool idle = false;
      {
        std::lock_guard<std::mutex> lock(fused_mu_);
        idle = fused_.empty() && launches_.empty();
      }
      int every = idle ? 500 : 33;
      int64_t since_scan = MonotonicMs() - scanned_at;
      if (scanned && since_scan < every) {
        if (cmd_wake_) WaitForSingleObject(cmd_wake_, static_cast<DWORD>(std::max<int64_t>(1, every - since_scan)));
        continue;
      }
      scanned = true;
      scanned_at = MonotonicMs();

      EnsureSharingEnabled(false);
      if (!IsDefaultDesktopActive(false)) {
        last_shape_id.clear();
        if (last_windows_str != "[]") {
          WriteStdoutJson({{"t", "windows"}, {"windows", json::array()}});
          last_windows_str = "[]";
        }
        continue;
      }

      try {
        json windows_arr = BuildFusionWindowsJson();
        std::string dumped = windows_arr.dump(-1, ' ', false, json::error_handler_t::replace);
        if (dumped != last_windows_str) {
          WriteStdoutLine("{\"t\":\"windows\",\"windows\":" + dumped + "}");
          last_windows_str = std::move(dumped);
        }

        if (idle || !fused_in_front_.load()) {
          last_shape_id.clear();
        } else if (MonotonicMs() - shape_at >= 200) {
          shape_at = MonotonicMs();
          POINT cursor_pt{0, 0};
          GetCursorPos(&cursor_pt);
          RECT screen_bounds = DisplayBoundsAt(cursor_pt);
          POINT mid{(screen_bounds.left + screen_bounds.right) / 2, (screen_bounds.top + screen_bounds.bottom) / 2};
          double scale = std::clamp(MonitorScale(mid), 1.0, 4.0);
          if (auto shape = CaptureCursorShape(scale)) {
            if (shape->id != last_shape_id) {
              last_shape_id = shape->id;
              bool first = sent_shapes.insert(shape->id).second;
              WriteStdoutJson(ShapeMessage(*shape, screen_bounds, scale, first));
            }
          }
        }
      } catch (const std::exception& err) {
        if (!IsDefaultDesktopActive(false)) {
          last_shape_id.clear();
          if (last_windows_str != "[]") {
            WriteStdoutJson({{"t", "windows"}, {"windows", json::array()}});
            last_windows_str = "[]";
          }
        } else {
          WriteStdoutJson({{"t", "log"}, {"message", std::string("windows: ") + err.what()}});
        }
      }

      if (MonotonicMs() - monitors_at > 2000) {
        WriteMonitorsIfChanged();
        monitors_at = MonotonicMs();
      }
    }

    ended_.store(true);
    if (shell_wake_) SetEvent(shell_wake_);
    if (shell_thread.joinable()) shell_thread.join();
    input_.Release(false);
    if (shell_wake_) CloseHandle(shell_wake_);
    if (cmd_wake_) CloseHandle(cmd_wake_);
  }

 private:
  void StdinReader() {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.size() > 64000 && !(line.rfind("{\"t\":\"clip\"", 0) == 0 && line.size() < (24 << 20))) {
        continue;
      }
      auto parsed = json::parse(line, nullptr, false);
      if (parsed.is_object()) {
        std::lock_guard<std::mutex> lock(cmd_mu_);
        commands_.push_back(std::move(parsed));
        if (cmd_wake_) SetEvent(cmd_wake_);
      }
    }
    ended_.store(true);
    if (cmd_wake_) SetEvent(cmd_wake_);
    if (shell_wake_) SetEvent(shell_wake_);
  }

  void ShellWorker() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool co_uninit = SUCCEEDED(hr);
    EnsureHelperGdiPlus();

    try {
      BuildCatalog();
    } catch (const std::exception& err) {
      WriteStdoutJson({{"t", "log"}, {"message", std::string("catalog: ") + err.what()}});
    }

    while (!ended_.load()) {
      json req;
      bool has_req = false;
      {
        std::lock_guard<std::mutex> lock(shell_mu_);
        if (!shell_requests_.empty()) {
          req = std::move(shell_requests_.front());
          shell_requests_.pop_front();
          has_req = true;
        }
      }
      if (!has_req) {
        ClipboardTick();
        if (shell_wake_) WaitForSingleObject(shell_wake_, 500);
        continue;
      }

      bool has_rid = req.contains("rid") && !req["rid"].is_null();
      json rid = has_rid ? req["rid"] : json(nullptr);
      try {
        std::string type = req.value("t", "");
        if (type == "clip") {
          SetClipboardFromJson(req);
        } else if (type == "apps") {
          bool fresh = has_catalog_result_ && (MonotonicMs() - catalog_at_ms_ < 60'000);
          json apps = fresh ? catalog_result_ : BuildCatalog();
          WriteStdoutJson({{"rid", rid}, {"apps", std::move(apps)}});
        } else if (type == "icon") {
          auto png = ExtractAppIconBase64(req.value("app", ""));
          WriteStdoutJson({{"rid", rid}, {"png", png ? json(*png) : json(nullptr)}});
        }
      } catch (const std::exception& err) {
        if (has_rid) WriteStdoutJson({{"rid", rid}, {"error", err.what()}});
        else WriteStdoutJson({{"t", "log"}, {"message", std::string("clipboard: ") + err.what()}});
      }
    }

    if (co_uninit) CoUninitialize();
  }

  json BuildCatalog() {
    ComPtr<IShellItem> apps_folder;
    HRESULT hr = SHGetKnownFolderItem(kFolderIdAppsFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(&apps_folder));
    if (FAILED(hr) || !apps_folder) {
      hr = SHCreateItemFromParsingName(L"shell:::{4234d49b-0245-4df3-b780-3893943456e1}", nullptr, IID_PPV_ARGS(&apps_folder));
    }
    if (FAILED(hr) || !apps_folder) {
      throw std::runtime_error("无法访问 Windows 开始菜单应用目录");
    }

    ComPtr<IEnumShellItems> enumerator;
    hr = apps_folder->BindToHandler(nullptr, kBhidEnumItems, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr) || !enumerator) {
      throw std::runtime_error("无法枚举开始菜单应用");
    }

    struct AppItem {
      std::string id;
      std::string name;
      std::wstring wide_name;
      bool system = false;
    };
    std::vector<AppItem> list;
    CiStringSet seen;
    CiStringMap<std::string> by_exe;
    CiStringSet primary_exes;
    CiStringSet ids;

    for (int count = 0; count < 2000; ++count) {
      ComPtr<IShellItem> item;
      ULONG fetched = 0;
      if (enumerator->Next(1, &item, &fetched) != S_OK || fetched == 0 || !item) break;

      PWSTR raw_name = nullptr;
      if (FAILED(item->GetDisplayName(SIGDN_NORMALDISPLAY, &raw_name)) || !raw_name) continue;
      std::wstring wname(raw_name);
      CoTaskMemFree(raw_name);

      std::string id;
      PWSTR raw_id = nullptr;
      if (SUCCEEDED(item->GetDisplayName(SIGDN_PARENTRELATIVEPARSING, &raw_id)) && raw_id) {
        id = WideToUtf8(raw_id);
        CoTaskMemFree(raw_id);
      }
      ComPtr<IShellItem2> item2;
      item.As(&item2);
      if (id.empty() && item2) {
        PWSTR aumid = nullptr;
        if (SUCCEEDED(item2->GetString(kPkeyAppUserModelId, &aumid)) && aumid) {
          id = WideToUtf8(aumid);
          CoTaskMemFree(aumid);
        }
      }

      std::string name = WideToUtf8(wname);
      if (id.empty() || name.empty() || !seen.insert(id).second) continue;
      if (StartsWithIgnoreCaseAscii(id, "http") ||
          ContainsIgnoreCaseAscii(name, "uninstall") ||
          name.find("卸载") != std::string::npos) {
        continue;
      }

      std::string exe = ResolveKnownFolderAppPath(id);
      if (IsOwnLinkShellEntry(id, exe)) continue;
      if (!exe.empty() && EndsWithIgnoreCaseAscii(exe, ".exe")) {
        by_exe[exe] = id;
        primary_exes.insert(exe);
      } else if (!exe.empty() && id.find('!') == std::string::npos) {
        continue;
      }

      if (exe.empty() && id.find('!') == std::string::npos) {
        std::string target, args;
        if (item2) {
          PWSTR p_target = nullptr;
          if (SUCCEEDED(item2->GetString(kPkeyLinkTargetParsingPath, &p_target)) && p_target) {
            target = WideToUtf8(p_target);
            CoTaskMemFree(p_target);
          }
          PWSTR p_args = nullptr;
          if (SUCCEEDED(item2->GetString(kPkeyLinkArguments, &p_args)) && p_args) {
            args = WideToUtf8(p_args);
            CoTaskMemFree(p_args);
          }
        }
        if (target.empty() && EndsWithIgnoreCaseAscii(id, ".exe") && id.size() >= 3 && id[1] == ':') {
          target = id;
        }
        if (target.empty()) target = ResolveAppPathRegistry(id);
        if (IsOwnLinkShellEntry(id, target)) continue;
        if (!target.empty() && EndsWithIgnoreCaseAscii(target, ".exe")) {
          bool primary = args.empty() && !ContainsIgnoreCaseAscii(id, "_crx_");
          if (primary && primary_exes.count(target) == 0) {
            by_exe[target] = id;
            primary_exes.insert(target);
          } else if (by_exe.find(target) == by_exe.end()) {
            by_exe[target] = id;
          }
        }
      }

      ids.insert(id);
      bool sys = StartsWithIgnoreCaseAscii(id, "Microsoft.Windows") ||
                 StartsWithIgnoreCaseAscii(id, "windows.") ||
                 ContainsIgnoreCaseAscii(id, "\\WINDOWS\\");
      list.push_back(AppItem{std::move(id), std::move(name), std::move(wname), sys});
    }

    std::sort(list.begin(), list.end(), [](const AppItem& a, const AppItem& b) {
      int cmp = CompareStringEx(LOCALE_NAME_USER_DEFAULT, LINGUISTIC_IGNORECASE,
                                a.wide_name.data(), static_cast<int>(a.wide_name.size()),
                                b.wide_name.data(), static_cast<int>(b.wide_name.size()),
                                nullptr, nullptr, 0);
      if (cmp != 0) return cmp == CSTR_LESS_THAN;
      return a.name < b.name;
    });

    json out = json::array();
    for (const auto& entry : list) {
      out.push_back({
          {"app", entry.id},
          {"name", entry.name},
          {"category", ""},
          {"system", entry.system},
      });
    }

    {
      std::lock_guard<std::mutex> lock(catalog_mu_);
      app_by_exe_ = std::move(by_exe);
      catalog_ids_ = std::move(ids);
      catalog_ready_.store(true);
      catalog_version_.fetch_add(1);
    }
    catalog_result_ = out;
    has_catalog_result_ = true;
    catalog_at_ms_ = MonotonicMs();
    return out;
  }

  std::optional<std::string> ExtractAppIconBase64(const std::string& app) {
    if (app.empty()) return std::nullopt;
    std::wstring parsing = L"shell:AppsFolder\\" + Utf8ToWide(app);
    ComPtr<IShellItemImageFactory> factory;
    if (FAILED(SHCreateItemFromParsingName(parsing.c_str(), nullptr, IID_PPV_ARGS(&factory))) || !factory) {
      return std::nullopt;
    }
    HBITMAP hbmp = nullptr;
    // SIIGBF_BIGGERSIZEOK (0x1) | SIIGBF_ICONONLY (0x4)
    if (FAILED(factory->GetImage(SIZE{256, 256}, static_cast<SIIGBF>(SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY), &hbmp)) || !hbmp) {
      return std::nullopt;
    }

    BITMAP bm{};
    std::optional<std::string> encoded;
    if (GetObjectW(hbmp, sizeof(bm), &bm) > 0 && bm.bmWidth > 0 && std::abs(bm.bmHeight) > 0) {
      int w = bm.bmWidth;
      int h = std::abs(bm.bmHeight);
      std::vector<uint8_t> bgra(static_cast<size_t>(w) * static_cast<size_t>(h) * 4, 0);
      if (bm.bmBits && bm.bmBitsPixel == 32) {
        const auto* src = static_cast<const uint8_t*>(bm.bmBits);
        bool bottom_up = bm.bmHeight > 0;
        for (int y = 0; y < h; ++y) {
          int sy = bottom_up ? (h - 1 - y) : y;
          std::memcpy(bgra.data() + static_cast<size_t>(y) * w * 4,
                      src + static_cast<size_t>(sy) * bm.bmWidthBytes,
                      static_cast<size_t>(w) * 4);
        }
      } else {
        HDC dc = GetDC(nullptr);
        BITMAPINFO bmi{};
        bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;
        GetDIBits(dc, hbmp, 0, static_cast<UINT>(h), bgra.data(), &bmi, DIB_RGB_COLORS);
        ReleaseDC(nullptr, dc);
      }
      std::vector<uint8_t> png;
      if (EncodeRgbaToPng(bgra.data(), w, h, w * 4, &png)) {
        encoded = Base64EncodeBytes(png.data(), png.size());
      }
    }
    DeleteObject(hbmp);
    return encoded;
  }

  std::vector<std::wstring> FilterClipboardFiles(const std::vector<std::wstring>& raw_paths) {
    std::vector<std::wstring> out;
    int64_t total_bytes = 0;
    for (const auto& p : raw_paths) {
      if (p.empty()) continue;
      WIN32_FILE_ATTRIBUTE_DATA fad{};
      if (!GetFileAttributesExW(p.c_str(), GetFileExInfoStandard, &fad)) continue;
      if ((fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) continue;
      int64_t sz = (static_cast<int64_t>(fad.nFileSizeHigh) << 32) | fad.nFileSizeLow;
      if (sz < 0 || total_bytes + sz > kMaxFileClipboardBytes || out.size() >= 256) {
        return {};
      }
      total_bytes += sz;
      out.push_back(p);
    }
    return out;
  }

  void ClipboardTick() {
    DWORD now = GetClipboardSequenceNumber();
    if (now == clip_seen_ || !fused_in_front_.load()) return;
    clip_seen_ = now;

    static UINT fmt_exclude = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
    static UINT fmt_png = RegisterClipboardFormatW(L"PNG");
    if (fmt_exclude && IsClipboardFormatAvailable(fmt_exclude)) return;

    if (!OpenClipboard(nullptr)) return;
    struct ClipGuard { ~ClipGuard() { CloseClipboard(); } } guard;

    if (IsClipboardFormatAvailable(CF_HDROP)) {
      HDROP hdrop = static_cast<HDROP>(GetClipboardData(CF_HDROP));
      if (hdrop) {
        UINT count = DragQueryFileW(hdrop, 0xFFFFFFFF, nullptr, 0);
        std::vector<std::wstring> raw;
        for (UINT i = 0; i < count && i < 300; ++i) {
          UINT need = DragQueryFileW(hdrop, i, nullptr, 0);
          if (need == 0) continue;
          std::wstring path(need, L'\0');
          DragQueryFileW(hdrop, i, path.data(), need + 1);
          raw.push_back(std::move(path));
        }
        auto valid = FilterClipboardFiles(raw);
        if (!valid.empty()) {
          json arr = json::array();
          for (const auto& f : valid) arr.push_back(WideToUtf8(f));
          WriteStdoutJson({{"t", "clip"}, {"files", std::move(arr)}});
          return;
        }
      }
    }

    std::string text;
    if (IsClipboardFormatAvailable(CF_UNICODETEXT)) {
      HANDLE h_txt = GetClipboardData(CF_UNICODETEXT);
      if (h_txt) {
        const auto* wstr = static_cast<const wchar_t*>(GlobalLock(h_txt));
        if (wstr) {
          text = WideToUtf8(wstr);
          GlobalUnlock(h_txt);
        }
      }
    }
    if (text.size() > static_cast<size_t>(kMaxClipboardBytes)) return;

    std::string png_b64;
    if (fmt_png && IsClipboardFormatAvailable(fmt_png)) {
      HANDLE h_png = GetClipboardData(fmt_png);
      if (h_png) {
        SIZE_T sz = GlobalSize(h_png);
        const auto* ptr = static_cast<const uint8_t*>(GlobalLock(h_png));
        if (ptr && sz > 0 && text.size() + sz <= static_cast<size_t>(kMaxClipboardBytes)) {
          png_b64 = Base64EncodeBytes(ptr, sz);
        }
        if (ptr) GlobalUnlock(h_png);
      }
    } else if (IsClipboardFormatAvailable(CF_BITMAP)) {
      HBITMAP hbmp = static_cast<HBITMAP>(GetClipboardData(CF_BITMAP));
      if (hbmp) {
        std::unique_ptr<Gdiplus::Bitmap> bmp(Gdiplus::Bitmap::FromHBITMAP(hbmp, nullptr));
        if (bmp && bmp->GetWidth() > 0 && bmp->GetHeight() > 0) {
          Gdiplus::Rect rc(0, 0, static_cast<INT>(bmp->GetWidth()), static_cast<INT>(bmp->GetHeight()));
          Gdiplus::BitmapData bd{};
          if (bmp->LockBits(&rc, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB, &bd) == Gdiplus::Ok) {
            std::vector<uint8_t> png;
            if (EncodeRgbaToPng(static_cast<const uint8_t*>(bd.Scan0), static_cast<int>(bmp->GetWidth()),
                                static_cast<int>(bmp->GetHeight()), bd.Stride, &png) &&
                text.size() + png.size() <= static_cast<size_t>(kMaxClipboardBytes)) {
              png_b64 = Base64EncodeBytes(png.data(), png.size());
            }
            bmp->UnlockBits(&bd);
          }
        }
      }
    }

    if (text.empty() && png_b64.empty()) return;
    json msg = {{"t", "clip"}};
    if (!text.empty()) msg["text"] = std::move(text);
    if (!png_b64.empty()) msg["png"] = std::move(png_b64);
    WriteStdoutJson(msg);
  }

  void SetClipboardFromJson(const json& c) {
    auto open_with_retry = []() -> bool {
      for (int i = 0; i < 5; ++i) {
        if (OpenClipboard(nullptr)) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
      return false;
    };

    if (c.contains("files") && c["files"].is_array()) {
      std::vector<std::wstring> raw;
      for (const auto& item : c["files"]) {
        if (item.is_string()) raw.push_back(Utf8ToWide(item.get<std::string>()));
      }
      auto files = FilterClipboardFiles(raw);
      if (!files.empty()) {
        size_t chars = 1;  // final trailing NUL
        for (const auto& f : files) chars += f.size() + 1;
        size_t total_bytes = sizeof(DROPFILES) + chars * sizeof(wchar_t);
        HGLOBAL hmem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_bytes);
        if (hmem) {
          auto* df = static_cast<DROPFILES*>(GlobalLock(hmem));
          if (df) {
            df->pFiles = sizeof(DROPFILES);
            df->fWide = TRUE;
            auto* dst = reinterpret_cast<wchar_t*>(reinterpret_cast<uint8_t*>(df) + sizeof(DROPFILES));
            for (const auto& f : files) {
              std::memcpy(dst, f.data(), f.size() * sizeof(wchar_t));
              dst += f.size();
              *dst++ = L'\0';
            }
            *dst = L'\0';
            GlobalUnlock(hmem);
            if (open_with_retry()) {
              EmptyClipboard();
              if (!SetClipboardData(CF_HDROP, hmem)) GlobalFree(hmem);
              CloseClipboard();
              clip_seen_ = GetClipboardSequenceNumber();
            } else {
              GlobalFree(hmem);
            }
          } else {
            GlobalFree(hmem);
          }
        }
      }
      return;
    }

    std::string text = c.value("text", "");
    std::string png_b64 = c.value("png", "");
    if (text.empty() && png_b64.empty()) return;

    std::vector<uint8_t> png_bytes;
    HBITMAP hbmp = nullptr;
    if (!png_b64.empty() && Base64DecodeBytes(png_b64, &png_bytes) && !png_bytes.empty()) {
      IStream* stream = nullptr;
      if (SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) && stream) {
        ULONG written = 0;
        if (SUCCEEDED(stream->Write(png_bytes.data(), static_cast<ULONG>(png_bytes.size()), &written))) {
          LARGE_INTEGER zero{};
          stream->Seek(zero, STREAM_SEEK_SET, nullptr);
          std::unique_ptr<Gdiplus::Bitmap> bmp(Gdiplus::Bitmap::FromStream(stream));
          if (bmp) {
            bmp->GetHBITMAP(Gdiplus::Color(255, 255, 255), &hbmp);
          }
        }
        stream->Release();
      }
    }

    if (!open_with_retry()) {
      if (hbmp) DeleteObject(hbmp);
      return;
    }
    EmptyClipboard();

    if (!text.empty()) {
      std::wstring wtext = Utf8ToWide(text);
      HGLOBAL htxt = GlobalAlloc(GMEM_MOVEABLE, (wtext.size() + 1) * sizeof(wchar_t));
      if (htxt) {
        auto* dst = static_cast<wchar_t*>(GlobalLock(htxt));
        if (dst) {
          std::memcpy(dst, wtext.data(), wtext.size() * sizeof(wchar_t));
          dst[wtext.size()] = L'\0';
          GlobalUnlock(htxt);
          if (!SetClipboardData(CF_UNICODETEXT, htxt)) GlobalFree(htxt);
        } else {
          GlobalFree(htxt);
        }
      }
    }

    if (!png_bytes.empty()) {
      static UINT fmt_png = RegisterClipboardFormatW(L"PNG");
      if (fmt_png) {
        HGLOBAL hpng = GlobalAlloc(GMEM_MOVEABLE, png_bytes.size());
        if (hpng) {
          void* dst = GlobalLock(hpng);
          if (dst) {
            std::memcpy(dst, png_bytes.data(), png_bytes.size());
            GlobalUnlock(hpng);
            if (!SetClipboardData(fmt_png, hpng)) GlobalFree(hpng);
          } else {
            GlobalFree(hpng);
          }
        }
      }
      if (hbmp) {
        if (!SetClipboardData(CF_BITMAP, hbmp)) DeleteObject(hbmp);
        hbmp = nullptr;
      }
    }

    CloseClipboard();
    if (hbmp) DeleteObject(hbmp);
    clip_seen_ = GetClipboardSequenceNumber();
  }

  void WriteMonitorsIfChanged() {
    auto screens = EnumerateHelperDisplays(true);
    json list = json::array();
    for (size_t i = 0; i < screens.size(); ++i) {
      const auto& s = screens[i];
      POINT mid{(s.bounds.left + s.bounds.right) / 2, (s.bounds.top + s.bounds.bottom) / 2};
      list.push_back({
          {"index", static_cast<int>(i)},
          {"x", s.bounds.left},
          {"y", s.bounds.top},
          {"w", s.width()},
          {"h", s.height()},
          {"scale", MonitorScale(mid)},
      });
    }
    std::string dumped = list.dump();
    if (dumped == last_monitors_) return;
    last_monitors_ = std::move(dumped);
    WriteStdoutJson({{"t", "monitors"}, {"monitors", std::move(list)}});
  }

  void FocusWindow(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) return;
    if (IsIconic(hwnd)) ShowWindowAsync(hwnd, SW_RESTORE);
    if (GetForegroundWindow() == hwnd) return;
    if (!input_.IsKeyHeld(VK_MENU)) {
      try { input_.TapKey(VK_MENU); } catch (...) {}
    }
    if (SetForegroundWindow(hwnd) && GetForegroundWindow() == hwnd) return;
    DWORD ignored_pid = 0;
    DWORD target_tid = GetWindowThreadProcessId(hwnd, &ignored_pid);
    DWORD front_tid = GetWindowThreadProcessId(GetForegroundWindow(), &ignored_pid);
    bool attached = (front_tid != 0 && front_tid != target_tid && AttachThreadInput(front_tid, target_tid, TRUE) != FALSE);
    SetForegroundWindow(hwnd);
    if (attached) AttachThreadInput(front_tid, target_tid, FALSE);
  }

  bool IsWindowOnTopForInput(HWND hwnd, bool press) {
    DWORD pid = 0, front_pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    HWND front = GetForegroundWindow();
    GetWindowThreadProcessId(front, &front_pid);
    if (front != hwnd && GetAncestor(front, GA_ROOTOWNER) != hwnd && front_pid != pid) return false;
    if (!press) return true;
    POINT at{};
    if (!GetCursorPos(&at)) return true;
    DWORD under_pid = 0;
    GetWindowThreadProcessId(GetAncestor(WindowFromPoint(at), GA_ROOT), &under_pid);
    return under_pid == pid;
  }

  void HandleCommand(const json& c) {
    std::string type = c.value("t", "");
    if (type == "apps" || type == "icon" || type == "clip") {
      std::lock_guard<std::mutex> lock(shell_mu_);
      shell_requests_.push_back(c);
      if (shell_wake_) SetEvent(shell_wake_);
      return;
    }

    bool has_rid = c.contains("rid") && !c["rid"].is_null();
    json rid = has_rid ? c["rid"] : json(nullptr);
    HWND hwnd = c.contains("hwnd") && c["hwnd"].is_number_integer()
                    ? reinterpret_cast<HWND>(static_cast<intptr_t>(c["hwnd"].get<int64_t>()))
                    : nullptr;

    if (type == "launch") {
      std::string app = c.value("app", "");
      {
        std::lock_guard<std::mutex> lock(fused_mu_);
        fused_.insert(app);
        launches_[app] = PendingLaunch{MonotonicMs(), std::nullopt, seen_windows_, GetForegroundWindow()};
      }
      app_by_window_.clear();

      wchar_t win_dir[MAX_PATH] = {};
      GetWindowsDirectoryW(win_dir, ARRAYSIZE(win_dir));
      std::wstring explorer = std::wstring(win_dir) + L"\\explorer.exe";
      std::wstring cmd = L"\"" + explorer + L"\" \"shell:AppsFolder\\" + Utf8ToWide(app) + L"\"";
      STARTUPINFOW si{};
      si.cb = sizeof(si);
      PROCESS_INFORMATION pi{};
      if (CreateProcessW(explorer.c_str(), cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        WriteStdoutJson({{"rid", rid}, {"ok", true}});
      } else {
        WriteStdoutJson({{"rid", rid}, {"ok", false}, {"error", "启动应用失败：" + std::to_string(GetLastError())}});
      }
      return;
    }

    if (type == "fuse") {
      bool none = false;
      {
        std::lock_guard<std::mutex> lock(fused_mu_);
        fused_.clear();
        if (c.contains("apps") && c["apps"].is_array()) {
          for (const auto& item : c["apps"]) {
            if (item.is_string()) fused_.insert(item.get<std::string>());
          }
        }
        none = fused_.empty();
        if (none) launches_.clear();
      }
      app_by_window_.clear();
      if (none) {
        app_aliases_.clear();
        fused_pids_.clear();
        parent_pids_.clear();
      }
      return;
    }

    if (type == "quit") {
      std::string app = c.value("app", "");
      bool force = c.value("force", false);
      for (const auto& w : CollectFusionWindows(true)) {
        if (!w.popup && EqualsIgnoreCaseAscii(w.app, app)) {
          if (force) {
            HANDLE proc = OpenProcess(PROCESS_TERMINATE, FALSE, w.pid);
            if (proc) {
              TerminateProcess(proc, 1);
              CloseHandle(proc);
            }
          } else {
            PostMessageW(w.handle, WM_CLOSE, 0, 0);
          }
        }
      }
      return;
    }

    if (type == "resize") {
      RECT win_rc{}, frame_rc{};
      if (!hwnd || !GetWindowRect(hwnd, &win_rc) || !WindowVisibleFrame(hwnd, &frame_rc)) return;
      int extra_w = (win_rc.right - win_rc.left) - (frame_rc.right - frame_rc.left);
      int extra_h = (win_rc.bottom - win_rc.top) - (frame_rc.bottom - frame_rc.top);
      int req_w = static_cast<int>(c.value("w", 0.0)) + extra_w;
      int req_h = static_cast<int>(c.value("h", 0.0)) + extra_h;
      SetWindowPos(hwnd, nullptr, 0, 0, req_w, req_h, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
      return;
    }

    if (type == "focus") {
      FocusWindow(hwnd);
      return;
    }

    if (type == "close") {
      if (hwnd) PostMessageW(hwnd, WM_CLOSE, 0, 0);
      return;
    }

    if (type == "input") {
      if (!c.contains("event") || !c["event"].is_object()) return;
      const json& ev = c["event"];
      RECT target_bounds{};
      if (hwnd) {
        if (!WindowVisibleFrame(hwnd, &target_bounds)) return;
      } else {
        auto screens = EnumerateHelperDisplays(true);
        int idx = c.value("monitor", 0);
        if (idx < 0 || idx >= static_cast<int>(screens.size())) return;
        target_bounds = screens[static_cast<size_t>(idx)].bounds;
      }
      if (target_bounds.right - target_bounds.left < 2 || target_bounds.bottom - target_bounds.top < 2) return;
      std::string kind = ev.value("t", "");
      if (hwnd && kind != "move" && kind != "scroll") {
        FocusWindow(hwnd);
        if (!IsWindowOnTopForInput(hwnd, kind == "down")) {
          WriteStdoutJson({{"t", "log"}, {"message", "input dropped: window " + std::to_string(reinterpret_cast<uintptr_t>(hwnd)) + " is not in front"}});
          return;
        }
      }
      input_.Handle(ev, target_bounds);
      return;
    }
  }

  std::string FusedOwnerOfPid(DWORD pid, const CiStringSet& fused) {
    DWORD cur = pid;
    for (int depth = 0; depth < 3 && cur != 0; ++depth) {
      if (auto it = fused_pids_.find(cur); it != fused_pids_.end() && fused.count(it->second) != 0) {
        return it->second;
      }
      DWORD parent = 0;
      if (auto pit = parent_pids_.find(cur); pit != parent_pids_.end()) {
        parent = pit->second;
      } else {
        parent = QueryParentPid(cur);
        if (parent_pids_.size() > 512) parent_pids_.clear();
        parent_pids_[cur] = parent;
      }
      if (parent == 0 || parent == cur) break;
      cur = parent;
    }
    return {};
  }

  std::string ProcessAppOf(DWORD pid) {
    if (auto it = app_by_pid_.find(pid); it != app_by_pid_.end()) return it->second;
    std::string res = QueryProcessAumidOrExe(pid, app_by_exe_, catalog_mu_);
    if (app_by_pid_.size() > 512) app_by_pid_.clear();
    if (catalog_ready_.load()) app_by_pid_[pid] = res;
    return res;
  }

  std::string AppOfWindow(HWND hwnd, DWORD pid, const CiStringSet& fused) {
    int64_t now = MonotonicMs();
    if (auto it = app_by_window_.find(hwnd); it != app_by_window_.end() && it->second.pid == pid && now - it->second.at_ms < 1500) {
      return it->second.app;
    }
    std::string win_id = QueryWindowAppUserModelId(hwnd);
    std::string proc_app = ProcessAppOf(pid);
    std::string pid_owner = FusedOwnerOfPid(pid, fused);
    std::string resolved;
    {
      std::lock_guard<std::mutex> lock(catalog_mu_);
      resolved = ResolveWindowApp(win_id, proc_app, pid_owner, fused, catalog_ids_, app_aliases_);
    }
    if (app_by_window_.size() > 1024) app_by_window_.clear();
    app_by_window_[hwnd] = WindowAppCacheEntry{pid, resolved, now};
    return resolved;
  }

  void AdoptLaunched(std::vector<FusionWindow>& found, const CiStringSet& fused) {
    if (!catalog_ready_.load()) return;
    std::lock_guard<std::mutex> lock(fused_mu_);
    if (launches_.empty()) return;

    int64_t now = MonotonicMs();
    HWND front = GetForegroundWindow();
    std::vector<std::string> keys;
    keys.reserve(launches_.size());
    for (const auto& kv : launches_) keys.push_back(kv.first);

    for (const auto& app : keys) {
      auto lit = launches_.find(app);
      if (lit == launches_.end()) continue;
      PendingLaunch& launch = lit->second;

      bool has_win = false;
      for (const auto& w : found) {
        if (!w.popup && EqualsIgnoreCaseAscii(w.app, app)) {
          has_win = true;
          break;
        }
      }
      if (has_win && !launch.first_window_ms.has_value()) launch.first_window_ms = now;
      if ((now - launch.at_ms > kLaunchWaitMs) ||
          (launch.first_window_ms.has_value() && now - *launch.first_window_ms > kPostFirstWindowFollowUpMs)) {
        launches_.erase(app);
        continue;
      }

      for (auto& w : found) {
        if (w.popup || w.minimized || w.app.empty() || w.title.empty() || fused.count(w.app) != 0) continue;
        if (w.frame.right - w.frame.left < 200 || w.frame.bottom - w.frame.top < 120) continue;
        bool existed_before = launch.before.count(w.handle) != 0;
        if (existed_before) {
          if (has_win || w.handle != front || w.handle == launch.front_before || now - launch.at_ms > 10'000) continue;
        } else if (w.handle != front && !ProcessStartedRecently(w.pid, now - launch.at_ms)) {
          continue;
        }

        bool known = false;
        {
          std::lock_guard<std::mutex> cat_lock(catalog_mu_);
          known = catalog_ids_.count(w.app) != 0;
        }
        if (known && !existed_before) {
          if (!StartsWithIgnoreCaseAscii(w.app, app + ".")) continue;
        }
        if (!known) {
          std::lock_guard<std::mutex> cat_lock(catalog_mu_);
          app_aliases_[w.app] = app;
        }
        fused_pids_[w.pid] = app;
        app_by_window_.clear();
        WriteStdoutJson({{"t", "log"}, {"message", "fusion: windows of " + w.app + " (pid " + std::to_string(w.pid) + ") belong to " + app}});

        std::string was = w.app;
        for (auto& other : found) {
          if (other.pid == w.pid || (!known && EqualsIgnoreCaseAscii(other.app, was))) {
            other.app = app;
          }
        }
        if (!launch.first_window_ms.has_value()) launch.first_window_ms = now;
        break;
      }
    }
  }

  std::vector<FusionWindow> CollectFusionWindows(bool all) {
    CiStringSet fused_snapshot;
    {
      std::lock_guard<std::mutex> lock(fused_mu_);
      fused_snapshot = fused_;
    }

    auto screens = EnumerateHelperDisplays(true);
    int version = catalog_version_.load();
    int64_t now_ms = MonotonicMs();
    if (version != catalog_used_ || now_ms - pids_cleared_at_ > 60'000) {
      catalog_used_ = version;
      pids_cleared_at_ = now_ms;
      app_by_pid_.clear();
      app_by_window_.clear();
      parent_pids_.clear();
      for (auto it = fused_pids_.begin(); it != fused_pids_.end();) {
        if (!IsProcessAlive(it->first)) it = fused_pids_.erase(it);
        else ++it;
      }
    }

    struct EnumWinCtx {
      FusionController* self;
      const CiStringSet* fused;
      const std::vector<HelperDisplay>* screens;
      std::vector<FusionWindow> found;
    } ctx{this, &fused_snapshot, &screens, {}};

    EnumWindows(
        [](HWND hwnd, LPARAM lparam) -> BOOL {
          auto* c = reinterpret_cast<EnumWinCtx*>(lparam);
          if (!IsWindowVisible(hwnd)) return TRUE;
          INT cloaked = 0;
          if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0) {
            return TRUE;
          }
          RECT frame{};
          if (!WindowVisibleFrame(hwnd, &frame) || frame.right - frame.left < 2 || frame.bottom - frame.top < 2) {
            return TRUE;
          }
          LONG style = GetWindowLongW(hwnd, GWL_STYLE);
          LONG ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
          if ((style & WS_CHILD) != 0) return TRUE;
          std::string cls = WindowClassUtf8(hwnd);
          if (cls == "SysShadow") return TRUE;
          DWORD pid = 0;
          GetWindowThreadProcessId(hwnd, &pid);
          HWND owner = GetWindow(hwnd, GW_OWNER);
          bool popup = IsPopupClassName(cls) ||
                       ((ex & WS_EX_TOOLWINDOW) != 0 && (style & WS_CAPTION) != WS_CAPTION) ||
                       ((style & WS_POPUP) != 0 && (style & WS_CAPTION) == 0 && owner != nullptr && (ex & WS_EX_APPWINDOW) == 0);

          POINT center{(frame.left + frame.right) / 2, (frame.top + frame.bottom) / 2};
          int monitor = 0;
          for (size_t i = 0; i < c->screens->size(); ++i) {
            const RECT& b = (*c->screens)[i].bounds;
            if (center.x >= b.left && center.x < b.right && center.y >= b.top && center.y < b.bottom) {
              monitor = static_cast<int>(i);
              break;
            }
          }

          FusionWindow fw;
          fw.handle = hwnd;
          fw.pid = pid;
          fw.app = c->self->AppOfWindow(hwnd, pid, *c->fused);
          fw.title = WindowTitleUtf8(hwnd);
          fw.frame = frame;
          fw.monitor = monitor;
          fw.popup = popup;
          fw.owner = owner;
          fw.minimized = IsIconic(hwnd) != FALSE;
          c->found.push_back(std::move(fw));
          return TRUE;
        },
        reinterpret_cast<LPARAM>(&ctx));

    seen_windows_.clear();
    for (const auto& w : ctx.found) seen_windows_.insert(w.handle);
    AdoptLaunched(ctx.found, fused_snapshot);
    if (all) return ctx.found;

    std::vector<FusionWindow> shown;
    std::unordered_set<DWORD> shown_pids;
    for (const auto& w : ctx.found) {
      if (!w.popup && fused_snapshot.count(w.app) != 0) {
        shown.push_back(w);
        fused_pids_[w.pid] = w.app;
        shown_pids.insert(w.pid);
      }
    }

    std::vector<FusionWindow> result = shown;
    for (auto p : ctx.found) {
      if (!p.popup || shown_pids.count(p.pid) == 0) continue;
      const FusionWindow* owner_win = nullptr;
      for (const auto& s : shown) {
        if (s.handle == p.owner) { owner_win = &s; break; }
      }
      if (!owner_win) {
        for (const auto& s : shown) {
          if (s.pid == p.pid) { owner_win = &s; break; }
        }
      }
      if (!owner_win) continue;
      p.owner = owner_win->handle;
      p.app = owner_win->app;
      result.push_back(std::move(p));
    }

    HWND front = GetForegroundWindow();
    bool in_front = false;
    for (const auto& w : result) {
      if (w.handle == front) { in_front = true; break; }
    }
    fused_in_front_.store(in_front);
    return result;
  }

  json MeasureWindowChrome(const FusionWindow& w) {
    int width = w.frame.right - w.frame.left;
    int height = w.frame.bottom - w.frame.top;
    std::string size_key = std::to_string(width) + "x" + std::to_string(height);

    auto it = chrome_cache_.find(w.handle);
    if (it != chrome_cache_.end() && it->second.first == size_key) {
      return it->second.second;
    }
    int64_t now = MonotonicMs();
    if (it != chrome_cache_.end()) {
      auto pit = chrome_probed_.find(w.handle);
      if (pit != chrome_probed_.end() && now - pit->second < 500) {
        return it->second.second;
      }
    }
    chrome_probed_[w.handle] = now;

    int band = static_cast<int>(std::lround(32.0 * MonitorScale(POINT{w.frame.left + width / 2, w.frame.top + 8})));
    int y = w.frame.top + std::max(4, band / 2);
    int step = std::max(std::max(4, band / 8), width / 96 + 1);

    struct Span { int code; int x0; int x1; };
    std::vector<Span> spans;
    int current = -1, start = 0;
    for (int x = w.frame.left + 1; x < w.frame.right; x += step) {
      DWORD_PTR res = 0;
      LPARAM lp = static_cast<LPARAM>(
          (static_cast<uint32_t>(static_cast<uint16_t>(static_cast<int16_t>(x)))) |
          (static_cast<uint32_t>(static_cast<uint16_t>(static_cast<int16_t>(y))) << 16));
      int code = SendMessageTimeoutW(w.handle, WM_NCHITTEST, 0, lp, SMTO_ABORTIFHUNG, 10, &res) == 0
                     ? -1
                     : static_cast<int>(static_cast<intptr_t>(res));
      if (code != current) {
        if (current != -1) spans.push_back({current, start, x});
        current = code;
        start = x;
      }
    }
    if (current != -1) spans.push_back({current, start, static_cast<int>(w.frame.right)});

    auto make_rect = [&](const Span& s) -> json {
      return {{"x", s.x0 - w.frame.left}, {"y", 0}, {"w", s.x1 - s.x0}, {"h", band}};
    };

    json buttons = json::object();
    json hitrects = json::array();
    for (const auto& sp : spans) {
      if (sp.code == HTMINBUTTON) buttons["minimize"] = make_rect(sp);
      else if (sp.code == HTMAXBUTTON) buttons["zoom"] = make_rect(sp);
      else if (sp.code == HTCLOSE) buttons["close"] = make_rect(sp);
      else if (sp.code == HTCLIENT && (sp.x1 - sp.x0) >= step && hitrects.size() < 64) {
        hitrects.push_back(make_rect(sp));
      }
    }

    json chrome = {{"buttons", std::move(buttons)}, {"hitrects", std::move(hitrects)}};
    if (chrome_cache_.size() > 256) {
      chrome_cache_.clear();
      chrome_probed_.clear();
    }
    chrome_cache_[w.handle] = {std::move(size_key), chrome};
    return chrome;
  }

  json BuildFusionWindowsJson() {
    auto list = CollectFusionWindows(false);
    json out = json::array();
    for (const auto& w : list) {
      int64_t id_low32 = static_cast<int64_t>(reinterpret_cast<uintptr_t>(w.handle) & 0xFFFFFFFFULL);
      json entry = {
          {"id", id_low32},
          {"pid", w.pid},
          {"app", w.app},
          {"title", w.title},
          {"x", w.frame.left},
          {"y", w.frame.top},
          {"w", w.frame.right - w.frame.left},
          {"h", w.frame.bottom - w.frame.top},
          {"monitor", w.monitor},
          {"popup", w.popup},
          {"minimized", w.minimized},
      };
      if (w.popup) {
        entry["owner"] = static_cast<int64_t>(reinterpret_cast<uintptr_t>(w.owner) & 0xFFFFFFFFULL);
      } else {
        json chrome = MeasureWindowChrome(w);
        entry["buttons"] = std::move(chrome["buttons"]);
        entry["hitrects"] = std::move(chrome["hitrects"]);
      }
      out.push_back(std::move(entry));
    }
    return out;
  }

  std::atomic<bool> ended_{false};
  std::atomic<bool> fused_in_front_{false};
  std::atomic<bool> catalog_ready_{false};
  std::atomic<int> catalog_version_{0};

  HANDLE shell_wake_ = nullptr;
  HANDLE cmd_wake_ = nullptr;

  std::mutex cmd_mu_;
  std::deque<json> commands_;

  std::mutex shell_mu_;
  std::deque<json> shell_requests_;
  DWORD clip_seen_ = 0;
  bool has_catalog_result_ = false;
  json catalog_result_;
  int64_t catalog_at_ms_ = 0;

  std::mutex catalog_mu_;
  CiStringMap<std::string> app_by_exe_;
  CiStringSet catalog_ids_;
  CiStringMap<std::string> app_aliases_;

  std::mutex fused_mu_;
  CiStringSet fused_;
  CiStringMap<PendingLaunch> launches_;

  std::unordered_set<HWND> seen_windows_;
  std::unordered_map<DWORD, std::string> fused_pids_;
  std::unordered_map<DWORD, DWORD> parent_pids_;
  std::unordered_map<DWORD, std::string> app_by_pid_;
  std::unordered_map<HWND, WindowAppCacheEntry> app_by_window_;
  std::unordered_map<HWND, std::pair<std::string, json>> chrome_cache_;
  std::unordered_map<HWND, int64_t> chrome_probed_;

  int catalog_used_ = -1;
  int64_t pids_cleared_at_ = MonotonicMs();
  std::string last_monitors_;
  InputState input_;
};

}  // namespace

void RunFusionMode() {
  FusionController controller;
  controller.Run();
}

}  // namespace linkshell::helper
