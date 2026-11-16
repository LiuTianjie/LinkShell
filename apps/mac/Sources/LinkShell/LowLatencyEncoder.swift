import CoreMedia
import Foundation
import WebRTC

/// The compression session can fail after it starts; kept separate so that the takeover can
/// be checked without depending on a particular Mac's hardware failing during a test.
protocol ScreenCompression: AnyObject {
  var mode: String { get }
  var keyPlan: VideoCompressor.KeyPlan? { get set }
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
///
/// It encodes HEVC too, for a receiver that asked for it (`ScreenEncoderFactory`): libwebrtc
/// (M154) packetizes H.265 but has no encoder for it here. There nothing can take over, so a
/// failure is libwebrtc's to handle: it asks for the next codec the call agreed.
final class LowLatencyH264Encoder: NSObject, RTCVideoEncoder {
  static let name = "LinkShellLowLatency"

  /// libwebrtc asks an encoder its name once, when it is made: when its own encoder has since
  /// taken over, the statistics are told here (`ScreenSession`).
  static let tookOver = Locked(false)

  /// libwebrtc's own answers (video_error_codes.h).
  private enum Code {
    static let ok = 0
    static let error = -1
    static let uninitialized = -7
  }

  private let info: RTCVideoCodecInfo
  private let maximumFrameRate: Int
  private let maxPendingFrames: Int
  private let profile: VideoCompressor.Profile
  private let hevc: Bool
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
  private let state = Locked((generation: 0, failure: String?.none, pending: 0, keyWanted: false))
  /// What has been made and is reckoned not yet sent, and what was skipped for it since last said.
  private let queue = Locked((model: SendQueue(), skipped: 0, longest: 0.0, since: 0.0))
  private let keyBudget: Bool
  private let queueAdmission: Bool
  private let clock: () -> Double

