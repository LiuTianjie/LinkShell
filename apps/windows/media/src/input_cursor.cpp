#include "input_cursor.hpp"

#include <objidl.h>
#include <gdiplus.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <unordered_map>
#include <vector>

#include "dxgi_capturer.hpp"

namespace linkshell {

namespace {

bool EnsureGdiPlus() {
  static bool initialized = []() {
    Gdiplus::GdiplusStartupInput input;
    ULONG_PTR token = 0;
    return Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok;
  }();
  return initialized;
}

bool GetPngEncoderClsid(CLSID* out_clsid) {
  static bool found = false;
  static CLSID cached{};
  if (found) {
    *out_clsid = cached;
    return true;
  }
  UINT num = 0, size = 0;
  if (Gdiplus::GetImageEncodersSize(&num, &size) != Gdiplus::Ok || size == 0) return false;
  std::vector<uint8_t> buf(size);
  auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
  if (Gdiplus::GetImageEncoders(num, size, encoders) != Gdiplus::Ok) return false;
  for (UINT i = 0; i < num; ++i) {
    if (encoders[i].MimeType && wcscmp(encoders[i].MimeType, L"image/png") == 0) {
      cached = encoders[i].Clsid;
      found = true;
      *out_clsid = cached;
      return true;
    }
  }
  return false;
}

uint64_t Fnv1a64(const uint8_t* data, size_t len) {
  uint64_t h = 14695981039346656037ULL;
  for (size_t i = 0; i < len; ++i) {
    h ^= data[i];
    h *= 1099511628211ULL;
  }
  return h;
}

bool IsProcessElevatedHandle(HANDLE proc) {
  HANDLE tok = nullptr;
  if (!OpenProcessToken(proc, TOKEN_QUERY, &tok)) return false;
  TOKEN_ELEVATION elev{};
  DWORD ret = 0;
  bool elevated = GetTokenInformation(tok, TokenElevation, &elev, sizeof(elev), &ret) && elev.TokenIsElevated != 0;
  CloseHandle(tok);
  return elevated;
}

bool IsForegroundWindowElevated() {
  static bool self_elevated = IsProcessElevatedHandle(GetCurrentProcess());
  if (self_elevated) return false;
  HWND fg = GetForegroundWindow();
  if (!fg) return false;
  DWORD pid = 0;
  GetWindowThreadProcessId(fg, &pid);
  if (pid == 0 || pid == GetCurrentProcessId()) return false;
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return GetLastError() == ERROR_ACCESS_DENIED;
  bool elevated = IsProcessElevatedHandle(proc);
  CloseHandle(proc);
  return elevated;
}

}  // namespace

InputCursorController::InputCursorController(LogFn log) : log_(std::move(log)) {
  EnsureGdiPlus();
}

InputCursorController::~InputCursorController() {
  ReleaseAll();
  CloseServicePipe();
}

void InputCursorController::SetDisplay(const DisplayInfo& display) {
  std::lock_guard<std::mutex> lock(mu_);
  display_ = display;
  if (svc_screen_ != display.screen) CloseServicePipe();
  last_cursor_x_ = -1.0;
  last_cursor_y_ = -1.0;
  last_hcursor_ = nullptr;
  last_shape_id_.clear();
}

void InputCursorController::SetGeneration(std::optional<int64_t> generation) {
  std::lock_guard<std::mutex> lock(mu_);
  active_generation_ = generation;
}

void InputCursorController::SetSuspended(bool suspended) {
  if (suspended) ReleaseAll();
  std::lock_guard<std::mutex> lock(mu_);
  suspended_ = suspended;
}

bool InputCursorController::ShouldForwardElevated() const {
  if (!GdiAndSecureCapturer::IsServiceAvailable()) return false;
  return !IsDefaultDesktopActive() || IsForegroundWindowElevated();
}

void InputCursorController::CloseServicePipe() {
  if (svc_pipe_ != INVALID_HANDLE_VALUE) {
    CloseHandle(svc_pipe_);
    svc_pipe_ = INVALID_HANDLE_VALUE;
  }
  svc_screen_ = -1;
}

bool InputCursorController::ForwardToService(const json& event) {
  if (svc_pipe_ == INVALID_HANDLE_VALUE || svc_screen_ != display_.screen) {
    CloseServicePipe();
    std::string token = GdiAndSecureCapturer::ReadServiceToken();
    if (token.empty()) return false;
    HANDLE h = CreateFileW(
        L"\\\\.\\pipe\\LinkShellScreenServiceV1",
        GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    json handshake = {{"token", token}, {"mode", "control"}, {"screen", display_.screen}, {"w", 1920}, {"h", 1080}, {"fps", 30}, {"quality", 80}};
    std::string hs = handshake.dump() + "\n";
    DWORD written = 0;
    if (!WriteFile(h, hs.data(), static_cast<DWORD>(hs.size()), &written, nullptr) || written != hs.size()) {
      CloseHandle(h);
      return false;
    }
    svc_pipe_ = h;
    svc_screen_ = display_.screen;
  }
  std::string line = event.dump() + "\n";
  DWORD written = 0;
  if (!WriteFile(svc_pipe_, line.data(), static_cast<DWORD>(line.size()), &written, nullptr) || written != line.size()) {
    CloseServicePipe();
    return false;
  }
  return true;
}

void InputCursorController::SendMouse(DWORD flags, int dx, int dy, DWORD data) {
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dx = dx;
  in.mi.dy = dy;
  in.mi.mouseData = data;
  in.mi.dwFlags = flags;
  SendInput(1, &in, sizeof(INPUT));
}

void InputCursorController::SendVirtualKey(WORD vk, bool up, bool extended) {
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = vk;
  in.ki.wScan = static_cast<WORD>(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC));
  in.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  SendInput(1, &in, sizeof(INPUT));
}

void InputCursorController::SendScanCode(WORD scan, bool up, bool extended) {
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = 0;
  in.ki.wScan = scan;
  in.ki.dwFlags = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  SendInput(1, &in, sizeof(INPUT));
}

void InputCursorController::SendUnicodeText(const std::string& utf8) {
  std::wstring wide = Utf8ToWide(utf8);
  if (wide.empty()) return;
  std::vector<INPUT> inputs;
  inputs.reserve(wide.size() * 2);
  for (wchar_t ch : wide) {
    if (ch == L'\r') continue;
    if (ch == L'\n') {
      INPUT down{}, up{};
      down.type = up.type = INPUT_KEYBOARD;
      down.ki.wVk = up.ki.wVk = VK_RETURN;
      up.ki.dwFlags = KEYEVENTF_KEYUP;
      inputs.push_back(down);
      inputs.push_back(up);
      continue;
    }
    INPUT down{}, up{};
    down.type = up.type = INPUT_KEYBOARD;
    down.ki.wScan = static_cast<WORD>(ch);
    down.ki.dwFlags = KEYEVENTF_UNICODE;
    up.ki.wScan = static_cast<WORD>(ch);
    up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    inputs.push_back(down);
    inputs.push_back(up);
  }
  if (!inputs.empty()) {
    SendInput(static_cast<UINT>(inputs.size()), inputs.data(), sizeof(INPUT));
  }
}

void InputCursorController::ReleaseAll() {
  std::lock_guard<std::mutex> lock(mu_);
  if (left_down_) { SendMouse(MOUSEEVENTF_LEFTUP); left_down_ = false; }
  if (right_down_) { SendMouse(MOUSEEVENTF_RIGHTUP); right_down_ = false; }
  if (middle_down_) { SendMouse(MOUSEEVENTF_MIDDLEUP); middle_down_ = false; }
  for (uint32_t packed : held_scans_) {
    bool ext = (packed >> 16) != 0;
    WORD scan = static_cast<WORD>(packed & 0xFFFF);
    SendScanCode(scan, true, ext);
  }
  held_scans_.clear();
}

bool InputCursorController::HandleEvent(const json& event, bool lossy) {
  std::lock_guard<std::mutex> lock(mu_);
  if (suspended_ || !event.is_object()) return false;
  if (!event.contains("t") || !event["t"].is_string()) return false;

  // Reject stale input from a prior display configuration generation.
  if (active_generation_) {
    if (event.contains("screenGeneration") && event["screenGeneration"].is_number_integer()) {
      int64_t g = event["screenGeneration"].get<int64_t>();
      if (g != *active_generation_) return false;
    }
  }

  // Drop out-of-order lossy pointer events (exact parity with ScreenInputOrder).
  if (event.contains("i") && event["i"].is_number_integer()) {
    int64_t num = event["i"].get<int64_t>();
    if (lossy && num <= newest_event_) return false;
    if (num > newest_event_) newest_event_ = num;
  }

  std::string type = event["t"].get<std::string>();

  // Forward to LinkShellScreenService when targeting UAC / Lock Screen / elevated Admin window.
  if (ShouldForwardElevated() && type != "keydown" && type != "keyup") {
    if (ForwardToService(event)) return true;
  }

  if (type == "move") {
    if (!event.contains("x") || !event.contains("y") || !event["x"].is_number() || !event["y"].is_number()) return false;
    double x = std::clamp(event["x"].get<double>(), 0.0, 1.0);
    double y = std::clamp(event["y"].get<double>(), 0.0, 1.0);
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = std::max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1);
    int vh = std::max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1);
    int px = display_.bounds.left + static_cast<int>(std::llround(x * std::max(1, display_.width - 1)));
    int py = display_.bounds.top + static_cast<int>(std::llround(y * std::max(1, display_.height - 1)));
    int abs_x = static_cast<int>((static_cast<int64_t>(px - vx) * 65535) / vw);
    int abs_y = static_cast<int>((static_cast<int64_t>(py - vy) * 65535) / vh);
    SendMouse(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE, abs_x, abs_y);
    return true;
  }

  if (type == "keydown" || type == "keyup") {
    if (!event.contains("c") || !event["c"].is_string()) return false;
    std::string code = event["c"].get<std::string>();
    WORD scan = 0;
    bool ext = false;
    if (!MapW3CCodeToScan(code, &scan, &ext)) return false;
    bool up = (type == "keyup");
    uint32_t packed = (static_cast<uint32_t>(ext ? 1 : 0) << 16) | scan;
    if (up) held_scans_.erase(packed);
    else held_scans_.insert(packed);
    SendScanCode(scan, up, ext);
    return true;
  }

  // Optional modifier wrapping for down/up/scroll/key.
  std::vector<WORD> pressed_mods;
  if (event.contains("m") && event["m"].is_array()) {
    for (const auto& m : event["m"]) {
      if (!m.is_string()) continue;
      std::string ms = m.get<std::string>();
      WORD vk = 0;
      if (ms == "cmd") vk = VK_LWIN;
      else if (ms == "ctrl") vk = VK_CONTROL;
      else if (ms == "alt") vk = VK_MENU;
      else if (ms == "shift") vk = VK_SHIFT;
      if (vk != 0) {
        SendVirtualKey(vk, false, vk == VK_LWIN);
        pressed_mods.push_back(vk);
      }
    }
  }

  bool ok = true;
  if (type == "down" || type == "up") {
    bool down = (type == "down");
    std::string b = event.contains("b") && event["b"].is_string() ? event["b"].get<std::string>() : "left";
    if (b == "right") {
      SendMouse(down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP);
      right_down_ = down;
    } else if (b == "middle") {
      SendMouse(down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP);
      middle_down_ = down;
    } else {
      SendMouse(down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP);
      left_down_ = down;
    }
  } else if (type == "scroll") {
    double dx = event.contains("dx") && event["dx"].is_number() ? event["dx"].get<double>() : 0.0;
    double dy = event.contains("dy") && event["dy"].is_number() ? event["dy"].get<double>() : 0.0;
    int idy = std::clamp(static_cast<int>(std::llround(dy)), -12000, 12000);
    int idx = std::clamp(static_cast<int>(std::llround(dx)), -12000, 12000);
    if (idy != 0) SendMouse(MOUSEEVENTF_WHEEL, 0, 0, static_cast<DWORD>(idy));
    if (idx != 0) SendMouse(MOUSEEVENTF_HWHEEL, 0, 0, static_cast<DWORD>(-idx));
  } else if (type == "text") {
    if (event.contains("s") && event["s"].is_string()) {
      SendUnicodeText(event["s"].get<std::string>());
    } else {
      ok = false;
    }
  } else if (type == "key") {
    if (event.contains("k") && event["k"].is_string()) {
      bool ext = false;
      WORD vk = MapNamedKeyToVk(event["k"].get<std::string>(), &ext);
      if (vk != 0) {
        SendVirtualKey(vk, false, ext);
        SendVirtualKey(vk, true, ext);
      } else {
        ok = false;
      }
    } else {
      ok = false;
    }
  } else {
    ok = false;
  }

  for (auto it = pressed_mods.rbegin(); it != pressed_mods.rend(); ++it) {
    SendVirtualKey(*it, true, *it == VK_LWIN);
  }
  return ok;
}

