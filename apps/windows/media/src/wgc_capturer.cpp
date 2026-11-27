#include "wgc_capturer.hpp"

#include <inspectable.h>
#include <roapi.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winstring.h>
#include <wrl/event.h>
#include <wrl/implements.h>
#include <wrl/wrappers/corewrappers.h>

#include <algorithm>
#include <mutex>

#include "common.hpp"

namespace linkshell {

namespace WGC = ABI::Windows::Graphics::Capture;
namespace WGD = ABI::Windows::Graphics::DirectX;
namespace WGD3D = ABI::Windows::Graphics::DirectX::Direct3D11;
namespace WG = ABI::Windows::Graphics;

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Wrappers::HStringReference;

namespace {

using CreateD3D11DeviceFromDXGIFn = HRESULT(WINAPI*)(IDXGIDevice*, IInspectable**);

CreateD3D11DeviceFromDXGIFn LoadCreateD3D11DeviceFn() {
  static CreateD3D11DeviceFromDXGIFn fn = []() -> CreateD3D11DeviceFromDXGIFn {
    HMODULE mod = LoadLibraryW(L"d3d11.dll");
    if (!mod) return nullptr;
    return reinterpret_cast<CreateD3D11DeviceFromDXGIFn>(
        GetProcAddress(mod, "CreateDirect3D11DeviceFromDXGIDevice"));
  }();
  return fn;
}

ComPtr<WGD3D::IDirect3DDevice> WrapD3D11Device(ID3D11Device* device) {
  auto fn = LoadCreateD3D11DeviceFn();
  if (!fn || !device) return nullptr;
  ComPtr<IDXGIDevice> dxgi_device;
  if (FAILED(device->QueryInterface(IID_PPV_ARGS(&dxgi_device))) || !dxgi_device) return nullptr;
  ComPtr<IInspectable> inspectable;
  if (FAILED(fn(dxgi_device.Get(), &inspectable)) || !inspectable) return nullptr;
  ComPtr<WGD3D::IDirect3DDevice> winrt_device;
  inspectable.As(&winrt_device);
  return winrt_device;
}

template <typename T>
HRESULT ActivateFactory(const wchar_t* class_name, ComPtr<T>& out) {
  HStringReference hstr(class_name, static_cast<unsigned int>(wcslen(class_name)));
  return RoGetActivationFactory(hstr.Get(), IID_PPV_ARGS(out.ReleaseAndGetAddressOf()));
}

}  // namespace

struct WgcCapturer::Impl {
  std::mutex mu;
  std::atomic<bool> alive{true};
  FrameCallback on_frame;
  ClosedCallback on_closed;
  ComPtr<WGD3D::IDirect3DDevice> winrt_device;
  ComPtr<WGC::IGraphicsCaptureItem> item;
  ComPtr<WGC::IDirect3D11CaptureFramePool> frame_pool;
  ComPtr<WGC::IGraphicsCaptureSession> session;
  EventRegistrationToken frame_token{};
  EventRegistrationToken closed_token{};
  bool has_frame_token = false;
  bool has_closed_token = false;
  WG::SizeInt32 pool_size{0, 0};
};

bool WgcCapturer::IsSupported() {
  if (!LoadCreateD3D11DeviceFn()) return false;
  ComPtr<WGC::IGraphicsCaptureSessionStatics> statics;
  if (FAILED(ActivateFactory(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureSession, statics)) || !statics) {
    return false;
  }
  boolean supported = FALSE;
  if (FAILED(statics->IsSupported(&supported))) return false;
  return supported != FALSE;
}

WgcCapturer::WgcCapturer(std::shared_ptr<D3DContext> d3d, FrameCallback on_frame, ClosedCallback on_closed)
    : d3d_(std::move(d3d)), on_frame_(std::move(on_frame)), on_closed_(std::move(on_closed)) {}

WgcCapturer::~WgcCapturer() {
  Stop();
}

bool WgcCapturer::StartMonitor(HMONITOR hmonitor, std::string* error) {
  Stop();
  if (!hmonitor) {
    if (error) *error = "invalid HMONITOR";
    return false;
  }
  ComPtr<IGraphicsCaptureItemInterop> interop;
  HRESULT hr = ActivateFactory(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem, interop);
  if (FAILED(hr) || !interop) {
    if (error) *error = "WGC GraphicsCaptureItem activation failed";
    return false;
  }
  ComPtr<WGC::IGraphicsCaptureItem> item;
  hr = interop->CreateForMonitor(hmonitor, IID_PPV_ARGS(&item));
  if (FAILED(hr) || !item) {
    if (error) *error = "WGC CreateForMonitor failed: " + std::to_string(hr);
    return false;
  }
  return StartWithItem(item.Get(), error);
}

bool WgcCapturer::StartWindow(HWND hwnd, std::string* error) {
  Stop();
  if (!hwnd || !IsWindow(hwnd)) {
    if (error) *error = "invalid HWND";
    return false;
  }
  ComPtr<IGraphicsCaptureItemInterop> interop;
  HRESULT hr = ActivateFactory(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem, interop);
  if (FAILED(hr) || !interop) {
    if (error) *error = "WGC GraphicsCaptureItem activation failed";
    return false;
  }
  ComPtr<WGC::IGraphicsCaptureItem> item;
  hr = interop->CreateForWindow(hwnd, IID_PPV_ARGS(&item));
  if (FAILED(hr) || !item) {
    if (error) *error = "WGC CreateForWindow failed: " + std::to_string(hr);
    return false;
  }
  return StartWithItem(item.Get(), error);
}

bool WgcCapturer::StartWithItem(void* raw_item_unknown, std::string* error) {
  if (!d3d_ || !d3d_->device()) {
    if (error) *error = "missing D3D11 device";
    return false;
  }
  auto impl = std::make_shared<Impl>();
  impl->on_frame = on_frame_;
  impl->on_closed = on_closed_;
  impl->winrt_device = WrapD3D11Device(d3d_->device());
  if (!impl->winrt_device) {
    if (error) *error = "CreateDirect3D11DeviceFromDXGIDevice failed";
    return false;
  }

  auto* item_ptr = reinterpret_cast<WGC::IGraphicsCaptureItem*>(raw_item_unknown);
  impl->item = item_ptr;

  WG::SizeInt32 size{0, 0};
  if (FAILED(impl->item->get_Size(&size)) || size.Width <= 0 || size.Height <= 0) {
    if (error) *error = "WGC item size is empty";
    return false;
  }
  impl->pool_size = size;

  ComPtr<WGC::IDirect3D11CaptureFramePoolStatics2> pool_statics2;
  HRESULT hr = ActivateFactory(RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool, pool_statics2);
  if (FAILED(hr) || !pool_statics2) {
    if (error) *error = "WGC Direct3D11CaptureFramePoolStatics2 unavailable (requires Win10 1903+)";
    return false;
  }

  hr = pool_statics2->CreateFreeThreaded(
      impl->winrt_device.Get(),
      WGD::DirectXPixelFormat_B8G8R8A8UIntNormalized,
      2,
      size,
      &impl->frame_pool);
  if (FAILED(hr) || !impl->frame_pool) {
    if (error) *error = "WGC CreateFreeThreaded failed: " + std::to_string(hr);
    return false;
  }

  hr = impl->frame_pool->CreateCaptureSession(impl->item.Get(), &impl->session);
  if (FAILED(hr) || !impl->session) {
    if (error) *error = "WGC CreateCaptureSession failed: " + std::to_string(hr);
    return false;
  }

  // Hide system cursor in video track (LinkShell sends crisp cursor shape/position over DataChannels).
  ComPtr<WGC::IGraphicsCaptureSession2> session2;
  if (SUCCEEDED(impl->session.As(&session2)) && session2) {
    session2->put_IsCursorCaptureEnabled(FALSE);
  }
  // Hide Win11 yellow capture border where supported.
  ComPtr<WGC::IGraphicsCaptureSession3> session3;
  if (SUCCEEDED(impl->session.As(&session3)) && session3) {
    session3->put_IsBorderRequired(FALSE);
  }

  impl_ = impl;
  running_.store(true);

  std::weak_ptr<Impl> weak_impl = impl;

  using FrameArrivedHandler =
      ABI::Windows::Foundation::ITypedEventHandler<WGC::Direct3D11CaptureFramePool*, IInspectable*>;
  using AgileFrameArrived =
      Microsoft::WRL::Implements<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, FrameArrivedHandler, Microsoft::WRL::FtmBase>;
  auto on_arrived = Callback<AgileFrameArrived>(
      [weak_impl](WGC::IDirect3D11CaptureFramePool* sender, IInspectable*) -> HRESULT {
        auto state = weak_impl.lock();
        if (!state || !state->alive.load(std::memory_order_acquire)) return S_OK;
        std::lock_guard<std::mutex> lock(state->mu);
        if (!state->alive.load(std::memory_order_acquire) || !state->frame_pool) return S_OK;

        ComPtr<WGC::IDirect3D11CaptureFrame> frame;
        if (FAILED(sender->TryGetNextFrame(&frame)) || !frame) return S_OK;

        WG::SizeInt32 content_size{0, 0};
        frame->get_ContentSize(&content_size);

        ComPtr<WGD3D::IDirect3DSurface> surface;
        if (SUCCEEDED(frame->get_Surface(&surface)) && surface) {
          ComPtr<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
          if (SUCCEEDED(surface.As(&access)) && access) {
            ComPtr<ID3D11Texture2D> texture;
            if (SUCCEEDED(access->GetInterface(IID_PPV_ARGS(&texture))) && texture) {
              D3D11_TEXTURE2D_DESC desc{};
              texture->GetDesc(&desc);
              int cw = content_size.Width > 0 ? std::min<int>(content_size.Width, static_cast<int>(desc.Width))
                                              : static_cast<int>(desc.Width);
              int ch = content_size.Height > 0 ? std::min<int>(content_size.Height, static_cast<int>(desc.Height))
                                               : static_cast<int>(desc.Height);
              if (cw > 0 && ch > 0 && state->on_frame) {
                state->on_frame(texture.Get(), cw, ch);
              }
            }
          }
        }

        // Recreate pool if monitor/window resized.
        if (content_size.Width > 0 && content_size.Height > 0 &&
            state->alive.load(std::memory_order_acquire) && state->frame_pool && state->winrt_device &&
            (content_size.Width != state->pool_size.Width || content_size.Height != state->pool_size.Height)) {
          state->pool_size = content_size;
          state->frame_pool->Recreate(
              state->winrt_device.Get(),
              WGD::DirectXPixelFormat_B8G8R8A8UIntNormalized,
              2,
              content_size);
        }
        return S_OK;
      });

  hr = impl_->frame_pool->add_FrameArrived(on_arrived.Get(), &impl_->frame_token);
  if (FAILED(hr)) {
    if (error) *error = "WGC add_FrameArrived failed: " + std::to_string(hr);
    Stop();
    return false;
  }
  impl_->has_frame_token = true;

  using ClosedHandler =
      ABI::Windows::Foundation::ITypedEventHandler<WGC::GraphicsCaptureItem*, IInspectable*>;
  using AgileClosed =
      Microsoft::WRL::Implements<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, ClosedHandler, Microsoft::WRL::FtmBase>;
  auto on_item_closed = Callback<AgileClosed>(
      [weak_impl](WGC::IGraphicsCaptureItem*, IInspectable*) -> HRESULT {
        auto state = weak_impl.lock();
        if (!state || !state->alive.exchange(false, std::memory_order_acq_rel)) return S_OK;
        std::lock_guard<std::mutex> lock(state->mu);
        if (state->on_closed) {
          state->on_closed("capture target closed");
        }
        return S_OK;
      });
  if (SUCCEEDED(impl_->item->add_Closed(on_item_closed.Get(), &impl_->closed_token))) {
    impl_->has_closed_token = true;
  }

  hr = impl_->session->StartCapture();
  if (FAILED(hr)) {
    if (error) *error = "WGC StartCapture failed: " + std::to_string(hr);
    Stop();
    return false;
  }
  return true;
}

void WgcCapturer::Stop() {
  running_.store(false);
  auto impl = std::move(impl_);
  if (!impl) return;
  impl->alive.store(false, std::memory_order_release);

  ComPtr<WGC::IDirect3D11CaptureFramePool> frame_pool;
  ComPtr<WGC::IGraphicsCaptureItem> item;
  ComPtr<WGC::IGraphicsCaptureSession> session;
  ComPtr<WGD3D::IDirect3DDevice> winrt_device;
  EventRegistrationToken frame_token{};
  EventRegistrationToken closed_token{};
  bool has_frame_token = false;
  bool has_closed_token = false;
  {
    // Wait for any in-flight callback to finish and detach all COM/callback state before
    // making WinRT remove/Close calls outside the lock (avoids WinRT lock inversion).
    std::lock_guard<std::mutex> lock(impl->mu);
    impl->on_frame = nullptr;
    impl->on_closed = nullptr;
    frame_pool = std::move(impl->frame_pool);
    item = std::move(impl->item);
    session = std::move(impl->session);
    winrt_device = std::move(impl->winrt_device);
    frame_token = impl->frame_token;
    closed_token = impl->closed_token;
    has_frame_token = impl->has_frame_token;
    has_closed_token = impl->has_closed_token;
    impl->has_frame_token = false;
    impl->has_closed_token = false;
  }

  if (frame_pool && has_frame_token) {
    frame_pool->remove_FrameArrived(frame_token);
  }
  if (item && has_closed_token) {
    item->remove_Closed(closed_token);
  }
  ComPtr<ABI::Windows::Foundation::IClosable> closable;
  if (session && SUCCEEDED(session.As(&closable)) && closable) closable->Close();
  closable.Reset();
  if (frame_pool && SUCCEEDED(frame_pool.As(&closable)) && closable) closable->Close();
}

}  // namespace linkshell
