import Foundation
import WebRTC

/// How a receiver paces the picture.
///
/// The sender asks every receiver to show each frame the moment it is decoded (the playout-delay
/// extension at 0/0, `Tuning.fieldTrials`). That is the lowest latency, but every bit of jitter on
/// the way (pacing, the network, a busy decoder) is shown as a stall followed by a jump. A
/// receiver that declines the extension gets libwebrtc's adaptive jitter buffer instead: frames
/// leave it evenly, at the cost of the jitter it has measured.
///
/// Loopback on an M3 Max, 1920×1246 at 120 fps, moving content, 30 s each (2026-11-03):
/// - Clean loopback: at 0/0, 34 waits over 25 ms between decoded frames, glass → decoded p50 13 ms;
///   declined, 8–17 such waits, p50 31 ms.
/// - Through a Wi-Fi-like proxy (`tools/jitter-check.mjs`: radio holds of 40–80 ms about once a
///   second): at 0/0, 72 waits over 25 ms (24 over 50 ms), p50 21 ms; declined, 15 (2), p50 72 ms.
///   The buffer grows to cover the network's pauses: smoother, about +50 ms on Wi-Fi.
/// Capping the delay (`max_ms` 16 or 33) was worse on both. So 0/0 stays the default, as when the
/// video track was first built (Safari's default buffer was ~68 ms); even pacing is a choice for
/// watching rather than controlling.
enum ScreenPacing {
  static let playoutDelayURI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"

  /// Stops negotiating the playout-delay extension on this receiving transceiver. Call after the
  /// offer is set and before the answer is made. Returns whether the extension was offered.
  @discardableResult
  static func declinePlayoutDelay(_ transceiver: RTCRtpTransceiver) -> Bool {
    let extensions = transceiver.headerExtensionsToNegotiate
    guard let offered = extensions.first(where: { $0.uri == playoutDelayURI }), offered.direction != .stopped else { return false }
    offered.direction = .stopped
    do { try transceiver.setHeaderExtensionsToNegotiate(extensions) } catch { return false }
    return true
  }
}
