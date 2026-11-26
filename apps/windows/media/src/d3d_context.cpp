#include "d3d_context.hpp"

#include <d3d10.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "api/make_ref_counted.h"
#include "common.hpp"
#include "libyuv/convert.h"
#include "libyuv/scale.h"

namespace linkshell {

namespace {

int Even(int v) { return std::max(2, (v / 2) * 2); }

std::string HexHr(HRESULT hr) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
  return buf;
}

}  // namespace

void D3DContext::SetError(const std::string& msg) {
  std::lock_guard<std::mutex> lock(err_mu_);
  last_error_ = msg;
}

std::shared_ptr<D3DContext> D3DContext::Create(int adapter_index, std::string* error) {
  auto ctx = std::shared_ptr<D3DContext>(new D3DContext());

  ComPtr<IDXGIFactory1> factory;
  HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
  ComPtr<IDXGIAdapter1> chosen;
  if (SUCCEEDED(hr) && factory) {
    if (adapter_index >= 0) {
      factory->EnumAdapters1(static_cast<UINT>(adapter_index), &chosen);
    }
    if (!chosen) {
      ComPtr<IDXGIAdapter1> candidate;
      for (UINT i = 0; factory->EnumAdapters1(i, &candidate) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_ADAPTER_DESC1 desc{};
        candidate->GetDesc1(&desc);
        if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0) {
          chosen = candidate;
          break;
        }
        candidate.Reset();
      }
      if (!chosen) factory->EnumAdapters1(0, &chosen);
    }
  }

  D3D_FEATURE_LEVEL levels[] = {
      D3D_FEATURE_LEVEL_11_1,
      D3D_FEATURE_LEVEL_11_0,
      D3D_FEATURE_LEVEL_10_1,
      D3D_FEATURE_LEVEL_10_0,
  };
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;

  if (chosen) {
    hr = D3D11CreateDevice(
        chosen.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
        levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
        &ctx->device_, nullptr, &ctx->context_);
  } else {
    hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
        levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
        &ctx->device_, nullptr, &ctx->context_);
  }

  if (FAILED(hr)) {
    hr = D3D11CreateDevice(
        chosen.Get(), chosen ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
        nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
        &ctx->device_, nullptr, &ctx->context_);
  }
  if (FAILED(hr)) {
    hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_WARP, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
        &ctx->device_, nullptr, &ctx->context_);
    ctx->is_warp_ = SUCCEEDED(hr);
  }
  if (FAILED(hr) || !ctx->device_ || !ctx->context_) {
    if (error) *error = "D3D11CreateDevice failed: " + HexHr(hr);
    return nullptr;
  }

  ComPtr<ID3D10Multithread> mt;
  if (SUCCEEDED(ctx->device_.As(&mt)) && mt) {
    mt->SetMultithreadProtected(TRUE);
  }

  ComPtr<IDXGIDevice> dxgi_dev;
  if (SUCCEEDED(ctx->device_.As(&dxgi_dev)) && dxgi_dev) {
    ComPtr<IDXGIAdapter> adapter;
    if (SUCCEEDED(dxgi_dev->GetAdapter(&adapter)) && adapter) {
      DXGI_ADAPTER_DESC desc{};
      if (SUCCEEDED(adapter->GetDesc(&desc))) {
        ctx->vendor_id_ = desc.VendorId;
        ctx->adapter_name_ = WideToUtf8(desc.Description);
        if (ctx->vendor_id_ == 0x1414) ctx->is_warp_ = true;  // Microsoft Basic Render Driver
      }
    }
  }

  ctx->device_.As(&ctx->video_device_);
  ctx->context_.As(&ctx->video_context_);

  if (SUCCEEDED(MFCreateDXGIDeviceManager(&ctx->reset_token_, &ctx->dxgi_manager_)) && ctx->dxgi_manager_) {
    ctx->dxgi_manager_->ResetDevice(ctx->device_.Get(), ctx->reset_token_);
  }

  return ctx;
}

D3DContext::~D3DContext() = default;

