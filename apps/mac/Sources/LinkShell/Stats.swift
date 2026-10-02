import Foundation
import WebRTC

/// A statistics report (libwebrtc's, as a browser's `getStats`), read the way `rtc.stats` wants its numbers.
struct StatsReader {
  let report: RTCStatisticsReport

  func first(_ type: String, kind: String? = nil) -> RTCStatistics? {
    report.statistics.values.first { $0.type == type && (kind == nil || $0.values["kind"] as? String == kind) }
  }

  func linked(_ from: RTCStatistics?, _ key: String) -> RTCStatistics? {
    (from?.values[key] as? String).flatMap { report.statistics[$0] }
  }

  /// The candidate pair the media is on.
  var pair: RTCStatistics? {
    linked(first("transport"), "selectedCandidatePairId")
  }

  static func number(_ from: RTCStatistics?, _ key: String) -> Double? {
    (from?.values[key] as? NSNumber)?.doubleValue
  }

  static func text(_ from: RTCStatistics?, _ key: String) -> String? {
    from?.values[key] as? String
  }
}

/// A counter that only ever grows, turned into a rate.
struct Rate {
  private var value: Double?
  private var at: Double?

  /// Per second, between this reading and the last; nil for the first.
  mutating func per(second value: Double?, at time: Double) -> Double? {
    defer {
      if let value {
        self.value = value
        at = time
      }
    }
    guard let value, let before = self.value, let at, time > at else { return nil }
    return (value - before) / (time - at)
  }

  /// The change since the last reading.
  mutating func step(_ value: Double?) -> Double? {
    defer { if let value { self.value = value } }
    guard let value, let before = self.value else { return nil }
    return value - before
  }
}

/// A value for JSON: the number or text, or null.
func json(_ value: Double?) -> Any { value.map { $0.isFinite ? ($0 == $0.rounded() ? Int($0) as Any : ($0 * 100).rounded() / 100 as Any) : NSNull() } ?? NSNull() }
func json(_ value: String?) -> Any { value ?? NSNull() }