std::optional<std::pair<double, double>> InputCursorController::PollCursor(bool force) {
  std::lock_guard<std::mutex> lock(mu_);
  if (display_.width <= 0 || display_.height <= 0) return std::nullopt;
  POINT pt{};
  if (!GetCursorPos(&pt)) return std::nullopt;
  if (pt.x < display_.bounds.left || pt.x >= display_.bounds.right ||
      pt.y < display_.bounds.top || pt.y >= display_.bounds.bottom) {
    return std::nullopt;
  }
  double x = static_cast<double>(pt.x - display_.bounds.left) / std::max(1, display_.width - 1);
  double y = static_cast<double>(pt.y - display_.bounds.top) / std::max(1, display_.height - 1);
  x = std::clamp(x, 0.0, 1.0);
  y = std::clamp(y, 0.0, 1.0);
  if (!force && std::abs(x - last_cursor_x_) < 0.0005 && std::abs(y - last_cursor_y_) < 0.0005) {
    return std::nullopt;
  }
  last_cursor_x_ = x;
  last_cursor_y_ = y;
  return std::make_pair(x, y);
}

std::optional<CursorShapePayload> InputCursorController::PollShape(bool force) {
  std::lock_guard<std::mutex> lock(mu_);
  if (display_.width <= 0 || display_.height <= 0) return std::nullopt;
  CURSORINFO ci{};
  ci.cbSize = sizeof(ci);
  if (!GetCursorInfo(&ci) || (ci.flags & CURSOR_SHOWING) == 0 || !ci.hCursor) return std::nullopt;
  if (!force && ci.hCursor == last_hcursor_) return std::nullopt;

  ICONINFO ii{};
  if (!GetIconInfo(ci.hCursor, &ii)) return std::nullopt;

  int w = 32, h = 32;
  BITMAP bm{};
  if (ii.hbmColor && GetObjectW(ii.hbmColor, sizeof(bm), &bm)) {
    w = bm.bmWidth;
    h = std::abs(bm.bmHeight);
  } else if (ii.hbmMask && GetObjectW(ii.hbmMask, sizeof(bm), &bm)) {
    w = bm.bmWidth;
    h = std::abs(bm.bmHeight) / 2;
  }
  if (w <= 0 || h <= 0 || w > 256 || h > 256) {
    if (ii.hbmColor) DeleteObject(ii.hbmColor);
    if (ii.hbmMask) DeleteObject(ii.hbmMask);
    return std::nullopt;
  }

  // Render cursor into 32-bit ARGB DIB so both alpha cursors and monochrome XOR cursors look crisp.
  HDC screen_dc = GetDC(nullptr);
  HDC mem_dc = CreateCompatibleDC(screen_dc);
  BITMAPINFO bmi{};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = w;
  bmi.bmiHeader.biHeight = -h;
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  std::optional<CursorShapePayload> result;

  if (mem_dc && dib && bits) {
    std::memset(bits, 0, static_cast<size_t>(w) * static_cast<size_t>(h) * 4);
    HGDIOBJ old = SelectObject(mem_dc, dib);
    DrawIconEx(mem_dc, 0, 0, ci.hCursor, w, h, 0, nullptr, DI_NORMAL);
    SelectObject(mem_dc, old);

    // Fix zero-alpha opaque pixels produced by GDI DrawIconEx on legacy monochrome cursors (e.g. I-beam).
    auto* px = static_cast<uint8_t*>(bits);
    bool any_alpha = false;
    for (int i = 0; i < w * h; ++i) {
      if (px[i * 4 + 3] != 0) { any_alpha = true; break; }
    }
    if (!any_alpha && ii.hbmMask) {
      // Fall back to visible dark outline where color bits are non-zero.
      for (int i = 0; i < w * h; ++i) {
        if (px[i * 4] | px[i * 4 + 1] | px[i * 4 + 2]) px[i * 4 + 3] = 255;
      }
    }

    uint64_t hash = Fnv1a64(px, static_cast<size_t>(w) * static_cast<size_t>(h) * 4);
    char id_buf[32];
    std::snprintf(id_buf, sizeof(id_buf), "win-%016llx", static_cast<unsigned long long>(hash));
    std::string id(id_buf);
    last_hcursor_ = ci.hCursor;

    if (!force && id == last_shape_id_) {
      // Unchanged shape.
    } else if (auto it = shape_cache_.find(id); it != shape_cache_.end()) {
      last_shape_id_ = id;
      CursorShapePayload slim = it->second;
      slim.png_base64.clear();  // Receiver already cached full PNG by id unless force.
      if (force) slim.png_base64 = it->second.png_base64;
      result = std::move(slim);
    } else {
      CLSID png_clsid{};
      if (GetPngEncoderClsid(&png_clsid)) {
        Gdiplus::Bitmap bmp(w, h, w * 4, PixelFormat32bppARGB, px);
        IStream* stream = nullptr;
        if (SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) && stream) {
          if (bmp.Save(stream, &png_clsid, nullptr) == Gdiplus::Ok) {
            HGLOBAL hmem = nullptr;
            if (SUCCEEDED(GetHGlobalFromStream(stream, &hmem)) && hmem) {
              SIZE_T sz = GlobalSize(hmem);
              void* mem_ptr = GlobalLock(hmem);
              if (mem_ptr && sz > 0) {
                CursorShapePayload payload;
                payload.id = id;
                payload.png_base64 = Base64Encode(static_cast<const uint8_t*>(mem_ptr), sz);
                payload.w = w;
                payload.h = h;
                payload.hot_x = static_cast<int>(ii.xHotspot);
                payload.hot_y = static_cast<int>(ii.yHotspot);
                payload.scale = 1;
                payload.display_w = display_.width;
                payload.display_h = display_.height;
                if (shape_cache_.size() >= 64) shape_cache_.clear();
                shape_cache_[id] = payload;
                last_shape_id_ = id;
                result = std::move(payload);
                GlobalUnlock(hmem);
              }
            }
          }
          stream->Release();
        }
      }
    }
  }

  if (dib) DeleteObject(dib);
  if (mem_dc) DeleteDC(mem_dc);
  if (screen_dc) ReleaseDC(nullptr, screen_dc);
  if (ii.hbmColor) DeleteObject(ii.hbmColor);
  if (ii.hbmMask) DeleteObject(ii.hbmMask);
  return result;
}

