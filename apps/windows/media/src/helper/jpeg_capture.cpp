#include "helper/screen_common.hpp"

#include <audioclient.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <fcntl.h>
#include <io.h>
#include <mmreg.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>

namespace linkshell::helper {

namespace {

using Microsoft::WRL::ComPtr;

struct CaptureProfile {
  int width = 1920;
  int fps = 30;
  int quality = 85;
  CaptureProfile() = default;
  CaptureProfile(int w, int f, int q)
      : width(std::clamp(w, 320, 3840)),
        fps(std::clamp(f, 1, 30)),
        quality(std::clamp(q, 35, 95)) {}
  bool operator==(const CaptureProfile& o) const {
    return width == o.width && fps == o.fps && quality == o.quality;
  }
};

// Lightweight DXGI Desktop Duplication reader with fast SIMD-friendly bilinear downscale to 24-bpp BGR.
class DxgiJpegDuplicator {
 public:
  static std::unique_ptr<DxgiJpegDuplicator> TryCreate(const RECT& bounds, std::string* reason) {
    if (GetEnvWide(L"LINKSHELL_SCREEN_CAPTURE") == L"gdi") {
      if (reason) *reason = "selected GDI";
      return nullptr;
    }
    auto inst = std::unique_ptr<DxgiJpegDuplicator>(new DxgiJpegDuplicator());
    if (!inst->Init(bounds, reason)) return nullptr;
    return inst;
  }

  static int FindDxgiOutput(const RECT& bounds, uint32_t* out_vendor, int* out_adapter) {
    if (out_vendor) *out_vendor = 0;
    if (out_adapter) *out_adapter = 0;
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) || !factory) return -1;
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a) {
      ComPtr<IDXGIOutput> output;
      for (UINT i = 0; adapter->EnumOutputs(i, &output) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_OUTPUT_DESC desc{};
        if (SUCCEEDED(output->GetDesc(&desc))) {
          const RECT& rc = desc.DesktopCoordinates;
          if (rc.left == bounds.left && rc.top == bounds.top && rc.right == bounds.right &&
              rc.bottom == bounds.bottom && desc.Rotation == DXGI_MODE_ROTATION_IDENTITY) {
            DXGI_ADAPTER_DESC1 ad{};
            if (SUCCEEDED(adapter->GetDesc1(&ad))) {
              if (out_vendor) *out_vendor = ad.VendorId;
              if (out_adapter) *out_adapter = static_cast<int>(a);
            }
            return static_cast<int>(i);
          }
        }
        output.Reset();
      }
      adapter.Reset();
    }
    return -1;
  }

  static uint32_t PrimaryVendor() {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) || !factory) return 0;
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a) {
      DXGI_ADAPTER_DESC1 ad{};
      if (SUCCEEDED(adapter->GetDesc1(&ad)) && ad.VendorId != 0x1414 && ad.VendorId != 0) {
        return ad.VendorId;
      }
      adapter.Reset();
    }
    return 0;
  }

  bool CopyScaledBgr24(int dst_w, int dst_h, bool force, std::vector<uint8_t>* out_bgr) {
    if (!duplication_ || !out_bgr || dst_w <= 0 || dst_h <= 0) return false;
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    HRESULT hr = duplication_->AcquireNextFrame(0, &info, &resource);
    bool changed = force;
    if (hr != DXGI_ERROR_WAIT_TIMEOUT) {
      if (FAILED(hr)) throw std::runtime_error("DXGI acquire failed");
      auto release_guard = [&]() { duplication_->ReleaseFrame(); };
      if (info.LastPresentTime.QuadPart != 0 || !staging_) {
        ComPtr<ID3D11Texture2D> tex;
        if (FAILED(resource.As(&tex)) || !tex) {
          release_guard();
          throw std::runtime_error("DXGI texture unavailable");
        }
        D3D11_TEXTURE2D_DESC desc{};
        tex->GetDesc(&desc);
        if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
          release_guard();
          throw std::runtime_error("此屏幕像素格式需要兼容采集");
        }
        if (!staging_ || src_w_ != static_cast<int>(desc.Width) || src_h_ != static_cast<int>(desc.Height)) {
          staging_.Reset();
          src_w_ = static_cast<int>(desc.Width);
          src_h_ = static_cast<int>(desc.Height);
          D3D11_TEXTURE2D_DESC st = desc;
          st.Usage = D3D11_USAGE_STAGING;
          st.BindFlags = 0;
          st.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
          st.MiscFlags = 0;
          if (FAILED(device_->CreateTexture2D(&st, nullptr, &staging_))) {
            release_guard();
            throw std::runtime_error("DXGI staging failed");
          }
        }
        context_->CopyResource(staging_.Get(), tex.Get());
        changed = true;
      }
      release_guard();
    }
    if (!staging_ || src_w_ <= 0 || src_h_ <= 0) return false;
    if (!changed && scaled_w_ == dst_w && scaled_h_ == dst_h) return false;
    scaled_w_ = dst_w;
    scaled_h_ = dst_h;

    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped)) || !mapped.pData) {
      throw std::runtime_error("DXGI map failed");
    }
    const auto* src_base = static_cast<const uint8_t*>(mapped.pData);
    const size_t dst_stride = static_cast<size_t>(dst_w) * 3;
    out_bgr->resize(dst_stride * static_cast<size_t>(dst_h));

    if (dst_w == src_w_ && dst_h == src_h_) {
      for (int y = 0; y < dst_h; ++y) {
        const uint8_t* srow = src_base + static_cast<size_t>(y) * mapped.RowPitch;
        uint8_t* drow = out_bgr->data() + static_cast<size_t>(y) * dst_stride;
        for (int x = 0; x < dst_w; ++x) {
          drow[x * 3 + 0] = srow[x * 4 + 0];
          drow[x * 3 + 1] = srow[x * 4 + 1];
          drow[x * 3 + 2] = srow[x * 4 + 2];
        }
      }
    } else {
      // Bilinear downscale from BGRA staging into packed 24-bpp BGR for crisp text.
      for (int y = 0; y < dst_h; ++y) {
        int64_t sy_fp = ((static_cast<int64_t>(y) * 2 + 1) * src_h_ * 128) / (dst_h * 2) - 128;
        int y0 = std::clamp(static_cast<int>(sy_fp >> 8), 0, src_h_ - 1);
        int y1 = std::min(y0 + 1, src_h_ - 1);
        int wy = static_cast<int>(sy_fp & 0xFF);
        if (sy_fp < 0) wy = 0;
        const uint8_t* r0 = src_base + static_cast<size_t>(y0) * mapped.RowPitch;
        const uint8_t* r1 = src_base + static_cast<size_t>(y1) * mapped.RowPitch;
        uint8_t* drow = out_bgr->data() + static_cast<size_t>(y) * dst_stride;
        for (int x = 0; x < dst_w; ++x) {
          int64_t sx_fp = ((static_cast<int64_t>(x) * 2 + 1) * src_w_ * 128) / (dst_w * 2) - 128;
          int x0 = std::clamp(static_cast<int>(sx_fp >> 8), 0, src_w_ - 1);
          int x1 = std::min(x0 + 1, src_w_ - 1);
          int wx = static_cast<int>(sx_fp & 0xFF);
          if (sx_fp < 0) wx = 0;

          const uint8_t* p00 = r0 + x0 * 4;
          const uint8_t* p10 = r0 + x1 * 4;
          const uint8_t* p01 = r1 + x0 * 4;
          const uint8_t* p11 = r1 + x1 * 4;
          int w00 = (256 - wx) * (256 - wy);
          int w10 = wx * (256 - wy);
          int w01 = (256 - wx) * wy;
          int w11 = wx * wy;
          drow[x * 3 + 0] = static_cast<uint8_t>((p00[0] * w00 + p10[0] * w10 + p01[0] * w01 + p11[0] * w11 + 32768) >> 16);
          drow[x * 3 + 1] = static_cast<uint8_t>((p00[1] * w00 + p10[1] * w10 + p01[1] * w01 + p11[1] * w11 + 32768) >> 16);
          drow[x * 3 + 2] = static_cast<uint8_t>((p00[2] * w00 + p10[2] * w10 + p01[2] * w01 + p11[2] * w11 + 32768) >> 16);
        }
      }
    }
    context_->Unmap(staging_.Get(), 0);
    return true;
  }

 private:
  bool Init(const RECT& bounds, std::string* reason) {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) || !factory) {
      if (reason) *reason = "CreateDXGIFactory1 failed";
      return false;
    }
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a) {
      ComPtr<IDXGIOutput> output;
      for (UINT i = 0; adapter->EnumOutputs(i, &output) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_OUTPUT_DESC desc{};
        if (SUCCEEDED(output->GetDesc(&desc))) {
          const RECT& area = desc.DesktopCoordinates;
          if (area.left == bounds.left && area.top == bounds.top &&
              area.right == bounds.right && area.bottom == bounds.bottom) {
            if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY) {
              if (reason) *reason = "旋转屏幕使用兼容采集";
              return false;
            }
            D3D_FEATURE_LEVEL level{};
            if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                         D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                         D3D11_SDK_VERSION, &device_, &level, &context_))) {
              if (reason) *reason = "D3D11CreateDevice failed";
              return false;
            }
            ComPtr<IDXGIOutput1> output1;
            if (FAILED(output.As(&output1)) || FAILED(output1->DuplicateOutput(device_.Get(), &duplication_))) {
              if (reason) *reason = "DuplicateOutput failed";
              return false;
            }
            return true;
          }
        }
        output.Reset();
      }
      adapter.Reset();
    }
    if (reason) *reason = "此显示器使用兼容采集";
    return false;
  }

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  ComPtr<ID3D11Texture2D> staging_;
  int src_w_ = 0, src_h_ = 0;
  int scaled_w_ = 0, scaled_h_ = 0;
};

