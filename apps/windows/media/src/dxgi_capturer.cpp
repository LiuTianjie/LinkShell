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
  ComPtr<IDXGIAdapter> adapter;
  if (FAILED(dxgi_dev->GetAdapter(&adapter)) || !adapter) return false;

  ComPtr<IDXGIOutput> matched;
  ComPtr<IDXGIOutput> candidate;
  for (UINT i = 0; adapter->EnumOutputs(i, &candidate) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_OUTPUT_DESC desc{};
    if (SUCCEEDED(candidate->GetDesc(&desc)) && desc.AttachedToDesktop) {
      if (desc.Monitor == display.hmonitor || _wcsicmp(desc.DeviceName, display.device_name.c_str()) == 0) {
        matched = candidate;
        break;
      }
    }
    candidate.Reset();
  }
  if (!matched) {
    if (error) *error = "no DXGI output for display";
    return false;
  }

  ComPtr<IDXGIOutput1> output1;
  if (FAILED(matched.As(&output1)) || !output1) {
    if (error) *error = "IDXGIOutput1 unavailable";
    return false;
  }

  HRESULT hr = output1->DuplicateOutput(d3d_->device(), &dup_);
  if (FAILED(hr) || !dup_) {
    if (error) *error = "DuplicateOutput failed: " + std::to_string(hr);
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

  ComPtr<ID3D11Texture2D> src;
  hr = res.As(&src);
  if (SUCCEEDED(hr) && src) {
    D3D11_TEXTURE2D_DESC sdesc{};
    src->GetDesc(&sdesc);
    if (!copy_tex_ || width_ != static_cast<int>(sdesc.Width) || height_ != static_cast<int>(sdesc.Height)) {
      copy_tex_.Reset();
      D3D11_TEXTURE2D_DESC cdesc = sdesc;
      cdesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      cdesc.MiscFlags = 0;
      cdesc.Usage = D3D11_USAGE_DEFAULT;
      cdesc.CPUAccessFlags = 0;
      d3d_->device()->CreateTexture2D(&cdesc, nullptr, &copy_tex_);
      width_ = static_cast<int>(sdesc.Width);
      height_ = static_cast<int>(sdesc.Height);
    }
    if (copy_tex_) {
      d3d_->context()->CopyResource(copy_tex_.Get(), src.Get());
      if (out_texture) *out_texture = copy_tex_;
      if (out_w) *out_w = width_;
      if (out_h) *out_h = height_;
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

bool GdiAndSecureCapturer::CaptureGdi(const RECT& bounds, std::vector<uint8_t>* out_bgra, int* out_w, int* out_h) {
  int w = bounds.right - bounds.left;
  int h = bounds.bottom - bounds.top;
  if (w <= 0 || h <= 0) return false;

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
    if (BitBlt(mem_dc_, 0, 0, w, h, screen_dc, bounds.left, bounds.top, SRCCOPY | CAPTUREBLT)) {
      size_t bytes = static_cast<size_t>(w) * static_cast<size_t>(h) * 4;
      out_bgra->resize(bytes);
      std::memcpy(out_bgra->data(), dib_bits_, bytes);
      if (out_w) *out_w = w;
      if (out_h) *out_h = h;
      ok = true;
    }
    SelectObject(mem_dc_, old);
  }
  ReleaseDC(nullptr, screen_dc);
  return ok;
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
  if (pipe_ == INVALID_HANDLE_VALUE) return false;
  // LinkShellScreenService capture-raw framing: [u32 LE length][raw BGRA bytes].
  uint32_t size = 0;
  if (!ReadExact(pipe_, reinterpret_cast<uint8_t*>(&size), 4)) {
    CloseSecurePipe();
    return false;
  }
  size_t expected = static_cast<size_t>(secure_w_) * static_cast<size_t>(secure_h_) * 4;
  if (size == 0 || size > 64 * 1024 * 1024 || size != expected) {
    CloseSecurePipe();
    return false;
  }
  out_bgra->resize(size);
  if (!ReadExact(pipe_, out_bgra->data(), size)) {
    CloseSecurePipe();
    return false;
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
