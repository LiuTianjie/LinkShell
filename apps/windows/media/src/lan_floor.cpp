#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>

#include "lan_floor.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <sstream>
#include <vector>

namespace linkshell {

namespace {
std::string ToLower(std::string s) {
  for (char& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

bool ContainsAsciiI(const std::string& haystack, const char* needle) {
  return ToLower(haystack).find(ToLower(needle)) != std::string::npos;
}

bool IsTailscaleCgnatIpv4(const std::string& addr) {
  int a = -1, b = -1, c = -1, d = -1;
  if (std::sscanf(addr.c_str(), "%d.%d.%d.%d", &a, &b, &c, &d) != 4) return false;
  return a == 100 && b >= 64 && b <= 127 && c >= 0 && c <= 255 && d >= 0 && d <= 255;
}

bool IsAlwaysUselessHostIp(const std::string& lower_ip) {
  if (lower_ip.empty()) return false;
  if (lower_ip == "::1" || lower_ip.rfind("fe80:", 0) == 0) return true;
  if (lower_ip.rfind("127.", 0) == 0 || lower_ip.rfind("169.254.", 0) == 0) return true;
  return false;
}

bool IsVirtualAdapter(const IP_ADAPTER_ADDRESSES* aa) {
  if (!aa) return true;
  if (aa->OperStatus != IfOperStatusUp) return true;
  if (aa->IfType == IF_TYPE_SOFTWARE_LOOPBACK || aa->IfType == IF_TYPE_TUNNEL) return true;
  // An adapter with a default gateway is a real routable LAN/WAN interface (e.g. Azure/Hyper-V/
  // VMware/Parallels VMs or a Hyper-V External Virtual Switch bridging the primary NIC).
  if (aa->FirstGatewayAddress != nullptr) return false;
  std::string friendly = aa->FriendlyName ? WideToUtf8(aa->FriendlyName) : "";
  std::string desc = aa->Description ? WideToUtf8(aa->Description) : "";
  static constexpr const char* kVirtualPatterns[] = {
      "vethernet",
      "hyper-v",
      "wsl",
      "docker",
      "vmware",
      "virtualbox",
      "vbox",
      "loopback",
      "bluetooth",
      "wi-fi direct",
      "teredo",
      "isatap",
      "npcap",
      "km-test",
  };
  for (const char* pat : kVirtualPatterns) {
    if (ContainsAsciiI(friendly, pat) || ContainsAsciiI(desc, pat)) return true;
  }
  // Chinese/English Windows Bluetooth and Wi-Fi Direct virtual adapters ("蓝牙网络连接", "本地连接* 9", "Local Area Connection* 9").
  if (friendly.find("\xe8\x93\x9d\xe7\x89\x99") != std::string::npos) return true;  // 蓝牙
  if (friendly.find("\xe6\x9c\xac\xe5\x9c\xb0\xe8\xbf\x9e\xe6\x8e\xa5*") != std::string::npos) return true;  // 本地连接*
  if (ContainsAsciiI(friendly, "local area connection*")) return true;
  return false;
}

std::string CandidateHostAddress(const std::string& sdp) {
  // Format: [a=]candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> ...
  std::istringstream iss(sdp);
  std::string tok;
  std::vector<std::string> fields;
  while (iss >> tok && fields.size() < 8) fields.push_back(std::move(tok));
  if (fields.size() < 8) return {};
  if (ToLower(fields[6]) != "typ" || ToLower(fields[7]) != "host") return {};
  return ToLower(fields[4]);
}
}  // namespace

std::unordered_set<std::string> CollectUselessHostAddresses() {
  std::unordered_set<std::string> out;
  ULONG buf_len = 32 * 1024;
  std::vector<uint8_t> buf(buf_len);
  ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_INCLUDE_GATEWAYS;
  ULONG res = GetAdaptersAddresses(AF_UNSPEC, flags, nullptr, reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buf.data()), &buf_len);
  if (res == ERROR_BUFFER_OVERFLOW && buf_len > 0 && buf_len <= 4 * 1024 * 1024) {
    buf.resize(buf_len);
    res = GetAdaptersAddresses(AF_UNSPEC, flags, nullptr, reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buf.data()), &buf_len);
  }
  if (res != ERROR_SUCCESS) return out;

