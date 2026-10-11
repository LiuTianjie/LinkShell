import Foundation

/// Which frame rate a video session runs at: the full one while the network and this Mac
/// carry it, the reduced one while they don't.
///
/// Text with half the frames and all its pixels reads better than text with all the frames and
/// half its pixels, so a network that doesn't carry the full rate costs frames, not pixels: the
/// encoder gives libwebrtc no quantizers to shrink the picture by (`ScreenEncoderFactory.scaling`).
/// A low bandwidth estimate alone doesn't say that this particular picture is too expensive.
/// What ends the full rate is a smaller picture, missing encoder output under active capture,
/// or packets persistently waiting to be sent. Packets being lost or a single frame taking a
/// long time are not enough: the consequences for delivered pictures are what matter.
///
/// A whole picture and a drained send queue permit a trial of the next rate. The trial doesn't
/// reserve a fraction of a worst-case bitrate ceiling: desktop content may fit in much less.
/// The wait doubles when a trial fails soon after, keeping an overloaded path from oscillating.
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
    /// The bandwidth estimate, for diagnostic context only, not a frame-rate threshold.
    var available: Double?
    /// Average RTP packet wait before reaching the network socket, not network RTT.
    var sendDelayMs: Double? = nil
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
  let lowest: Int
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

  init(full: Int = Tuning.fullFps, reduced: Int = Tuning.reducedFps, lowest: Int? = nil) {
    self.full = full
    self.reduced = reduced
    self.lowest = lowest ?? reduced
    current = full
  }

  mutating func judge(_ second: Second) -> Verdict {
    sinceRaised = sinceRaised.map { $0 + 1 }
    guard settling == 0 else {
      settling -= 1
      return .keep
    }
    if current > lowest, trouble(second) != nil { return judgeFull(second) }
    troubled = 0
    return current < full ? judgeReduced(second) : .keep
  }

  private mutating func judgeFull(_ second: Second) -> Verdict {
    calm = 0
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
    calm = 0
    change(to: current > reduced ? reduced : lowest)
    return .down(reason)
  }

  private mutating func judgeReduced(_ second: Second) -> Verdict {
    guard healthy(second) else {
      calm = 0
      return .keep
    }
    calm += 1
    guard calm >= wait else { return .keep }
    let reason = "the whole picture and a drained send queue held for \(calm) s; trying the next frame rate"
    sinceRaised = 0
    change(to: nextHigher)
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
    if let share = second.sentShare, share < Tuning.frameRateShrunk { return "the picture was being shrunk" }
    if let encoded = second.encoded, dropping(encoded, of: second.captured, at: current) {
      return String(format: "only %.0f of %.0f frames a second were sent", encoded, min(second.captured, Double(current)))
    }
    // Reducing a frame-rate ceiling cannot help a quiet screen sending a rare large frame.
    if second.captured >= Double(current) * Tuning.frameRateBusy,
       let delay = second.sendDelayMs, delay.isFinite, delay > Tuning.frameRateQueueSlowMs {
      return String(format: "packets waited %.0f ms before being sent", delay)
    }
    return nil
  }

  /// Positive delivery evidence is required to probe; absent statistics never count as health.
  private func healthy(_ second: Second) -> Bool {
    guard let share = second.sentShare, share >= Tuning.frameRateShrunk, second.limitation == "none",
          let delay = second.sendDelayMs, delay.isFinite, delay >= 0, delay <= Tuning.frameRateQueueCalmMs,
          let encoded = second.encoded, encoded > 0, !dropping(encoded, of: second.captured, at: current) else { return false }
    return true
  }

  private var nextHigher: Int { current < reduced ? reduced : full }

  /// The screen is giving the rate (or near it), and a good part of what it gives is not encoded.
  /// A still screen gives nothing, and says nothing about the rate.
  private func dropping(_ encoded: Double, of captured: Double, at rate: Int) -> Bool {
    captured >= Double(rate) * Tuning.frameRateBusy && encoded < min(captured, Double(rate)) * Tuning.frameRateCarried
  }
}
