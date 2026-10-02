import CoreMedia
import Foundation

/// Reads the quantizer an encoded frame starts with out of its first slice header (ITU-T H.264
/// §7.3.3): the one number that says how coarse the frame is — 51 the coarsest. VideoToolbox
/// doesn't say it any other way. It is what sizing a key frame goes by (`VideoCompressor`), and
/// what libwebrtc judges the picture's quality by.
struct SliceQuantizer {
  /// What a slice header can't be read without, from the stream's parameter sets.
  private struct Sets {
    var separatePlanes = false
    var frameNumBits = 0
    var pocType = 0
    var pocBits = 0
    var deltaPocAlwaysZero = false
    var frameMbsOnly = true
    var cabac = false
    var bottomFieldPoc = false
    var redundant = false
    var weighted = false
    var weightedBi = 0
    var initQp = 26
  }

  private var format: CMFormatDescription?
  private var sets: Sets?

  /// Nil for a frame it can't read (a stream using what VideoToolbox's encoder never does).
  mutating func quantizer(of sample: CMSampleBuffer) -> Int? {
    guard let described = CMSampleBufferGetFormatDescription(sample), let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
    if format == nil || !CFEqual(format, described) {
      format = described
      sets = SliceQuantizer.sets(of: described)
    }
    guard let sets else { return nil }
    // The first slice: NAL units behind 4-byte lengths, as VideoToolbox writes them.
    let length = CMBlockBufferGetDataLength(block)
    var offset = 0
    var head = [UInt8](repeating: 0, count: 64)
    while offset + 5 <= length {
      let count = min(head.count, length - offset)
      guard CMBlockBufferCopyDataBytes(block, atOffset: offset, dataLength: count, destination: &head) == kCMBlockBufferNoErr else { return nil }
      let size = Int(head[0]) << 24 | Int(head[1]) << 16 | Int(head[2]) << 8 | Int(head[3])
      let type = head[4] & 0x1f
      if type == 1 || type == 5 {
        var bits = Bits(head[4..<min(count, 4 + size)])
        return SliceQuantizer.quantizer(&bits, sets, idr: type == 5, reference: head[4] & 0x60 != 0)
      }
      offset += 4 + size
    }
    return nil
  }

  private static func sets(of format: CMFormatDescription) -> Sets? {
    func set(_ index: Int) -> Bits? {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer else { return nil }
      return Bits(UnsafeBufferPointer(start: pointer, count: size))
    }
    guard var sps = set(0), var pps = set(1) else { return nil }
    var sets = Sets()

    // The sequence parameter set, as far as the size of the picture.
    let profile = sps.u(8)
    sps.skip(16)
    sps.ue()
    if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(profile) {
      let chroma = sps.ue()
      if chroma == 3 { sets.separatePlanes = sps.u(1) == 1 }
      sps.ue()
      sps.ue()
      sps.skip(1)
      // Scaling matrices: the encoder writes none.
      if sps.u(1) == 1 { return nil }
    }
    sets.frameNumBits = sps.ue() + 4
    sets.pocType = sps.ue()
    if sets.pocType == 0 {
      sets.pocBits = sps.ue() + 4
    } else if sets.pocType == 1 {
      sets.deltaPocAlwaysZero = sps.u(1) == 1
      sps.se()
      sps.se()
      for _ in 0..<sps.ue() { sps.se() }
    }
    sps.ue()
    sps.skip(1)
    sps.ue()
    sps.ue()
    sets.frameMbsOnly = sps.u(1) == 1

    // The picture parameter set.
    pps.ue()
    pps.ue()
    sets.cabac = pps.u(1) == 1
    sets.bottomFieldPoc = pps.u(1) == 1
    // Slice groups: none in the profiles asked for.
    if pps.ue() != 0 { return nil }
    pps.ue()
    pps.ue()
    sets.weighted = pps.u(1) == 1
    sets.weightedBi = pps.u(2)
    sets.initQp = 26 + pps.se()
    pps.se()
    pps.se()
    pps.skip(2)
    sets.redundant = pps.u(1) == 1
    return sps.ended || pps.ended ? nil : sets
  }

  private static func quantizer(_ bits: inout Bits, _ sets: Sets, idr: Bool, reference: Bool) -> Int? {
    bits.ue()
    let kind = bits.ue() % 5
    bits.ue()
    if sets.separatePlanes { bits.skip(2) }
    bits.skip(sets.frameNumBits)
    var field = false
    if !sets.frameMbsOnly {
      field = bits.u(1) == 1
      if field { bits.skip(1) }
    }
    if idr { bits.ue() }
    if sets.pocType == 0 {
      bits.skip(sets.pocBits)
      if sets.bottomFieldPoc, !field { bits.se() }
    } else if sets.pocType == 1, !sets.deltaPocAlwaysZero {
      bits.se()
      if sets.bottomFieldPoc, !field { bits.se() }
    }
    if sets.redundant { bits.ue() }
    // 0 and 3 are predicted from earlier frames (P, SP), 1 from both sides (B), 2 and 4 from nothing.
    let predicted = kind == 0 || kind == 3
    let both = kind == 1
    if both { bits.skip(1) }
    if predicted || both, bits.u(1) == 1 {
      bits.ue()
      if both { bits.ue() }
    }
    for _ in 0..<(both ? 2 : predicted ? 1 : 0) where bits.u(1) == 1 {
      while !bits.ended, bits.ue() != 3 { bits.ue() }
    }
    if (sets.weighted && predicted) || (sets.weightedBi == 1 && both) { return nil }
    if reference {
      if idr {
        bits.skip(2)
      } else if bits.u(1) == 1 {
        while !bits.ended {
          let operation = bits.ue()
          if operation == 0 { break }
          if operation == 1 || operation == 3 { bits.ue() }
          if operation == 2 { bits.ue() }
          if operation == 3 || operation == 6 { bits.ue() }
          if operation == 4 { bits.ue() }
        }
      }
    }
    if sets.cabac, kind != 2, kind != 4 { bits.ue() }
    let quantizer = sets.initQp + bits.se()
    return bits.ended || !(0...51).contains(quantizer) ? nil : quantizer
  }
}
