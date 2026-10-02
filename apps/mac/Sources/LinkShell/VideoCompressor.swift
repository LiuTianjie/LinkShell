import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// H.264 from the hardware encoder, for a picture that is being watched as it is made: one
/// VideoToolbox compression session of one size.
///
/// It is asked for the low-latency rate control first. That mode keeps to the rate from one
/// second to the next, holds no frame back, and encodes a 1080p frame in about 6 ms where the
/// usual mode takes 11 (M3 Max) — what a picture needs to stay live on a path that carries only
/// so much. Where the session can't be made that way (an encoder without the mode), it is made
/// the usual real-time way, with the same settings.
///
/// No frame waits on a later one in either mode: no reordering, no frames held, so what comes
/// out can be decoded and shown as it arrives. The low-latency mode says so in the stream
/// (`max_num_reorder_frames` 0); the usual mode doesn't, so there it is written into the
/// parameter sets on their way out (`SequenceParameters`), and the profile asked for is baseline,
/// which has no reordering for a decoder to wait for even if it doesn't read that.
final class VideoCompressor {
  enum Profile: String {
    /// Constrained Baseline: what every decoder has.
    case baseline
    /// Constrained High: the same picture in fewer bits (CABAC, 8×8 transforms).
    case high
  }

  struct Setup {
    var width: Int
    var height: Int
    var fps: Int
    /// Bits a second, on average.
    var bitrate: Int
    /// Bits in any one second, at most; nil leaves it to the average.
    var ceiling: Int?
    /// Nil: High from the low-latency encoder, baseline from the usual one.
    var profile: Profile?
    /// Ask for the low-latency rate control (off to be as on a Mac without it: `--no-low-latency`).
    var lowLatency = true
  }

  struct Failure: Error, CustomStringConvertible {
    let what: String
    let status: OSStatus
    var description: String { "\(what) (\(status))" }
  }

  struct Frame {
    let sample: CMSampleBuffer
    let key: Bool
    /// 0 the finest, 51 the coarsest; nil when it couldn't be read.
    let quantizer: Int?
    /// The encoder's stream doesn't say that frames come in the order they are shown.
    fileprivate let silentOnOrder: Bool

    /// The frame as a decoder off this Mac wants it (`AnnexB`), after `reserved` bytes left
    /// for the caller's own header.
    func accessUnit(reserved: Int = 0) -> Data? {
      AnnexB.accessUnit(sample, key: key, reserved: reserved, statingNoReordering: silentOnOrder)
    }
  }

  /// "low-latency" or "real-time": the rate control the session got.
  let mode: String
  let profile: Profile
  let hardware: Bool
  let width: Int
  let height: Int

  /// How large the next key frames may be; nil leaves it to the encoder.
  ///
  /// The encoder gives a key frame a quantizer of its own choosing — by the rate set, not by
  /// what the rate has room for just then. In the low-latency mode a 854×480 key frame of a page
  /// of text at 260 kbit/s came out at 48 KB, a second and a half of the rate, and the frames
  /// after it were starved to pay for it, or dropped. So a key frame is held to a quantizer no
  /// finer than the last one's size says the budget needs; and where the budget has room and the
  /// plan allows (`finest`), to one finer than the encoder would choose. Each key frame corrects
  /// the guess for the next.
  struct KeyPlan {
    /// Bytes.
    var budget: Int
    /// Nil: no finer than the encoder's own choice. Otherwise as fine as this, budget allowing:
    /// for a key frame that is all there is to send, of a screen that is still.
    var finest: Int?
  }

  var keyPlan: KeyPlan? {
    get { state.withLock { $0.keyPlan } }
    set { state.withLock { $0.keyPlan = newValue } }
  }

  private struct State {
    var keyPlan: KeyPlan?
    /// The last key frame: what the next one's quantizer is worked out from.
    var lastKey: (quantizer: Int, bytes: Int)?
    /// A key frame is on its way with its quantizer held: let go when it is out.
    var holding = false
    var reader = SliceQuantizer()
  }

