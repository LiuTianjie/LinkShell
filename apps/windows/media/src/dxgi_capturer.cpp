#include "dxgi_capturer.hpp"

#include <cstring>
#include <fstream>
#include <sstream>

#include "common.hpp"

namespace linkshell {

using Microsoft::WRL::ComPtr;

// ── DxgiDuplicationCapturer ─────────────────────────────────────────────────

DxgiDuplicationCapturer::DxgiDuplicationCapturer(std::shared_ptr<D3DContext> d3d) : d3d_(std::move(d3d)) {}

DxgiDuplicationCapturer::~DxgiDuplicationCapturer() {
  Close();
}

bool DxgiDuplicationCapturer::Open(const DisplayInfo& display, std::string* error) {
  Close();
  if (!d3d_ || !d3d_->device()) {
    if (error) *error = "no D3D11 device";
    return false;
  }
  ComPtr<IDXGIDevice> dxgi_dev;
  if (FAILED(d3d_->device()->QueryInterface(IID_PPV_ARGS(&dxgi_dev))) || !dxgi_dev) return false;
  ComPtr<IDXGIAdapter> primary_adapter;
  if (FAILED(dxgi_dev->GetAdapter(&primary_adapter)) || !primary_adapter) return false;

  auto find_output_on_adapter = [&](IDXGIAdapter* adapter) -> ComPtr<IDXGIOutput> {
    ComPtr<IDXGIOutput> candidate;
    for (UINT i = 0; adapter->EnumOutputs(i, &candidate) != DXGI_ERROR_NOT_FOUND; ++i) {
      DXGI_OUTPUT_DESC desc{};
      if (SUCCEEDED(candidate->GetDesc(&desc)) && desc.AttachedToDesktop) {
        if ((display.hmonitor && desc.Monitor == display.hmonitor) ||
            (!display.device_name.empty() && _wcsicmp(desc.DeviceName, display.device_name.c_str()) == 0)) {
          return candidate;
        }
      }
      candidate.Reset();
    }
    return nullptr;
  };

  // Fast path: display belongs to d3d_'s own GPU adapter (100% zero-copy VRAM blit).
  ComPtr<IDXGIOutput> matched = find_output_on_adapter(primary_adapter.Get());
  ID3D11Device* dup_owner_dev = d3d_->device();

  // Multi-GPU path (e.g. Optimus laptop where display is on iGPU while NVENC sits on dGPU):
  // search all DXGI adapters and create a lightweight duplication device on the owning adapter.
  if (!matched) {
    ComPtr<IDXGIFactory1> factory;
    if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) && factory) {
      ComPtr<IDXGIAdapter1> adapter;
      for (UINT ai = 0; factory->EnumAdapters1(ai, &adapter) != DXGI_ERROR_NOT_FOUND; ++ai) {
        matched = find_output_on_adapter(adapter.Get());
        if (matched) {
          D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1};
          HRESULT chr = D3D11CreateDevice(
              adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
              levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
              &dup_device_, nullptr, &dup_context_);
          if (SUCCEEDED(chr) && dup_device_ && dup_context_) {
            dup_owner_dev = dup_device_.Get();
            cross_adapter_ = true;
          } else {
            matched.Reset();
          }
          break;
        }
        adapter.Reset();
      }
    }
  }

  if (!matched) {
    if (error) *error = "no DXGI output for display";
    return false;
  }

  ComPtr<IDXGIOutput1> output1;
  if (FAILED(matched.As(&output1)) || !output1) {
    if (error) *error = "IDXGIOutput1 unavailable";
    Close();
    return false;
  }

  HRESULT hr = output1->DuplicateOutput(dup_owner_dev, &dup_);
  if (FAILED(hr) || !dup_) {
    if (error) *error = "DuplicateOutput failed: " + std::to_string(hr);
    Close();
    return false;
  }

  DXGI_OUTDUPL_DESC ddesc{};
  dup_->GetDesc(&ddesc);
  width_ = static_cast<int>(ddesc.ModeDesc.Width);
  height_ = static_cast<int>(ddesc.ModeDesc.Height);
  return width_ > 0 && height_ > 0;
}

