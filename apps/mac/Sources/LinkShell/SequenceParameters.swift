import Foundation

/// A sequence parameter set made to say that frames are shown in the order they come
/// (`max_num_reorder_frames` 0, in the VUI's bitstream restriction; ITU-T H.264 §E.1.1).
///
/// VideoToolbox's usual encoder never reorders when told not to, but doesn't say so in the
/// stream, and a decoder that isn't told may hold frames back until it is sure: Chrome's held
/// six of a 1600×900 stream, as many as the level allows a decoder to buffer — at 20 frames a
/// second, 300 ms. libwebrtc rewrites the parameter set the same way for the streams it sends
/// (SpsVuiRewriter). The low-latency encoder says it itself.
enum SequenceParameters {
  /// Nil when the set says it already, or isn't one the encoder would write.
  static func statingNoReordering<Bytes: Collection>(_ sps: Bytes) -> [UInt8]? where Bytes.Element == UInt8 {
    guard let header = sps.first else { return nil }
    var bits = Bits(sps)
    let profile = bits.u(8)
    bits.skip(16)
    bits.ue()
    if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(profile) {
      if bits.ue() == 3 { bits.skip(1) }
      bits.ue()
      bits.ue()
      bits.skip(1)
      // Scaling matrices: the encoder writes none.
      if bits.u(1) == 1 { return nil }
    }
    bits.ue()
    let pocType = bits.ue()
    if pocType == 0 {
      bits.ue()
    } else if pocType == 1 {
      bits.skip(1)
      bits.se()
      bits.se()
      for _ in 0..<bits.ue() { bits.se() }
    }
    let references = bits.ue()
    bits.skip(1)
    bits.ue()
    bits.ue()
    if bits.u(1) == 0 { bits.skip(1) }
    bits.skip(1)
    if bits.u(1) == 1 { for _ in 0..<4 { bits.ue() } }

    var writer = BitWriter()
    let vuiAt = bits.position
    if bits.u(1) == 0 {
      guard !bits.ended else { return nil }
      // No VUI at all: one with nothing in it but the restriction.
      writer.copy(bits.bytes, bits: vuiAt)
      writer.put(1, bits: 1)
      writer.put(0, bits: 8)
    } else {
      // Aspect ratio, overscan, video signal (with the colours), chroma location, timing.
      if bits.u(1) == 1, bits.u(8) == 255 { bits.skip(32) }
      if bits.u(1) == 1 { bits.skip(1) }
      if bits.u(1) == 1 {
        bits.skip(4)
        if bits.u(1) == 1 { bits.skip(24) }
      }
      if bits.u(1) == 1 {
        bits.ue()
        bits.ue()
      }
      if bits.u(1) == 1 {
        bits.skip(32)
        bits.skip(33)
      }
      // The two buffer models, then the picture structure flag.
      var models = 0
      for _ in 0..<2 where bits.u(1) == 1 {
        models += 1
        let count = bits.ue() + 1
        bits.skip(8)
        for _ in 0..<count {
          bits.ue()
          bits.ue()
          bits.skip(1)
        }
        bits.skip(20)
      }
      if models > 0 { bits.skip(1) }
      bits.skip(1)
      let restrictionAt = bits.position
      guard bits.u(1) == 0, !bits.ended else { return nil }
      writer.copy(bits.bytes, bits: restrictionAt)
    }
    // The restriction: motion vectors may leave the picture; no limit on a picture's bytes (the
    // values that mean "unknown" are libwebrtc's too: 2, 1); vectors up to 2^16; nothing shown
    // out of order; and no more frames kept than are referred to.
    writer.put(1, bits: 1)
    writer.put(1, bits: 1)
    writer.ue(2)
    writer.ue(1)
    writer.ue(16)
    writer.ue(16)
    writer.ue(0)
    writer.ue(max(references, 1))
    return [header] + writer.finished()
  }
}