  bool has_real_adapter = false;
  for (auto* aa = reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buf.data()); aa; aa = aa->Next) {
    if (IsVirtualAdapter(aa)) continue;
    for (auto* ua = aa->FirstUnicastAddress; ua; ua = ua->Next) {
      if (!ua->Address.lpSockaddr) continue;
      char ip_buf[INET6_ADDRSTRLEN] = {};
      if (ua->Address.lpSockaddr->sa_family == AF_INET) {
        auto* sin = reinterpret_cast<const sockaddr_in*>(ua->Address.lpSockaddr);
        if (inet_ntop(AF_INET, &sin->sin_addr, ip_buf, sizeof(ip_buf)) && !IsAlwaysUselessHostIp(ToLower(ip_buf))) {
          has_real_adapter = true;
        }
      } else if (ua->Address.lpSockaddr->sa_family == AF_INET6) {
        auto* sin6 = reinterpret_cast<const sockaddr_in6*>(ua->Address.lpSockaddr);
        if (inet_ntop(AF_INET6, &sin6->sin6_addr, ip_buf, sizeof(ip_buf)) && !IsAlwaysUselessHostIp(ToLower(ip_buf))) {
          has_real_adapter = true;
        }
      }
    }
  }
  // Never drop virtual adapter IPs if no non-virtual adapter has a usable address (e.g. isolated VM).
  if (!has_real_adapter) return out;

  for (auto* aa = reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buf.data()); aa; aa = aa->Next) {
    if (!IsVirtualAdapter(aa)) continue;
    for (auto* ua = aa->FirstUnicastAddress; ua; ua = ua->Next) {
      if (!ua->Address.lpSockaddr) continue;
      char ip_buf[INET6_ADDRSTRLEN] = {};
      if (ua->Address.lpSockaddr->sa_family == AF_INET) {
        auto* sin = reinterpret_cast<const sockaddr_in*>(ua->Address.lpSockaddr);
        if (inet_ntop(AF_INET, &sin->sin_addr, ip_buf, sizeof(ip_buf))) {
          std::string ip = ToLower(ip_buf);
          // Keep Tailscale CGNAT (100.64.0.0/10) even though it rides a tunnel adapter.
          if (IsTailscaleCgnatIpv4(ip)) continue;
          out.insert(std::move(ip));
        }
      } else if (ua->Address.lpSockaddr->sa_family == AF_INET6) {
        auto* sin6 = reinterpret_cast<const sockaddr_in6*>(ua->Address.lpSockaddr);
        if (inet_ntop(AF_INET6, &sin6->sin6_addr, ip_buf, sizeof(ip_buf))) {
          out.insert(ToLower(ip_buf));
        }
      }
    }
  }
  return out;
}

bool IsUselessHostCandidate(
    const std::string& candidate_sdp,
    const std::unordered_set<std::string>& useless_ips) {
  std::string ip = CandidateHostAddress(candidate_sdp);
  if (ip.empty()) return false;
  if (IsAlwaysUselessHostIp(ip)) return true;
  return useless_ips.find(ip) != useless_ips.end();
}

bool LanFloor::IsLocal(const std::optional<Endpoint>& ep) {
  if (!ep) return false;
  if (ep->type != "host" && ep->type != "prflx") return false;
  std::string addr = ToLower(ep->address);
  if (addr.size() >= 6 && addr.compare(addr.size() - 6, 6, ".local") == 0) return true;
  if (addr.find(':') != std::string::npos) {
    return addr == "::1" || addr.rfind("fe8", 0) == 0 || addr.rfind("fe9", 0) == 0 ||
           addr.rfind("fea", 0) == 0 || addr.rfind("feb", 0) == 0 ||
           addr.rfind("fc", 0) == 0 || addr.rfind("fd", 0) == 0;
  }
  int a = -1, b = -1, c = -1, d = -1;
  if (std::sscanf(addr.c_str(), "%d.%d.%d.%d", &a, &b, &c, &d) != 4) return false;
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) return false;
  if (a == 10 || a == 127) return true;
  if (a == 192 && b == 168) return true;
  if (a == 169 && b == 254) return true;
  if (a == 172 && b >= 16 && b <= 31) return true;
  return false;
}

std::string LanFloor::Describe(const Endpoint& local, const Endpoint& remote) {
  std::string kind = (IsLocal(local) && IsLocal(remote))
                         ? "over the local network"
                         : ((local.type == "relay" || remote.type == "relay") ? "through a TURN relay" : "across the internet");
  return kind + " (" + local.type + " -> " + remote.type + ")";
}

