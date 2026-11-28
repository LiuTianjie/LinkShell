#include "helper/screen_common.hpp"

#include <algorithm>
using std::max;
using std::min;

#include <bcrypt.h>
#include <knownfolders.h>
#include <objidl.h>
#include <gdiplus.h>
#include <shellscalingapi.h>
#include <shlobj.h>

#include <chrono>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <unordered_map>

namespace linkshell::helper {

namespace {

std::mutex& OutputMutex() {
  static std::mutex mu;
  return mu;
}

bool GetEncoderClsid(const wchar_t* mime, CLSID* out_clsid) {
  if (!EnsureHelperGdiPlus() || !out_clsid) return false;
  UINT num = 0, size = 0;
  if (Gdiplus::GetImageEncodersSize(&num, &size) != Gdiplus::Ok || size == 0) return false;
  std::vector<uint8_t> buf(size);
  auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
  if (Gdiplus::GetImageEncoders(num, size, encoders) != Gdiplus::Ok) return false;
  for (UINT i = 0; i < num; ++i) {
    if (encoders[i].MimeType && wcscmp(encoders[i].MimeType, mime) == 0) {
      *out_clsid = encoders[i].Clsid;
      return true;
    }
  }
  return false;
}

double Round2(double v) {
  return std::round(v * 100.0) / 100.0;
}

bool DrawCursorToBgra(HCURSOR cursor, int width, int height, uint8_t bg_b, uint8_t bg_g, uint8_t bg_r, std::vector<uint8_t>* out_bgra) {
  if (!out_bgra || width <= 0 || height <= 0) return false;
  HDC screen_dc = GetDC(nullptr);
  HDC mem_dc = CreateCompatibleDC(screen_dc);
  BITMAPINFO bmi{};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = width;
  bmi.bmiHeader.biHeight = -height;  // top-down
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  bool ok = false;
  if (mem_dc && dib && bits) {
    auto* px = static_cast<uint8_t*>(bits);
    const size_t total = static_cast<size_t>(width) * static_cast<size_t>(height);
    for (size_t i = 0; i < total; ++i) {
      px[i * 4 + 0] = bg_b;
      px[i * 4 + 1] = bg_g;
      px[i * 4 + 2] = bg_r;
      px[i * 4 + 3] = 255;
    }
    HGDIOBJ old = SelectObject(mem_dc, dib);
    ok = DrawIconEx(mem_dc, 0, 0, cursor, width, height, 0, nullptr, DI_NORMAL) != FALSE;
    GdiFlush();
    SelectObject(mem_dc, old);
    if (ok) {
      out_bgra->assign(px, px + total * 4);
    }
  }
  if (dib) DeleteObject(dib);
  if (mem_dc) DeleteDC(mem_dc);
  if (screen_dc) ReleaseDC(nullptr, screen_dc);
  return ok;
}

bool IsProcessUserInteractive() {
  HWINSTA winsta = GetProcessWindowStation();
  if (!winsta) return false;
  USEROBJECTFLAGS flags{};
  DWORD needed = 0;
  if (!GetUserObjectInformationW(winsta, UOI_FLAGS, &flags, sizeof(flags), &needed)) {
    return true;
  }
  return (flags.dwFlags & WSF_VISIBLE) != 0;
}

std::string JsonStr(const json& obj, const char* key) {
  auto it = obj.find(key);
  if (it == obj.end() || it->is_null()) return {};
  if (it->is_string()) return it->get<std::string>();
  if (it->is_number_integer()) return std::to_string(it->get<int64_t>());
  if (it->is_number()) return std::to_string(it->get<double>());
  if (it->is_boolean()) return it->get<bool>() ? "true" : "false";
  return {};
}

double JsonNum(const json& obj, const char* key, double fallback = 0.0) {
  auto it = obj.find(key);
  if (it == obj.end()) return fallback;
  if (it->is_number()) return it->get<double>();
  if (it->is_string()) {
    try { return std::stod(it->get<std::string>()); } catch (...) {}
  }
  return fallback;
}

}  // namespace

int64_t MonotonicMs() {
  using clock = std::chrono::steady_clock;
  static const auto kStart = clock::now();
  return std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - kStart).count();
}

std::string WideToUtf8(std::wstring_view w) {
  if (w.empty()) return {};
  int needed = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return {};
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), needed, nullptr, nullptr);
  return out;
}

std::wstring Utf8ToWide(std::string_view s) {
  if (s.empty()) return {};
  int needed = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (needed <= 0) return {};
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), needed);
  return out;
}

