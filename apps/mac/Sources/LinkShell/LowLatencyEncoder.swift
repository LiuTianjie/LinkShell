import CoreMedia
import Foundation
import WebRTC

/// The compression session can fail after it starts; kept separate so that the takeover can
/// be checked without depending on a particular Mac's hardware failing during a test.
protocol ScreenCompression: AnyObject {
  var mode: String { get }
  func setRates(bitrate: Int, ceiling: Int?, fps: Int)
  func encode(_ buffer: CVPixelBuffer, at time: CMTime, key: Bool, done: @escaping (Result<VideoCompressor.Frame?, VideoCompressor.Failure>) -> Void)
}

extension VideoCompressor: ScreenCompression {}

/// The video track's H.264 encoder on this app's own compression session (`VideoCompressor`) in
/// place of libwebrtc's: the low-latency rate control, which libwebrtc's doesn't ask for, takes
/// about half the time over a frame and keeps closer to the rate the bandwidth estimate sets.
///
/// It tells libwebrtc what `RTCVideoEncoderH264` tells it: Annex B frames with their parameter
/// sets before each key frame, the capture time and RTP timestamp of the frame they came from,
/// the quantizer of the first slice, screen content, the packetization mode agreed, and the same
/// thresholds for making the picture smaller or larger.
///
/// Where the low-latency session can't be had, or stops working, libwebrtc's encoder takes over
/// (`H264ScreenEncoder`) for the rest of the call, and the name in the statistics says so.
final class LowLatencyH264Encoder: NSObject, RTCVideoEncoder {
  static let name = "LinkShellLowLatency"

  /// libwebrtc asks an encoder its name once, when it is made: when its own encoder has since
  /// taken over, the statistics are told here (`ScreenSession`).
  static let tookOver = Locked(false)

  /// libwebrtc's own answers (video_error_codes.h).
  private enum Code {
    static let ok = 0
    static let uninitialized = -7
  }

  private let info: RTCVideoCodecInfo
  private let maximumFrameRate: Int
  private let profile: VideoCompressor.Profile
  private let packetization: RTCH264PacketizationMode
  private var callback: RTCVideoEncoderCallback?
  private var settings: RTCVideoEncoderSettings?
  private var cores: Int32 = 1
  private let makeCompressor: (VideoCompressor.Setup) throws -> ScreenCompression
  private let makeStock: (RTCVideoCodecInfo, Int) -> RTCVideoEncoder
  private var compressor: ScreenCompression?
  private var stock: RTCVideoEncoder?
  private var latestRates: (bitrate: UInt32, framerate: UInt32)?
  /// Set on the encoder's thread when a frame fails; read on libwebrtc's before the next.
  /// Old callbacks must not break a replacement session or publish its stale pictures.
  private let state = Locked((generation: 0, failure: String?.none))

  init(info: RTCVideoCodecInfo, maximumFrameRate: Int = Tuning.fullFps,
       makeCompressor: @escaping (VideoCompressor.Setup) throws -> ScreenCompression = { try VideoCompressor($0) },
       makeStock: @escaping (RTCVideoCodecInfo, Int) -> RTCVideoEncoder = { H264ScreenEncoder(info: $0, maximumFrameRate: $1) }) {
    self.info = info
    self.maximumFrameRate = maximumFrameRate
    self.makeCompressor = makeCompressor
    self.makeStock = makeStock
    // 42…: (Constrained) Baseline; anything else offered is Constrained High.
    profile = (info.parameters["profile-level-id"] ?? "").lowercased().hasPrefix("42") ? .baseline : .high
    packetization = info.parameters["packetization-mode"] == "1" ? .nonInterleaved : .singleNalUnit
    LowLatencyH264Encoder.tookOver.withLock { $0 = false }
  }

  func setCallback(_ callback: RTCVideoEncoderCallback?) {
    self.callback = callback
    stock?.setCallback(callback)
  }

  func startEncode(with settings: RTCVideoEncoderSettings, numberOfCores: Int32) -> Int {
    invalidateCallbacks()
    self.settings = settings
    cores = numberOfCores
    latestRates = nil
    compressor = nil
    if let stock { return stock.startEncode(with: settings, numberOfCores: numberOfCores) }
    do {
      let made = try makeCompressor(.init(
        width: Int(settings.width),
        height: Int(settings.height),
        fps: Int(settings.maxFramerate),
        bitrate: Int(settings.startBitrate) * 1000,
        profile: profile,
        lowLatency: Launch.lowLatency
      ))
      // Without its rate control this encoder has nothing over libwebrtc's.
      guard made.mode == "low-latency" else { return fallBack("no low-latency encoder on this Mac") }
      compressor = made
      return Code.ok
    } catch {
      return fallBack("\(error)")
    }
  }

  func release() -> Int {
    invalidateCallbacks()
    compressor = nil
    return stock?.release() ?? Code.ok
  }