HRESULT DxgiDuplicationCapturer::Acquire(int timeout_ms, ComPtr<ID3D11Texture2D>* out_texture, int* out_w, int* out_h) {
  if (!dup_) return E_FAIL;
  DXGI_OUTDUPL_FRAME_INFO info{};
  ComPtr<IDXGIResource> res;
  HRESULT hr = dup_->AcquireNextFrame(static_cast<UINT>(timeout_ms), &info, &res);
  if (FAILED(hr)) return hr;

  // Cursor-only or metadata-only wakeups carry no updated desktop image; avoid encoding duplicates
  // or uninitialized pre-present textures.
  if (info.LastPresentTime.QuadPart == 0 && info.AccumulatedFrames == 0) {
    dup_->ReleaseFrame();
    return DXGI_ERROR_WAIT_TIMEOUT;
  }

  ComPtr<ID3D11Texture2D> src;
  hr = res.As(&src);
  if (SUCCEEDED(hr) && src) {
    D3D11_TEXTURE2D_DESC sdesc{};
    src->GetDesc(&sdesc);
    if (!copy_tex_ || width_ != static_cast<int>(sdesc.Width) || height_ != static_cast<int>(sdesc.Height)) {
      copy_tex_.Reset();
      xadapter_staging_.Reset();
      D3D11_TEXTURE2D_DESC cdesc = sdesc;
      cdesc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      cdesc.MiscFlags = 0;
      cdesc.Usage = D3D11_USAGE_DEFAULT;
      cdesc.CPUAccessFlags = 0;
      if (FAILED(d3d_->device()->CreateTexture2D(&cdesc, nullptr, &copy_tex_))) {
        cdesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        d3d_->device()->CreateTexture2D(&cdesc, nullptr, &copy_tex_);
      }
      if (cross_adapter_ && dup_device_) {
        D3D11_TEXTURE2D_DESC stdesc = sdesc;
        stdesc.BindFlags = 0;
        stdesc.MiscFlags = 0;
        stdesc.Usage = D3D11_USAGE_STAGING;
        stdesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        dup_device_->CreateTexture2D(&stdesc, nullptr, &xadapter_staging_);
      }
      width_ = static_cast<int>(sdesc.Width);
      height_ = static_cast<int>(sdesc.Height);
    }
    if (copy_tex_) {
      if (!cross_adapter_) {
        d3d_->context()->CopyResource(copy_tex_.Get(), src.Get());
      } else if (dup_context_ && xadapter_staging_) {
        dup_context_->CopyResource(xadapter_staging_.Get(), src.Get());
        D3D11_MAPPED_SUBRESOURCE mapped{};
        if (SUCCEEDED(dup_context_->Map(xadapter_staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped))) {
          d3d_->context()->UpdateSubresource(copy_tex_.Get(), 0, nullptr, mapped.pData, mapped.RowPitch, 0);
          dup_context_->Unmap(xadapter_staging_.Get(), 0);
        } else {
          hr = E_FAIL;
        }
      } else {
        hr = E_FAIL;
      }
      if (SUCCEEDED(hr)) {
        if (out_texture) *out_texture = copy_tex_;
        if (out_w) *out_w = width_;
        if (out_h) *out_h = height_;
      }
    } else {
      hr = E_OUTOFMEMORY;
    }
  }
  dup_->ReleaseFrame();
  return hr;
}

void DxgiDuplicationCapturer::Close() {
  dup_.Reset();
  copy_tex_.Reset();
  xadapter_staging_.Reset();
  dup_context_.Reset();
  dup_device_.Reset();
  cross_adapter_ = false;
  width_ = 0;
  height_ = 0;
}

// ── GdiAndSecureCapturer ────────────────────────────────────────────────────