bool CaptureGdiScaledBgr24(HDC screen_dc, const RECT& bounds, int dst_w, int dst_h, std::vector<uint8_t>* out_bgr, DWORD* out_err) {
  if (!screen_dc || dst_w <= 0 || dst_h <= 0 || !out_bgr) return false;
  HDC mem_dc = CreateCompatibleDC(screen_dc);
  BITMAPINFO bmi{};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = dst_w;
  bmi.bmiHeader.biHeight = -dst_h;  // top-down
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 24;
  bmi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  bool ok = false;
  if (mem_dc && dib && bits) {
    HGDIOBJ old = SelectObject(mem_dc, dib);
    SetStretchBltMode(mem_dc, HALFTONE);
    SetBrushOrgEx(mem_dc, 0, 0, nullptr);
    int src_w = bounds.right - bounds.left;
    int src_h = bounds.bottom - bounds.top;
    // SRCCOPY | CAPTUREBLT (0x40CC0020)
    ok = StretchBlt(mem_dc, 0, 0, dst_w, dst_h, screen_dc, bounds.left, bounds.top, src_w, src_h, 0x40CC0020) != FALSE;
    if (!ok && out_err) *out_err = GetLastError();
    GdiFlush();
    SelectObject(mem_dc, old);
    if (ok) {
      int dib_stride = ((dst_w * 3 + 3) / 4) * 4;
      const auto* src = static_cast<const uint8_t*>(bits);
      const size_t row_bytes = static_cast<size_t>(dst_w) * 3;
      out_bgr->resize(row_bytes * static_cast<size_t>(dst_h));
      for (int y = 0; y < dst_h; ++y) {
        std::memcpy(out_bgr->data() + static_cast<size_t>(y) * row_bytes, src + static_cast<size_t>(y) * dib_stride, row_bytes);
      }
    }
  } else if (out_err) {
    *out_err = GetLastError();
  }
  if (dib) DeleteObject(dib);
  if (mem_dc) DeleteDC(mem_dc);
  return ok;
}

bool SameRect(const RECT& a, const RECT& b) {
  return a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom;
}

}  // namespace

