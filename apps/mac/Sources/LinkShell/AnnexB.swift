import CoreMedia
import Foundation

/// An encoded frame as a decoder off this Mac wants it: Annex B, each NAL unit behind a start
/// code (00 00 00 01), and in front of a key frame the parameter sets (SPS, PPS) it is decoded
/// with — so that any key frame is a place to begin.
enum AnnexB {
  private static let startCode: [UInt8] = [0, 0, 0, 1]

  /// Whether a frame from the encoder stands by itself.
  static func isKey(_ sample: CMSampleBuffer) -> Bool {
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
    return !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
  }

  /// The frame's access unit, after `reserved` bytes left for the caller to write a header in.
  /// `statingNoReordering`: the sequence parameter set is made to say that frames come in the
  /// order they are shown (`SequenceParameters`), for an encoder that doesn't say it.
  /// Nil for a sample that isn't the H.264 VideoToolbox makes (NAL units behind 4-byte lengths).
  static func accessUnit(_ sample: CMSampleBuffer, key: Bool, reserved: Int = 0, statingNoReordering: Bool = false) -> Data? {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
    let length = CMBlockBufferGetDataLength(block)
    var unit = Data(count: reserved)
    unit.reserveCapacity(reserved + length + 128)

    if key {
      guard let format = CMSampleBufferGetFormatDescription(sample) else { return nil }
      var count = 0
      var lengthSize: Int32 = 0
      guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &lengthSize) == noErr, lengthSize == 4 else { return nil }
      for index in 0..<count {
        var pointer: UnsafePointer<UInt8>?
        var size = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer else { return nil }
        unit.append(contentsOf: startCode)
        // The first set is the sequence's.
        if index == 0, statingNoReordering, let stated = SequenceParameters.statingNoReordering(UnsafeBufferPointer(start: pointer, count: size)) {
          unit.append(contentsOf: stated)
        } else {
          unit.append(pointer, count: size)
        }
      }
    }

    // The frame as the encoder wrote it: each NAL unit behind its length, which is as long as a
    // start code — copied once, and the lengths written over.
    let start = unit.count
    unit.count = start + length
    let whole = unit.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) -> Bool in
      guard let base = bytes.baseAddress, CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base + start) == kCMBlockBufferNoErr else { return false }
      var offset = start
      let end = start + length
      while offset + 4 <= end {
        let size = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
        for index in 0..<4 { bytes[offset + index] = startCode[index] }
        offset += 4 + size
      }
      return offset == end
    }
    return whole ? unit : nil
  }
}