void WriteStdoutJson(const json& value) {
  std::string line = value.dump(-1, ' ', false, json::error_handler_t::replace);
  WriteStdoutLine(line);
}

void WriteStdoutLine(std::string_view line) {
  std::lock_guard<std::mutex> lock(OutputMutex());
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

bool WriteAllBytes(HANDLE h, const void* data, size_t len) {
  if (h == INVALID_HANDLE_VALUE || !h) return false;
  const auto* ptr = static_cast<const uint8_t*>(data);
  size_t off = 0;
  while (off < len) {
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(len - off, 1024 * 1024));
    DWORD written = 0;
    if (!WriteFile(h, ptr + off, chunk, &written, nullptr) || written == 0) return false;
    off += written;
  }
  return true;
}

bool ReadExactBytes(HANDLE h, void* data, size_t len) {
  if (h == INVALID_HANDLE_VALUE || !h) return false;
  auto* ptr = static_cast<uint8_t*>(data);
  size_t off = 0;
  while (off < len) {
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(len - off, 1024 * 1024));
    DWORD got = 0;
    if (!ReadFile(h, ptr + off, chunk, &got, nullptr) || got == 0) return false;
    off += got;
  }
  return true;
}

std::wstring GetEnvWide(const wchar_t* name) {
  DWORD needed = GetEnvironmentVariableW(name, nullptr, 0);
  if (needed <= 1) return {};
  std::wstring val(needed - 1, L'\0');
  DWORD got = GetEnvironmentVariableW(name, val.data(), needed);
  if (got == 0 || got >= needed) return {};
  val.resize(got);
  return val;
}

std::wstring UserHomeDirWide() {
  std::wstring env_home = GetEnvWide(L"LINKSHELL_HOME");
  if (!env_home.empty()) return env_home;
  std::wstring profile = GetEnvWide(L"USERPROFILE");
  if (!profile.empty()) return profile + L"\\.linkshell";
  PWSTR known = nullptr;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &known)) && known) {
    std::wstring res = std::wstring(known) + L"\\.linkshell";
    CoTaskMemFree(known);
    return res;
  }
  return L".linkshell";
}

std::wstring CurrentExePathWide() {
  std::wstring buf(1024, L'\0');
  for (;;) {
    DWORD len = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    if (len == 0) return {};
    if (len < buf.size() - 1) {
      buf.resize(len);
      return buf;
    }
    if (buf.size() >= 32768) return {};
    buf.resize(buf.size() * 2);
  }
}

bool FileExistsWide(const std::wstring& path) {
  if (path.empty()) return false;
  DWORD attr = GetFileAttributesW(path.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool DirectoryExistsWide(const std::wstring& path) {
  if (path.empty()) return false;
  DWORD attr = GetFileAttributesW(path.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool EnsureDirectoryTreeWide(const std::wstring& path) {
  if (path.empty()) return false;
  if (DirectoryExistsWide(path)) return true;
  int rc = SHCreateDirectoryExW(nullptr, path.c_str(), nullptr);
  return rc == ERROR_SUCCESS || rc == ERROR_ALREADY_EXISTS || DirectoryExistsWide(path);
}

std::string ReadUtf8FileWide(const std::wstring& path) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return {};
  LARGE_INTEGER sz{};
  std::string out;
  if (GetFileSizeEx(h, &sz) && sz.QuadPart > 0 && sz.QuadPart <= 16 * 1024 * 1024) {
    out.resize(static_cast<size_t>(sz.QuadPart));
    if (!ReadExactBytes(h, out.data(), out.size())) out.clear();
  }
  CloseHandle(h);
  return out;
}

bool WriteUtf8FileWide(const std::wstring& path, std::string_view content) {
  size_t slash = path.find_last_of(L"\\/");
  if (slash != std::wstring::npos && slash > 0) {
    EnsureDirectoryTreeWide(path.substr(0, slash));
  }
  HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  bool ok = content.empty() || WriteAllBytes(h, content.data(), content.size());
  FlushFileBuffers(h);
  CloseHandle(h);
  return ok;
}

std::vector<uint8_t> Sha256Bytes(const void* data, size_t len) {
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::vector<uint8_t> digest(32, 0);
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) {
    if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0) {
      if (len == 0 || BCryptHashData(hash, static_cast<PUCHAR>(const_cast<void*>(data)), static_cast<ULONG>(len), 0) == 0) {
        BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
      }
      BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(alg, 0);
  }
  return digest;
}

std::string FileSha256HexWide(const std::wstring& path) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return {};

  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::string hex;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) {
    if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0) {
      std::vector<uint8_t> buf(65536);
      DWORD got = 0;
      bool ok = true;
      while (ReadFile(h, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr) && got > 0) {
        if (BCryptHashData(hash, buf.data(), got, 0) != 0) {
          ok = false;
          break;
        }
      }
      std::vector<uint8_t> digest(32, 0);
      if (ok && BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0) {
        hex = HexEncode(digest.data(), digest.size());
      }
      BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(alg, 0);
  }
  CloseHandle(h);
  return hex;
}