void RunCaptureJpegMode(int screen, int width, int fps, int quality) {
  _setmode(_fileno(stdout), _O_BINARY);
  EnsureSharingEnabled(false);

  RECT bounds{};
  bool has_active_monitor = true;
  if (!IsDefaultDesktopActive(false) && TryServiceDisplayBounds(screen, &bounds)) {
    has_active_monitor = true;
  } else {
    auto entry = DisplayEntry(screen, true, false);
    bounds = entry.bounds;
    has_active_monitor = entry.has_active_monitor;
  }
  NudgeDesktopForCapture();

  std::mutex state_mu;
  CaptureProfile current_profile(width, fps, quality);
  std::atomic<bool> paused{false};
  std::atomic<bool> ended{false};
  std::atomic<int> force_frame{1};
  HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  std::thread eof_thread([&]() {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.size() > 1024) continue;
      auto msg = json::parse(line, nullptr, false);
      if (!msg.is_object() || !msg.contains("t") || !msg["t"].is_string()) continue;
      std::string type = msg["t"].get<std::string>();
      if (type == "profile") {
        int pw = msg.value("width", 1920);
        int pfps = msg.value("fps", 30);
        int pq = msg.value("quality", 85);
        std::lock_guard<std::mutex> lock(state_mu);
        current_profile = CaptureProfile(pw, pfps, pq);
      } else if (type == "pause") {
        paused.store(msg.value("value", 0) != 0);
      } else if (type != "keyframe") {
        continue;
      }
      force_frame.store(1);
      if (wake) SetEvent(wake);
    }
    ended.store(true);
    if (wake) SetEvent(wake);
  });
  eof_thread.detach();

  bool diagnostics = GetEnvWide(L"LINKSHELL_SCREEN_DIAGNOSTICS") == L"1";
  int64_t metric_at = 0, copy_ms = 0, compare_ms = 0, encode_ms = 0, write_ms = 0;
  int measured = 0;
  int64_t checked_at = -1000;

  HDC screen_dc = GetDC(nullptr);
  if (!screen_dc) {
    if (wake) CloseHandle(wake);
    throw std::runtime_error("无法读取 Windows 桌面");
  }

  std::string dup_reason = "no active physical monitor (headless)";
  auto duplication = has_active_monitor ? DxgiJpegDuplicator::TryCreate(bounds, &dup_reason) : nullptr;
  int64_t dup_started_at = MonotonicMs();
  std::cerr << (duplication ? "[capture] DXGI Desktop Duplication\n" : ("[capture] GDI: " + dup_reason + "\n"));

  HANDLE stdout_handle = GetStdHandle(STD_OUTPUT_HANDLE);

  try {
    std::vector<uint8_t> jpeg_frame;
    while (!ended.load()) {
      CaptureProfile profile;
      {
        std::lock_guard<std::mutex> lock(state_mu);
        profile = current_profile;
      }
      int bw = std::max(1, static_cast<int>(bounds.right - bounds.left));
      int bh = std::max(1, static_cast<int>(bounds.bottom - bounds.top));
      int w = std::min(profile.width, bw);
      int h = std::max(1, static_cast<int>(static_cast<int64_t>(bh) * w / bw));

      std::vector<uint8_t> pixels, previous;
      int64_t last_changed = MonotonicMs();
      int64_t last_sent = -2000;
      bool refined = false;
      int encoded_quality = 0;

      for (;;) {
        if (ended.load()) break;
        {
          std::lock_guard<std::mutex> lock(state_mu);
          if (!(profile == current_profile)) break;
        }

        int64_t began = MonotonicMs();
        if (began - checked_at >= 250) {
          EnsureSharingEnabled(false);
          if (!IsDefaultDesktopActive(false)) {
            duplication.reset();
            std::cerr << "[capture] desktop interrupted (UAC/secure desktop); switching to secure capture/wait\n";
            if (!TryStreamSecureDesktopJpeg(screen, w, std::min(15, profile.fps), profile.quality, stdout_handle, ended)) {
              if (!WaitForDefaultDesktop(120000, ended)) break;
            }
            if (ended.load()) break;
            if (!IsDefaultDesktopActive(false)) {
              checked_at = -1000;
              continue;
            }
            if (wake) WaitForSingleObject(wake, 150);
            EnsureSharingEnabled(false);
            if (screen_dc) ReleaseDC(nullptr, screen_dc);
            screen_dc = GetDC(nullptr);
            if (!screen_dc) throw std::runtime_error("无法读取 Windows 桌面");
            has_active_monitor = DisplayEntry(screen, true, false).has_active_monitor;
            duplication = has_active_monitor ? DxgiJpegDuplicator::TryCreate(bounds, &dup_reason) : nullptr;
            dup_started_at = MonotonicMs();
            force_frame.store(1);
            checked_at = -1000;
            continue;
          }
          if (!SameRect(DisplayBounds(screen, false), bounds)) {
            throw std::runtime_error("屏幕布局已改变，请重新连接");
          }
          checked_at = began;
        }

        if (paused.load()) {
          if (wake) WaitForSingleObject(wake, 100);
          continue;
        }

        bool copied = false;
        if (duplication) {
          try {
            copied = duplication->CopyScaledBgr24(w, h, jpeg_frame.empty(), &pixels);
          } catch (const std::exception& err) {
            duplication.reset();
            if (!IsDefaultDesktopActive(false)) {
              checked_at = -1000;
              continue;
            }
            std::cerr << "[capture] GDI fallback: " << err.what() << "\n";
          }
          if (duplication && !copied && jpeg_frame.empty() && began - dup_started_at >= 1000) {
            duplication.reset();
            std::cerr << "[capture] GDI fallback: DXGI produced no initial frame\n";
          }
        }

        if (!duplication) {
          DWORD blt_err = 0;
          if (!CaptureGdiScaledBgr24(screen_dc, bounds, w, h, &pixels, &blt_err)) {
            if (!IsDefaultDesktopActive(false)) {
              checked_at = -1000;
              continue;
            }
            throw std::runtime_error("Windows 屏幕采集失败：" + std::to_string(blt_err));
          }
          copied = true;
        }

        if (!copied && jpeg_frame.empty()) {
          if (wake) WaitForSingleObject(wake, 10);
          continue;
        }

        int64_t copied_at = MonotonicMs();
        if (previous.size() != pixels.size()) previous.assign(pixels.size(), 0);
        bool changed = jpeg_frame.empty() || (!pixels.empty() && std::memcmp(pixels.data(), previous.data(), pixels.size()) != 0);
        if (changed && !pixels.empty()) {
          previous = pixels;
          last_changed = began;
          refined = false;
        }
        bool refine = !refined && (began - last_changed >= 200);
        bool forced = force_frame.exchange(0) != 0;
        int64_t compared_at = MonotonicMs();
        int64_t encoded_at = compared_at;

        if (changed || refine || forced || (began - last_sent >= 2000)) {
          int next_quality = (refine || refined) ? std::min(95, profile.quality + 15) : profile.quality;
          if (changed || encoded_quality != next_quality || jpeg_frame.empty()) {
            if (!EncodeBgr24ToJpeg(pixels.data(), w, h, w * 3, next_quality, &jpeg_frame)) {
              throw std::runtime_error("JPEG 编码失败");
            }
            encoded_quality = next_quality;
          }
          encoded_at = MonotonicMs();
          uint32_t sz_le = static_cast<uint32_t>(jpeg_frame.size());
          if (!WriteAllBytes(stdout_handle, &sz_le, 4) || !WriteAllBytes(stdout_handle, jpeg_frame.data(), jpeg_frame.size())) {
            break;
          }
          FlushFileBuffers(stdout_handle);
          last_sent = began;
          if (refine) refined = true;
        }

        copy_ms += copied_at - began;
        compare_ms += compared_at - copied_at;
        encode_ms += encoded_at - compared_at;
        write_ms += MonotonicMs() - encoded_at;
        measured += 1;
        if (diagnostics && MonotonicMs() - metric_at >= 2000 && measured > 0) {
          std::cerr << "[capture] frames=" << measured << " copy=" << (copy_ms / measured)
                    << "ms compare=" << (compare_ms / measured) << "ms encode=" << (encode_ms / measured)
                    << "ms write=" << (write_ms / measured) << "ms\n";
          metric_at = MonotonicMs();
          copy_ms = compare_ms = encode_ms = write_ms = 0;
          measured = 0;
        }

        int wait = static_cast<int>(std::ceil(1000.0 / profile.fps)) - static_cast<int>(MonotonicMs() - began);
        if (wait > 0 && wake) WaitForSingleObject(wake, static_cast<DWORD>(wait));
      }
      // Profile switch publishes a fresh frame even when the desktop is still.
      jpeg_frame.clear();
    }
  } catch (...) {
    ReleaseDC(nullptr, screen_dc);
    if (wake) CloseHandle(wake);
    throw;
  }

  ReleaseDC(nullptr, screen_dc);
  if (wake) CloseHandle(wake);
}