bool InputCursorController::MapW3CCodeToScan(const std::string& code, WORD* out_scan, bool* out_extended) {
  struct Entry { WORD scan; bool ext; };
  static const std::unordered_map<std::string, Entry> kMap = {
      {"Escape", {0x01, false}}, {"Digit1", {0x02, false}}, {"Digit2", {0x03, false}}, {"Digit3", {0x04, false}},
      {"Digit4", {0x05, false}}, {"Digit5", {0x06, false}}, {"Digit6", {0x07, false}}, {"Digit7", {0x08, false}},
      {"Digit8", {0x09, false}}, {"Digit9", {0x0A, false}}, {"Digit0", {0x0B, false}}, {"Minus", {0x0C, false}},
      {"Equal", {0x0D, false}}, {"Backspace", {0x0E, false}}, {"Tab", {0x0F, false}},
      {"KeyQ", {0x10, false}}, {"KeyW", {0x11, false}}, {"KeyE", {0x12, false}}, {"KeyR", {0x13, false}},
      {"KeyT", {0x14, false}}, {"KeyY", {0x15, false}}, {"KeyU", {0x16, false}}, {"KeyI", {0x17, false}},
      {"KeyO", {0x18, false}}, {"KeyP", {0x19, false}}, {"BracketLeft", {0x1A, false}}, {"BracketRight", {0x1B, false}},
      {"Enter", {0x1C, false}}, {"ControlLeft", {0x1D, false}},
      {"KeyA", {0x1E, false}}, {"KeyS", {0x1F, false}}, {"KeyD", {0x20, false}}, {"KeyF", {0x21, false}},
      {"KeyG", {0x22, false}}, {"KeyH", {0x23, false}}, {"KeyJ", {0x24, false}}, {"KeyK", {0x25, false}},
      {"KeyL", {0x26, false}}, {"Semicolon", {0x27, false}}, {"Quote", {0x28, false}}, {"Backquote", {0x29, false}},
      {"ShiftLeft", {0x2A, false}}, {"Backslash", {0x2B, false}},
      {"KeyZ", {0x2C, false}}, {"KeyX", {0x2D, false}}, {"KeyC", {0x2E, false}}, {"KeyV", {0x2F, false}},
      {"KeyB", {0x30, false}}, {"KeyN", {0x31, false}}, {"KeyM", {0x32, false}}, {"Comma", {0x33, false}},
      {"Period", {0x34, false}}, {"Slash", {0x35, false}}, {"ShiftRight", {0x36, false}},
      {"NumpadMultiply", {0x37, false}}, {"AltLeft", {0x38, false}}, {"Space", {0x39, false}},
      {"CapsLock", {0x3A, false}}, {"F1", {0x3B, false}}, {"F2", {0x3C, false}}, {"F3", {0x3D, false}},
      {"F4", {0x3E, false}}, {"F5", {0x3F, false}}, {"F6", {0x40, false}}, {"F7", {0x41, false}},
      {"F8", {0x42, false}}, {"F9", {0x43, false}}, {"F10", {0x44, false}}, {"F11", {0x57, false}}, {"F12", {0x58, false}},
      {"NumLock", {0x45, true}}, {"ScrollLock", {0x46, false}},
      {"Numpad7", {0x47, false}}, {"Numpad8", {0x48, false}}, {"Numpad9", {0x49, false}}, {"NumpadSubtract", {0x4A, false}},
      {"Numpad4", {0x4B, false}}, {"Numpad5", {0x4C, false}}, {"Numpad6", {0x4D, false}}, {"NumpadAdd", {0x4E, false}},
      {"Numpad1", {0x4F, false}}, {"Numpad2", {0x50, false}}, {"Numpad3", {0x51, false}}, {"Numpad0", {0x52, false}},
      {"NumpadDecimal", {0x53, false}}, {"NumpadEnter", {0x1C, true}}, {"NumpadDivide", {0x35, true}},
      {"ControlRight", {0x1D, true}}, {"AltRight", {0x38, true}},
      {"MetaLeft", {0x5B, true}}, {"OSLeft", {0x5B, true}}, {"MetaRight", {0x5C, true}}, {"OSRight", {0x5C, true}},
      {"ContextMenu", {0x5D, true}},
      {"Home", {0x47, true}}, {"ArrowUp", {0x48, true}}, {"PageUp", {0x49, true}},
      {"ArrowLeft", {0x4B, true}}, {"ArrowRight", {0x4D, true}},
      {"End", {0x4F, true}}, {"ArrowDown", {0x50, true}}, {"PageDown", {0x51, true}},
      {"Insert", {0x52, true}}, {"Delete", {0x53, true}}, {"PrintScreen", {0x37, true}},
  };
  auto it = kMap.find(code);
  if (it == kMap.end()) return false;
  *out_scan = it->second.scan;
  *out_extended = it->second.ext;
  return true;
}