std::string GenerateRandomHex(size_t num_bytes) {
  std::vector<uint8_t> bytes(num_bytes, 0);
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    throw std::runtime_error("无法生成安全随机令牌");
  }
  return HexEncode(bytes.data(), bytes.size());
}

bool IsRunningAsAdministrator() {
  BOOL is_admin = FALSE;
  SID_IDENTIFIER_AUTHORITY nt_authority = SECURITY_NT_AUTHORITY;
  PSID admins_group = nullptr;
  if (AllocateAndInitializeSid(&nt_authority, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS,
                               0, 0, 0, 0, 0, 0, &admins_group)) {
    if (!CheckTokenMembership(nullptr, admins_group, &is_admin)) {
      is_admin = FALSE;
    }
    FreeSid(admins_group);
  }
  return is_admin != FALSE;
}

std::wstring DesktopNameOf(HDESK handle) {
  if (!handle) return {};
  wchar_t name[256] = {};
  DWORD needed = 0;
  if (!GetUserObjectInformationW(handle, UOI_NAME, name, sizeof(name), &needed)) return {};
  return name;
}

void EnsureSharingEnabled(bool dry_run) {
  std::wstring home = UserHomeDirWide();
  if (FileExistsWide(home + L"\\windows-screen-disabled")) {
    throw std::runtime_error("请在 LinkShell 桌面版设置中允许远程屏幕");
  }
  if (!dry_run && !IsProcessUserInteractive()) {
    throw std::runtime_error("屏幕共享需要登录 Windows 桌面");
  }
}

bool IsServiceSharingEnabledWide(const std::wstring& home) {
  if (home.empty()) return false;
  return !FileExistsWide(home + L"\\windows-screen-disabled");
}

bool IsDefaultDesktopActive(bool dry_run) {
  if (dry_run) return true;
  HDESK current = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!current) return false;
  std::wstring name = DesktopNameOf(current);
  CloseDesktop(current);
  return _wcsicmp(name.c_str(), L"Default") == 0;
}

