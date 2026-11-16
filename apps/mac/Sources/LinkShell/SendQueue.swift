import Foundation

/// What the video track's encoder has made and libwebrtc has not yet put on the network, as far
/// as the encoder can tell.
///
/// libwebrtc's pacer lets packets out at a multiple of the rate it gives the encoder
/// (`Tuning.pacerFactor`), in order. One large frame (a window switched to, a key frame) therefore
/// takes its size over that rate to leave, and every frame made meanwhile waits behind it: on a
/// watched Mac's log, 54–263 ms within seconds of most sessions' start, and up to two seconds
/// where the estimate had fallen. The statistics that say so come once a second, too late to act
/// on, so the queue is reckoned here: bits in as frames come out of the encoder, bits out at the
/// pacer's rate.
///
/// While more than `Tuning.sendQueueAdmitMs` is reckoned to be waiting, a new picture is not
/// encoded at all (`LowLatencyH264Encoder`): it would only wait too, and what the viewer needs
/// next is the screen as it is when the queue has gone. Skipping before the encoder breaks no
/// reference, as dropping a compressed frame would.
///
/// It is an estimate. The pacer may be faster than reckoned (it speeds up for a queue over two
/// seconds, and for probes), never slower by much: so this errs towards skipping a frame too
/// many after a large one, not towards letting the queue stand.
struct SendQueue {
  /// Bits a second the pacer lets out.
  private(set) var rate: Double = Double(Tuning.startBitrate) * Tuning.pacerFactor
  private var bits = 0.0
  private var at: Double?

  /// The rate libwebrtc gave the encoder, bits a second.
  mutating func set(encoderRate: Double, now: Double) {
    drain(to: now)
    rate = max(encoderRate, Double(Tuning.sendQueueLowestRate)) * Tuning.pacerFactor
  }

  /// A frame came out of the encoder.
  mutating func made(bytes: Int, now: Double) {
    drain(to: now)
    bits += Double(bytes * 8)
  }

  /// Seconds the last bit made so far waits before it is sent.
  mutating func wait(now: Double) -> Double {
    drain(to: now)
    return bits / rate
  }

  mutating func reset() {
    bits = 0
    at = nil
  }

  private mutating func drain(to now: Double) {
    if let at, now > at { bits = max(0, bits - (now - at) * rate) }
    at = now
  }
}
