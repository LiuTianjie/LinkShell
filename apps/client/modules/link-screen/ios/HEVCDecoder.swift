import CoreMedia
import Foundation
import VideoToolbox
import WebRTC

/// HEVC for a WebRTC video track, decoded by VideoToolbox. libwebrtc (M154) carries H.265 over
/// RTP but has no Objective-C decoder for it; this is that decoder. The phone's receiver and the
/// Mac app's own test receiver (`--loopback`) share this file (apps/mac links to it).
///
/// Frames come as Annex B: each NAL unit behind a start code, and in front of a key frame the
/// parameter sets (VPS, SPS, PPS). VideoToolbox wants the sets as a format description and the
/// rest behind 4-byte lengths. The picture comes out as the hardware decodes it, in an IOSurface
/// the renderer can take as a Metal texture without a copy.
final class HEVCDecoder: NSObject, RTCVideoDecoder {
  static let implementation = "LinkShellHEVC"

  /// What a receiver says it takes: Main profile, main tier, up to level 5.2 (a 3024-wide screen
  /// at 120 frames), single-stream transmission.
  static let codecInfo = RTCVideoCodecInfo(name: "H265", parameters: ["profile-id": "1", "tier-flag": "0", "level-id": "156", "tx-mode": "SRST"])

  /// Whether this device decodes HEVC in hardware; without it the stream stays H.264.
  static var available: Bool { VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC) }

  /// libwebrtc's answers (video_error_codes.h). An error makes the receiver ask for a key frame.
  private enum Code {
    static let ok = 0
    static let error = -1
  }

  private var callback: RTCVideoDecoderCallback?
  private var parameterSets: [Data] = []
  private var format: CMVideoFormatDescription?
  private var session: VTDecompressionSession?
  private var needsKeyframe = true

  func setCallback(_ callback: @escaping RTCVideoDecoderCallback) { self.callback = callback }
  func startDecode(withNumberOfCores numberOfCores: Int32) -> Int { Code.ok }
  func implementationName() -> String { Self.implementation }

  func release() -> Int {
    invalidate()
    callback = nil
    format = nil
    parameterSets = []
    needsKeyframe = true
    return Code.ok
  }

  deinit {
    invalidate()
    callback = nil
  }

  func decode(_ image: RTCEncodedImage, missingFrames: Bool, codecSpecificInfo info: RTCCodecSpecificInfo?, renderTimeMs: Int64) -> Int {
    let data = image.buffer
    var sets: [Data] = []
    var payloadRanges: [Range<Int>] = []
    var payloadLength = 0
    var hasKeyframeUnit = image.frameType == .videoFrameKey
    data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      let ranges = Self.unitRanges(in: bytes)
      payloadRanges.reserveCapacity(ranges.count)
      for range in ranges {
        let nalType = (bytes[range.lowerBound] >> 1) & 0x3f
        switch nalType {
        case 32...34:
          sets.append(Data(bytes[range]))
        // An access unit delimiter is of no use to VideoToolbox.
        case 35:
          break
        default:
          // HEVC IRAP NAL units (BLA/IDR/CRA: 16...21) start an independent decodable picture.
          if (16...21).contains(nalType) { hasKeyframeUnit = true }
          payloadRanges.append(range)
          payloadLength += 4 + range.count
        }
      }
    }
    if !sets.isEmpty, sets != parameterSets {
      guard let made = Self.formatDescription(sets) else {
        needsKeyframe = true
        return Code.error
      }
      invalidate()
      format = made
      parameterSets = sets
      needsKeyframe = true
    }
    // After startup or any decode error, wait for the next IDR/keyframe instead of feeding broken P-frames.
    if needsKeyframe && !hasKeyframeUnit { return Code.error }
    // Nothing to decode with until the first key frame.
    guard let described = format, payloadLength > 0 else { return Code.error }
    if session == nil, !makeSession(described) {
      needsKeyframe = true
      return Code.error
    }
    guard let session, let sample = Self.sample(from: data, ranges: payloadRanges, totalLength: payloadLength, format: described) else {
      needsKeyframe = true
      return Code.error
    }

    let callback = self.callback
    let timestamp = Int32(bitPattern: image.timeStamp)
    let rotation = image.rotation
    let captured = image.captureTimeMs * 1_000_000
    var decoded = false
    // Without the asynchronous flag the picture comes out before this returns: nothing waits
    // in a queue behind a later frame.
    let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: nil) { status, _, buffer, _, _ in
      guard status == noErr, let buffer else { return }
      decoded = true
      let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: buffer), rotation: rotation, timeStampNs: captured)
      frame.timeStamp = timestamp
      callback?(frame)
    }
    if status != noErr || !decoded {
      // The session can be lost (e.g. backgrounding or corrupted bitstream): invalidate and
      // require the next IDR keyframe so libwebrtc sends a PLI instead of decoding broken P-frames.
      // Keep the last valid format/parameterSets so a subsequent IDR recovers even if parameter sets match.
      invalidate()
      needsKeyframe = true
      return Code.error
    }
    needsKeyframe = false
    return Code.ok
  }

  private func makeSession(_ format: CMVideoFormatDescription) -> Bool {
    // NV12, video range, as the Mac encodes it; IOSurface-backed for Metal.
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any],
      kCVPixelBufferMetalCompatibilityKey: true,
    ]
    var made: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(allocator: nil, formatDescription: format, decoderSpecification: nil,
                                              imageBufferAttributes: attributes as CFDictionary, outputCallback: nil, decompressionSessionOut: &made)
    guard status == noErr, let made else { return false }
    VTSessionSetProperty(made, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    session = made
    return true
  }

  private func invalidate() {
    if let session { VTDecompressionSessionInvalidate(session) }
    session = nil
  }

  /// Zero-allocation Annex B NAL range scanner.
  static func unitRanges(in bytes: UnsafeRawBufferPointer) -> [Range<Int>] {
    var ranges: [Range<Int>] = []
    let count = bytes.count
    var index = 0
    var start: Int?
    while index + 2 < count {
      if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 {
        if let start {
          // A 4-byte start code's leading zero belongs to it, not to the unit before.
          var end = index
          while end > start, bytes[end - 1] == 0 { end -= 1 }
          if end > start { ranges.append(start..<end) }
        }
        index += 3
        start = index
      } else {
        index += 1
      }
    }
    if let start, start < count {
      var end = count
      while end > start, bytes[end - 1] == 0 { end -= 1 }
      if end > start { ranges.append(start..<end) }
    }
    return ranges
  }

  /// The NAL units of an Annex B stream, without their start codes (3 or 4 bytes).
  static func units(of data: Data) -> [Data] {
    data.withUnsafeBytes { bytes in
      unitRanges(in: bytes).map { Data(bytes[$0]) }
    }
  }

  static func formatDescription(_ sets: [Data]) -> CMVideoFormatDescription? {
    let kinds = Set(sets.map { ($0[$0.startIndex] >> 1) & 0x3f })
    guard kinds.isSuperset(of: [32, 33, 34]) else { return nil }
    let copies = sets.map { set -> UnsafeMutablePointer<UInt8> in
      let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: set.count)
      set.copyBytes(to: pointer, count: set.count)
      return pointer
    }
    defer { copies.forEach { $0.deallocate() } }
    let pointers = copies.map { UnsafePointer($0) }
    let sizes = sets.map(\.count)
    var format: CMVideoFormatDescription?
    let status = CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator: nil, parameterSetCount: sets.count, parameterSetPointers: pointers,
                                                                     parameterSetSizes: sizes, nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &format)
    return status == noErr ? format : nil
  }

  /// Single-pass write straight into CMBlockBuffer memory — avoids 2 intermediate full-frame Data copies at 120 fps.
  private static func sample(from data: Data, ranges: [Range<Int>], totalLength: Int, format: CMVideoFormatDescription) -> CMSampleBuffer? {
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: totalLength, blockAllocator: kCFAllocatorDefault,
                                             customBlockSource: nil, offsetToData: 0, dataLength: totalLength, flags: kCMBlockBufferAssureMemoryNowFlag,
                                             blockBufferOut: &block) == kCMBlockBufferNoErr, let block else { return nil }
    var dstPtr: UnsafeMutablePointer<CChar>?
    var availableLength = 0
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &availableLength, totalLengthOut: nil, dataPointerOut: &dstPtr) == kCMBlockBufferNoErr,
          let dst = dstPtr, availableLength >= totalLength else { return nil }
    data.withUnsafeBytes { bytes in
      guard let srcBase = bytes.baseAddress else { return }
      var offset = 0
      for range in ranges {
        var lenBE = UInt32(range.count).bigEndian
        memcpy(dst.advanced(by: offset), &lenBE, 4)
        offset += 4
        memcpy(dst.advanced(by: offset), srcBase.advanced(by: range.lowerBound), range.count)
        offset += range.count
      }
    }
    var sample: CMSampleBuffer?
    var size = totalLength
    guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 0,
                                    sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample) == noErr else { return nil }
    return sample
  }
}