bool WaitForDefaultDesktop(int max_wait_ms, const std::atomic<bool>& ended) {
  int64_t started = MonotonicMs();
  while (!ended.load()) {
    EnsureSharingEnabled(false);
    if (IsDefaultDesktopActive(false)) return true;
    if (MonotonicMs() - started >= max_wait_ms) {
      throw std::runtime_error("Windows 已锁定或正在显示安全桌面，请在电脑上解锁后重新连接");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
  }
  return false;
}

void EnsureDesktop(bool dry_run) {
  EnsureSharingEnabled(dry_run);
  if (!IsDefaultDesktopActive(dry_run)) {
    throw std::runtime_error("Windows 已锁定或正在显示安全桌面，请在电脑上解锁后重新连接");
  }
}

void NudgeDesktopForCapture() {
  SetThreadExecutionState(ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
  RedrawWindow(nullptr, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_FRAME);
}

bool DisplayHasActiveMonitor(const std::wstring& device_name) {
  if (device_name.empty()) return false;
  for (DWORD j = 0; j < 16; ++j) {
    DISPLAY_DEVICEW mon{};
    mon.cb = sizeof(mon);
    if (!EnumDisplayDevicesW(device_name.c_str(), j, &mon, 0)) break;
    if ((mon.StateFlags & DISPLAY_DEVICE_ACTIVE) != 0) return true;
  }
  return false;
}

namespace {
struct EnumDisplayCtx {
  bool probe_monitors = true;
  std::vector<HelperDisplay> list;
};

BOOL CALLBACK EnumDisplayCallback(HMONITOR mon, HDC, LPRECT, LPARAM data) {
  auto* ctx = reinterpret_cast<EnumDisplayCtx*>(data);
  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (GetMonitorInfoW(mon, &info)) {
    HelperDisplay d;
    d.bounds = info.rcMonitor;
    d.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
    d.monitor = mon;
    d.device_name = info.szDevice;
    d.has_active_monitor = ctx->probe_monitors && DisplayHasActiveMonitor(d.device_name);
    ctx->list.push_back(std::move(d));
  }
  return TRUE;
}
}  // namespace

std::vector<HelperDisplay> EnumerateHelperDisplays(bool probe_monitors) {
  EnumDisplayCtx ctx{probe_monitors, {}};
  EnumDisplayMonitors(nullptr, nullptr, EnumDisplayCallback, reinterpret_cast<LPARAM>(&ctx));
  if (ctx.list.empty()) {
    int sw = GetSystemMetrics(SM_CXSCREEN);
    int sh = GetSystemMetrics(SM_CYSCREEN);
    if (sw > 0 && sh > 0) {
      HelperDisplay fallback;
      fallback.bounds = RECT{0, 0, sw, sh};
      fallback.primary = true;
      ctx.list.push_back(std::move(fallback));
    }
  }
  std::stable_sort(ctx.list.begin(), ctx.list.end(), [](const HelperDisplay& a, const HelperDisplay& b) {
    return a.primary > b.primary;
  });
  return ctx.list;
}

HelperDisplay DisplayEntry(int index, bool probe_monitors, bool dry_run) {
  EnsureDesktop(dry_run);
  auto all = EnumerateHelperDisplays(probe_monitors);
  if (all.empty()) {
    throw std::runtime_error(
        "这台 Windows 电脑未检测到可用显示器（无头模式）。请连接显示器、插入 HDMI/DP 欺骗器，或安装虚拟显示器驱动（Virtual Display Driver）后再试。");
  }
  if (index < 0 || index >= static_cast<int>(all.size())) {
    throw std::runtime_error("屏幕已断开，请重新打开屏幕共享");
  }
  return all[static_cast<size_t>(index)];
}

RECT DisplayBounds(int index, bool dry_run) {
  return DisplayEntry(index, false, dry_run).bounds;
}

RECT DisplayBoundsAt(POINT pt) {
  auto all = EnumerateHelperDisplays(true);
  for (const auto& d : all) {
    if (pt.x >= d.bounds.left && pt.x < d.bounds.right && pt.y >= d.bounds.top && pt.y < d.bounds.bottom) {
      return d.bounds;
    }
  }
  if (!all.empty()) return all.front().bounds;
  return RECT{0, 0, std::max(1, GetSystemMetrics(SM_CXSCREEN)), std::max(1, GetSystemMetrics(SM_CYSCREEN))};
}

RECT VirtualScreenBounds() {
  int w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (w > 0 && h > 0) {
    int x = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int y = GetSystemMetrics(SM_YVIRTUALSCREEN);
    return RECT{x, y, x + w, y + h};
  }
  return RECT{0, 0, std::max(1, GetSystemMetrics(SM_CXSCREEN)), std::max(1, GetSystemMetrics(SM_CYSCREEN))};
}

double MonitorScale(POINT at) {
  HMONITOR mon = MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST);
  UINT dx = 0, dy = 0;
  if (mon && GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &dx, &dy) == S_OK && dx > 0) {
    return static_cast<double>(dx) / 96.0;
  }
  return 1.0;
}

bool EnsureHelperGdiPlus() {
  static bool initialized = []() {
    Gdiplus::GdiplusStartupInput input;
    ULONG_PTR token = 0;
    return Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok;
  }();
  return initialized;
}

bool EncodeRgbaToPng(const uint8_t* bgra, int width, int height, int stride, std::vector<uint8_t>* out_png) {
  if (!bgra || width <= 0 || height <= 0 || !out_png) return false;
  CLSID png_clsid{};
  if (!GetEncoderClsid(L"image/png", &png_clsid)) return false;
  Gdiplus::Bitmap bmp(width, height, stride, PixelFormat32bppARGB, const_cast<BYTE*>(bgra));
  IStream* stream = nullptr;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) || !stream) return false;
  bool ok = false;
  if (bmp.Save(stream, &png_clsid, nullptr) == Gdiplus::Ok) {
    HGLOBAL hmem = nullptr;
    if (SUCCEEDED(GetHGlobalFromStream(stream, &hmem)) && hmem) {
      SIZE_T sz = GlobalSize(hmem);
      const void* ptr = GlobalLock(hmem);
      if (ptr && sz > 0) {
        out_png->assign(static_cast<const uint8_t*>(ptr), static_cast<const uint8_t*>(ptr) + sz);
        ok = true;
      }
      if (ptr) GlobalUnlock(hmem);
    }
  }
  stream->Release();
  return ok;
}