namespace {
std::wstring UserHomeDir() {
  wchar_t buf[MAX_PATH * 2] = {};
  DWORD len = GetEnvironmentVariableW(L"LINKSHELL_HOME", buf, ARRAYSIZE(buf));
  if (len > 0 && len < ARRAYSIZE(buf)) return std::wstring(buf, len);
  len = GetEnvironmentVariableW(L"USERPROFILE", buf, ARRAYSIZE(buf));
  if (len > 0 && len < ARRAYSIZE(buf)) return std::wstring(buf, len) + L"\\.linkshell";
  return L"";
}

bool ReadExact(HANDLE pipe, uint8_t* dst, size_t len) {
  size_t got = 0;
  while (got < len) {
    DWORD n = 0;
    if (!ReadFile(pipe, dst + got, static_cast<DWORD>(len - got), &n, nullptr) || n == 0) {
      return false;
    }
    got += n;
  }
  return true;
}
}  // namespace

std::string GdiAndSecureCapturer::ReadServiceToken() {
  std::wstring home = UserHomeDir();
  if (home.empty()) return {};
  std::wstring path = home + L"\\windows-service-token";
  std::ifstream in(path, std::ios::binary);
  if (!in) return {};
  std::string token;
  std::getline(in, token);
  while (!token.empty() && (token.back() == '\r' || token.back() == '\n' || token.back() == ' ')) {
    token.pop_back();
  }
  return token.size() == 64 ? token : std::string{};
}

bool GdiAndSecureCapturer::IsServiceAvailable() {
  return !ReadServiceToken().empty();
}

GdiAndSecureCapturer::GdiAndSecureCapturer() = default;

GdiAndSecureCapturer::~GdiAndSecureCapturer() {
  CloseSecurePipe();
  if (dib_) DeleteObject(dib_);
  if (mem_dc_) DeleteDC(mem_dc_);
}

bool GdiAndSecureCapturer::CaptureGdiDirect(const RECT& bounds, const uint8_t** out_ptr, int* out_w, int* out_h) {
  int w = bounds.right - bounds.left;
  int h = bounds.bottom - bounds.top;
  if (w <= 0 || h <= 0 || !out_ptr) return false;

  HDC screen_dc = GetDC(nullptr);
  if (!screen_dc) return false;

  if (!mem_dc_) mem_dc_ = CreateCompatibleDC(screen_dc);
  if (!dib_ || dib_w_ != w || dib_h_ != h) {
    if (dib_) {
      DeleteObject(dib_);
      dib_ = nullptr;
      dib_bits_ = nullptr;
    }
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h;  // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    dib_ = CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &dib_bits_, nullptr, 0);
    dib_w_ = w;
    dib_h_ = h;
  }

  bool ok = false;
  if (mem_dc_ && dib_ && dib_bits_) {
    HGDIOBJ old = SelectObject(mem_dc_, dib_);
    // Plain SRCCOPY avoids DWM's synchronous CAPTUREBLT layered-compose stall (3-5x faster on 4K headless).
    if (BitBlt(mem_dc_, 0, 0, w, h, screen_dc, bounds.left, bounds.top, SRCCOPY)) {
      GdiFlush();
      *out_ptr = static_cast<const uint8_t*>(dib_bits_);
      if (out_w) *out_w = w;
      if (out_h) *out_h = h;
      ok = true;
    }
    SelectObject(mem_dc_, old);
  }
  ReleaseDC(nullptr, screen_dc);
  return ok;
}

bool GdiAndSecureCapturer::CaptureWindowDirect(HWND hwnd, const uint8_t** out_ptr, int* out_w, int* out_h) {
  if (!hwnd || !IsWindow(hwnd) || !out_ptr) return false;
  RECT rc{};
  if (!GetWindowRect(hwnd, &rc)) return false;
  int w = rc.right - rc.left;
  int h = rc.bottom - rc.top;
  if (w <= 0 || h <= 0 || w > 7680 || h > 4320) return false;

  HDC screen_dc = GetDC(nullptr);
  if (!screen_dc) return false;

  if (!mem_dc_) mem_dc_ = CreateCompatibleDC(screen_dc);
  if (!dib_ || dib_w_ != w || dib_h_ != h) {
    if (dib_) {
      DeleteObject(dib_);
      dib_ = nullptr;
      dib_bits_ = nullptr;
    }
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h;  // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    dib_ = CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &dib_bits_, nullptr, 0);
    dib_w_ = w;
    dib_h_ = h;
  }

  bool ok = false;
  if (mem_dc_ && dib_ && dib_bits_) {
    HGDIOBJ old = SelectObject(mem_dc_, dib_);
    // PW_RENDERFULLCONTENT (0x2) captures DWM/DirectComposition/WinForms/Chromium windows even headless.
    constexpr UINT kRenderFullContent = 0x00000002;
    if (PrintWindow(hwnd, mem_dc_, kRenderFullContent) || PrintWindow(hwnd, mem_dc_, 0)) {
      GdiFlush();
      *out_ptr = static_cast<const uint8_t*>(dib_bits_);
      if (out_w) *out_w = w;
      if (out_h) *out_h = h;
      ok = true;
    }
    SelectObject(mem_dc_, old);
  }
  ReleaseDC(nullptr, screen_dc);
  return ok;
}