  private let session: VTCompressionSession
  private let state = Locked(State())
  private let settings = DispatchQueue(label: "com.bd.linkshell.encoder-settings")

  /// Quantizer steps that take a key frame of screen content to 1/e of its size: measured on
  /// a page of text, 19 from 22 to 28, 16 from 34 to 40 and 10 from 40 to 46. The lowest: a guess
  /// that falls short is corrected by the next key frame, one that overshoots costs sharpness.
  private static let stepsPerFold = 12.0
  /// No key frame is asked to be coarser than this: beyond it text can't be read.
  private static let coarsestKey = 46

  init(_ setup: Setup) throws {
    var made: (session: VTCompressionSession, lowLatency: Bool, profile: Profile)?
    var failure = Failure(what: "no encoder", status: kVTCouldNotFindVideoEncoderErr)
    for lowLatency in setup.lowLatency ? [true, false] : [false] {
      let profile = setup.profile ?? (lowLatency ? .high : .baseline)
      do {
        made = (try VideoCompressor.session(setup, lowLatency: lowLatency, profile: profile), lowLatency, profile)
        break
      } catch let error as Failure {
        failure = error
      }
    }
    guard let made else { throw failure }
    session = made.session
    mode = made.lowLatency ? "low-latency" : "real-time"
    profile = made.profile
    width = setup.width
    height = setup.height
    // The low-latency encoder is the hardware's and doesn't answer the question.
    hardware = made.lowLatency || (VideoCompressor.copy(kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, of: session) as? Bool ?? false)
    setRates(bitrate: setup.bitrate, ceiling: setup.ceiling, fps: setup.fps)
    VTCompressionSessionPrepareToEncodeFrames(session)
  }

  deinit {
    VTCompressionSessionInvalidate(session)
  }

  private static func session(_ setup: Setup, lowLatency: Bool, profile: Profile) throws -> VTCompressionSession {
    // Low-latency rate control is the hardware's. Otherwise the hardware is asked for and the
    // system's own encoder taken where there is none: a picture is worth more than none.
    let specification: [CFString: Any] = lowLatency
      ? [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
      : [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true]
    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: nil,
      width: Int32(setup.width),
      height: Int32(setup.height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: specification as CFDictionary,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &created
    )
    guard status == noErr, let session = created else { throw Failure(what: "the \(lowLatency ? "low-latency " : "")encoder could not be made", status: status) }

    // What the picture can't do without: a session that refuses one is of no use, and the next
    // way of making one is tried.
    let required: [(CFString, Any)] = [
      (kVTCompressionPropertyKey_RealTime, true),
      (kVTCompressionPropertyKey_ProfileLevel, profile == .high ? kVTProfileLevel_H264_ConstrainedHigh_AutoLevel : kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel),
      (kVTCompressionPropertyKey_AllowFrameReordering, false),
    ]
    for (key, value) in required {
      let status = VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
      guard status == noErr else {
        VTCompressionSessionInvalidate(session)
        throw Failure(what: "the encoder did not take \(key)", status: status)
      }
    }
    // What an encoder may not know, and does right by default where it doesn't. (macOS 26's
    // hardware H.264 encoders refuse MaxFrameDelayCount in both modes, and hold nothing back.)
    let wished: [(CFString, Any)] = [
      (kVTCompressionPropertyKey_MaxFrameDelayCount, 0),
      // Key frames are made when they are asked for (`encode(key:)`), never by a count.
      (kVTCompressionPropertyKey_MaxKeyFrameInterval, Int(Int32.max)),
      // The screen is captured as BT.709, video range; said in the stream so that a decoder
      // doesn't guess by the size of the picture.
      (kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2),
      (kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2),
      (kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2),
    ]
    for (key, value) in wished { VTSessionSetProperty(session, key: key, value: value as CFTypeRef) }
    return session
  }

  private static func copy(_ key: CFString, of session: VTCompressionSession) -> CFTypeRef? {
    var value: Unmanaged<CFTypeRef>?
    let status = withUnsafeMutablePointer(to: &value) { VTSessionCopyProperty(session, key: key, allocator: nil, valueOut: $0) }
    return status == noErr ? value?.takeRetainedValue() : nil
  }

  /// Takes effect with the next frame; the session and its picture go on.
  func setRates(bitrate: Int, ceiling: Int?, fps: Int) {
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
    // Bytes, then the seconds they are counted over.
    if let ceiling { VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: [max(ceiling, bitrate) / 8, 1] as CFArray) }
  }

