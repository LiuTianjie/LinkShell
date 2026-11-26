#pragma once

#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "d3d_context.hpp"
#include "display_info.hpp"

namespace linkshell {

// Native DXGI Desktop Duplication fallback for older Win10 builds or WGC failures.
class DxgiDuplicationCapturer {
 public:
  DxgiDuplicationCapturer(std::shared_ptr<D3DContext> d3d);
  ~DxgiDuplicationCapturer();

  bool Open(const DisplayInfo& display, std::string* error = nullptr);
  // Returns S_OK with a GPU texture copy, DXGI_ERROR_WAIT_TIMEOUT if static, or failure HRESULT.
  HRESULT Acquire(int timeout_ms, Microsoft::WRL::ComPtr<ID3D11Texture2D>* out_texture, int* out_w, int* out_h);
  void Close();

 private:
  std::shared_ptr<D3DContext> d3d_;
  Microsoft::WRL::ComPtr<IDXGIOutputDuplication> dup_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> copy_tex_;
  int width_ = 0;
  int height_ = 0;
};

// GDI capture + LinkShellScreenService Secure Desktop (UAC / Lock Screen) raw BGRA reader.
// Security invariant: never runs as SYSTEM itself; connects as a normal user client to the
// already-isolated LinkShellScreenServiceV1 pipe with the per-install 256-bit token.
class GdiAndSecureCapturer {
 public:
  GdiAndSecureCapturer();
  ~GdiAndSecureCapturer();

  // Zero-extra-copy GDI capture into persistent DIBSection; out_ptr remains valid until next Capture* call.
  bool CaptureGdiDirect(const RECT& bounds, const uint8_t** out_ptr, int* out_w, int* out_h);

  // Zero-extra-copy headless window capture via PrintWindow(PW_RENDERFULLCONTENT) for Fusion fallback.
  bool CaptureWindowDirect(HWND hwnd, const uint8_t** out_ptr, int* out_w, int* out_h);

  // Captures current default desktop via GDI BitBlt into out_bgra (top-down 32-bit BGRA).
  bool CaptureGdi(const RECT& bounds, std::vector<uint8_t>* out_bgra, int* out_w, int* out_h);

  // Opens/maintains a streaming capture-raw pipe to LinkShellScreenService when on Winlogon/UAC.
  bool OpenSecurePipe(int screen, int width, int height, int fps);
  bool ReadSecureFrame(std::vector<uint8_t>* out_bgra, int* out_w, int* out_h);
  void CloseSecurePipe();

  static std::string ReadServiceToken();
  static bool IsServiceAvailable();

 private:
  HANDLE pipe_ = INVALID_HANDLE_VALUE;
  int secure_w_ = 0;
  int secure_h_ = 0;
  HDC mem_dc_ = nullptr;
  HBITMAP dib_ = nullptr;
  void* dib_bits_ = nullptr;
  int dib_w_ = 0;
  int dib_h_ = 0;
};

}  // namespace linkshell
