import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import WebRTC

/// The desktop receiver has no software or browser decoder. Capability probing only decides
/// what to negotiate; every actual session must separately prove it obtained hardware.
final class DesktopScreenDecoderFactory: NSObject, RTCVideoDecoderFactory {
  private let onStatus: ([String: Any]) -> Void
  private let onFailure: (String) -> Void
  private let hardwareAvailable: (CMVideoCodecType) -> Bool
  private let failure = DesktopScreenDecoderFailure()

  init(onStatus: @escaping ([String: Any]) -> Void, onFailure: @escaping (String) -> Void,
       hardwareAvailable: @escaping (CMVideoCodecType) -> Bool = { VTIsHardwareDecodeSupported($0) }) {
    self.onStatus = onStatus
    self.onFailure = onFailure
    self.hardwareAvailable = hardwareAvailable
    super.init()
  }

  func supportedCodecs() -> [RTCVideoCodecInfo] {
    var codecs: [RTCVideoCodecInfo] = []
    if hardwareAvailable(kCMVideoCodecType_H264) {
      // Use upstream's negotiated profiles, including the browser High alias already accepted
      // by our sender. The stock factory supplies metadata only, never a decoder instance.
      codecs += ScreenEncoderFactory.browserCompatible(RTCVideoDecoderFactoryH264().supportedCodecs())
    }
    if hardwareAvailable(kCMVideoCodecType_HEVC) { codecs.append(HEVCDecoder.codecInfo) }
    return codecs
  }

  func createDecoder(_ info: RTCVideoCodecInfo) -> RTCVideoDecoder? {
    guard let codec = DesktopScreenCodec(name: info.name) else {
      failure.report("远程桌面不支持 \(info.name) 编码，请使用 H.264 或 HEVC。", to: onFailure)
      return nil
    }
    guard hardwareAvailable(codec.type) else {
      failure.report("此 Mac 无法使用 \(codec.label) 硬件解码，请选择此电脑支持的画面编码。", to: onFailure)
      return nil
    }
    return DesktopScreenDecoder(codec: codec, onStatus: onStatus, onFailure: { [failure, onFailure] message in
      failure.report(message, to: onFailure)
    })
  }
}

enum DesktopScreenCodec {
  case h264, hevc

  init?(name: String) {
    switch name.uppercased() {
    case "H264": self = .h264
    case "H265": self = .hevc
    default: return nil
    }
  }

  var type: CMVideoCodecType { self == .h264 ? kCMVideoCodecType_H264 : kCMVideoCodecType_HEVC }
  var name: String { self == .h264 ? "H264" : "H265" }
  var label: String { self == .h264 ? "H.264" : "HEVC" }
  var parameterKinds: [UInt8] { self == .h264 ? [7, 8] : [32, 33, 34] }

  func kind(of unit: Data) -> UInt8? {
    guard let first = unit.first, first & 0x80 == 0 else { return nil }
    if self == .h264 { return first & 0x1f }
    guard unit.count >= 2, unit[unit.startIndex + 1] & 7 != 0 else { return nil }
    return (first >> 1) & 0x3f
  }

  func isPicture(_ kind: UInt8) -> Bool { self == .h264 ? (1...5).contains(kind) : kind <= 31 }
  func isKey(_ kind: UInt8) -> Bool { self == .h264 ? kind == 5 : (16...21).contains(kind) }
  func isDelimiter(_ kind: UInt8) -> Bool { kind == (self == .h264 ? 9 : 35) }
}

/// One stream from LinkShell's encoder has one set of each parameter kind. A format is only
/// committed with a complete parameter set and a keyframe, including after a size change.
struct DesktopScreenAccessUnit {
  var parameters: [UInt8: Data] = [:]
  var body = Data()
  var hasPicture = false
  var hasKey = false

  init(_ data: Data, codec: DesktopScreenCodec) {
    body.reserveCapacity(data.count)
    for unit in Self.units(of: data) {
      guard let kind = codec.kind(of: unit) else { continue }
      if codec.parameterKinds.contains(kind) {
        parameters[kind] = unit
      } else if !codec.isDelimiter(kind), unit.count <= UInt32.max {
        var length = UInt32(unit.count).bigEndian
        withUnsafeBytes(of: &length) { body.append(contentsOf: $0) }
        body.append(unit)
        hasPicture = hasPicture || codec.isPicture(kind)
        hasKey = hasKey || codec.isKey(kind)
      }
    }
  }

