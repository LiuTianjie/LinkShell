import Foundation
import WebRTC

/// libwebrtc's own encoders, with its VideoToolbox H.264 encoder given a level that fits the
/// picture.
///
/// Upstream fixes the H.264 level at 3.1 on macOS (RTCH264ProfileLevelId.mm: only iOS looks at
/// the device) and browsers answer with 3.1 too, whatever they can decode. The encoder passes
/// that level to VideoToolbox, and on Apple silicon a session held to 3.1 (1280×720) refuses a
/// 1920×1080 frame with -12902; libwebrtc then drops H.264 for the call and encodes VP8 in
/// software. A browser sending H.264 does what this does: says 3.1 in the SDP and lets the
/// encoder use the level the picture needs.
final class ScreenEncoderFactory: NSObject, RTCVideoEncoderFactory {
  private let standard = RTCDefaultVideoEncoderFactory()

  func supportedCodecs() -> [RTCVideoCodecInfo] {
    standard.supportedCodecs()
  }

  func createEncoder(_ info: RTCVideoCodecInfo) -> RTCVideoEncoder? {
    guard info.name == kRTCVideoCodecH264Name else { return standard.createEncoder(info) }
    return Engine.ownEncoder ? LowLatencyH264Encoder(info: info) : H264ScreenEncoder(info: info)
  }

  /// An encoder's quantizer thresholds as libwebrtc is told them: none while the picture is
  /// being kept whole.
  static func scaling(_ thresholds: RTCVideoEncoderQpThresholds?) -> RTCVideoEncoderQpThresholds? {
    Engine.wholePicture.withLock { $0 } ? nil : thresholds
  }
}

/// H.264's levels: the largest picture (in 16×16 blocks) and the most blocks a second each allows
/// (ITU-T H.264, table A-1), with the byte that names it in a profile-level-id.
enum H264Level {
  private static let table: [(id: UInt8, blocks: Int, blocksPerSecond: Int)] = [
    (0x1f, 3600, 108_000), // 3.1
    (0x20, 5120, 216_000), // 3.2
    (0x28, 8192, 245_760), // 4
    (0x2a, 8704, 522_240), // 4.2
    (0x32, 22080, 589_824), // 5
    (0x33, 36864, 983_040), // 5.1
    (0x34, 36864, 2_073_600), // 5.2
  ]

  /// The lowest level a picture of this size and rate fits in.
  static func fitting(width: Int, height: Int, fps: Int) -> UInt8 {
    let blocks = ((width + 15) / 16) * ((height + 15) / 16)
    return table.first { $0.blocks >= blocks && $0.blocksPerSecond >= blocks * fps }?.id ?? table[table.count - 1].id
  }

  /// A profile-level-id with its level raised to `level`, if it was lower.
  static func raise(_ profileLevelId: String, to level: UInt8) -> String {
    guard profileLevelId.count == 6, let current = UInt8(profileLevelId.suffix(2), radix: 16), current < level else { return profileLevelId }
    return profileLevelId.prefix(4) + String(format: "%02x", level)
  }
}

/// `RTCVideoEncoderH264`, made anew when the size of the picture is known.
final class H264ScreenEncoder: NSObject, RTCVideoEncoder {
  private let info: RTCVideoCodecInfo
  private var encoder: RTCVideoEncoderH264
  private var callback: RTCVideoEncoderCallback?

  init(info: RTCVideoCodecInfo) {
    self.info = info
    encoder = RTCVideoEncoderH264(codecInfo: info)
  }

  func setCallback(_ callback: RTCVideoEncoderCallback?) {
    self.callback = callback
    encoder.setCallback(callback)
  }

  func startEncode(with settings: RTCVideoEncoderSettings, numberOfCores: Int32) -> Int {
    var parameters = info.parameters
    if let id = parameters["profile-level-id"] {
      // For the fastest the track may become: its rate changes (`FrameRate`) without the encoder
      // being started again.
      let level = H264Level.fitting(width: Int(settings.width), height: Int(settings.height), fps: max(Int(settings.maxFramerate), Tuning.fullFps))
      parameters["profile-level-id"] = H264Level.raise(id, to: level)
    }
    _ = encoder.release()
    encoder = RTCVideoEncoderH264(codecInfo: RTCVideoCodecInfo(name: info.name, parameters: parameters))
    encoder.setCallback(callback)
    return encoder.startEncode(with: settings, numberOfCores: numberOfCores)
  }

  func release() -> Int {
    encoder.release()
  }

  func encode(_ frame: RTCVideoFrame, codecSpecificInfo info: RTCCodecSpecificInfo?, frameTypes: [NSNumber]) -> Int {
    encoder.encode(frame, codecSpecificInfo: info, frameTypes: frameTypes)
  }

  func setBitrate(_ bitrateKbit: UInt32, framerate: UInt32) -> Int32 {
    encoder.setBitrate(bitrateKbit, framerate: framerate)
  }

  func implementationName() -> String {
    encoder.implementationName()
  }

  func scalingSettings() -> RTCVideoEncoderQpThresholds? {
    ScreenEncoderFactory.scaling(encoder.scalingSettings())
  }

  var resolutionAlignment: Int { encoder.resolutionAlignment }
  var applyAlignmentToAllSimulcastLayers: Bool { encoder.applyAlignmentToAllSimulcastLayers }
  var supportsNativeHandle: Bool { encoder.supportsNativeHandle }
}