void RunWatchShapeMode(int screen) {
  RECT bounds = DisplayBounds(screen, false);
  std::atomic<bool> paused{false};
  std::atomic<bool> ended{false};
  HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  std::thread eof_thread([&]() {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.size() > 1024) continue;
      auto msg = json::parse(line, nullptr, false);
      if (msg.is_object() && msg.value("t", "") == "pause") {
        paused.store(msg.value("value", 0) != 0);
        if (wake) SetEvent(wake);
      }
    }
    ended.store(true);
    if (wake) SetEvent(wake);
  });
  eof_thread.detach();

  std::string last_id;
  CiStringSet sent;
  while (!ended.load()) {
    EnsureSharingEnabled(false);
    if (!paused.load() && IsDefaultDesktopActive(false)) {
      POINT mid{(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2};
      double scale = std::clamp(MonitorScale(mid), 1.0, 4.0);
      auto shape = CaptureCursorShape(scale);
      if (shape && shape->id != last_id) {
        last_id = shape->id;
        bool first_time = sent.insert(shape->id).second;
        WriteStdoutJson(ShapeMessage(*shape, bounds, scale, first_time));
      }
    }
    if (wake) WaitForSingleObject(wake, 200);
  }
  if (wake) CloseHandle(wake);
}

void RunCaptureAudioMode() {
  _setmode(_fileno(stdout), _O_BINARY);
  std::atomic<bool> ended{false};
  std::thread input_thread([&]() {
    std::string line;
    while (std::getline(std::cin, line)) {}
    ended.store(true);
  });
  input_thread.detach();

  HRESULT hr_co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool co_uninit = SUCCEEDED(hr_co);

  constexpr int kTargetRate = 48000;
  constexpr int kFrameSamples = 960;
  constexpr int kFrameBytes = kFrameSamples * 2 * 2;
  std::vector<uint8_t> out_frame(8 + kFrameBytes, 0);
  out_frame[0] = static_cast<uint8_t>(kFrameBytes & 0xFF);
  out_frame[1] = static_cast<uint8_t>((kFrameBytes >> 8) & 0xFF);
  out_frame[2] = static_cast<uint8_t>((kFrameBytes >> 16) & 0xFF);
  out_frame[3] = static_cast<uint8_t>((kFrameBytes >> 24) & 0xFF);

  HANDLE stdout_handle = GetStdHandle(STD_OUTPUT_HANDLE);
  auto emit_frame = [&](uint32_t ts_ms) -> bool {
    out_frame[4] = static_cast<uint8_t>(ts_ms & 0xFF);
    out_frame[5] = static_cast<uint8_t>((ts_ms >> 8) & 0xFF);
    out_frame[6] = static_cast<uint8_t>((ts_ms >> 16) & 0xFF);
    out_frame[7] = static_cast<uint8_t>((ts_ms >> 24) & 0xFF);
    if (!WriteAllBytes(stdout_handle, out_frame.data(), out_frame.size())) return false;
    FlushFileBuffers(stdout_handle);
    return true;
  };

  auto read_sample = [](const uint8_t* buf, size_t off, bool is_float, uint16_t bits) -> float {
    if (is_float && bits == 32) {
      float v = 0;
      std::memcpy(&v, buf + off, 4);
      return v;
    }
    if (!is_float && bits == 16) {
      int16_t v = 0;
      std::memcpy(&v, buf + off, 2);
      return static_cast<float>(v) / 32768.0f;
    }
    if (!is_float && bits == 32) {
      int32_t v = 0;
      std::memcpy(&v, buf + off, 4);
      return static_cast<float>(v) / 2147483648.0f;
    }
    if (!is_float && bits == 24) {
      int32_t v = static_cast<int32_t>(buf[off]) |
                  (static_cast<int32_t>(buf[off + 1]) << 8) |
                  (static_cast<int32_t>(static_cast<int8_t>(buf[off + 2])) << 16);
      return static_cast<float>(v) / 8388608.0f;
    }
    return 0.0f;
  };

  auto write_i16 = [](uint8_t* dst, float s) {
    float clamped = std::clamp(s, -1.0f, 1.0f);
    int scaled = std::clamp(static_cast<int>(std::lround(clamped * 32767.0f)), -32768, 32767);
    dst[0] = static_cast<uint8_t>(scaled & 0xFF);
    dst[1] = static_cast<uint8_t>((scaled >> 8) & 0xFF);
  };

  try {
    while (!ended.load()) {
      EnsureSharingEnabled(false);
      if (!IsDefaultDesktopActive(false)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        continue;
      }

      ComPtr<IMMDeviceEnumerator> enumerator;
      if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator))) || !enumerator) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        continue;
      }
      ComPtr<IMMDevice> device;
      HRESULT hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
      if (hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) || !device) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        continue;
      }
      if (FAILED(hr)) break;

      ComPtr<IAudioClient> audio_client;
      if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &audio_client)) || !audio_client) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        continue;
      }

      WAVEFORMATEX* mix = nullptr;
      if (FAILED(audio_client->GetMixFormat(&mix)) || !mix) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        continue;
      }

      uint16_t format_tag = mix->wFormatTag;
      uint16_t channels = mix->nChannels;
      uint32_t sample_rate = mix->nSamplesPerSec;
      uint16_t block_align = mix->nBlockAlign;
      uint16_t bits = mix->wBitsPerSample;
      bool is_float = (format_tag == WAVE_FORMAT_IEEE_FLOAT);
      static constexpr GUID kSubTypeIeeeFloat = {
          0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
      static constexpr GUID kSubTypePcm = {
          0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
      if (format_tag == WAVE_FORMAT_EXTENSIBLE && mix->cbSize >= 22) {
        const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mix);
        if (IsEqualGUID(ext->SubFormat, kSubTypeIeeeFloat)) is_float = true;
        else if (IsEqualGUID(ext->SubFormat, kSubTypePcm)) is_float = false;
      }

      hr = audio_client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1000000, 0, mix, nullptr);
      CoTaskMemFree(mix);
      if (hr == AUDCLNT_E_DEVICE_INVALIDATED || FAILED(hr) || channels == 0 || sample_rate == 0 || block_align == 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        continue;
      }

      ComPtr<IAudioCaptureClient> capture;
      if (FAILED(audio_client->GetService(IID_PPV_ARGS(&capture))) || !capture || FAILED(audio_client->Start())) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        continue;
      }

      int frame_pos = 0;
      int silent_frames = 0;
      double src_pos = 0.0;
      const double step = static_cast<double>(sample_rate) / kTargetRate;
      float prev_l = 0.0f, prev_r = 0.0f;
      bool has_prev = false;
      int64_t desktop_checked = MonotonicMs();
      std::vector<float> left_buf, right_buf;

      while (!ended.load()) {
        int64_t now_ms = MonotonicMs();
        if (now_ms - desktop_checked >= 250) {
          EnsureSharingEnabled(false);
          desktop_checked = now_ms;
          if (!IsDefaultDesktopActive(false)) break;
        }
        UINT32 packet_frames = 0;
        hr = capture->GetNextPacketSize(&packet_frames);
        if (hr == AUDCLNT_E_DEVICE_INVALIDATED || FAILED(hr)) break;
        if (packet_frames == 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(10));
          continue;
        }

        while (packet_frames > 0 && !ended.load()) {
          BYTE* data = nullptr;
          UINT32 num_frames = 0;
          DWORD flags = 0;
          hr = capture->GetBuffer(&data, &num_frames, &flags, nullptr, nullptr);
          if (hr == AUDCLNT_E_DEVICE_INVALIDATED || FAILED(hr) || hr != S_OK) break;

          bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || !data;
          int count = static_cast<int>(num_frames);
          if (silent) {
            if (silent_frames < 5) {
              int out_samples = std::max(1, static_cast<int>(std::lround(count / step)));
              int64_t base_ts = MonotonicMs();
              int emitted = 0;
              for (int i = 0; i < out_samples; ++i) {
                std::memset(out_frame.data() + 8 + frame_pos, 0, 4);
                frame_pos += 4;
                if (frame_pos == kFrameBytes) {
                  if (!emit_frame(static_cast<uint32_t>(base_ts + emitted * 20))) { ended.store(true); break; }
                  frame_pos = 0;
                  emitted++;
                  if (++silent_frames >= 5) break;
                }
              }
            }
            prev_l = prev_r = 0.0f;
            has_prev = false;
            src_pos = 0.0;
          } else if (count > 0) {
            silent_frames = 0;
            left_buf.resize(static_cast<size_t>(count));
            right_buf.resize(static_cast<size_t>(count));
            size_t stride = bits / 8;
            for (int i = 0; i < count; ++i) {
              size_t off = static_cast<size_t>(i) * block_align;
              float s0 = read_sample(data, off, is_float, bits);
              float l = s0, r = s0;
              if (channels >= 2) {
                float s1 = read_sample(data, off + stride, is_float, bits);
                if (channels >= 6) {
                  float fc = read_sample(data, off + stride * 2, is_float, bits);
                  float bl = read_sample(data, off + stride * 4, is_float, bits);
                  float br = read_sample(data, off + stride * 5, is_float, bits);
                  l = s0 + 0.7071f * fc + 0.5f * bl;
                  r = s1 + 0.7071f * fc + 0.5f * br;
                } else {
                  l = s0;
                  r = s1;
                }
              }
              left_buf[static_cast<size_t>(i)] = l;
              right_buf[static_cast<size_t>(i)] = r;
            }

            int64_t base_ts = MonotonicMs();
            int emitted = 0;
            while (src_pos < count && !ended.load()) {
              float ls = 0.0f, rs = 0.0f;
              if (sample_rate == kTargetRate) {
                size_t idx = static_cast<size_t>(src_pos);
                ls = left_buf[idx];
                rs = right_buf[idx];
                src_pos += 1.0;
              } else {
                int idx = static_cast<int>(std::floor(src_pos));
                float frac = static_cast<float>(src_pos - idx);
                float l0, r0, l1, r1;
                if (idx < 0) {
                  l0 = has_prev ? prev_l : left_buf[0];
                  r0 = has_prev ? prev_r : right_buf[0];
                  l1 = left_buf[0];
                  r1 = right_buf[0];
                } else if (idx + 1 < count) {
                  l0 = left_buf[static_cast<size_t>(idx)];
                  r0 = right_buf[static_cast<size_t>(idx)];
                  l1 = left_buf[static_cast<size_t>(idx + 1)];
                  r1 = right_buf[static_cast<size_t>(idx + 1)];
                } else {
                  l0 = l1 = left_buf[static_cast<size_t>(count - 1)];
                  r0 = r1 = right_buf[static_cast<size_t>(count - 1)];
                }
                ls = l0 + (l1 - l0) * frac;
                rs = r0 + (r1 - r0) * frac;
                src_pos += step;
              }
              write_i16(out_frame.data() + 8 + frame_pos, ls);
              write_i16(out_frame.data() + 8 + frame_pos + 2, rs);
              frame_pos += 4;
              if (frame_pos == kFrameBytes) {
                if (!emit_frame(static_cast<uint32_t>(base_ts + emitted * 20))) { ended.store(true); break; }
                frame_pos = 0;
                emitted++;
              }
            }
            src_pos -= count;
            prev_l = left_buf[static_cast<size_t>(count - 1)];
            prev_r = right_buf[static_cast<size_t>(count - 1)];
            has_prev = true;
          }

          capture->ReleaseBuffer(num_frames);
          hr = capture->GetNextPacketSize(&packet_frames);
          if (hr == AUDCLNT_E_DEVICE_INVALIDATED || FAILED(hr)) break;
        }
      }
      audio_client->Stop();
      if (!ended.load()) std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
  } catch (...) {
    if (co_uninit) CoUninitialize();
    throw;
  }
  if (co_uninit) CoUninitialize();
}