  static func units(of data: Data) -> [Data] {
    var result: [Data] = []
    data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      var index = 0
      var start: Int?
      func append(until limit: Int) {
        guard let start else { return }
        var end = limit
        // Annex B trailing_zero_8bits and a four-byte start code's first zero are not payload.
        while end > start, bytes[end - 1] == 0 { end -= 1 }
        if end > start { result.append(Data(bytes[start..<end])) }
      }
      while index + 2 < bytes.count {
        if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 {
          append(until: index)
          index += 3
          start = index
        } else {
          index += 1
        }
      }
      append(until: bytes.count)
    }
    return result
  }
}

final class DesktopScreenDecoder: NSObject, RTCVideoDecoder {
  private let codec: DesktopScreenCodec
  private let onStatus: ([String: Any]) -> Void
  private let onFailure: (String) -> Void
  private let hardwareUse: (VTDecompressionSession) -> Bool?
  private let failure = DesktopScreenDecoderFailure()
  private var callback: RTCVideoDecoderCallback?
  private var parameters: [UInt8: Data] = [:]
  private var pendingParameters: [UInt8: Data] = [:]
  private var format: CMVideoFormatDescription?
  private var session: VTDecompressionSession?
  private var needsKey = true
  private var terminalFailure = false
  private var reportedSession = false
  private var consecutiveDecodeFailures = 0

  init(codec: DesktopScreenCodec, onStatus: @escaping ([String: Any]) -> Void,
       onFailure: @escaping (String) -> Void,
       hardwareUse: @escaping (VTDecompressionSession) -> Bool? = DesktopScreenDecoder.hardwareUse) {
    self.codec = codec
    self.onStatus = onStatus
    self.onFailure = onFailure
    self.hardwareUse = hardwareUse
    super.init()
  }

  func setCallback(_ callback: @escaping RTCVideoDecoderCallback) { self.callback = callback }
  func startDecode(withNumberOfCores numberOfCores: Int32) -> Int { terminalFailure ? -1 : 0 }
  func implementationName() -> String { "LinkShellVideoToolbox\(codec.name)Hardware" }

  func release() -> Int {
    invalidate()
    format = nil
    parameters = [:]
    pendingParameters = [:]
    callback = nil
    consecutiveDecodeFailures = 0
    return 0
  }

  deinit { invalidate() }