bool GdiAndSecureCapturer::CaptureGdi(const RECT& bounds, std::vector<uint8_t>* out_bgra, int* out_w, int* out_h) {
  const uint8_t* ptr = nullptr;
  int w = 0, h = 0;
  if (!CaptureGdiDirect(bounds, &ptr, &w, &h) || !ptr) return false;
  size_t bytes = static_cast<size_t>(w) * static_cast<size_t>(h) * 4;
  out_bgra->resize(bytes);
  std::memcpy(out_bgra->data(), ptr, bytes);
  if (out_w) *out_w = w;
  if (out_h) *out_h = h;
  return true;
}

bool GdiAndSecureCapturer::OpenSecurePipe(int screen, int width, int height, int fps) {
  CloseSecurePipe();
  std::string token = ReadServiceToken();
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

  int req_w = std::clamp((width / 2) * 2, 320, 3840);
  int req_h = std::clamp((height / 2) * 2, 180, 2160);
  int req_fps = std::clamp(fps, 1, 30);
  json req = {
      {"token", token},
      {"mode", "capture-raw"},
      {"screen", screen},
      {"w", req_w},
      {"h", req_h},
      {"fps", req_fps},
      {"quality", 80},
  };
  std::string line = req.dump() + "\n";
  DWORD written = 0;
  if (!WriteFile(h, line.data(), static_cast<DWORD>(line.size()), &written, nullptr) || written != line.size()) {
    CloseHandle(h);
    return false;
  }

  pipe_ = h;
  secure_w_ = req_w;
  secure_h_ = req_h;
  return true;
}

bool GdiAndSecureCapturer::ReadSecureFrame(std::vector<uint8_t>* out_bgra, int* out_w, int* out_h) {
  if (pipe_ == INVALID_HANDLE_VALUE || !out_bgra || secure_w_ <= 0 || secure_h_ <= 0) return false;
  // LinkShellScreenService capture-raw framing (`ScreenService.cs` RunServiceCaptureRawWorker):
  // raw packed 24-bpp BGR frames (`w * h * 3` bytes, no length prefix).
  const size_t pixels = static_cast<size_t>(secure_w_) * static_cast<size_t>(secure_h_);
  const size_t bgr_bytes = pixels * 3;
  if (bgr_bytes == 0 || bgr_bytes > 64 * 1024 * 1024) {
    CloseSecurePipe();
    return false;
  }
  std::vector<uint8_t> bgr(bgr_bytes);
  if (!ReadExact(pipe_, bgr.data(), bgr_bytes)) {
    CloseSecurePipe();
    return false;
  }
  out_bgra->resize(pixels * 4);
  const uint8_t* src = bgr.data();
  uint8_t* dst = out_bgra->data();
  for (size_t i = 0; i < pixels; ++i) {
    dst[0] = src[0];
    dst[1] = src[1];
    dst[2] = src[2];
    dst[3] = 255;
    src += 3;
    dst += 4;
  }
  if (out_w) *out_w = secure_w_;
  if (out_h) *out_h = secure_h_;
  return true;
}

void GdiAndSecureCapturer::CloseSecurePipe() {
  if (pipe_ != INVALID_HANDLE_VALUE) {
    CancelIoEx(pipe_, nullptr);
    CloseHandle(pipe_);
    pipe_ = INVALID_HANDLE_VALUE;
  }
}

}  // namespace linkshell
