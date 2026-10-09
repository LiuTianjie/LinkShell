import Foundation

/// Which of two frame rates a video session runs at: the full one while the network and this Mac
/// carry it, the reduced one while they don't.
///
/// Text with half the frames and all its pixels reads better than text with all the frames and
/// half its pixels, so a network that doesn't carry the full rate costs frames, not pixels: the
/// encoder gives libwebrtc no quantizers to shrink the picture by (`ScreenEncoderFactory.scaling`).
/// What ends the full rate is a bandwidth estimate under `Tuning.frameRateNarrow` of its
/// ceiling, a picture libwebrtc made smaller anyway (on its own account, when even the bits for
/// a smaller one are short), or frames that don't come out of the encoder, for a few seconds
/// running. A session's first estimate is low and climbs: it stays above the narrow line. Packets
/// being lost is not trouble: half the frames lose the same share of theirs. Nor the time the
/// encoder takes over a frame: it is the hardware's own (11 ms here at 30 frames and at 60),
/// and when it is too long frames don't come out, which is counted.
///
/// The way back asks for more and takes longer: nothing limiting the reduced rate, and a
/// bandwidth estimate with room for the full one, for a time that doubles whenever the full rate
/// was tried and lost again soon after (as `Pacer` in the host does with its ladder).
///
/// It is shown one second of the session at a time, in the numbers `rtc.stats` says, and has no
/// clock of its own: its time is the seconds it has been shown. The thresholds are `Tuning`'s.
/// What a change of rate takes besides the rate is `ScreenSession.change`.
struct FrameRate {
  /// One second of a session. What libwebrtc doesn't know yet is nil, and is never held against
  /// the full rate nor counted as room for it.
  struct Second {
    /// New pictures from the screen.
    var captured: Double
    /// Frames out of the encoder.
    var encoded: Double?
    /// The pixels of the picture sent, as a share of the picture captured: below 1 when
    /// libwebrtc has made it smaller.
    var sentShare: Double?
    /// libwebrtc's `qualityLimitationReason`: "none", "bandwidth", "cpu" or "other".
    var limitation: String?
    /// The bandwidth estimate, in bits a second.
    var available: Double?
  }

  enum Verdict: Equatable {
    case keep
    /// To the reduced rate, and why.
    case down(String)
    /// To the full rate, and why.
    case up(String)
  }

  let full: Int
  let reduced: Int
  /// The bandwidth estimate there has to be before the full rate is tried again, in bits a second.
  let room: Double
  /// The estimate below which the network does not carry the full rate, in bits a second.
  let narrow: Double
  /// The rate in force.
  private(set) var current: Int

  /// Seconds still to go by before anything is concluded.
  private var settling = Tuning.frameRateSettle
  /// Seconds running in which the full rate was not carried.
  private var troubled = 0
  /// Seconds running in which there was room for the full rate, and how many it takes.
  private var calm = 0
  private var wait = Tuning.frameRateCalm
  /// Seconds since the full rate was last tried; nil when it has been in force from the start,
  /// or was lost since.
  private var sinceRaised: Int?

  /// `ceiling`: the most the full rate may send, in bits a second (`Tuning.maxBitrate`).
  init(full: Int = Tuning.fullFps, reduced: Int = Tuning.reducedFps, ceiling: Int) {
    self.full = full
    self.reduced = reduced
    room = Double(ceiling) * Tuning.frameRateRoom
    narrow = Double(ceiling) * Tuning.frameRateNarrow
    current = full
  }

  mutating func judge(_ second: Second) -> Verdict {
    sinceRaised = sinceRaised.map { $0 + 1 }
    guard settling == 0 else {
      settling -= 1
      return .keep
    }
    return current == full ? judgeFull(second) : judgeReduced(second)
  }

  private mutating func judgeFull(_ second: Second) -> Verdict {
    guard let trouble = trouble(second) else {
      troubled = 0
      return .keep
    }
    troubled += 1
    guard troubled >= Tuning.frameRateDownAfter else { return .keep }
    let cause = second.limitation.flatMap { $0 == "none" ? nil : " (\($0))" } ?? ""
    let reason = "\(trouble) for \(troubled) s\(cause)"
    // Tried, and lost again this soon: the next try waits twice as long.
    if let sinceRaised, sinceRaised < Tuning.frameRateHeld { wait = min(wait * 2, Tuning.frameRateCalmMax) }
    sinceRaised = nil
    change(to: reduced)
    return .down(reason)
  }

  private mutating func judgeReduced(_ second: Second) -> Verdict {
    guard let available = second.available, hasRoom(second, available) else {
      calm = 0
      return .keep
    }
    calm += 1
    guard calm >= wait else { return .keep }
    let reason = String(format: "nothing limited the picture for \(calm) s, and the network is estimated at %.1f Mbit/s", available / 1e6)
    sinceRaised = 0
    change(to: full)
    return .up(reason)
  }

  private mutating func change(to rate: Int) {
    current = rate
    settling = Tuning.frameRateSettle
    troubled = 0
    calm = 0
  }

  /// What says the full rate is not being carried, if anything does.
  private func trouble(_ second: Second) -> String? {
    if let available = second.available, available < narrow { return String(format: "the network was estimated at %.1f Mbit/s", available / 1e6) }
    if let share = second.sentShare, share < Tuning.frameRateShrunk { return "the picture was being shrunk" }
    if let encoded = second.encoded, dropping(encoded, of: second.captured, at: full) {
      return String(format: "only %.0f of %.0f frames a second were sent", encoded, min(second.captured, Double(full)))
    }
    return nil
  }

  /// The reduced rate whole and unhindered, and an estimate that has the bits for the full one.
  private func hasRoom(_ second: Second, _ available: Double) -> Bool {
    guard let share = second.sentShare, share >= Tuning.frameRateShrunk, second.limitation == "none", available >= room else { return false }
    if let encoded = second.encoded, dropping(encoded, of: second.captured, at: reduced) { return false }
    return true
  }

  /// The screen is giving the rate (or near it), and a good part of what it gives is not encoded.
  /// A still screen gives nothing, and says nothing about the rate.
  private func dropping(_ encoded: Double, of captured: Double, at rate: Int) -> Bool {
    captured >= Double(rate) * Tuning.frameRateBusy && encoded < min(captured, Double(rate)) * Tuning.frameRateCarried
  }
}
