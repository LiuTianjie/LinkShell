#pragma once

#include <windows.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <iostream>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "json.hpp"

namespace linkshell {

using json = nlohmann::json;

// Exact parity with apps/mac/Sources/LinkShell/Tuning.swift.
namespace tuning {
inline constexpr int kDefaultMaxWidth = 1920;
inline constexpr int kWidestPicture = 3840;
inline constexpr int kNarrowestPicture = 160;
inline constexpr int kFullFps = 60;
inline constexpr int kReducedFps = 30;
inline constexpr int kMaxFps = 120;
inline constexpr int kMinFps = 1;

inline constexpr int kStartBitrateBps = 6'000'000;
inline constexpr int kRelayDefaultKbps = 3000;

inline constexpr int kLanFloorBps = 16'000'000;
inline constexpr int kLanFloorWindow = 3;
inline constexpr double kLanFloorRttMs = 25.0;
inline constexpr double kLanFloorLiftRttMs = 65.0;
inline constexpr double kLanFloorLoss = 0.01;
inline constexpr double kLanFloorLiftLoss = 0.05;
inline constexpr double kLanFloorSendDelayMs = 10.0;
inline constexpr double kLanFloorLiftSendDelayMs = 50.0;
inline constexpr int kLanFloorSettle = 5;
inline constexpr int kLanFloorLiftSendDelaySeconds = 3;
inline constexpr int kLanFloorRecalm = 20;
inline constexpr int kLanFloorMaxLifts = 6;

inline constexpr int kIceRestartAfterSeconds = 8;
inline constexpr int kIceRestartLimit = 2;

inline constexpr int kFrameRateSettle = 4;
inline constexpr int kFrameRateDownAfter = 3;
inline constexpr double kFrameRateShrunk = 0.9;
inline constexpr double kFrameRateBusy = 0.8;
inline constexpr double kFrameRateCarried = 0.75;
inline constexpr double kFrameRateQueueSlowMs = 50.0;
inline constexpr double kFrameRateQueueCalmMs = 10.0;
inline constexpr int kFrameRateCalm = 10;
inline constexpr int kFrameRateCalmMax = 160;
inline constexpr int kFrameRateHeld = 30;
inline constexpr double kFrameRateEase = 0.5;
inline constexpr int kFrameRateEaseFloorBps = 1'000'000;

inline constexpr double kPacerFactor = 2.5;
inline constexpr double kKeyFrameSendSeconds = 0.16;
inline constexpr double kSendQueueAdmitMs = 75.0;
inline constexpr int kSendQueueMaxConsecutiveSkips = 2;
inline constexpr int kSendQueueLowestRateBps = 300'000;

inline constexpr int kSettleRepeatMs = 100;
inline constexpr int kSettleWindowMs = 1000;
inline constexpr int kIdleRepeatMs = 250;

inline constexpr int kCursorIntervalMs = 8;   // ~120 Hz for ProMotion / high-refresh receivers
inline constexpr int kShapeIntervalMs = 200;  // 5 Hz
inline constexpr size_t kMaxEventBytes = 64'000;

inline int FullRate(int viewer_max_fps, int display_hz) {
  int maximum = std::min(viewer_max_fps, display_hz > 0 ? display_hz : 60);
  if (maximum >= 120) return 120;
  if (maximum >= 60) return 60;
  return std::max(1, std::min(30, maximum));
}

inline int MaxBitrateBps(int width, int height, int fps) {
  double pixels = static_cast<double>(std::max(1, width) * std::max(1, height)) / (1920.0 * 1080.0);
  double frame_factor = fps > 60 ? 1.6 * static_cast<double>(fps) / 60.0 : (fps > 30 ? 1.6 : 1.0);
  double scaled = pixels > 1.0 ? std::sqrt(pixels) : pixels;
  double rate = 10'000'000.0 * scaled * frame_factor;
  if (rate < 2'000'000.0) rate = 2'000'000.0;
  if (rate > 50'000'000.0) rate = 50'000'000.0;
  return static_cast<int>(rate);
}

inline int KeyFrameBudgetBytes(int bitrate_bps) {
  double bytes = static_cast<double>(std::max(bitrate_bps, kSendQueueLowestRateBps)) *
                 kPacerFactor * kKeyFrameSendSeconds / 8.0;
  return std::max(1024, static_cast<int>(bytes));
}
}  // namespace tuning

inline double NowSeconds() {
  using clock = std::chrono::steady_clock;
  static const auto kStart = clock::now();
  return std::chrono::duration<double>(clock::now() - kStart).count();
}

inline int64_t NowMicros() {
  using clock = std::chrono::steady_clock;
  static const auto kStart = clock::now();
  return std::chrono::duration_cast<std::chrono::microseconds>(clock::now() - kStart).count();
}

inline int64_t NowMillis() {
  return NowMicros() / 1000;
}

inline std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  int needed = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return {};
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), needed, nullptr, nullptr);
  return out;
}

inline std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return {};
  int needed = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (needed <= 0) return {};
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), needed);
  return out;
}

inline std::string Base64Encode(const uint8_t* data, size_t len) {
  static constexpr char kTable[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = static_cast<uint32_t>(data[i]) << 16;
    if (i + 1 < len) v |= static_cast<uint32_t>(data[i + 1]) << 8;
    if (i + 2 < len) v |= static_cast<uint32_t>(data[i + 2]);
    out.push_back(kTable[(v >> 18) & 0x3F]);
    out.push_back(kTable[(v >> 12) & 0x3F]);
    out.push_back(i + 1 < len ? kTable[(v >> 6) & 0x3F] : '=');
    out.push_back(i + 2 < len ? kTable[v & 0x3F] : '=');
  }
  return out;
}

class IpcChannel {
 public:
  void Emit(const json& message) {
    std::string line = message.dump(-1, ' ', false, json::error_handler_t::replace);
    line.push_back('\n');
    std::lock_guard<std::mutex> lock(mu_);
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fflush(stdout);
  }

  void Log(const std::string& msg) {
    Emit({{"t", "log"}, {"message", msg.size() > 2000 ? msg.substr(0, 2000) : msg}});
  }

 private:
  std::mutex mu_;
};

// Keep the Windows display awake while a viewer is actively watching (RAII).
class AwakeGuard {
 public:
  AwakeGuard() {
    SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
  }
  ~AwakeGuard() {
    SetThreadExecutionState(ES_CONTINUOUS);
  }
  AwakeGuard(const AwakeGuard&) = delete;
  AwakeGuard& operator=(const AwakeGuard&) = delete;
};

}  // namespace linkshell
