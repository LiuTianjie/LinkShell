#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>

namespace linkshell {

// Native WASAPI Loopback audio capturer -> 48 kHz stereo PCM16 (20 ms frames),
// framed with @linkshell/wire's 8-byte big-endian screen-audio header for the "audio" DataChannel.
class AudioCapturer {
 public:
  using PacketCallback = std::function<void(const uint8_t* data, size_t size)>;
  using LogFn = std::function<void(const std::string&)>;

  AudioCapturer(PacketCallback on_packet, LogFn log = {});
  ~AudioCapturer();

  void Start();
  void Stop();
  bool running() const { return running_.load(); }

 private:
  void RunLoop();

  PacketCallback on_packet_;
  LogFn log_;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

}  // namespace linkshell
