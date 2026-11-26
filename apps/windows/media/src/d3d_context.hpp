#pragma once

#include <d3d11.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfobjects.h>
#include <wrl/client.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "api/scoped_refptr.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame_buffer.h"

namespace linkshell {

using Microsoft::WRL::ComPtr;

// Shared D3D11 + DXGI Device Manager + VideoProcessor context.
// Performs zero-copy GPU BGRA->NV12 conversion, BT.709 color tagging, scaling,
// Fusion canvas blitting, and NV12->NV12 CropAndScale for libwebrtc degradation,
// with automatic libyuv CPU fallback on WARP / unsupported drivers.
class D3DContext : public std::enable_shared_from_this<D3DContext> {
 public:
  static std::shared_ptr<D3DContext> Create(int adapter_index = -1, std::string* error = nullptr);
  ~D3DContext();

  ID3D11Device* device() const { return device_.Get(); }
  ID3D11DeviceContext* context() const { return context_.Get(); }
  IMFDXGIDeviceManager* dxgi_manager() const { return dxgi_manager_.Get(); }
  UINT reset_token() const { return reset_token_; }
  uint32_t vendor_id() const { return vendor_id_; }
  std::string adapter_name() const { return adapter_name_; }
  bool is_warp() const { return is_warp_; }

  std::string last_error() const {
    std::lock_guard<std::mutex> lock(err_mu_);
    return last_error_;
  }

  // Converts BGRA GPU texture to NV12 GPU texture (or returns nullptr and sets last_error()).
  ComPtr<ID3D11Texture2D> ConvertBgraToNv12(
      ID3D11Texture2D* src_bgra,
      int src_w,
      int src_h,
      int dst_w,
      int dst_h,
      bool canvas_paste = false,
      int paste_w = 0,
      int paste_h = 0);

  // Converts BGRA GPU texture to a VideoFrameBuffer (GPU zero-copy D3D11TextureBuffer when
  // D3D11VideoProcessor succeeds; CPU libyuv I420 fallback if driver rejects VideoProcessor).
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> ConvertBgraToFrame(
      ID3D11Texture2D* src_bgra,
      int src_w,
      int src_h,
      int dst_w,
      int dst_h,
      const std::string& fusion_layout = {},
      bool canvas_paste = false,
      int paste_w = 0,
      int paste_h = 0);

  // Uploads CPU BGRA pixels (GDI / UAC Secure Desktop / selftest) to GPU NV12 texture.
  ComPtr<ID3D11Texture2D> UploadBgraToNv12(
      const uint8_t* bgra_pixels,
      int src_w,
      int src_h,
      int stride,
      int dst_w,
      int dst_h);

  // Uploads CPU BGRA pixels to a VideoFrameBuffer (GPU zero-copy NV12 preferred, libyuv I420 fallback).
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> UploadBgraToFrame(
      const uint8_t* bgra_pixels,
      int src_w,
      int src_h,
      int stride,
      int dst_w,
      int dst_h,
      const std::string& fusion_layout = {});

  // GPU NV12 -> NV12 crop and scale (used by D3D11TextureBuffer::CropAndScale).
  ComPtr<ID3D11Texture2D> ScaleNv12(
      ID3D11Texture2D* src_nv12,
      int crop_x,
      int crop_y,
      int crop_w,
      int crop_h,
      int dst_w,
      int dst_h);

  // Maps an NV12 GPU texture to CPU I420 when falling back to software encoders.
  webrtc::scoped_refptr<webrtc::I420BufferInterface> CopyNv12ToI420(
      ID3D11Texture2D* nv12_tex,
      int width,
      int height);

 private:
  D3DContext() = default;
  void SetError(const std::string& msg);
  bool InitVideoProcessor(int src_w, int src_h, int dst_w, int dst_h);
  ComPtr<ID3D11Texture2D> CreateNv12Texture(int width, int height);
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ConvertBgraCpuFallback(
      ID3D11Texture2D* src_bgra,
      int src_w,
      int src_h,
      int dst_w,
      int dst_h,
      bool canvas_paste,
      int paste_w,
      int paste_h);
  webrtc::scoped_refptr<webrtc::I420BufferInterface> BgraBytesToI420(
      const uint8_t* bgra,
      int src_w,
      int src_h,
      int stride,
      int dst_w,
      int dst_h,
      bool canvas_paste,
      int paste_w,
      int paste_h);

  std::mutex gpu_mu_;
  mutable std::mutex err_mu_;
  std::string last_error_;

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11VideoDevice> video_device_;
  ComPtr<ID3D11VideoContext> video_context_;
  ComPtr<ID3D11VideoProcessorEnumerator> vp_enum_;
  ComPtr<ID3D11VideoProcessor> vp_;
  int vp_src_w_ = 0;
  int vp_src_h_ = 0;
  int vp_dst_w_ = 0;
  int vp_dst_h_ = 0;

  ComPtr<ID3D11Texture2D> vp_input_bgra_;
  int vp_input_w_ = 0;
  int vp_input_h_ = 0;

  ComPtr<ID3D11Texture2D> cpu_upload_bgra_;
  int cpu_upload_w_ = 0;
  int cpu_upload_h_ = 0;

  ComPtr<ID3D11Texture2D> staging_bgra_;
  int staging_bgra_w_ = 0;
  int staging_bgra_h_ = 0;

  ComPtr<ID3D11Texture2D> staging_nv12_;
  int staging_w_ = 0;
  int staging_h_ = 0;

  ComPtr<IMFDXGIDeviceManager> dxgi_manager_;
  UINT reset_token_ = 0;
  uint32_t vendor_id_ = 0;
  std::string adapter_name_;
  bool is_warp_ = false;
};

// Native GPU-backed (or CPU-I420-backed) VideoFrameBuffer carrying optional Fusion SEI layout.
class D3D11TextureBuffer : public webrtc::VideoFrameBuffer {
 public:
  D3D11TextureBuffer(
      std::shared_ptr<D3DContext> ctx,
      ComPtr<ID3D11Texture2D> texture,
      int width,
      int height,
      std::string fusion_layout = {});

  D3D11TextureBuffer(
      webrtc::scoped_refptr<webrtc::I420BufferInterface> cpu_i420,
      std::string fusion_layout = {});

  Type type() const override { return Type::kNative; }
  int width() const override { return width_; }
  int height() const override { return height_; }

  webrtc::scoped_refptr<webrtc::I420BufferInterface> ToI420() override;
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> CropAndScale(
      int offset_x,
      int offset_y,
      int crop_width,
      int crop_height,
      int scaled_width,
      int scaled_height) override;

  ID3D11Texture2D* texture() const { return texture_.Get(); }
  bool is_gpu() const { return texture_ != nullptr; }
  const std::shared_ptr<D3DContext>& d3d_context() const { return ctx_; }
  const std::string& fusion_layout() const { return fusion_layout_; }

 private:
  std::shared_ptr<D3DContext> ctx_;
  ComPtr<ID3D11Texture2D> texture_;
  webrtc::scoped_refptr<webrtc::I420BufferInterface> cpu_i420_;
  int width_;
  int height_;
  std::string fusion_layout_;
};

}  // namespace linkshell