  /// What the encoder that follows this one knows from the start: how large this one's key
  /// frames came out, taken in proportion to the pictures' sizes.
  func learn(from earlier: VideoCompressor) {
    guard let last = earlier.state.withLock({ $0.lastKey }) else { return }
    let bytes = Int(Double(last.bytes) * Double(width * height) / Double(earlier.width * earlier.height))
    state.withLock { $0.lastKey = (last.quantizer, bytes) }
  }

  /// Encodes one picture. `done` is called once, on a thread of the encoder's, with the frame
  /// (nil when the encoder dropped it to keep to the rate) or what went wrong. Frames come out
  /// in the order they went in.
  func encode(_ buffer: CVPixelBuffer, at time: CMTime, key: Bool, done: @escaping (Result<Frame?, Failure>) -> Void) {
    if key { holdKeyQuantizer() }
    let properties = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let status = VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: time, duration: .invalid, frameProperties: properties, infoFlagsOut: nil) { [weak self] status, flags, sample in
      if status != noErr { return done(.failure(Failure(what: "a frame could not be encoded", status: status))) }
      guard let self, let sample, !flags.contains(.frameDropped) else { return done(.success(nil)) }
      let key = AnnexB.isKey(sample)
      let quantizer = self.state.withLock { $0.reader.quantizer(of: sample) }
      if key { self.keyCameOut(quantizer: quantizer, bytes: CMSampleBufferGetTotalSampleSize(sample)) }
      done(.success(Frame(sample: sample, key: key, quantizer: quantizer, silentOnOrder: self.mode != "low-latency")))
    }
    if status != noErr { done(.failure(Failure(what: "a frame was not taken by the encoder", status: status))) }
  }

  /// Waits for every frame given so far to come out.
  func finish() {
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
  }

  // MARK: The size of a key frame

  private func holdKeyQuantizer() {
    let range: ClosedRange<Int>? = state.withLock { state in
      guard let plan = state.keyPlan, plan.budget > 0, let last = state.lastKey else { return nil }
      state.holding = true
      let steps = VideoCompressor.stepsPerFold * log(Double(last.bytes) / Double(plan.budget))
      let fitting = last.quantizer + Int(steps.rounded())
      // Exactly what fits, where finer than the encoder's choice is allowed; otherwise a floor,
      // which changes nothing when it is below what the encoder would choose.
      if let finest = plan.finest {
        let quantizer = min(max(fitting, finest), VideoCompressor.coarsestKey)
        return quantizer...quantizer
      }
      return min(max(fitting, 1), VideoCompressor.coarsestKey)...51
    }
    if let range {
      VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MinAllowedFrameQP, value: range.lowerBound as CFNumber)
      VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxAllowedFrameQP, value: range.upperBound as CFNumber)
    }
  }

  private func keyCameOut(quantizer: Int?, bytes: Int) {
    let held: Bool = state.withLock { state in
      if let quantizer { state.lastKey = (quantizer, bytes) }
      defer { state.holding = false }
      return state.holding
    }
    // The frames after it are the rate control's again. Not from here: this is the encoder's
    // own thread, in the middle of a frame, and the session waits for it to be done.
    if held {
      settings.async { [session] in
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MinAllowedFrameQP, value: 1 as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxAllowedFrameQP, value: 51 as CFNumber)
      }
    }
  }
}

/// A value several threads use, one at a time.
final class Locked<Value> {
  private var value: Value
  private let lock = NSLock()

  init(_ value: Value) {
    self.value = value
  }

  func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return body(&value)
  }
}