  init(info: RTCVideoCodecInfo, maximumFrameRate: Int = Tuning.fullFps,
       maxPendingFrames: Int = Tuning.encoderPendingFrames,
       keyBudget: Bool = Tuning.keyBudget || Launch.has("--budget-keyframes"),
       queueAdmission: Bool = Tuning.queueAdmission,
       clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
       makeCompressor: @escaping (VideoCompressor.Setup) throws -> ScreenCompression = { try VideoCompressor($0) },
       makeStock: @escaping (RTCVideoCodecInfo, Int) -> RTCVideoEncoder = { H264ScreenEncoder(info: $0, maximumFrameRate: $1) }) {
    self.info = info
    self.maximumFrameRate = maximumFrameRate
    self.maxPendingFrames = max(1, maxPendingFrames)
    self.keyBudget = keyBudget
    self.queueAdmission = queueAdmission
    self.clock = clock
    self.makeCompressor = makeCompressor
    self.makeStock = makeStock
    // 42…: (Constrained) Baseline; anything else offered is Constrained High.
    profile = (info.parameters["profile-level-id"] ?? "").lowercased().hasPrefix("42") ? .baseline : .high
    hevc = info.name == ScreenEncoderFactory.hevcName
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
        lowLatency: Launch.lowLatency,
        codec: hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264
      ))
      // Without its rate control this encoder has nothing over libwebrtc's.
      guard made.mode == "low-latency" else { return fallBack("no low-latency encoder on this Mac") }
      compressor = made
      let rate = Int(settings.startBitrate) * 1000
      if keyBudget { made.keyPlan = .init(budget: Tuning.keyFrameBudget(bitrate: rate), finest: nil) }
      queue.withLock { $0.model.reset(); $0.model.set(encoderRate: Double(rate), now: clock()) }
      return Code.ok
    } catch {
      return fallBack("\(error)")
    }
  }

  func release() -> Int {
    invalidateCallbacks()
    compressor = nil
    cropPool = nil
    return stock?.release() ?? Code.ok
  }

  func encode(_ frame: RTCVideoFrame, codecSpecificInfo info: RTCCodecSpecificInfo?, frameTypes: [NSNumber]) -> Int {
    let key = frameTypes.contains { $0.uintValue == RTCFrameType.videoFrameKey.rawValue }
    if stock == nil, let reason = state.withLock({ $0.failure }) {
      let result = fallBack(reason)
      if result != Code.ok { return result }
    }
    // A frame that is not a pixel buffer (not from the screen) is libwebrtc's encoder's to copy
    // and convert.
    let native = frame.buffer as? RTCCVPixelBuffer
    if stock == nil, compressor != nil, native == nil {
      let result = fallBack("a frame that is not a pixel buffer")
      if result != Code.ok { return result }
    }
    // A cropped one is cut out here. libwebrtc crops a row or a column when it makes the picture
    // smaller (to keep its shape at the new size); handing those to its own encoder meant the
    // low-latency encoder was never used again that call, and for HEVC, which it cannot encode,
    // that the codec stopped.
    var cut: CVPixelBuffer?
    if stock == nil, compressor != nil, let native, native.requiresCropping(), let settings {
      cut = cropped(native, width: Int(settings.width), height: Int(settings.height))
      if cut == nil {
        let result = fallBack("a cropped frame could not be cut out")
        if result != Code.ok { return result }
      }
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
    let hevc = self.hevc
    // A picture is not encoded behind a queue of earlier ones (`SendQueue`): it would wait too.
    // A key frame asked for meanwhile is remembered, and made when there is room for it.
    if queueAdmission {
      let now = clock()
      let report: String?
      let skip: Bool
      (skip, report) = queue.withLock { queue in
        let wait = queue.model.wait(now: now)
        let skip = wait * 1000 > Tuning.sendQueueAdmitMs
        if skip {
          if queue.skipped == 0 { queue.since = now }
          queue.skipped += 1
          queue.longest = max(queue.longest, wait)
        }
        // Said a few seconds after the first of them, with what came since.
        guard queue.skipped > 0, now - queue.since >= 5 else { return (skip, nil) }
        defer { queue.skipped = 0; queue.longest = 0 }
        return (skip, String(format: "%d pictures were not encoded while earlier ones waited to be sent (up to %.0f ms, reckoned)", queue.skipped, queue.longest * 1000))
      }
      if let report { Engine.report(report) }
      if skip {
        if key { state.withLock { $0.keyWanted = true } }
        FrameTrace.mark("queueSkip")
        return Code.ok
      }
    }
    // A hardware encoder can accept frames faster than it finishes them. Bound raw input
    // instead of queuing old screen contents or discarding compressed reference frames later.
    let job: (generation: Int, key: Bool)? = state.withLock { state in
      state.keyWanted = state.keyWanted || key
      guard state.pending < maxPendingFrames else { return nil }
      state.pending += 1
      let key = state.keyWanted
      state.keyWanted = false
      return (state.generation, key)
    }
    guard let job else { FrameTrace.mark("encodeSkip"); return Code.ok }
    FrameTrace.mark("encodeIn")
    let began = MediaStageProbe.enabled ? ProcessInfo.processInfo.systemUptime : 0
    if MediaStageProbe.enabled, job.key || rtpTime % 31 == 0 {
      MediaStageProbe.shared.reference(native.pixelBuffer, began: began)
    }
    let fusion = FusionMetadata.layout(of: native.pixelBuffer)
    compressor.encode(cut ?? native.pixelBuffer, at: CMTime(value: frame.timeStampNs, timescale: 1_000_000_000), key: job.key) { [state, queue, clock] result in
      guard state.withLock({ state in
        guard state.generation == job.generation else { return false }
        state.pending -= 1
        return true
      }) else { return }
      switch result {
      case .failure(let failure):
        state.withLock { if $0.generation == job.generation { $0.failure = "\(failure)" } }
      case .success(nil):
        // Dropped to keep to the rate: libwebrtc hears of no frame, as from its own encoder.
        if job.key { state.withLock { if $0.generation == job.generation { $0.keyWanted = true } } }
        break
      case .success(let encoded?):
        FrameTrace.mark(encoded.key ? "encodeOutKey" : "encodeOut")
        let bytes = CMSampleBufferGetTotalSampleSize(encoded.sample)
        let now = clock()
        queue.withLock { $0.model.made(bytes: bytes, now: now) }
        // Rare, and what a field comparison wants to see: how large key frames come out.
        if encoded.key { Engine.report("key frame: \(bytes / 1024) KB" + (compressor.keyPlan.map { ", for a budget of \($0.budget / 1024) KB" } ?? "")) }
        guard let data = encoded.accessUnit() else {
          state.withLock { if $0.generation == job.generation { $0.failure = "an encoded frame had no access unit" } }
          return
        }
        let image = RTCEncodedImage()
        // The probe's marker is an H.264 SEI; HEVC would read it as a reserved unit.
        image.buffer = MediaStageProbe.enabled && !hevc ? MediaStageProbe.attaching(to: data, began: began) : data
        if let fusion { image.buffer = FusionMetadata.attaching(fusion, to: image.buffer, hevc: hevc) }
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
        // libwebrtc's bridge takes no other kind; for HEVC the packetizer goes by the payload's
        // name and reads nothing from it.
        let specific = RTCCodecSpecificInfoH264()
        specific.packetizationMode = packetization
        _ = callback(image, specific)
      }
    }
    return Code.ok
  }

  func setBitrate(_ bitrateKbit: UInt32, framerate: UInt32) -> Int32 {
    if Launch.has("--rtc-log") {
      Engine.report("encoder target: \(bitrateKbit) kbit/s, \(framerate) fps")
    }
    latestRates = (bitrateKbit, framerate)
    if let stock { return stock.setBitrate(bitrateKbit, framerate: framerate) }
    compressor?.setRates(bitrate: Int(bitrateKbit) * 1000, ceiling: nil, fps: Int(framerate))
    if keyBudget { compressor?.keyPlan = .init(budget: Tuning.keyFrameBudget(bitrate: Int(bitrateKbit) * 1000), finest: nil) }
    queue.withLock { $0.model.set(encoderRate: Double(bitrateKbit) * 1000, now: clock()) }
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

  // MARK: Cropped frames

  private var cropPool: (pool: CVPixelBufferPool, width: Int, height: Int)?

  /// The part of the buffer libwebrtc means, at the size the encoder was started for.
  private func cropped(_ source: RTCCVPixelBuffer, width: Int, height: Int) -> CVPixelBuffer? {
    let format = CVPixelBufferGetPixelFormatType(source.pixelBuffer)
    guard width > 0, height > 0, format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange else { return nil }
    if cropPool?.width != width || cropPool?.height != height {
      let attributes: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: format, kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
      ]
      var pool: CVPixelBufferPool?
      guard CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess, let pool else { return nil }
      cropPool = (pool, width, height)
    }
    var made: CVPixelBuffer?
    guard let pool = cropPool?.pool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made) == kCVReturnSuccess, let made else { return nil }
    // Scaling as well as cropping needs room to work in; cropping alone needs none.
    let room = Int(source.bufferSizeForCroppingAndScaling(toWidth: Int32(width), height: Int32(height)))
    let scratch = room > 0 ? UnsafeMutablePointer<UInt8>.allocate(capacity: room) : nil
    defer { scratch?.deallocate() }
    return source.cropAndScale(to: made, withTempBuffer: scratch) ? made : nil
  }

  // MARK: libwebrtc's encoder, when this one can't

  private var switched = false

  private func invalidateCallbacks() {
    state.withLock {
      $0.generation += 1
      $0.failure = nil
      $0.pending = 0
      $0.keyWanted = false
    }
  }

  private func fallBack(_ reason: String) -> Int {
    if hevc {
      Engine.report("the HEVC encoder stopped (\(reason))")
      invalidateCallbacks()
      compressor = nil
      return Code.error
    }
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