WORD InputCursorController::MapNamedKeyToVk(const std::string& name, bool* out_extended) {
  *out_extended = false;
  static const std::unordered_map<std::string, std::pair<WORD, bool>> kNamed = {
      {"Return", {VK_RETURN, false}}, {"Enter", {VK_RETURN, false}},
      {"Escape", {VK_ESCAPE, false}}, {"Backspace", {VK_BACK, false}},
      {"Tab", {VK_TAB, false}}, {"Space", {VK_SPACE, false}}, {" ", {VK_SPACE, false}},
      {"Delete", {VK_DELETE, true}}, {"Insert", {VK_INSERT, true}},
      {"Home", {VK_HOME, true}}, {"End", {VK_END, true}},
      {"PageUp", {VK_PRIOR, true}}, {"PageDown", {VK_NEXT, true}},
      {"ArrowUp", {VK_UP, true}}, {"ArrowDown", {VK_DOWN, true}},
      {"ArrowLeft", {VK_LEFT, true}}, {"ArrowRight", {VK_RIGHT, true}},
      {"Up", {VK_UP, true}}, {"Down", {VK_DOWN, true}}, {"Left", {VK_LEFT, true}}, {"Right", {VK_RIGHT, true}},
      {"F1", {VK_F1, false}}, {"F2", {VK_F2, false}}, {"F3", {VK_F3, false}}, {"F4", {VK_F4, false}},
      {"F5", {VK_F5, false}}, {"F6", {VK_F6, false}}, {"F7", {VK_F7, false}}, {"F8", {VK_F8, false}},
      {"F9", {VK_F9, false}}, {"F10", {VK_F10, false}}, {"F11", {VK_F11, false}}, {"F12", {VK_F12, false}},
  };
  if (auto it = kNamed.find(name); it != kNamed.end()) {
    *out_extended = it->second.second;
    return it->second.first;
  }
  if (name.size() == 1) {
    SHORT vk = VkKeyScanA(name[0]);
    if (vk != -1) return static_cast<WORD>(vk & 0xFF);
  }
  return 0;
}

}  // namespace linkshell