// Legacy diagnostic external-FFmpeg bridge (`LINKSHELL_WINDOWS_FFMPEG` fallback path).
namespace {
struct VideoAttempt {
  std::string source_kind;
  std::string encoder;
  bool compatible = false;
  bool software = false;
  std::string path_name() const { return software ? "software" : (compatible ? "compatible" : "native"); }
  std::string hint_key() const { return source_kind + ":" + encoder + ":" + path_name(); }
  std::string legacy_hint_key() const { return encoder + ":" + path_name(); }
};

bool IsDesktopAccessLostLine(std::string_view line) {
  return ContainsIgnoreCaseAscii(line, "887a0026") ||
         ContainsIgnoreCaseAscii(line, "DXGI_ERROR_ACCESS_LOST") ||
         ContainsIgnoreCaseAscii(line, "access lost") ||
         ContainsIgnoreCaseAscii(line, "failed to acquire") ||
         ContainsIgnoreCaseAscii(line, "desktop switch");
}

void RunExternalVideoCommon(
    int w,
    int h,
    int fps,
    int bitrate,
    const std::wstring& executable,
    std::string source,
    uint32_t vendor,
    int adapter_index,
    int screen_index,
    int dxgi_output,
    HMONITOR hmonitor,
    bool has_active_monitor,
    RECT bounds) {
  _setmode(_fileno(stdout), _O_BINARY);
  if (executable.empty() || !FileExistsWide(executable)) {
    throw std::runtime_error("Windows 视频组件缺失");
  }
  fps = std::clamp(fps, 1, 60);
  bitrate = std::clamp(bitrate, 300000, 24000000);
  bool is_window = screen_index < 0;
  if (vendor == 0 && IsDefaultDesktopActive(false)) {
    int ignored = 0;
    if (DxgiJpegDuplicator::FindDxgiOutput(bounds, &vendor, &ignored) < 0) {
      vendor = DxgiJpegDuplicator::PrimaryVendor();
    }
  }
  std::string preferred = (vendor == 0x1002) ? "h264_amf" : (vendor == 0x10DE) ? "h264_nvenc" : (vendor == 0x8086) ? "h264_qsv" : "h264_mf";
  std::string selected = WideToUtf8(GetEnvWide(L"LINKSHELL_WINDOWS_ENCODER"));
  std::vector<std::string> encoders;
  if (selected.empty()) {
    encoders.push_back(preferred);
    if (preferred != "h264_mf") encoders.push_back("h264_mf");
  } else {
    if (selected != "h264_amf" && selected != "h264_nvenc" && selected != "h264_qsv" && selected != "h264_mf") {
      throw std::runtime_error("未知 Windows 硬件编码器");
    }
    encoders.push_back(selected);
  }

  std::atomic<bool> ended{false};
  std::thread input_thread([&]() {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.find("\"nudge\"") != std::string::npos || line.find("\"keyframe\"") != std::string::npos) {
        NudgeDesktopForCapture();
      }
    }
    ended.store(true);
  });
  input_thread.detach();

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) throw std::runtime_error("无法保护视频进程生命周期");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
  jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
    CloseHandle(job);
    throw std::runtime_error("无法配置视频进程生命周期");
  }

  std::vector<VideoAttempt> attempts;
  if (is_window) {
    for (const auto& enc : encoders) {
      if (enc != "h264_mf") attempts.push_back({ "window", enc, false, false });
      attempts.push_back({ "window", enc, true, false });
    }
  } else {
    bool allow_dda = has_active_monitor && dxgi_output >= 0 && !source.empty();
    bool allow_gfx = hmonitor != nullptr;
    if (allow_dda) {
      for (const auto& enc : encoders) {
        if (enc != "h264_mf") attempts.push_back({ "ddagrab", enc, false, false });
      }
    }
    if (allow_gfx) {
      for (const auto& enc : encoders) {
        if (enc == "h264_nvenc") attempts.push_back({ "gfxcapture", enc, false, false });
        attempts.push_back({ "gfxcapture", enc, true, false });
      }
    }
    if (allow_dda) {
      for (const auto& enc : encoders) attempts.push_back({ "ddagrab", enc, true, false });
    }
    for (const auto& enc : encoders) attempts.push_back({ "gdigrab", enc, true, false });
    if (selected.empty()) {
      if (allow_gfx) attempts.push_back({ "gfxcapture", "h264_mf", true, true });
      attempts.push_back({ "gdigrab", "h264_mf", true, true });
    }
  }

  std::string hint = WideToUtf8(GetEnvWide(L"LINKSHELL_WINDOWS_VIDEO_HINT"));
  if (!hint.empty()) {
    auto it = std::find_if(attempts.begin(), attempts.end(), [&](const VideoAttempt& a) { return a.hint_key() == hint; });
    if (it == attempts.end() && (is_window || has_active_monitor)) {
      it = std::find_if(attempts.begin(), attempts.end(), [&](const VideoAttempt& a) { return a.legacy_hint_key() == hint; });
    }
    if (it != attempts.end() && it != attempts.begin()) {
      VideoAttempt picked = *it;
      attempts.erase(it);
      attempts.insert(attempts.begin(), picked);
    }
  }

  bool framed = GetEnvWide(L"LINKSHELL_VIDEO_FRAMED") == L"1";
  bool baseline = EqualsIgnoreCaseAscii(WideToUtf8(GetEnvWide(L"LINKSHELL_WINDOWS_PROFILE")), "baseline");
  HANDLE stdout_handle = GetStdHandle(STD_OUTPUT_HANDLE);

  auto display_changed = [&]() {
    auto all = EnumerateHelperDisplays(false);
    for (const auto& d : all) {
      if (SameRect(d.bounds, bounds)) return false;
    }
    return true;
  };

  try {
    for (const auto& attempt : attempts) {
      int zero_frame_pauses = 0;
      while (!ended.load()) {
        EnsureSharingEnabled(false);
        if (!IsDefaultDesktopActive(false)) {
          bool sec = screen_index >= 0 && TryStreamSecureDesktopVideo(job, stdout_handle, executable, screen_index, w, h, std::min(15, fps), std::min(bitrate, 4000000), attempt.encoder, framed, ended);
          if (ended.load()) { CloseHandle(job); return; }
          if (!sec && !WaitForDefaultDesktop(120000, ended)) { CloseHandle(job); return; }
          if (!IsDefaultDesktopActive(false)) continue;
          std::this_thread::sleep_for(std::chrono::milliseconds(250));
          continue;
        }
        if (attempt.source_kind == "ddagrab" && (dxgi_output < 0 || source.empty())) break;

        int bw = bounds.right - bounds.left, bh = bounds.bottom - bounds.top;
        bool needs_scale = (w != bw || h != bh);
        bool direct_nvenc = (attempt.source_kind == "gfxcapture" && attempt.encoder == "h264_nvenc" && !attempt.compatible);
        int eff_fps = (attempt.source_kind == "gdigrab" || attempt.software) ? std::min(30, fps) : fps;

        std::string input_args, adapter_opt;
        if (attempt.source_kind == "gdigrab") {
          std::string vf = needs_scale
                               ? ("scale=" + std::to_string(w) + ":" + std::to_string(h) + ":flags=bilinear:out_color_matrix=bt709,format=nv12")
                               : "scale=out_color_matrix=bt709,format=nv12";
          input_args = "-f gdigrab -framerate " + std::to_string(eff_fps) + " -draw_mouse 0 -offset_x " +
                       std::to_string(bounds.left) + " -offset_y " + std::to_string(bounds.top) +
                       " -video_size " + std::to_string(bw) + "x" + std::to_string(bh) + " -i desktop -vf \"" + vf + "\"";
        } else if (attempt.source_kind == "gfxcapture") {
          std::string target = hmonitor
                                   ? ("hmonitor=" + std::to_string(reinterpret_cast<uintptr_t>(hmonitor)))
                                   : ("monitor_idx=" + std::to_string(std::max(0, screen_index)));
          std::string gfx = "gfxcapture=" + target + ":capture_cursor=0:width=" + std::to_string(w) +
                            ":height=" + std::to_string(h) + ":resize_mode=scale:scale_mode=bicubic:max_framerate=" + std::to_string(eff_fps);
          std::string filter = direct_nvenc ? gfx : (gfx + ",hwdownload,format=bgra,scale=out_color_matrix=bt709,format=nv12");
          input_args = "-f lavfi -i \"" + filter + "\"";
        } else {
          std::string filter = source;
          if (attempt.compatible) {
            filter += needs_scale
                          ? ("hwdownload,format=bgra,scale=" + std::to_string(w) + ":" + std::to_string(h) + ":flags=bilinear:out_color_matrix=bt709,format=nv12")
                          : "hwdownload,format=bgra,scale=out_color_matrix=bt709,format=nv12";
          } else if (attempt.encoder == "h264_amf") {
            filter += "vpp_amf=w=" + std::to_string(w) + ":h=" + std::to_string(h) + ":format=nv12";
          } else if (attempt.encoder == "h264_qsv") {
            filter += "hwmap=derive_device=qsv,vpp_qsv=w=" + std::to_string(w) + ":h=" + std::to_string(h) + ":format=nv12";
          } else {
            filter += "scale_d3d11=width=" + std::to_string(w) + ":height=" + std::to_string(h) + ":format=nv12";
          }
          if (adapter_index > 0 && attempt.source_kind == "ddagrab") {
            adapter_opt = "-init_hw_device d3d11va=ls:" + std::to_string(adapter_index) + " -filter_hw_device ls ";
          }
          input_args = "-f lavfi -i \"" + filter + "\"";
        }

        bool level52 = w * h > 3686400;
        bool level51 = w * h > 2088960;
        std::string nv_lvl = level52 ? "5.2" : (level51 ? "5.1" : "4.2");
        std::string num_lvl = level52 ? "52" : (level51 ? "51" : "42");
        std::string tuning = (attempt.encoder == "h264_amf")
                                 ? "-usage lowlatency -quality quality -rc vbr_latency -qp_i 18 -qp_p 20 -min_qp_i 14 -max_qp_i 32 -min_qp_p 14 -max_qp_p 34 -async_depth 1 -preanalysis 0"
                             : (attempt.encoder == "h264_nvenc")
                                 ? "-preset p4 -tune ll -rc vbr -cq 19 -qmin 14 -qmax 32 -zerolatency 1 -delay 0 -rc-lookahead 0 -spatial-aq 1 -aq-strength 10"
                             : (attempt.encoder == "h264_qsv")
                                 ? "-preset fast -async_depth 1 -look_ahead 0 -qmin 14 -qmax 32"
                                 : (attempt.software ? "-hw_encoding 0 -scenario display_remoting -quality 80" : "-hw_encoding 1 -scenario display_remoting -quality 90");
        std::string prof = (attempt.encoder == "h264_nvenc")
                               ? (" -profile:v " + std::string(baseline ? "baseline" : "main") + " -level:v " + nv_lvl)
                           : (attempt.encoder == "h264_amf")
                               ? (" -profile:v " + std::string(baseline ? "constrained_baseline" : "main") + " -level:v " + num_lvl)
                           : (attempt.encoder == "h264_qsv")
                               ? (" -profile:v " + std::string(baseline ? "baseline" : "main") + " -level:v " + num_lvl)
                               : (" -profile:v " + std::string(baseline ? "66" : "77") + " -level:v " + num_lvl);
        int gop = std::clamp(eff_fps * 2, eff_fps, 120);
        int maxrate = std::min(28000000, bitrate + bitrate / 4);
        int bufsize = std::max(1500000, std::min(bitrate / 2, std::max(bitrate / 4, 2500000)));
        std::string color = direct_nvenc ? "" : " -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709";
        std::string tail = framed
                               ? " -bsf:v h264_metadata=aud=insert,setts=ts=N -flush_packets 1 -f avi pipe:1"
                               : " -bsf:v h264_metadata=aud=insert -flush_packets 1 -f h264 pipe:1";
        std::string args = "-hide_banner -loglevel warning -nostats " + adapter_opt + input_args +
                           " -an -c:v " + attempt.encoder + " " + tuning + prof + color +
                           " -bf 0 -g " + std::to_string(gop) + " -b:v " + std::to_string(bitrate) +
                           " -maxrate " + std::to_string(maxrate) + " -bufsize " + std::to_string(bufsize) +
                           " -fps_mode passthrough" + tail;

        SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE stdin_r = nullptr, stdin_w = nullptr;
        HANDLE stdout_r = nullptr, stdout_w = nullptr;
        HANDLE stderr_r = nullptr, stderr_w = nullptr;
        CreatePipe(&stdin_r, &stdin_w, &sa, 0);
        CreatePipe(&stdout_r, &stdout_w, &sa, 65536);
        CreatePipe(&stderr_r, &stderr_w, &sa, 0);
        SetHandleInformation(stdin_w, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stdout_r, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stderr_r, HANDLE_FLAG_INHERIT, 0);

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = stdin_r;
        si.hStdOutput = stdout_w;
        si.hStdError = stderr_w;
        PROCESS_INFORMATION pi{};
        std::wstring cmdline = L"\"" + executable + L"\" " + Utf8ToWide(args);

        if (attempt.source_kind == "gfxcapture") NudgeDesktopForCapture();
        BOOL started = CreateProcessW(executable.c_str(), cmdline.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
        CloseHandle(stdin_r);
        CloseHandle(stdout_w);
        CloseHandle(stderr_w);

        if (!started) {
          CloseHandle(stdin_w);
          CloseHandle(stdout_r);
          CloseHandle(stderr_r);
          break;
        }
        AssignProcessToJobObject(job, pi.hProcess);
        CloseHandle(pi.hThread);
        std::cerr << "[video] child=" << pi.dwProcessId << " source=" << attempt.source_kind << "\n";

        std::atomic<bool> access_lost{false};
        std::atomic<int> received{0};

        std::thread err_reader([&]() {
          char buf[4096];
          DWORD got = 0;
          std::string rem;
          while (ReadFile(stderr_r, buf, sizeof(buf), &got, nullptr) && got > 0) {
            rem.append(buf, got);
            size_t nl;
            while ((nl = rem.find('\n')) != std::string::npos) {
              std::string ln = TrimAscii(rem.substr(0, nl));
              rem.erase(0, nl + 1);
              if (!ln.empty()) {
                std::cerr << "[video:" << attempt.encoder << "] " << ln << "\n";
                if (IsDesktopAccessLostLine(ln)) access_lost.store(true);
              }
            }
          }
        });

        std::thread out_copier([&]() {
          std::vector<uint8_t> buf(65536);
          DWORD got = 0;
          const uint8_t mark[4] = {'m', 'o', 'v', 'i'};
          int matched = framed ? 0 : 4;
          while (ReadFile(stdout_r, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr) && got > 0) {
            bool pictures = (matched == 4);
            for (DWORD i = 0; i < got && !pictures; ++i) {
              matched = (buf[i] == mark[matched]) ? (matched + 1) : (buf[i] == mark[0] ? 1 : 0);
              if (matched == 4) pictures = (i + 1 < got);
            }
            if (pictures && received.exchange(1) == 0) {
              std::string src_tag = (attempt.source_kind == "window") ? "" : (" source=" + attempt.source_kind);
              std::cerr << "[video] encoder=" << attempt.encoder << " width=" << w << " height=" << h
                        << " fps=" << eff_fps << " path=" << attempt.path_name() << src_tag << "\n";
            }
            if (!WriteAllBytes(stdout_handle, buf.data(), got)) break;
            FlushFileBuffers(stdout_handle);
          }
        });

        int first_timeout = (attempt.source_kind == "ddagrab") ? 2200 : (attempt.source_kind == "gfxcapture" ? 3000 : 4000);
        int64_t t0 = MonotonicMs();
        int64_t last_layout = 0;
        bool desktop_paused = false;
        bool nudged = false;

        while (!ended.load() && WaitForSingleObject(pi.hProcess, 50) == WAIT_TIMEOUT) {
          EnsureSharingEnabled(false);
          if (!IsDefaultDesktopActive(false)) { desktop_paused = true; break; }
          int64_t elapsed = MonotonicMs() - t0;
          if (elapsed - last_layout >= 500) {
            last_layout = elapsed;
            if (display_changed()) {
              TerminateProcess(pi.hProcess, 1);
              break;
            }
          }
          if (received.load() == 0 && !nudged && attempt.source_kind == "gfxcapture" && elapsed >= 350) {
            nudged = true;
            NudgeDesktopForCapture();
          }
          if (received.load() == 0 && elapsed > first_timeout) break;
        }

        WriteAllBytes(stdin_w, "q\n", 2);
        CloseHandle(stdin_w);
        if (WaitForSingleObject(pi.hProcess, desktop_paused ? 1000 : 500) == WAIT_TIMEOUT) {
          TerminateProcess(pi.hProcess, 1);
          WaitForSingleObject(pi.hProcess, 2000);
        }
        CloseHandle(pi.hProcess);
        if (out_copier.joinable()) out_copier.join();
        if (err_reader.joinable()) err_reader.join();
        CloseHandle(stdout_r);
        CloseHandle(stderr_r);

        bool had_frames = received.load() != 0;
        if (ended.load()) { CloseHandle(job); return; }
        if (display_changed() && IsDefaultDesktopActive(false)) {
          throw std::runtime_error("屏幕布局已改变，请重新连接");
        }
        if (desktop_paused || !IsDefaultDesktopActive(false) || (had_frames && access_lost.load())) {
          if (had_frames) zero_frame_pauses = 0;
          else if (++zero_frame_pauses >= 5) break;
          bool sec = screen_index >= 0 && TryStreamSecureDesktopVideo(job, stdout_handle, executable, screen_index, w, h, std::min(15, fps), std::min(bitrate, 4000000), attempt.encoder, framed, ended);
          if (ended.load()) { CloseHandle(job); return; }
          if (!sec && !WaitForDefaultDesktop(120000, ended)) { CloseHandle(job); return; }
          std::this_thread::sleep_for(std::chrono::milliseconds(250));
          continue;
        }
        if (had_frames) throw std::runtime_error("硬件视频编码已停止");
        break;
      }
    }
  } catch (...) {
    CloseHandle(job);
    throw;
  }
  CloseHandle(job);
  if (!ended.load()) throw std::runtime_error("这台电脑的硬件视频编码不可用，将使用兼容画面");
}
}  // namespace