bool EncodeBgr24ToJpeg(const uint8_t* bgr, int width, int height, int stride, int quality, std::vector<uint8_t>* out_jpeg) {
  if (!bgr || width <= 0 || height <= 0 || !out_jpeg) return false;
  CLSID jpeg_clsid{};
  if (!GetEncoderClsid(L"image/jpeg", &jpeg_clsid)) return false;
  Gdiplus::Bitmap bmp(width, height, stride, PixelFormat24bppRGB, const_cast<BYTE*>(bgr));
  static constexpr GUID kEncoderQualityGuid = {
      0x1d5be4b5, 0xfa4a, 0x452d, {0x9c, 0xdd, 0x5d, 0xb3, 0x51, 0x05, 0xe7, 0xeb}};
  Gdiplus::EncoderParameters params{};
  params.Count = 1;
  params.Parameter[0].Guid = kEncoderQualityGuid;
  params.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
  params.Parameter[0].NumberOfValues = 1;
  ULONG q = static_cast<ULONG>(std::clamp(quality, 1, 100));
  params.Parameter[0].Value = &q;

  IStream* stream = nullptr;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) || !stream) return false;
  bool ok = false;
  if (bmp.Save(stream, &jpeg_clsid, &params) == Gdiplus::Ok) {
    HGLOBAL hmem = nullptr;
    if (SUCCEEDED(GetHGlobalFromStream(stream, &hmem)) && hmem) {
      SIZE_T sz = GlobalSize(hmem);
      const void* ptr = GlobalLock(hmem);
      if (ptr && sz > 0) {
        out_jpeg->assign(static_cast<const uint8_t*>(ptr), static_cast<const uint8_t*>(ptr) + sz);
        ok = true;
      }
      if (ptr) GlobalUnlock(hmem);
    }
  }
  stream->Release();
  return ok;
}