LanFloor::Action LanFloor::Judge(const Second& second, int ceiling_bps) {
  if (second.rtt_ms && std::isfinite(*second.rtt_ms) && *second.rtt_ms >= 0.0) {
    rtts_.push_back(*second.rtt_ms);
    while (static_cast<int>(rtts_.size()) > tuning::kLanFloorWindow) rtts_.pop_front();
  }
  bool local = IsLocal(second.local) && IsLocal(second.remote);
  double lost = second.fraction_lost.value_or(0.0);
  double waited = second.send_delay_ms.value_or(0.0);

  if (floor_) {
    held_ += 1;
    if (!local) return Lift("the media left the local network");
    if (lost > tuning::kLanFloorLiftLoss) {
      char buf[96];
      std::snprintf(buf, sizeof(buf), "%.0f%% of packets were lost", lost * 100.0);
      return Lift(buf);
    }
    queued_ = (held_ > tuning::kLanFloorSettle && waited > tuning::kLanFloorLiftSendDelayMs) ? (queued_ + 1) : 0;
    if (queued_ >= tuning::kLanFloorLiftSendDelaySeconds) {
      char buf[128];
      std::snprintf(buf, sizeof(buf), "packets waited %.0f ms to be sent, for %d s running", waited, queued_);
      return Lift(buf);
    }
    if (held_ > tuning::kLanFloorSettle && static_cast<int>(rtts_.size()) >= tuning::kLanFloorWindow) {
      double lowest = *std::min_element(rtts_.begin(), rtts_.end());
      if (lowest > tuning::kLanFloorLiftRttMs) {
        char buf[96];
        std::snprintf(buf, sizeof(buf), "the round trip stayed above %.0f ms", lowest);
        return Lift(buf);
      }
    }
    int wanted = std::min(tuning::kLanFloorBps, ceiling_bps);
    if (wanted != *floor_) {
      floor_ = wanted;
      return {ActionKind::kApply, wanted, {}};
    }
    return {ActionKind::kKeep, 0, {}};
  }

  if (lifts_ >= tuning::kLanFloorMaxLifts) return {ActionKind::kKeep, 0, {}};
  bool quiet = local && lost < tuning::kLanFloorLoss && waited <= tuning::kLanFloorSendDelayMs &&
               static_cast<int>(rtts_.size()) >= tuning::kLanFloorWindow &&
               (*std::min_element(rtts_.begin(), rtts_.end()) < tuning::kLanFloorRttMs);
  calm_ = quiet ? (calm_ + 1) : 0;
  if (calm_ < (lifts_ == 0 ? 1 : tuning::kLanFloorRecalm)) return {ActionKind::kKeep, 0, {}};

  int wanted = std::min(tuning::kLanFloorBps, ceiling_bps);
  floor_ = wanted;
  held_ = 0;
  queued_ = 0;
  return {ActionKind::kApply, wanted, {}};
}

LanFloor::Action LanFloor::Lift(std::string reason) {
  floor_.reset();
  rtts_.clear();
  calm_ = 0;
  held_ = 0;
  queued_ = 0;
  lifts_ += 1;
  return {ActionKind::kLift, 0, std::move(reason)};
}

// ── FrameRateController ─────────────────────────────────────────────────────

FrameRateController::FrameRateController(int full, int reduced, int lowest)
    : full_(full), reduced_(reduced), lowest_(lowest), current_(full) {}

FrameRateController::Verdict FrameRateController::Judge(const Second& second) {
  if (since_raised_) *since_raised_ += 1;
  if (settling_ > 0) {
    settling_ -= 1;
    return {VerdictKind::kKeep, current_, {}};
  }
  if (current_ > lowest_ && Trouble(second).has_value()) {
    return JudgeFull(second);
  }
  troubled_ = 0;
  return current_ < full_ ? JudgeReduced(second) : Verdict{VerdictKind::kKeep, current_, {}};
}