void RunCaptureVideoMode(int screen, int width, int fps, int bitrate, const std::wstring& executable) {
  EnsureSharingEnabled(false);
  RECT bounds{};
  HMONITOR hmon = nullptr;
  bool has_active = true;
  bool started_secure = !IsDefaultDesktopActive(false);
  if (started_secure && TryServiceDisplayBounds(screen, &bounds)) {
    has_active = true;
  } else {
    auto entry = DisplayEntry(screen, true, false);
    bounds = entry.bounds;
    hmon = entry.monitor;
    has_active = entry.has_active_monitor;
  }
  int bw = std::max(2, static_cast<int>(bounds.right - bounds.left));
  int bh = std::max(2, static_cast<int>(bounds.bottom - bounds.top));
  int max_w = std::clamp(width, 320, 3840);
  double max_h = max_w > 2560 ? 2160.0 : (max_w > 1920 ? 1440.0 : 1080.0);
  double scale = std::min(1.0, std::min(max_w / static_cast<double>(bw), max_h / static_cast<double>(bh)));
  int w = std::max(2, (static_cast<int>(bw * scale) / 2) * 2);
  int h = std::max(2, (static_cast<int>(bh * scale) / 2) * 2);
  uint32_t vendor = 0;
  int adapter_idx = 0;
  int dxgi_out = -1;
  if (!started_secure) {
    dxgi_out = DxgiJpegDuplicator::FindDxgiOutput(bounds, &vendor, &adapter_idx);
  }
  if (vendor == 0) vendor = DxgiJpegDuplicator::PrimaryVendor();
  std::string dda = dxgi_out >= 0 ? ("ddagrab=output_idx=" + std::to_string(dxgi_out) + ":framerate=" + std::to_string(std::clamp(fps, 1, 60)) + ":draw_mouse=0,") : "";
  RunExternalVideoCommon(w, h, fps, bitrate, executable, dda, vendor, adapter_idx, screen, dxgi_out, hmon, has_active, bounds);
}

void RunCaptureWindowVideoMode(int64_t hwnd_val, int canvas_w, int canvas_h, int fps, int bitrate, const std::wstring& executable) {
  HWND hwnd = reinterpret_cast<HWND>(static_cast<intptr_t>(hwnd_val));
  RECT frame{};
  if (!IsWindow(hwnd) || !GetWindowRect(hwnd, &frame)) {
    throw std::runtime_error("窗口已关闭");
  }
  POINT center{(frame.left + frame.right) / 2, (frame.top + frame.bottom) / 2};
  RECT bounds = DisplayBoundsAt(center);
  int w = std::max(2, (std::min(3840, canvas_w) / 2) * 2);
  int h = std::max(2, (std::min(2160, canvas_h) / 2) * 2);
  std::string source = "gfxcapture=hwnd=" + std::to_string(hwnd_val) + ":capture_border=1:capture_cursor=0:width=" +
                       std::to_string(w) + ":height=" + std::to_string(h) + ":resize_mode=crop:max_framerate=" +
                       std::to_string(std::clamp(fps, 1, 60)) + ",";
  RunExternalVideoCommon(w, h, fps, bitrate, executable, source, 0, 0, -1, -1, nullptr, true, bounds);
}

}  // namespace linkshell::helper
