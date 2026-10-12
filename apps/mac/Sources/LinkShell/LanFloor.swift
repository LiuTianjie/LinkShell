import Foundation

/// A floor under libwebrtc's bandwidth estimate while the video goes over the local network.
///
/// On a home network the estimate falls far below what the path carries. A still screen sends
/// little, so the estimate has nothing to grow on, and a phone's radio holding packets for a
/// moment (Wi-Fi power save, peer-to-peer Wi-Fi visiting another channel) reads as congestion.
/// On the user's iPhone over Wi-Fi the estimate fell 32 times, to a median of 1.0 Mbit/s, and
/// never came back above 6, where the same sender reaches 35 Mbit/s on loopback: the screen was
/// then encoded for 1 Mbit/s on a link with room for many times that.
///
/// So while both ends are on the local network and the path shows no sign of a standing queue,
/// the estimate is held at or above `Tuning.lanFloor`. A queue that stays (the lowest round trip
/// of the last seconds grows) or loss that appears lifts the floor at once, and from then on the
/// estimate is libwebrtc's alone, as it always is over the internet, where no floor is set.
/// Momentary holds don't lift it: they raise some round trips, not the lowest of several.
struct LanFloor {
  /// One end of the pair the media is on, as libwebrtc's statistics name it.
  struct Endpoint {
    var type: String
    var address: String
  }

  struct Second {
    var local: Endpoint?
    var remote: Endpoint?
    /// Round trip, in milliseconds: the average of the measurements made this second.
    var rttMs: Double?
    /// The share of packets the receiver last said it lost (RTCP), 0…1.
    var fractionLost: Double?
    /// Average time a packet waited in the sender before reaching the network, this second.
    var sendDelayMs: Double? = nil
  }

  enum Action: Equatable {
    case keep
    case apply(Int)
    case lift(String)
  }

  /// The floor in force, bits a second; nil when there is none.
  private(set) var floor: Int?
  private var rtts: [Double] = []
  /// Seconds the path has been calm since the floor was last lifted; and how often it was.
  private var calm = 0
  private(set) var lifts = 0

  /// `ceiling`: the most the encoding may send; the floor is never above it.
  mutating func judge(_ second: Second, ceiling: Int) -> Action {
    if let rtt = second.rttMs, rtt.isFinite, rtt >= 0 {
      rtts.append(rtt)
      if rtts.count > Tuning.lanFloorWindow { rtts.removeFirst(rtts.count - Tuning.lanFloorWindow) }
    }
    let local = Self.isLocal(second.local) && Self.isLocal(second.remote)
    let lost = second.fractionLost ?? 0
    let waited = second.sendDelayMs ?? 0
    if let floor {
      if !local { return lift("the media left the local network") }
      if lost > Tuning.lanFloorLiftLoss { return lift(String(format: "%.0f%% of packets were lost", lost * 100)) }
      // Packets queueing in the sender: the network is not taking what the floor lets out.
      if waited > Tuning.lanFloorLiftSendDelayMs { return lift(String(format: "packets waited %.0f ms to be sent", waited)) }
      if rtts.count >= Tuning.lanFloorWindow, let lowest = rtts.min(), lowest > Tuning.lanFloorLiftRttMs {
        return lift(String(format: "the round trip stayed above %.0f ms", lowest))
      }
      let wanted = min(Tuning.lanFloor, ceiling)
      if wanted != floor {
        self.floor = wanted
        return .apply(wanted)
      }
      return .keep
    }
    // A path that needed the floor lifted twice is left to libwebrtc for the rest of the call.
    guard lifts < Tuning.lanFloorMaxLifts else { return .keep }
    let quiet = local && lost < Tuning.lanFloorLoss && waited <= Tuning.lanFloorSendDelayMs
      && rtts.count >= Tuning.lanFloorWindow && (rtts.suffix(Tuning.lanFloorWindow).min() ?? .infinity) < Tuning.lanFloorRttMs
    calm = quiet ? calm + 1 : 0
    // The first time, a window of calm is enough; after a lift, the path has to prove itself longer.
    guard calm >= (lifts == 0 ? 1 : Tuning.lanFloorRecalm) else { return .keep }
    let wanted = min(Tuning.lanFloor, ceiling)
    floor = wanted
    return .apply(wanted)
  }

  private mutating func lift(_ reason: String) -> Action {
    floor = nil
    rtts.removeAll()
    calm = 0
    lifts += 1
    return .lift(reason)
  }

  /// A host or peer-reflexive candidate on an address that is not on the internet: a private
  /// IPv4 range, loopback, link-local, an IPv6 unique-local address, or an mDNS name (a browser
  /// that hides its address). A server-reflexive or relayed candidate is never local, and
  /// 100.64/10 isn't counted: it is also what carrier-grade NAT and overlay networks use.
  /// The path for the log, by kind only: a candidate's address is the phone's, not the log's.
  static func describe(local: Endpoint, remote: Endpoint) -> String {
    let kind = isLocal(local) && isLocal(remote) ? "over the local network"
      : local.type == "relay" || remote.type == "relay" ? "through a TURN relay"
      : "across the internet"
    return "\(kind) (\(local.type) → \(remote.type))"
  }

  static func isLocal(_ endpoint: Endpoint?) -> Bool {
    guard let endpoint, endpoint.type == "host" || endpoint.type == "prflx" else { return false }
    let address = endpoint.address.lowercased()
    if address.hasSuffix(".local") { return true }
    if address.contains(":") {
      return address == "::1" || address.hasPrefix("fe8") || address.hasPrefix("fe9") || address.hasPrefix("fea")
        || address.hasPrefix("feb") || address.hasPrefix("fc") || address.hasPrefix("fd")
    }
    let parts = address.split(separator: ".").compactMap { Int($0) }
    guard parts.count == 4 else { return false }
    switch (parts[0], parts[1]) {
    case (10, _), (127, _), (192, 168), (169, 254): return true
    case (172, 16...31): return true
    default: return false
    }
  }
}