std::optional<CursorShapeSnapshot> CaptureCursorShape(double fallback_scale) {
  static std::mutex cache_mu;
  static std::unordered_map<std::string, CursorShapeSnapshot> cache;

  CURSORINFO ci{};
  ci.cbSize = sizeof(ci);
  if (!GetCursorInfo(&ci) || (ci.flags & CURSOR_SHOWING) == 0 || !ci.hCursor) return std::nullopt;

  HICON copied = nullptr;
  ICONINFO icon_info{};
  bool has_info = GetIconInfo(ci.hCursor, &icon_info) != FALSE;
  if (!has_info) {
    copied = CopyIcon(ci.hCursor);
    if (copied) has_info = GetIconInfo(copied, &icon_info) != FALSE;
  }
  if (!has_info) {
    if (copied) DestroyIcon(copied);
    return std::nullopt;
  }

  HCURSOR draw_handle = copied ? copied : ci.hCursor;
  std::optional<CursorShapeSnapshot> result;

  BITMAP bm{};
  int px_w = 0, px_h = 0;
  if (icon_info.hbmColor && GetObjectW(icon_info.hbmColor, sizeof(bm), &bm) > 0) {
    px_w = bm.bmWidth;
    px_h = std::abs(bm.bmHeight);
  } else if (icon_info.hbmMask && GetObjectW(icon_info.hbmMask, sizeof(bm), &bm) > 0) {
    px_w = bm.bmWidth;
    px_h = std::max(1, std::abs(bm.bmHeight) / 2);
  } else {
    px_w = GetSystemMetrics(SM_CXCURSOR);
    px_h = GetSystemMetrics(SM_CYCURSOR);
  }

  if (px_w > 0 && px_h > 0 && px_w <= 512 && px_h <= 512) {
    double scale = std::clamp(MonitorScale(ci.ptScreenPos), 1.0, 4.0);
    if (scale <= 0) scale = std::clamp(fallback_scale, 1.0, 4.0);
    double logical_w = Round2(px_w / scale);
    double logical_h = Round2(px_h / scale);
    if (logical_w > 0 && logical_h > 0 && logical_w <= 256 && logical_h <= 256) {
      int hot_x = std::clamp(static_cast<int>(icon_info.xHotspot), 0, px_w);
      int hot_y = std::clamp(static_cast<int>(icon_info.yHotspot), 0, px_h);

      std::vector<uint8_t> black, white;
      if (DrawCursorToBgra(draw_handle, px_w, px_h, 0, 0, 0, &black) &&
          DrawCursorToBgra(draw_handle, px_w, px_h, 255, 255, 255, &white)) {
        const size_t total = static_cast<size_t>(px_w) * static_cast<size_t>(px_h);
        std::vector<uint8_t> packed(total * 4, 0);
        for (size_t i = 0; i < total; ++i) {
          uint8_t b_b = black[i * 4], b_g = black[i * 4 + 1], b_r = black[i * 4 + 2];
          uint8_t w_b = white[i * 4], w_g = white[i * 4 + 1], w_r = white[i * 4 + 2];
          uint8_t out_b = 0, out_g = 0, out_r = 0, out_a = 0;
          if (w_b < b_b || w_g < b_g || w_r < b_r) {
            // Monochrome XOR-inverted cursor pixels (classic I-beam): opaque black for video legibility.
            out_a = 255;
          } else {
            int diff = ((static_cast<int>(w_r) - b_r) + (static_cast<int>(w_g) - b_g) + (static_cast<int>(w_b) - b_b)) / 3;
            int a = std::clamp(255 - diff, 0, 255);
            if (a == 255) {
              out_b = b_b; out_g = b_g; out_r = b_r; out_a = 255;
            } else if (a > 0) {
              out_a = static_cast<uint8_t>(a);
              out_b = static_cast<uint8_t>(std::min(255, static_cast<int>(b_b) * 255 / a));
              out_g = static_cast<uint8_t>(std::min(255, static_cast<int>(b_g) * 255 / a));
              out_r = static_cast<uint8_t>(std::min(255, static_cast<int>(b_r) * 255 / a));
            }
          }
          packed[i * 4 + 0] = out_b;
          packed[i * 4 + 1] = out_g;
          packed[i * 4 + 2] = out_r;
          packed[i * 4 + 3] = out_a;
        }

        std::ostringstream meta_ss;
        meta_ss << "|" << px_w << "x" << px_h << "|" << hot_x << "," << hot_y << "|" << Round2(scale);
        std::string meta = meta_ss.str();
        std::vector<uint8_t> hash_input = packed;
        hash_input.insert(hash_input.end(), meta.begin(), meta.end());
        auto digest = Sha256Bytes(hash_input.data(), hash_input.size());
        std::string id = HexEncode(digest.data(), 8);

        std::lock_guard<std::mutex> lock(cache_mu);
        if (auto it = cache.find(id); it != cache.end()) {
          result = it->second;
        } else {
          std::vector<uint8_t> png_bytes;
          if (EncodeRgbaToPng(packed.data(), px_w, px_h, px_w * 4, &png_bytes)) {
            if (cache.size() >= 64) cache.clear();
            CursorShapeSnapshot snap;
            snap.id = id;
            snap.png = Base64EncodeBytes(png_bytes.data(), png_bytes.size());
            snap.width = logical_w;
            snap.height = logical_h;
            snap.hot_x = Round2(hot_x / scale);
            snap.hot_y = Round2(hot_y / scale);
            snap.scale = Round2(scale);
            cache[id] = snap;
            result = std::move(snap);
          }
        }
      }
    }
  }

  if (icon_info.hbmMask) DeleteObject(icon_info.hbmMask);
  if (icon_info.hbmColor) DeleteObject(icon_info.hbmColor);
  if (copied) DestroyIcon(copied);
  return result;
}

json ShapeMessage(const CursorShapeSnapshot& shape, const RECT& display_bounds, double display_scale, bool include_png) {
  json msg = {{"t", "shape"}, {"id", shape.id}};
  if (include_png) {
    double scale = std::clamp(display_scale, 1.0, 4.0);
    int w = display_bounds.right - display_bounds.left;
    int h = display_bounds.bottom - display_bounds.top;
    msg["png"] = shape.png;
    msg["w"] = shape.width;
    msg["h"] = shape.height;
    msg["hotX"] = shape.hot_x;
    msg["hotY"] = shape.hot_y;
    msg["scale"] = shape.scale;
    msg["displayW"] = Round2(w / scale);
    msg["displayH"] = Round2(h / scale);
  }
  return msg;
}

void InputState::Post(const INPUT& input) {
  INPUT copy = input;
  if (SendInput(1, &copy, sizeof(INPUT)) != 1) {
    throw std::runtime_error("Windows 拒绝了输入；无法控制管理员窗口、锁屏或 UAC 安全桌面");
  }
}

void InputState::Mouse(DWORD flags, int x, int y, int data) {
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dx = x;
  in.mi.dy = y;
  in.mi.mouseData = static_cast<DWORD>(data);
  in.mi.dwFlags = flags;
  Post(in);
}

