#include "audio_capturer.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

#include "common.hpp"

namespace linkshell {

using Microsoft::WRL::ComPtr;

namespace {
constexpr uint8_t kAudioVersion = 1;
constexpr uint8_t kAudioCodecPcm16 = 2;
constexpr int kTargetRate = 48000;
constexpr int kTargetChannels = 2;
constexpr int kFrameSamples = 960;  // 20 ms at 48 kHz
constexpr size_t kFramePcmBytes = kFrameSamples * kTargetChannels * sizeof(int16_t);
constexpr size_t kHeaderBytes = 8;

inline int16_t FloatToPcm16(float v) {
  float clamped = std::clamp(v, -1.0f, 1.0f);
  int scaled = static_cast<int>(std::lrintf(clamped * 32767.0f));
  return static_cast<int16_t>(std::clamp(scaled, -32768, 32767));
}
}  // namespace

AudioCapturer::AudioCapturer(PacketCallback on_packet, LogFn log)
    : on_packet_(std::move(on_packet)), log_(std::move(log)) {}

AudioCapturer::~AudioCapturer() {
  Stop();
}

void AudioCapturer::Start() {
  if (running_.exchange(true)) return;
  thread_ = std::thread([this]() { RunLoop(); });
}

void AudioCapturer::Stop() {
  if (!running_.exchange(false)) return;
  if (thread_.joinable()) thread_.join();
}

void AudioCapturer::RunLoop() {
  HRESULT hr_co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool uninit = SUCCEEDED(hr_co);

  uint16_t seq = 0;
  std::vector<int16_t> accum;
  accum.reserve(kFrameSamples * kTargetChannels * 4);
  std::vector<uint8_t> packet(kHeaderBytes + kFramePcmBytes);
  double resample_phase = 0.0;

  while (running_.load()) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator))) ||
        !enumerator) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    ComPtr<IMMDevice> device;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device)) || !device) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    ComPtr<IAudioClient> client;
    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client)) || !client) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    WAVEFORMATEX* mix = nullptr;
    if (FAILED(client->GetMixFormat(&mix)) || !mix) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    bool is_float = (mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
    bool is_pcm16 = (mix->wFormatTag == WAVE_FORMAT_PCM && mix->wBitsPerSample == 16);
    if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE && mix->cbSize >= 22) {
      auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mix);
      if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) is_float = true;
      else if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM) && mix->wBitsPerSample == 16) is_pcm16 = true;
    }

    int src_rate = static_cast<int>(mix->nSamplesPerSec);
    int src_channels = static_cast<int>(mix->nChannels);

    HRESULT hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        200'000,  // 20 ms buffer
        0,
        mix,
        nullptr);
    CoTaskMemFree(mix);
    if (FAILED(hr) || src_rate <= 0 || src_channels <= 0 || (!is_float && !is_pcm16)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    ComPtr<IAudioCaptureClient> capture;
    if (FAILED(client->GetService(IID_PPV_ARGS(&capture))) || !capture) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    if (FAILED(client->Start())) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      continue;
    }

    if (log_) {
      log_("WASAPI loopback audio active (" + std::to_string(src_rate) + " Hz, " +
           std::to_string(src_channels) + " ch -> 48000 Hz stereo PCM16)");
    }

    accum.clear();
    resample_phase = 0.0;
    const double step = static_cast<double>(src_rate) / static_cast<double>(kTargetRate);

    while (running_.load()) {
      UINT32 next_frames = 0;
      hr = capture->GetNextPacketSize(&next_frames);
      if (FAILED(hr)) break;

      if (next_frames == 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        continue;
      }

      while (next_frames > 0 && running_.load()) {
        BYTE* data = nullptr;
        UINT32 num_frames = 0;
        DWORD flags = 0;
        hr = capture->GetBuffer(&data, &num_frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;

        if (num_frames > 0) {
          bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || !data;
          // Extract stereo float frames from source layout.
          std::vector<float> stereo(static_cast<size_t>(num_frames) * 2, 0.0f);
          if (!silent) {
            for (UINT32 i = 0; i < num_frames; ++i) {
              float l = 0.0f, r = 0.0f;
              if (is_float) {
                const float* f = reinterpret_cast<const float*>(data) + static_cast<size_t>(i) * src_channels;
                l = f[0];
                r = src_channels >= 2 ? f[1] : f[0];
              } else {
                const int16_t* s = reinterpret_cast<const int16_t*>(data) + static_cast<size_t>(i) * src_channels;
                l = static_cast<float>(s[0]) / 32768.0f;
                r = static_cast<float>(src_channels >= 2 ? s[1] : s[0]) / 32768.0f;
              }
              stereo[static_cast<size_t>(i) * 2] = l;
              stereo[static_cast<size_t>(i) * 2 + 1] = r;
            }
          }

          if (src_rate == kTargetRate) {
            for (size_t i = 0; i < stereo.size(); ++i) accum.push_back(FloatToPcm16(stereo[i]));
          } else {
            // Linear resampling to 48 kHz.
            double pos = resample_phase;
            double max_pos = static_cast<double>(num_frames);
            while (pos < max_pos) {
              size_t idx0 = static_cast<size_t>(pos);
              size_t idx1 = std::min<size_t>(idx0 + 1, static_cast<size_t>(num_frames) - 1);
              float frac = static_cast<float>(pos - static_cast<double>(idx0));
              float l = stereo[idx0 * 2] * (1.0f - frac) + stereo[idx1 * 2] * frac;
              float r = stereo[idx0 * 2 + 1] * (1.0f - frac) + stereo[idx1 * 2 + 1] * frac;
              accum.push_back(FloatToPcm16(l));
              accum.push_back(FloatToPcm16(r));
              pos += step;
            }
            resample_phase = pos - max_pos;
          }

          while (accum.size() >= kFrameSamples * kTargetChannels) {
            uint32_t ts_ms = static_cast<uint32_t>(NowMillis() & 0xFFFFFFFFu);
            packet[0] = kAudioVersion;
            packet[1] = kAudioCodecPcm16;
            packet[2] = static_cast<uint8_t>((seq >> 8) & 0xFF);
            packet[3] = static_cast<uint8_t>(seq & 0xFF);
            packet[4] = static_cast<uint8_t>((ts_ms >> 24) & 0xFF);
            packet[5] = static_cast<uint8_t>((ts_ms >> 16) & 0xFF);
            packet[6] = static_cast<uint8_t>((ts_ms >> 8) & 0xFF);
            packet[7] = static_cast<uint8_t>(ts_ms & 0xFF);
            std::memcpy(packet.data() + kHeaderBytes, accum.data(), kFramePcmBytes);
            seq += 1;
            accum.erase(accum.begin(), accum.begin() + kFrameSamples * kTargetChannels);
            if (on_packet_) on_packet_(packet.data(), packet.size());
          }
        }

        capture->ReleaseBuffer(num_frames);
        hr = capture->GetNextPacketSize(&next_frames);
        if (FAILED(hr)) break;
      }

      if (hr == AUDCLNT_E_DEVICE_INVALIDATED) break;
    }

    client->Stop();
    if (running_.load()) std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }

  if (uninit) CoUninitialize();
}

}  // namespace linkshell