  func encode(_ frame: RTCVideoFrame, codecSpecificInfo info: RTCCodecSpecificInfo?, frameTypes: [NSNumber]) -> Int {
    let key = frameTypes.contains { $0.uintValue == RTCFrameType.videoFrameKey.rawValue }
    if stock == nil, let reason = state.withLock({ $0.failure }) {
      let result = fallBack(reason)
      if result != Code.ok { return result }
    }
    // A frame that is not a whole pixel buffer (cropped, or not from the screen) is libwebrtc's
    // encoder's to copy and convert.
    let native = frame.buffer as? RTCCVPixelBuffer
    if stock == nil, compressor != nil, native == nil || native?.requiresCropping() == true {
      let result = fallBack("a frame that is not a whole pixel buffer")
      if result != Code.ok { return result }
    }
    if let stock {
      // A change of encoder begins with a key frame, whatever was asked for.
      let types = switched ? [NSNumber(value: RTCFrameType.videoFrameKey.rawValue)] : frameTypes
      switched = false
      return stock.encode(frame, codecSpecificInfo: info, frameTypes: types)
    }
    guard let callback, let compressor, let settings, let native else { return Code.uninitialized }

    let width = Int32(settings.width)
    let height = Int32(settings.height)
    let screen = settings.mode == .screensharing
    let rtpTime = UInt32(bitPattern: frame.timeStamp)
    let captured = frame.timeStampNs / 1_000_000
    let rotation = frame.rotation
    let packetization = self.packetization
    let generation = state.withLock { $0.generation }
    compressor.encode(native.pixelBuffer, at: CMTime(value: frame.timeStampNs, timescale: 1_000_000_000), key: key) { [state] result in
      guard state.withLock({ $0.generation == generation }) else { return }
      switch result {
      case .failure(let failure):
        state.withLock { if $0.generation == generation { $0.failure = "\(failure)" } }
      case .success(nil):
        // Dropped to keep to the rate: libwebrtc hears of no frame, as from its own encoder.
        break
      case .success(let encoded?):
        guard let data = encoded.accessUnit() else {
          state.withLock { if $0.generation == generation { $0.failure = "an encoded frame had no H.264 access unit" } }
          return
        }
        let image = RTCEncodedImage()
        image.buffer = data
        image.encodedWidth = width
        image.encodedHeight = height
        image.timeStamp = rtpTime
        image.captureTimeMs = captured
        image.frameType = encoded.key ? .videoFrameKey : .videoFrameDelta
        image.rotation = rotation
        image.contentType = screen ? .screenshare : .unspecified
        // "No timing in this frame" (VideoSendTiming::kInvalid): libwebrtc fills in its own.
        image.flags = UInt8.max
        image.qp = NSNumber(value: encoded.quantizer ?? -1)
        let specific = RTCCodecSpecificInfoH264()
        specific.packetizationMode = packetization
        _ = callback(image, specific)
      }
    }
    return Code.ok
  }

  func setBitrate(_ bitrateKbit: UInt32, framerate: UInt32) -> Int32 {
    latestRates = (bitrateKbit, framerate)
    if let stock { return stock.setBitrate(bitrateKbit, framerate: framerate) }
    compressor?.setRates(bitrate: Int(bitrateKbit) * 1000, ceiling: nil, fps: Int(framerate))
    return Int32(Code.ok)
  }

  func implementationName() -> String {
    stock?.implementationName() ?? LowLatencyH264Encoder.name
  }

  /// The quantizers at which libwebrtc makes the picture larger (below 28) or smaller (above
  /// 39): its own encoder's. (libwebrtc goes by 24 and 37 all the same: its quality-scaling
  /// experiment, on unless a field trial says otherwise, has its own for H.264.)
  func scalingSettings() -> RTCVideoEncoderQpThresholds? {
    ScreenEncoderFactory.scaling(RTCVideoEncoderQpThresholds(thresholdsLow: 28, high: 39))
  }

  var resolutionAlignment: Int { 1 }
  var applyAlignmentToAllSimulcastLayers: Bool { false }
  var supportsNativeHandle: Bool { true }

  // MARK: libwebrtc's encoder, when this one can't

  private var switched = false

  private func invalidateCallbacks() {
    state.withLock {
      $0.generation += 1
      $0.failure = nil
    }
  }

  private func fallBack(_ reason: String) -> Int {
    Engine.report("the low-latency encoder is not used (\(reason)): libwebrtc's VideoToolbox encoder takes over")
    invalidateCallbacks()
    compressor = nil
    LowLatencyH264Encoder.tookOver.withLock { $0 = true }
    let stock = makeStock(info, maximumFrameRate)
    stock.setCallback(callback)
    self.stock = stock
    switched = true
    guard let settings else { return Code.uninitialized }
    let result = stock.startEncode(with: settings, numberOfCores: cores)
    guard result == Code.ok else { return result }
    if let latestRates { return Int(stock.setBitrate(latestRates.bitrate, framerate: latestRates.framerate)) }
    return Code.ok
  }
}
