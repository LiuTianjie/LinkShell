import Darwin
import Foundation

/// Two clocks: the host clock (what frames, display links and libwebrtc are stamped with:
/// `mach_absolute_time`, the same as `CACurrentMediaTime`) and the wall clock, which is the only
/// one a phone can be compared against.
enum HostClock {
  private static let timebase: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
  }()

  private static let lock = NSLock()
  private static var offset = measure()
  private static var measuredAt = seconds()

  static func nanoseconds() -> Int64 {
    Int64(clock_gettime_nsec_np(CLOCK_UPTIME_RAW))
  }

  static func seconds() -> Double {
    Double(nanoseconds()) / 1e9
  }

  /// `mach_absolute_time` units (ScreenCaptureKit's displayTime) in seconds.
  static func seconds(mach: UInt64) -> Double {
    Double(mach) * Double(timebase.numer) / Double(timebase.denom) / 1e9
  }

  /// Wall clock minus host clock, from the tightest of a few readings.
  private static func measure() -> Double {
    var best = (width: Double.infinity, offset: 0.0)
    for _ in 0..<5 {
      let before = seconds()
      let wall = Date().timeIntervalSince1970
      let after = seconds()
      if after - before < best.width { best = (after - before, wall - (before + after) / 2) }
    }
    return best.offset
  }

  /// Milliseconds since 1970 of a moment on the host clock. The wall clock is looked at again
  /// every second, so a correction to it (NTP) is followed.
  static func epochMilliseconds(host: Double) -> Double {
    lock.lock()
    defer { lock.unlock() }
    let now = seconds()
    if now - measuredAt > 1 {
      offset = measure()
      measuredAt = now
    }
    return (host + offset) * 1000
  }
}
