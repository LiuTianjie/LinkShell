import Foundation
import WebRTC

/// libwebrtc, set up once for the life of the app.
enum Engine {
  /// Off (`--no-playout-delay`) only to measure what the extension is worth.
  static var playoutDelay = true

  /// H.264 from this app's own low-latency encoder (`LowLatencyH264Encoder`) or from libwebrtc's
  /// (`--encoder own|stock`).
  static var ownEncoder = false

  /// While this is set the track's encoder gives libwebrtc no quantizers to resize the picture
  /// by (`ScreenEncoderFactory.scaling`). libwebrtc looks at every frame: it stops resizing, and
  /// what it had taken off the picture is given back at once
  /// (video_stream_encoder_resource_manager.cc, `UpdateQualityScalerSettings`); when this is
  /// cleared it starts again, from the whole picture. Set by the one video session there is.
  static let wholePicture = Locked(false)

  /// Where the engine says what the host should know (its log).
  static var report: (String) -> Void = { _ in }

  static let factory: RTCPeerConnectionFactory = {
    // M154 has no way to hand field trials to the factory from Objective-C: its environment is
    // made with none, which falls back to this global string (environment_factory.cc). Hence the
    // deprecated call; it has to come before anything else in the library.
    var trials = Tuning.fieldTrials
    if !playoutDelay { trials["WebRTC-ForceSendPlayoutDelay"] = nil }
    // `--trial Name=value`, to try one out.
    for trial in Launch.values(after: "--trial") {
      let parts = trial.split(separator: "=", maxSplits: 1).map(String.init)
      if parts.count == 2 { trials[parts[0]] = parts[1] }
    }
    initFieldTrials(trials)
    RTCInitializeSSL()
    // VideoToolbox for H.264; the software codecs are there for a viewer without it.
    return RTCPeerConnectionFactory(encoderFactory: ScreenEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
  }()

  private static func initFieldTrials(_ trials: [String: String]) {
    // Through a protocol, so that the one deprecated call doesn't warn at every build.
    (Trials() as FieldTrialSetting).set(trials)
  }

  private struct Trials: FieldTrialSetting {
    @available(*, deprecated)
    func set(_ trials: [String: String]) {
      RTCInitFieldTrialDictionary(trials)
    }
  }

  /// libwebrtc's own log, into the host's (`--rtc-log`).
  private static var logger: RTCCallbackLogger?

  static func forwardLog(to link: Link) {
    let logger = RTCCallbackLogger()
    logger.severity = .info
    logger.start { message in
      link.log("rtc: " + message.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    self.logger = logger
  }
}

/// The codecs a transceiver offers, with the one asked for first.
enum Codecs {
  /// H.264 high profile before baseline, then whatever else can be sent; the entries that aren't
  /// pictures (retransmission, FEC) keep their place at the end.
  static func preferences(_ wanted: String, from capabilities: [RTCRtpCodecCapability]) -> (codecs: [RTCRtpCodecCapability], found: Bool) {
    let name = wanted == "hevc" ? "H265" : "H264"
    func rank(_ codec: RTCRtpCodecCapability) -> Int {
      let upper = codec.name.uppercased()
      if ["RTX", "RED", "ULPFEC", "FLEXFEC-03"].contains(upper) { return 9 }
      if upper == name { return (codec.parameters["profile-level-id"] ?? "").lowercased().hasPrefix("64") ? 0 : 1 }
      if upper == "H264" { return (codec.parameters["profile-level-id"] ?? "").lowercased().hasPrefix("64") ? 2 : 3 }
      return 4
    }
    let ordered = capabilities.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
    return (ordered, capabilities.contains { $0.name.uppercased() == name })
  }
}

private protocol FieldTrialSetting {
  func set(_ trials: [String: String])
}