bool D3DContext::InitVideoProcessor(int src_w, int src_h, int dst_w, int dst_h) {
  if (!video_device_ || !video_context_) {
    SetError("ID3D11VideoDevice unavailable");
    return false;
  }
  if (vp_ && vp_enum_ && vp_src_w_ == src_w && vp_src_h_ == src_h && vp_dst_w_ == dst_w && vp_dst_h_ == dst_h) {
    return true;
  }
  vp_.Reset();
  vp_enum_.Reset();

  D3D11_VIDEO_PROCESSOR_CONTENT_DESC desc{};
  desc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  desc.InputFrameRate = {60, 1};
  desc.InputWidth = static_cast<UINT>(src_w);
  desc.InputHeight = static_cast<UINT>(src_h);
  desc.OutputFrameRate = {60, 1};
  desc.OutputWidth = static_cast<UINT>(dst_w);
  desc.OutputHeight = static_cast<UINT>(dst_h);
  desc.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;

  HRESULT hr = video_device_->CreateVideoProcessorEnumerator(&desc, &vp_enum_);
  if (FAILED(hr)) {
    SetError("CreateVideoProcessorEnumerator failed: " + HexHr(hr));
    return false;
  }
  hr = video_device_->CreateVideoProcessor(vp_enum_.Get(), 0, &vp_);
  if (FAILED(hr)) {
    SetError("CreateVideoProcessor failed: " + HexHr(hr));
    return false;
  }

  video_context_->VideoProcessorSetStreamAutoProcessingMode(vp_.Get(), 0, FALSE);

  ComPtr<ID3D11VideoContext1> vc1;
  if (SUCCEEDED(video_context_.As(&vc1)) && vc1) {
    vc1->VideoProcessorSetStreamColorSpace1(vp_.Get(), 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
    vc1->VideoProcessorSetOutputColorSpace1(vp_.Get(), DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
  } else {
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE in_cs{};
    in_cs.Usage = 0;
    in_cs.RGB_Range = 0;
    in_cs.YCbCr_Matrix = 1;
    video_context_->VideoProcessorSetStreamColorSpace(vp_.Get(), 0, &in_cs);
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE out_cs{};
    out_cs.Usage = 0;
    out_cs.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    out_cs.YCbCr_Matrix = 1;
    video_context_->VideoProcessorSetOutputColorSpace(vp_.Get(), &out_cs);
  }

  D3D11_VIDEO_COLOR bg{};
  bg.YCbCr = {0.0625f, 0.5f, 0.5f, 1.0f};
  video_context_->VideoProcessorSetOutputBackgroundColor(vp_.Get(), TRUE, &bg);

  vp_src_w_ = src_w;
  vp_src_h_ = src_h;
  vp_dst_w_ = dst_w;
  vp_dst_h_ = dst_h;
  return true;
}

ComPtr<ID3D11Texture2D> D3DContext::CreateNv12Texture(int width, int height) {
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = static_cast<UINT>(Even(width));
  desc.Height = static_cast<UINT>(Even(height));
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_NV12;
  desc.SampleDesc = {1, 0};
  desc.Usage = D3D11_USAGE_DEFAULT;
  // NVIDIA/Intel CreateVideoProcessorOutputView requires RENDER_TARGET only (without SHADER_RESOURCE).
  desc.BindFlags = D3D11_BIND_RENDER_TARGET;

  ComPtr<ID3D11Texture2D> tex;
  HRESULT hr = device_->CreateTexture2D(&desc, nullptr, &tex);
  if (FAILED(hr)) {
    desc.BindFlags = 0;
    hr = device_->CreateTexture2D(&desc, nullptr, &tex);
    if (FAILED(hr)) {
      SetError("CreateNv12Texture failed: " + HexHr(hr));
      return nullptr;
    }
  }
  return tex;
}

ComPtr<ID3D11Texture2D> D3DContext::ConvertBgraToNv12(
    ID3D11Texture2D* src_bgra,
    int src_w,
    int src_h,
    int dst_w,
    int dst_h,
    bool canvas_paste,
    int paste_w,
    int paste_h) {
  if (!src_bgra || src_w <= 0 || src_h <= 0 || dst_w <= 0 || dst_h <= 0) return nullptr;
  dst_w = Even(dst_w);
  dst_h = Even(dst_h);

  D3D11_TEXTURE2D_DESC src_desc{};
  src_bgra->GetDesc(&src_desc);
  int tex_w = static_cast<int>(src_desc.Width);
  int tex_h = static_cast<int>(src_desc.Height);
  if (tex_w <= 0 || tex_h <= 0) return nullptr;

  std::lock_guard<std::mutex> lock(gpu_mu_);
  if (!InitVideoProcessor(tex_w, tex_h, dst_w, dst_h)) return nullptr;

  ComPtr<ID3D11Texture2D> dst = CreateNv12Texture(dst_w, dst_h);
  if (!dst) return nullptr;

  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC in_desc{};
  in_desc.FourCC = 0;
  in_desc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  in_desc.Texture2D.MipSlice = 0;
  in_desc.Texture2D.ArraySlice = 0;

  ComPtr<ID3D11VideoProcessorInputView> in_view;
  HRESULT hr = video_device_->CreateVideoProcessorInputView(src_bgra, vp_enum_.Get(), &in_desc, &in_view);
  if (FAILED(hr)) {
    // WGC / DXGI shared textures can be rejected by CreateVideoProcessorInputView on NVIDIA;
    // GPU-copy into a clean local non-shared BGRA texture (<0.05 ms VRAM blit).
    if (!vp_input_bgra_ || vp_input_w_ != tex_w || vp_input_h_ != tex_h) {
      vp_input_bgra_.Reset();
      D3D11_TEXTURE2D_DESC local_desc{};
      local_desc.Width = src_desc.Width;
      local_desc.Height = src_desc.Height;
      local_desc.MipLevels = 1;
      local_desc.ArraySize = 1;
      local_desc.Format = src_desc.Format;
      local_desc.SampleDesc = {1, 0};
      local_desc.Usage = D3D11_USAGE_DEFAULT;
      local_desc.BindFlags = D3D11_BIND_RENDER_TARGET;
      HRESULT chr = device_->CreateTexture2D(&local_desc, nullptr, &vp_input_bgra_);
      if (FAILED(chr)) {
        local_desc.BindFlags = 0;
        chr = device_->CreateTexture2D(&local_desc, nullptr, &vp_input_bgra_);
        if (FAILED(chr)) {
          SetError("vp_input_bgra CreateTexture2D failed: " + HexHr(chr));
          return nullptr;
        }
      }
      vp_input_w_ = tex_w;
      vp_input_h_ = tex_h;
    }
    context_->CopyResource(vp_input_bgra_.Get(), src_bgra);
    hr = video_device_->CreateVideoProcessorInputView(vp_input_bgra_.Get(), vp_enum_.Get(), &in_desc, &in_view);
    if (FAILED(hr)) {
      SetError("CreateVideoProcessorInputView failed (direct+local): " + HexHr(hr));
      return nullptr;
    }
  }

  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC out_desc{};
  out_desc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  out_desc.Texture2D.MipSlice = 0;
  ComPtr<ID3D11VideoProcessorOutputView> out_view;
  hr = video_device_->CreateVideoProcessorOutputView(dst.Get(), vp_enum_.Get(), &out_desc, &out_view);
  if (FAILED(hr)) {
    SetError("CreateVideoProcessorOutputView failed: " + HexHr(hr));
    return nullptr;
  }

  ComPtr<ID3D11VideoContext1> vc1;
  if (SUCCEEDED(video_context_.As(&vc1)) && vc1) {
    vc1->VideoProcessorSetStreamColorSpace1(vp_.Get(), 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
    vc1->VideoProcessorSetOutputColorSpace1(vp_.Get(), DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
  }

  int eff_w = std::min(src_w, tex_w);
  int eff_h = std::min(src_h, tex_h);
  RECT src_rect = {0, 0, eff_w, eff_h};
  RECT dst_rect = {0, 0, dst_w, dst_h};
  if (canvas_paste) {
    int pw = std::clamp(paste_w > 0 ? paste_w : eff_w, 1, dst_w);
    int ph = std::clamp(paste_h > 0 ? paste_h : eff_h, 1, dst_h);
    src_rect = {0, 0, std::min(eff_w, pw), std::min(eff_h, ph)};
    dst_rect = {0, 0, pw, ph};
  }
  RECT target_rect = {0, 0, dst_w, dst_h};
  video_context_->VideoProcessorSetStreamSourceRect(vp_.Get(), 0, TRUE, &src_rect);
  video_context_->VideoProcessorSetStreamDestRect(vp_.Get(), 0, TRUE, &dst_rect);
  video_context_->VideoProcessorSetOutputTargetRect(vp_.Get(), TRUE, &target_rect);

  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = in_view.Get();

  hr = video_context_->VideoProcessorBlt(vp_.Get(), out_view.Get(), 0, 1, &stream);
  if (FAILED(hr)) {
    SetError("VideoProcessorBlt failed: " + HexHr(hr));
    return nullptr;
  }
  context_->Flush();
  return dst;
}

webrtc::scoped_refptr<webrtc::I420BufferInterface> D3DContext::BgraBytesToI420(
    const uint8_t* bgra,
    int src_w,
    int src_h,
    int stride,
    int dst_w,
    int dst_h,
    bool canvas_paste,
    int paste_w,
    int paste_h) {
  dst_w = Even(dst_w);
  dst_h = Even(dst_h);
  auto src_i420 = webrtc::I420Buffer::Create(Even(src_w), Even(src_h));
  if (!src_i420) return nullptr;
  libyuv::ARGBToI420(
      bgra, stride,
      src_i420->MutableDataY(), src_i420->StrideY(),
      src_i420->MutableDataU(), src_i420->StrideU(),
      src_i420->MutableDataV(), src_i420->StrideV(),
      Even(src_w), Even(src_h));

  if (!canvas_paste && Even(src_w) == dst_w && Even(src_h) == dst_h) {
    return src_i420;
  }
  auto dst_i420 = webrtc::I420Buffer::Create(dst_w, dst_h);
  if (!dst_i420) return nullptr;
  if (canvas_paste) {
    // Fill black canvas in YUV, then copy top-left window region.
    std::memset(dst_i420->MutableDataY(), 16, static_cast<size_t>(dst_i420->StrideY()) * dst_h);
    std::memset(dst_i420->MutableDataU(), 128, static_cast<size_t>(dst_i420->StrideU()) * (dst_h / 2));
    std::memset(dst_i420->MutableDataV(), 128, static_cast<size_t>(dst_i420->StrideV()) * (dst_h / 2));
    int cw = Even(std::min({src_w, paste_w > 0 ? paste_w : src_w, dst_w}));
    int ch = Even(std::min({src_h, paste_h > 0 ? paste_h : src_h, dst_h}));
    for (int r = 0; r < ch; ++r) {
      std::memcpy(dst_i420->MutableDataY() + r * dst_i420->StrideY(), src_i420->DataY() + r * src_i420->StrideY(), cw);
    }
    for (int r = 0; r < ch / 2; ++r) {
      std::memcpy(dst_i420->MutableDataU() + r * dst_i420->StrideU(), src_i420->DataU() + r * src_i420->StrideU(), cw / 2);
      std::memcpy(dst_i420->MutableDataV() + r * dst_i420->StrideV(), src_i420->DataV() + r * src_i420->StrideV(), cw / 2);
    }
    return dst_i420;
  }
  libyuv::I420Scale(
      src_i420->DataY(), src_i420->StrideY(),
      src_i420->DataU(), src_i420->StrideU(),
      src_i420->DataV(), src_i420->StrideV(),
      Even(src_w), Even(src_h),
      dst_i420->MutableDataY(), dst_i420->StrideY(),
      dst_i420->MutableDataU(), dst_i420->StrideU(),
      dst_i420->MutableDataV(), dst_i420->StrideV(),
      dst_w, dst_h,
      libyuv::kFilterBox);
  return dst_i420;
}

webrtc::scoped_refptr<webrtc::I420BufferInterface> D3DContext::ConvertBgraCpuFallback(
    ID3D11Texture2D* src_bgra,
    int src_w,
    int src_h,
    int dst_w,
    int dst_h,
    bool canvas_paste,
    int paste_w,
    int paste_h) {
  if (!src_bgra) return nullptr;
  D3D11_TEXTURE2D_DESC src_desc{};
  src_bgra->GetDesc(&src_desc);
  int tw = static_cast<int>(src_desc.Width);
  int th = static_cast<int>(src_desc.Height);
  if (tw <= 0 || th <= 0) return nullptr;

  std::lock_guard<std::mutex> lock(gpu_mu_);
  if (!staging_bgra_ || staging_bgra_w_ != tw || staging_bgra_h_ != th) {
    staging_bgra_.Reset();
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = src_desc.Width;
    desc.Height = src_desc.Height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = src_desc.Format;
    desc.SampleDesc = {1, 0};
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(device_->CreateTexture2D(&desc, nullptr, &staging_bgra_))) return nullptr;
    staging_bgra_w_ = tw;
    staging_bgra_h_ = th;
  }
  context_->CopyResource(staging_bgra_.Get(), src_bgra);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(context_->Map(staging_bgra_.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return nullptr;
  auto i420 = BgraBytesToI420(
      static_cast<const uint8_t*>(mapped.pData),
      std::min(src_w, tw), std::min(src_h, th),
      static_cast<int>(mapped.RowPitch),
      dst_w, dst_h, canvas_paste, paste_w, paste_h);
  context_->Unmap(staging_bgra_.Get(), 0);
  return i420;
}

webrtc::scoped_refptr<webrtc::VideoFrameBuffer> D3DContext::ConvertBgraToFrame(
    ID3D11Texture2D* src_bgra,
    int src_w,
    int src_h,
    int dst_w,
    int dst_h,
    const std::string& fusion_layout,
    bool canvas_paste,
    int paste_w,
    int paste_h) {
  dst_w = Even(dst_w);
  dst_h = Even(dst_h);
  auto nv12 = ConvertBgraToNv12(src_bgra, src_w, src_h, dst_w, dst_h, canvas_paste, paste_w, paste_h);
  if (nv12) {
    return webrtc::make_ref_counted<D3D11TextureBuffer>(shared_from_this(), std::move(nv12), dst_w, dst_h, fusion_layout);
  }
  auto i420 = ConvertBgraCpuFallback(src_bgra, src_w, src_h, dst_w, dst_h, canvas_paste, paste_w, paste_h);
  if (!i420) return nullptr;
  return webrtc::make_ref_counted<D3D11TextureBuffer>(std::move(i420), fusion_layout);
}

ComPtr<ID3D11Texture2D> D3DContext::UploadBgraToNv12(
    const uint8_t* bgra_pixels,
    int src_w,
    int src_h,
    int stride,
    int dst_w,
    int dst_h) {
  if (!bgra_pixels || src_w <= 0 || src_h <= 0) return nullptr;
  {
    std::lock_guard<std::mutex> lock(gpu_mu_);
    if (!cpu_upload_bgra_ || cpu_upload_w_ != src_w || cpu_upload_h_ != src_h) {
      cpu_upload_bgra_.Reset();
      D3D11_TEXTURE2D_DESC desc{};
      desc.Width = static_cast<UINT>(src_w);
      desc.Height = static_cast<UINT>(src_h);
      desc.MipLevels = 1;
      desc.ArraySize = 1;
      desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      desc.SampleDesc = {1, 0};
      desc.Usage = D3D11_USAGE_DEFAULT;
      desc.BindFlags = D3D11_BIND_RENDER_TARGET;
      HRESULT hr = device_->CreateTexture2D(&desc, nullptr, &cpu_upload_bgra_);
      if (FAILED(hr)) {
        desc.BindFlags = 0;
        hr = device_->CreateTexture2D(&desc, nullptr, &cpu_upload_bgra_);
        if (FAILED(hr)) {
          SetError("cpu_upload_bgra CreateTexture2D failed: " + HexHr(hr));
          return nullptr;
        }
      }
      cpu_upload_w_ = src_w;
      cpu_upload_h_ = src_h;
    }
    context_->UpdateSubresource(cpu_upload_bgra_.Get(), 0, nullptr, bgra_pixels, static_cast<UINT>(stride), 0);
  }
  return ConvertBgraToNv12(cpu_upload_bgra_.Get(), src_w, src_h, dst_w, dst_h);
}

webrtc::scoped_refptr<webrtc::VideoFrameBuffer> D3DContext::UploadBgraToFrame(
    const uint8_t* bgra_pixels,
    int src_w,
    int src_h,
    int stride,
    int dst_w,
    int dst_h,
    const std::string& fusion_layout) {
  dst_w = Even(dst_w);
  dst_h = Even(dst_h);
  if (!is_warp_) {
    auto nv12 = UploadBgraToNv12(bgra_pixels, src_w, src_h, stride, dst_w, dst_h);
    if (nv12) {
      return webrtc::make_ref_counted<D3D11TextureBuffer>(shared_from_this(), std::move(nv12), dst_w, dst_h, fusion_layout);
    }
  }
  auto i420 = BgraBytesToI420(bgra_pixels, src_w, src_h, stride, dst_w, dst_h, false, 0, 0);
  if (!i420) return nullptr;
  return webrtc::make_ref_counted<D3D11TextureBuffer>(std::move(i420), fusion_layout);
}

ComPtr<ID3D11Texture2D> D3DContext::ScaleNv12(
    ID3D11Texture2D* src_nv12,
    int crop_x,
    int crop_y,
    int crop_w,
    int crop_h,
    int dst_w,
    int dst_h) {
  if (!src_nv12 || crop_w <= 0 || crop_h <= 0 || dst_w <= 0 || dst_h <= 0) return nullptr;
  D3D11_TEXTURE2D_DESC src_desc{};
  src_nv12->GetDesc(&src_desc);
  dst_w = Even(dst_w);
  dst_h = Even(dst_h);

  std::lock_guard<std::mutex> lock(gpu_mu_);
  if (!InitVideoProcessor(static_cast<int>(src_desc.Width), static_cast<int>(src_desc.Height), dst_w, dst_h)) {
    return nullptr;
  }

  ComPtr<ID3D11Texture2D> dst = CreateNv12Texture(dst_w, dst_h);
  if (!dst) return nullptr;

  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC in_desc{};
  in_desc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  ComPtr<ID3D11VideoProcessorInputView> in_view;
  if (FAILED(video_device_->CreateVideoProcessorInputView(src_nv12, vp_enum_.Get(), &in_desc, &in_view))) {
    return nullptr;
  }
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC out_desc{};
  out_desc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  ComPtr<ID3D11VideoProcessorOutputView> out_view;
  if (FAILED(video_device_->CreateVideoProcessorOutputView(dst.Get(), vp_enum_.Get(), &out_desc, &out_view))) {
    return nullptr;
  }

  ComPtr<ID3D11VideoContext1> vc1;
  if (SUCCEEDED(video_context_.As(&vc1)) && vc1) {
    vc1->VideoProcessorSetStreamColorSpace1(vp_.Get(), 0, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
    vc1->VideoProcessorSetOutputColorSpace1(vp_.Get(), DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
  }

  RECT src_rect = {crop_x, crop_y, crop_x + crop_w, crop_y + crop_h};
  RECT dst_rect = {0, 0, dst_w, dst_h};
  video_context_->VideoProcessorSetStreamSourceRect(vp_.Get(), 0, TRUE, &src_rect);
  video_context_->VideoProcessorSetStreamDestRect(vp_.Get(), 0, TRUE, &dst_rect);
  video_context_->VideoProcessorSetOutputTargetRect(vp_.Get(), TRUE, &dst_rect);

  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = in_view.Get();
  if (FAILED(video_context_->VideoProcessorBlt(vp_.Get(), out_view.Get(), 0, 1, &stream))) {
    return nullptr;
  }
  context_->Flush();
  return dst;
}

webrtc::scoped_refptr<webrtc::I420BufferInterface> D3DContext::CopyNv12ToI420(
    ID3D11Texture2D* nv12_tex,
    int width,
    int height) {
  if (!nv12_tex || width <= 0 || height <= 0) return nullptr;
  D3D11_TEXTURE2D_DESC src_desc{};
  nv12_tex->GetDesc(&src_desc);
  int w = static_cast<int>(src_desc.Width);
  int h = static_cast<int>(src_desc.Height);

  std::lock_guard<std::mutex> lock(gpu_mu_);
  if (!staging_nv12_ || staging_w_ != w || staging_h_ != h) {
    staging_nv12_.Reset();
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = static_cast<UINT>(w);
    desc.Height = static_cast<UINT>(h);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_NV12;
    desc.SampleDesc = {1, 0};
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(device_->CreateTexture2D(&desc, nullptr, &staging_nv12_))) return nullptr;
    staging_w_ = w;
    staging_h_ = h;
  }

  context_->CopyResource(staging_nv12_.Get(), nv12_tex);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(context_->Map(staging_nv12_.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return nullptr;

  auto i420 = webrtc::I420Buffer::Create(width, height);
  const uint8_t* y_plane = static_cast<const uint8_t*>(mapped.pData);
  const uint8_t* uv_plane = y_plane + static_cast<size_t>(mapped.RowPitch) * static_cast<size_t>(h);
  libyuv::NV12ToI420(
      y_plane, static_cast<int>(mapped.RowPitch),
      uv_plane, static_cast<int>(mapped.RowPitch),
      i420->MutableDataY(), i420->StrideY(),
      i420->MutableDataU(), i420->StrideU(),
      i420->MutableDataV(), i420->StrideV(),
      width, height);

  context_->Unmap(staging_nv12_.Get(), 0);
  return i420;
}

// ── D3D11TextureBuffer ──────────────────────────────────────────────────────

D3D11TextureBuffer::D3D11TextureBuffer(
    std::shared_ptr<D3DContext> ctx,
    ComPtr<ID3D11Texture2D> texture,
    int width,
    int height,
    std::string fusion_layout)
    : ctx_(std::move(ctx)),
      texture_(std::move(texture)),
      width_(width),
      height_(height),
      fusion_layout_(std::move(fusion_layout)) {}

D3D11TextureBuffer::D3D11TextureBuffer(
    webrtc::scoped_refptr<webrtc::I420BufferInterface> cpu_i420,
    std::string fusion_layout)
    : cpu_i420_(std::move(cpu_i420)),
      width_(cpu_i420_ ? cpu_i420_->width() : 0),
      height_(cpu_i420_ ? cpu_i420_->height() : 0),
      fusion_layout_(std::move(fusion_layout)) {}

webrtc::scoped_refptr<webrtc::I420BufferInterface> D3D11TextureBuffer::ToI420() {
  if (cpu_i420_) return cpu_i420_;
  return ctx_ ? ctx_->CopyNv12ToI420(texture_.Get(), width_, height_) : nullptr;
}

webrtc::scoped_refptr<webrtc::VideoFrameBuffer> D3D11TextureBuffer::CropAndScale(
    int offset_x,
    int offset_y,
    int crop_width,
    int crop_height,
    int scaled_width,
    int scaled_height) {
  if (offset_x == 0 && offset_y == 0 && crop_width == width_ && crop_height == height_ &&
      scaled_width == width_ && scaled_height == height_) {
    return webrtc::scoped_refptr<webrtc::VideoFrameBuffer>(this);
  }
  if (ctx_ && texture_) {
    auto scaled = ctx_->ScaleNv12(texture_.Get(), offset_x, offset_y, crop_width, crop_height, scaled_width, scaled_height);
    if (scaled) {
      return webrtc::make_ref_counted<D3D11TextureBuffer>(
          ctx_, std::move(scaled), Even(scaled_width), Even(scaled_height), fusion_layout_);
    }
  }
  auto i420 = ToI420();
  if (!i420) return nullptr;
  auto scaled_i420 = i420->CropAndScale(offset_x, offset_y, crop_width, crop_height, scaled_width, scaled_height);
  if (!scaled_i420) return nullptr;
  return webrtc::make_ref_counted<D3D11TextureBuffer>(scaled_i420->ToI420(), fusion_layout_);
}

}  // namespace linkshell