void InputState::Key(WORD vk, bool up, WORD scan, bool unicode) {
  DWORD extended = ((vk >= 0x21 && vk <= 0x2E) || vk == 0x5B) ? KEYEVENTF_EXTENDEDKEY : 0;
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = vk;
  in.ki.wScan = scan;
  in.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (unicode ? KEYEVENTF_UNICODE : extended);
  Post(in);
  if (!unicode) {
    if (up) held_keys_.erase(vk);
    else held_keys_.insert(vk);
  }
}

void InputState::ScanKey(WORD scan, bool up, bool extended) {
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = 0;
  in.ki.wScan = scan;
  in.ki.dwFlags = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  Post(in);
  uint32_t packed = (static_cast<uint32_t>(extended ? 1 : 0) << 16) | scan;
  if (up) held_scans_.erase(packed);
  else held_scans_.insert(packed);
}

void InputState::TapKey(WORD vk) {
  Key(vk, false);
  Key(vk, true);
}

void InputState::Release(bool dry_run) {
  if (dry_run) return;
  std::vector<WORD> keys(held_keys_.begin(), held_keys_.end());
  for (WORD vk : keys) {
    try { Key(vk, true); } catch (...) { held_keys_.erase(vk); }
  }
  std::vector<uint32_t> scans(held_scans_.begin(), held_scans_.end());
  for (uint32_t packed : scans) {
    try { ScanKey(static_cast<WORD>(packed & 0xFFFFu), true, (packed >> 16) != 0); } catch (...) {}
  }
  held_scans_.clear();
  try {
    if (left_down_) Mouse(MOUSEEVENTF_LEFTUP);
    if (right_down_) Mouse(MOUSEEVENTF_RIGHTUP);
    if (middle_down_) Mouse(MOUSEEVENTF_MIDDLEUP);
  } catch (...) {}
  left_down_ = right_down_ = middle_down_ = false;
}

void InputState::Handle(const json& e, const RECT& target_bounds) {
  if (!e.is_object()) return;
  std::string type = JsonStr(e, "t");
  int bw = target_bounds.right - target_bounds.left;
  int bh = target_bounds.bottom - target_bounds.top;

  if (type == "move") {
    RECT all = VirtualScreenBounds();
    int aw = std::max(1, (all.right - all.left) - 1);
    int ah = std::max(1, (all.bottom - all.top) - 1);
    double nx = std::clamp(JsonNum(e, "x"), 0.0, 1.0);
    double ny = std::clamp(JsonNum(e, "y"), 0.0, 1.0);
    int x = target_bounds.left + static_cast<int>(nx * std::max(0, bw - 1));
    int y = target_bounds.top + static_cast<int>(ny * std::max(0, bh - 1));
    Mouse(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE,
          static_cast<int>(static_cast<int64_t>(x - all.left) * 65535 / aw),
          static_cast<int>(static_cast<int64_t>(y - all.top) * 65535 / ah));
    return;
  }

  if (type == "keydown" || type == "keyup") {
    uint16_t scan = 0;
    bool ext = false;
    if (TryMapW3cCodeToScan(JsonStr(e, "c"), &scan, &ext)) {
      ScanKey(scan, type == "keyup", ext);
    }
    return;
  }

  std::vector<WORD> modifiers;
  if (auto it = e.find("m"); it != e.end() && it->is_array()) {
    for (const auto& m : *it) {
      if (!m.is_string()) continue;
      std::string ms = m.get<std::string>();
      WORD vk = (ms == "cmd") ? VK_LWIN : (ms == "ctrl") ? VK_CONTROL : (ms == "alt") ? VK_MENU : VK_SHIFT;
      if (held_keys_.count(vk) == 0) {
        Key(vk, false);
        modifiers.push_back(vk);
      }
    }
  }

  auto release_mods = [&]() {
    for (auto it = modifiers.rbegin(); it != modifiers.rend(); ++it) {
      try { Key(*it, true); } catch (...) { held_keys_.erase(*it); }
    }
  };

  try {
    if (type == "down" || type == "up") {
      bool down = (type == "down");
      std::string b = JsonStr(e, "b");
      if (b == "right") {
        Mouse(down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP);
        right_down_ = down;
      } else if (b == "middle") {
        Mouse(down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP);
        middle_down_ = down;
      } else {
        Mouse(down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP);
        left_down_ = down;
      }
    } else if (type == "scroll") {
      int dy = std::clamp(static_cast<int>(JsonNum(e, "dy")), -12000, 12000);
      int dx = std::clamp(static_cast<int>(JsonNum(e, "dx")), -12000, 12000);
      if (dy != 0) Mouse(MOUSEEVENTF_WHEEL, 0, 0, dy);
      if (dx != 0) Mouse(MOUSEEVENTF_HWHEEL, 0, 0, -dx);
    } else if (type == "text") {
      std::wstring ws = Utf8ToWide(JsonStr(e, "s"));
      size_t limit = std::min<size_t>(ws.size(), 4000);
      for (size_t i = 0; i < limit; ++i) {
        Key(0, false, static_cast<WORD>(ws[i]), true);
        Key(0, true, static_cast<WORD>(ws[i]), true);
      }
    } else if (type == "key") {
      std::string name = JsonStr(e, "k");
      WORD vk = MapNamedKeyToVk(name);
      std::wstring wname = Utf8ToWide(name);
      if (vk == 0 && wname.size() == 1) {
        SHORT mapping = VkKeyScanW(wname[0]);
        if (mapping == -1) {
          Key(0, false, static_cast<WORD>(wname[0]), true);
          Key(0, true, static_cast<WORD>(wname[0]), true);
          release_mods();
          return;
        }
        vk = static_cast<WORD>(mapping & 0xFF);
        const WORD needed[3] = {VK_SHIFT, VK_CONTROL, VK_MENU};
        for (int i = 0; i < 3; ++i) {
          if ((mapping & (1 << (8 + i))) != 0 && held_keys_.count(needed[i]) == 0) {
            Key(needed[i], false);
            modifiers.push_back(needed[i]);
          }
        }
      }
      if (vk != 0) {
        Key(vk, false);
        Key(vk, true);
      }
    }
  } catch (...) {
    release_mods();
    throw;
  }
  release_mods();
}