  func decode(_ image: RTCEncodedImage, missingFrames: Bool, codecSpecificInfo info: RTCCodecSpecificInfo?, renderTimeMs: Int64) -> Int {
    guard !terminalFailure else { return -1 }
    let access = DesktopScreenAccessUnit(image.buffer, codec: codec)
    pendingParameters.merge(access.parameters) { _, newest in newest }
    guard access.hasPicture else { return access.parameters.isEmpty ? -1 : 0 }
    if needsKey, !access.hasKey { return -1 }

    if access.hasKey {
      let candidate = parameters.merging(pendingParameters) { _, newest in newest }
      guard codec.parameterKinds.allSatisfy({ candidate[$0] != nil }) else { return -1 }
      if format == nil || candidate != parameters {
        let sets = codec.parameterKinds.compactMap { candidate[$0] }
        guard let made = Self.formatDescription(sets, codec: codec) else {
          decodeFailed(kCMFormatDescriptionError_InvalidParameter)
          return -1
        }
        invalidate()
        format = made
        parameters = candidate
      }
      pendingParameters = [:]
    } else if !pendingParameters.isEmpty, pendingParameters.contains(where: { parameters[$0.key] != $0.value }) {
      // An updated SPS followed by an old delta cannot be decoded against either configuration.
      needsKey = true
      return -1
    }
    guard let described = format else { return -1 }
    if session == nil, !makeSession(described) { return -1 }
    guard let session, let sample = Self.sample(access.body, format: described) else { return -1 }

    let timestamp = Int32(bitPattern: image.timeStamp)
    let rotation = image.rotation
    let captured = image.captureTimeMs * 1_000_000
    var output: RTCVideoFrame?
    var outputStatus: OSStatus = noErr
    // With both asynchronous and temporal-processing flags clear, VideoToolbox guarantees the
    // output block completes before this returns. No decoded-frame queue builds up here.
    let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: nil) { status, flags, buffer, _, _ in
      outputStatus = status
      guard status == noErr, !flags.contains(.frameDropped), let buffer else { return }
      let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: buffer), rotation: rotation, timeStampNs: captured)
      frame.timeStamp = timestamp
      output = frame
    }
    guard status == noErr, outputStatus == noErr else {
      // Packet loss can damage a frame. Ask WebRTC for a keyframe and recreate a hardware
      // session on that keyframe; never negotiate a software decoder as recovery.
      decodeFailed(status == noErr ? outputStatus : status)
      return -1
    }
    guard let output else {
      if access.hasKey {
        decodeFailed(kVTVideoDecoderBadDataErr)
        return -1
      }
      return 0
    }
    needsKey = false
    consecutiveDecodeFailures = 0
    if !reportedSession {
      reportedSession = true
      onStatus(["codec": codec.name, "hardware": true, "decoder": implementationName()])
    }
    callback?(output)
    return 0
  }

  private func decodeFailed(_ status: OSStatus) {
    invalidate()
    consecutiveDecodeFailures += 1
    // Give ordinary packet loss a bounded chance to recover. After playback has started the
    // initial-frame timeout no longer protects against a frozen picture and active controls.
    if consecutiveDecodeFailures >= 3 {
      fail("\(codec.label) 硬件解码连续失败（\(status)），已停止远程画面，请重新连接。")
    }
  }

  private func makeSession(_ format: CMVideoFormatDescription) -> Bool {
    let specification: [CFString: Any] = [kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder: true]
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any],
      kCVPixelBufferMetalCompatibilityKey: true,
    ]
    var made: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(allocator: nil, formatDescription: format,
      decoderSpecification: specification as CFDictionary, imageBufferAttributes: attributes as CFDictionary,
      outputCallback: nil, decompressionSessionOut: &made)
    guard status == noErr, let made else {
      fail("无法启动 \(codec.label) 硬件解码（\(status)），请重试或调整画面编码。")
      return false
    }
    guard hardwareUse(made) == true else {
      VTDecompressionSessionInvalidate(made)
      fail("未能确认 \(codec.label) 硬件解码，已停止远程画面。")
      return false
    }
    VTSessionSetProperty(made, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    session = made
    reportedSession = false
    return true
  }

  private func fail(_ message: String) {
    terminalFailure = true
    failure.report(message, to: onFailure)
  }

  private func invalidate() {
    if let session { VTDecompressionSessionInvalidate(session) }
    session = nil
    needsKey = true
    reportedSession = false
  }

  static func hardwareUse(_ session: VTDecompressionSession) -> Bool? {
    var value: Unmanaged<CFTypeRef>?
    let status = VTSessionCopyProperty(session, key: kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
      allocator: nil, valueOut: &value)
    guard status == noErr else { return nil }
    return value?.takeRetainedValue() as? Bool
  }

  private static func formatDescription(_ sets: [Data], codec: DesktopScreenCodec) -> CMVideoFormatDescription? {
    let copies = sets.map { set -> UnsafeMutablePointer<UInt8> in
      let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: set.count)
      set.copyBytes(to: pointer, count: set.count)
      return pointer
    }
    defer { copies.forEach { $0.deallocate() } }
    let pointers = copies.map { UnsafePointer($0) }
    let sizes = sets.map(\.count)
    var format: CMVideoFormatDescription?
    let status: OSStatus
    if codec == .h264 {
      status = CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: nil, parameterSetCount: sets.count,
        parameterSetPointers: pointers, parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &format)
    } else {
      status = CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator: nil, parameterSetCount: sets.count,
        parameterSetPointers: pointers, parameterSetSizes: sizes, nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &format)
    }
    return status == noErr ? format : nil
  }

  private static func sample(_ body: Data, format: CMVideoFormatDescription) -> CMSampleBuffer? {
    guard !body.isEmpty else { return nil }
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: body.count,
      blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: body.count,
      flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr, let block else { return nil }
    let copied = body.withUnsafeBytes { bytes in
      CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: body.count)
    }
    guard copied == noErr else { return nil }
    var sample: CMSampleBuffer?
    var size = body.count
    guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
      sampleCount: 1, sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1,
      sampleSizeArray: &size, sampleBufferOut: &sample) == noErr else { return nil }
    return sample
  }
}

private final class DesktopScreenDecoderFailure {
  private let lock = NSLock()
  private var reported = false

  func report(_ message: String, to callback: (String) -> Void) {
    lock.lock()
    let first = !reported
    reported = true
    lock.unlock()
    if first { callback(message) }
  }
}
