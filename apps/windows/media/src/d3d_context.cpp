#include "d3d_context.hpp"

#include <d3d10.h>
#include <algorithm>
#include <cstring>

#include "api/make_ref_counted.h"
#include "common.hpp"
#include "libyuv/convert.h"

namespace linkshell {

namespace {
int Even(int v) { return std::max(2, (v / 2) * 2); }
}  // namespace

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
      // Pick the first non-software hardware adapter; fall back to adapter 0.
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
    // Fallback without VIDEO_SUPPORT or via WARP for headless VMs without GPU video acceleration.
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
    if (error) *error = "D3D11CreateDevice failed: " + std::to_string(hr);
    return nullptr;
  }

  ComPtr<ID3D10Multithread> mt;
  if (SUCCEEDED(ctx->device_.As(&mt)) && mt) {
    mt->SetMultithreadProtected(TRUE);
  }

  // Record adapter identity for telemetry and encoder preference.
  ComPtr<IDXGIDevice> dxgi_dev;
  if (SUCCEEDED(ctx->device_.As(&dxgi_dev)) && dxgi_dev) {
    ComPtr<IDXGIAdapter> adapter;
    if (SUCCEEDED(dxgi_dev->GetAdapter(&adapter)) && adapter) {
      DXGI_ADAPTER_DESC desc{};
      if (SUCCEEDED(adapter->GetDesc(&desc))) {
        ctx->vendor_id_ = desc.VendorId;
        ctx->adapter_name_ = WideToUtf8(desc.Description);
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
  if (!video_device_ || !video_context_) return false;
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

  if (FAILED(video_device_->CreateVideoProcessorEnumerator(&desc, &vp_enum_))) return false;
  if (FAILED(video_device_->CreateVideoProcessor(vp_enum_.Get(), 0, &vp_))) return false;

  // Disable automatic post-processing (denoising, edge enhancement) that blurs crisp desktop text.
  video_context_->VideoProcessorSetStreamAutoProcessingMode(vp_.Get(), 0, FALSE);

  // Set BT.709 color space accurately so desktop text does not suffer BT.601 color shift.
  ComPtr<ID3D11VideoContext1> vc1;
  if (SUCCEEDED(video_context_.As(&vc1)) && vc1) {
    vc1->VideoProcessorSetStreamColorSpace1(vp_.Get(), 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
    vc1->VideoProcessorSetOutputColorSpace1(vp_.Get(), DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
  } else {
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE in_cs{};
    in_cs.Usage = 0;
    in_cs.RGB_Range = 0;  // Full range RGB
    in_cs.YCbCr_Matrix = 1;  // BT.709
    video_context_->VideoProcessorSetStreamColorSpace(vp_.Get(), 0, &in_cs);
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE out_cs{};
    out_cs.Usage = 0;
    out_cs.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    out_cs.YCbCr_Matrix = 1;  // BT.709
    video_context_->VideoProcessorSetOutputColorSpace(vp_.Get(), &out_cs);
  }

  D3D11_VIDEO_COLOR bg{};
  bg.RGBA = {0.0f, 0.0f, 0.0f, 1.0f};
  video_context_->VideoProcessorSetOutputBackgroundColor(vp_.Get(), FALSE, &bg);

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
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

  ComPtr<ID3D11Texture2D> tex;
  if (FAILED(device_->CreateTexture2D(&desc, nullptr, &tex))) {
    // Some legacy/WARP drivers reject SHADER_RESOURCE on NV12; retry with RENDER_TARGET only.
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    if (FAILED(device_->CreateTexture2D(&desc, nullptr, &tex))) return nullptr;
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

  std::lock_guard<std::mutex> lock(gpu_mu_);
  if (!InitVideoProcessor(src_w, src_h, dst_w, dst_h)) return nullptr;

  ComPtr<ID3D11Texture2D> dst = CreateNv12Texture(dst_w, dst_h);
  if (!dst) return nullptr;

  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC in_desc{};
  in_desc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  in_desc.Texture2D.MipSlice = 0;
  ComPtr<ID3D11VideoProcessorInputView> in_view;
  if (FAILED(video_device_->CreateVideoProcessorInputView(src_bgra, vp_enum_.Get(), &in_desc, &in_view))) {
    return nullptr;
  }

  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC out_desc{};
  out_desc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  out_desc.Texture2D.MipSlice = 0;
  ComPtr<ID3D11VideoProcessorOutputView> out_view;
  if (FAILED(video_device_->CreateVideoProcessorOutputView(dst.Get(), vp_enum_.Get(), &out_desc, &out_view))) {
    return nullptr;
  }

  ComPtr<ID3D11VideoContext1> vc1;
  if (SUCCEEDED(video_context_.As(&vc1)) && vc1) {
    vc1->VideoProcessorSetStreamColorSpace1(vp_.Get(), 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
    vc1->VideoProcessorSetOutputColorSpace1(vp_.Get(), DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
  }

  RECT src_rect = {0, 0, src_w, src_h};
  RECT dst_rect = {0, 0, dst_w, dst_h};
  if (canvas_paste) {
    int pw = std::clamp(paste_w > 0 ? paste_w : src_w, 1, dst_w);
    int ph = std::clamp(paste_h > 0 ? paste_h : src_h, 1, dst_h);
    src_rect = {0, 0, std::min(src_w, pw), std::min(src_h, ph)};
    dst_rect = {0, 0, pw, ph};
  }
  RECT target_rect = {0, 0, dst_w, dst_h};
  video_context_->VideoProcessorSetStreamSourceRect(vp_.Get(), 0, TRUE, &src_rect);
  video_context_->VideoProcessorSetStreamDestRect(vp_.Get(), 0, TRUE, &dst_rect);
  video_context_->VideoProcessorSetOutputTargetRect(vp_.Get(), TRUE, &target_rect);

  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = in_view.Get();

  if (FAILED(video_context_->VideoProcessorBlt(vp_.Get(), out_view.Get(), 0, 1, &stream))) {
    return nullptr;
  }
  context_->Flush();
  return dst;
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
      desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      if (FAILED(device_->CreateTexture2D(&desc, nullptr, &cpu_upload_bgra_))) return nullptr;
      cpu_upload_w_ = src_w;
      cpu_upload_h_ = src_h;
    }
    context_->UpdateSubresource(cpu_upload_bgra_.Get(), 0, nullptr, bgra_pixels, static_cast<UINT>(stride), 0);
  }
  return ConvertBgraToNv12(cpu_upload_bgra_.Get(), src_w, src_h, dst_w, dst_h);
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

webrtc::scoped_refptr<webrtc::I420BufferInterface> D3D11TextureBuffer::ToI420() {
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
  if (ctx_) {
    auto scaled = ctx_->ScaleNv12(texture_.Get(), offset_x, offset_y, crop_width, crop_height, scaled_width, scaled_height);
    if (scaled) {
      return webrtc::make_ref_counted<D3D11TextureBuffer>(
          ctx_, std::move(scaled), Even(scaled_width), Even(scaled_height), fusion_layout_);
    }
  }
  auto i420 = ToI420();
  return i420 ? i420->CropAndScale(offset_x, offset_y, crop_width, crop_height, scaled_width, scaled_height) : nullptr;
}

}  // namespace linkshell