void RunControlMode(int screen_index, bool dry_run) {
  EnsureSharingEnabled(dry_run);
  if (!dry_run && TryRunElevatedControl(screen_index, dry_run)) return;

  RECT bounds = DisplayBounds(screen_index, dry_run);
  WriteStdoutJson({{"t", "ready"}, {"trusted", true}, {"app", "LinkShell"}});

  std::mutex q_mu;
  std::deque<std::string> lines;
  bool eof = false;
  HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  std::thread reader([&]() {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      {
        std::lock_guard<std::mutex> lock(q_mu);
        lines.push_back(std::move(line));
      }
      if (wake) SetEvent(wake);
    }
    {
      std::lock_guard<std::mutex> lock(q_mu);
      eof = true;
    }
    if (wake) SetEvent(wake);
  });
  reader.detach();

  InputState input;
  POINT last{INT_MIN, INT_MIN};
  bool in_secure_desktop = false;

  try {
    for (;;) {
      EnsureSharingEnabled(dry_run);
      if (!IsDefaultDesktopActive(dry_run)) {
        if (!in_secure_desktop) {
          input.Release(dry_run);
          in_secure_desktop = true;
        }
        if (wake) WaitForSingleObject(wake, 150);
        std::lock_guard<std::mutex> lock(q_mu);
        lines.clear();
        if (eof) break;
        continue;
      }
      in_secure_desktop = false;

      POINT p{};
      if (GetCursorPos(&p) && (p.x != last.x || p.y != last.y)) {
        double bw = std::max(1, static_cast<int>(bounds.right - bounds.left));
        double bh = std::max(1, static_cast<int>(bounds.bottom - bounds.top));
        double cx = std::clamp((p.x - bounds.left) / bw, 0.0, 1.0);
        double cy = std::clamp((p.y - bounds.top) / bh, 0.0, 1.0);
        WriteStdoutJson({{"t", "cursor"}, {"x", cx}, {"y", cy}});
        last = p;
      }

      std::string line;
      bool has_line = false;
      {
        std::lock_guard<std::mutex> lock(q_mu);
        if (!lines.empty()) {
          line = std::move(lines.front());
          lines.pop_front();
          has_line = true;
        } else if (eof) {
          break;
        }
      }
      if (!has_line) {
        if (wake) WaitForSingleObject(wake, 16);
        continue;
      }
      if (line.size() > 32000) continue;
      auto parsed = json::parse(line, nullptr, false);
      if (parsed.is_discarded() || !parsed.is_object()) continue;
      if (dry_run) {
        parsed["t"] = "posted";
        WriteStdoutJson(parsed);
        continue;
      }
      try {
        input.Handle(parsed, bounds);
      } catch (const std::exception& err) {
        input.Release(dry_run);
        std::cerr << "[control] " << err.what() << "\n";
      }
    }
  } catch (...) {
    input.Release(dry_run);
    if (wake) CloseHandle(wake);
    throw;
  }
  input.Release(dry_run);
  if (wake) CloseHandle(wake);
}

}  // namespace linkshell::helper
