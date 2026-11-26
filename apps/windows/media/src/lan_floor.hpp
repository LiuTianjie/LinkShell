#pragma once

#include <deque>
#include <optional>
#include <string>

#include "common.hpp"

namespace linkshell {

// Exact port of apps/mac/Sources/LinkShell/LanFloor.swift.
class LanFloor {
 public:
  struct Endpoint {
    std::string type;     // "host", "prflx", "srflx", "relay"
    std::string address;
  };

  struct Second {
    std::optional<Endpoint> local;
    std::optional<Endpoint> remote;
    std::optional<double> rtt_ms;
    std::optional<double> fraction_lost;
    std::optional<double> send_delay_ms;
  };

  enum class ActionKind { kKeep, kApply, kLift };
  struct Action {
    ActionKind kind = ActionKind::kKeep;
    int floor_bps = 0;
    std::string reason;
  };

  Action Judge(const Second& second, int ceiling_bps);
  std::optional<int> current_floor() const { return floor_; }
  int lifts() const { return lifts_; }

  static bool IsLocal(const std::optional<Endpoint>& ep);
  static std::string Describe(const Endpoint& local, const Endpoint& remote);

 private:
  Action Lift(std::string reason);

  std::optional<int> floor_;
  std::deque<double> rtts_;
  int calm_ = 0;
  int lifts_ = 0;
  int held_ = 0;
  int queued_ = 0;
};

// Exact port of apps/mac/Sources/LinkShell/FrameRate.swift.
class FrameRateController {
 public:
  struct Second {
    double captured = 0.0;
    std::optional<double> encoded;
    std::optional<double> sent_share;
    std::optional<std::string> limitation;
    std::optional<double> available;
    std::optional<double> send_delay_ms;
  };

  enum class VerdictKind { kKeep, kDown, kUp };
  struct Verdict {
    VerdictKind kind = VerdictKind::kKeep;
    int next_rate = 0;
    std::string reason;
  };

  FrameRateController(int full, int reduced, int lowest);

  int current() const { return current_; }
  int full() const { return full_; }
  int reduced() const { return reduced_; }
  int lowest() const { return lowest_; }

  Verdict Judge(const Second& second);

 private:
  Verdict JudgeFull(const Second& second);
  Verdict JudgeReduced(const Second& second);
  void Change(int rate);
  std::optional<std::string> Trouble(const Second& second) const;
  bool Healthy(const Second& second) const;
  bool Dropping(double encoded, double captured, int rate) const;
  int NextHigher() const { return current_ < reduced_ ? reduced_ : full_; }

  int full_;
  int reduced_;
  int lowest_;
  int current_;
  int settling_ = tuning::kFrameRateSettle;
  int troubled_ = 0;
  int calm_ = 0;
  int wait_ = tuning::kFrameRateCalm;
  std::optional<int> since_raised_;
};

// Exact port of apps/mac/Sources/LinkShell/SendQueue.swift.
class SendQueue {
 public:
  void SetEncoderRate(double encoder_rate_bps, double now_sec);
  void Made(size_t bytes, double now_sec);
  double WaitSeconds(double now_sec);
  void Reset();

 private:
  void Drain(double now_sec);

  double rate_ = static_cast<double>(tuning::kStartBitrateBps) * tuning::kPacerFactor;
  double bits_ = 0.0;
  std::optional<double> at_;
};

}  // namespace linkshell