FrameRateController::Verdict FrameRateController::JudgeFull(const Second& second) {
  calm_ = 0;
  auto trouble = Trouble(second);
  if (!trouble) {
    troubled_ = 0;
    return {VerdictKind::kKeep, current_, {}};
  }
  troubled_ += 1;
  if (troubled_ < tuning::kFrameRateDownAfter) return {VerdictKind::kKeep, current_, {}};
  std::string cause;
  if (second.limitation && *second.limitation != "none" && !second.limitation->empty()) {
    cause = " (" + *second.limitation + ")";
  }
  std::string reason = *trouble + " for " + std::to_string(troubled_) + " s" + cause;
  if (since_raised_ && *since_raised_ < tuning::kFrameRateHeld) {
    wait_ = std::min(wait_ * 2, tuning::kFrameRateCalmMax);
  }
  since_raised_.reset();
  calm_ = 0;
  int next = current_ > reduced_ ? reduced_ : lowest_;
  Change(next);
  return {VerdictKind::kDown, next, std::move(reason)};
}

FrameRateController::Verdict FrameRateController::JudgeReduced(const Second& second) {
  if (!Healthy(second)) {
    calm_ = 0;
    return {VerdictKind::kKeep, current_, {}};
  }
  calm_ += 1;
  if (calm_ < wait_) return {VerdictKind::kKeep, current_, {}};
  std::string reason = "the whole picture and a drained send queue held for " + std::to_string(calm_) + " s; trying the next frame rate";
  since_raised_ = 0;
  int next = NextHigher();
  Change(next);
  return {VerdictKind::kUp, next, std::move(reason)};
}

void FrameRateController::Change(int rate) {
  current_ = rate;
  settling_ = tuning::kFrameRateSettle;
  troubled_ = 0;
  calm_ = 0;
}

std::optional<std::string> FrameRateController::Trouble(const Second& second) const {
  if (second.sent_share && *second.sent_share < tuning::kFrameRateShrunk) {
    return "the picture was being shrunk";
  }
  if (second.encoded && Dropping(*second.encoded, second.captured, current_)) {
    char buf[96];
    std::snprintf(buf, sizeof(buf), "only %.0f of %.0f frames a second were sent",
                  *second.encoded, std::min(second.captured, static_cast<double>(current_)));
    return std::string(buf);
  }
  if (second.captured >= static_cast<double>(current_) * tuning::kFrameRateBusy &&
      second.send_delay_ms && std::isfinite(*second.send_delay_ms) &&
      *second.send_delay_ms > tuning::kFrameRateQueueSlowMs) {
    char buf[96];
    std::snprintf(buf, sizeof(buf), "packets waited %.0f ms before being sent", *second.send_delay_ms);
    return std::string(buf);
  }
  return std::nullopt;
}

bool FrameRateController::Healthy(const Second& second) const {
  if (!second.sent_share || *second.sent_share < tuning::kFrameRateShrunk) return false;
  if (!second.limitation || *second.limitation != "none") return false;
  if (!second.send_delay_ms || !std::isfinite(*second.send_delay_ms) ||
      *second.send_delay_ms < 0.0 || *second.send_delay_ms > tuning::kFrameRateQueueCalmMs) {
    return false;
  }
  if (!second.encoded || *second.encoded <= 0.0) return false;
  if (Dropping(*second.encoded, second.captured, current_)) return false;
  return true;
}

bool FrameRateController::Dropping(double encoded, double captured, int rate) const {
  return captured >= static_cast<double>(rate) * tuning::kFrameRateBusy &&
         encoded < std::min(captured, static_cast<double>(rate)) * tuning::kFrameRateCarried;
}

// ── SendQueue ───────────────────────────────────────────────────────────────

void SendQueue::SetEncoderRate(double encoder_rate_bps, double now_sec) {
  Drain(now_sec);
  rate_ = std::max(encoder_rate_bps, static_cast<double>(tuning::kSendQueueLowestRateBps)) * tuning::kPacerFactor;
}

void SendQueue::Made(size_t bytes, double now_sec) {
  Drain(now_sec);
  bits_ += static_cast<double>(bytes * 8);
}

double SendQueue::WaitSeconds(double now_sec) {
  Drain(now_sec);
  return rate_ > 0.0 ? (bits_ / rate_) : 0.0;
}

void SendQueue::Reset() {
  bits_ = 0.0;
  at_.reset();
}

void SendQueue::Drain(double now_sec) {
  if (at_ && now_sec > *at_) {
    bits_ = std::max(0.0, bits_ - (now_sec - *at_) * rate_);
  }
  at_ = now_sec;
}

}  // namespace linkshell
