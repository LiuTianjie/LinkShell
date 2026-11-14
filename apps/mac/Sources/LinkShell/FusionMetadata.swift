import CoreVideo
import Foundation

/// Fusion (experimental): where the fused windows were in one picture of a display, carried with
/// that picture from capture to presentation so a window is always cut from the frame it was in.
///
/// Capture notes it on the pixel buffer; the low-latency H.264 encoder puts it in an SEI
/// (user data unregistered) ahead of the picture; the desktop decoder reads it back and notes it
/// on the decoded buffer. Ordinary screen sharing never sets it, and nothing changes there.
enum FusionMetadata {
  static let key = "LinkShellFusionLayout" as CFString
  /// Readers decode it only in the fusion lab.
  static var enabled = false
  private static let uuid = Array("LinkShellFusion1".utf8)

  static func attach(_ json: Data, to buffer: CVPixelBuffer) {
    CVBufferSetAttachment(buffer, key, json as CFData, .shouldNotPropagate)
  }

  static func layout(of buffer: CVPixelBuffer) -> Data? {
    CVBufferCopyAttachment(buffer, key, nil) as? Data
  }

  /// An SEI NAL unit in front of the access unit (as `MediaStageProbe` does): H.264 type 6, or
  /// HEVC's prefix SEI (type 39, two-byte header).
  static func attaching(_ json: Data, to data: Data, hevc: Bool = false) -> Data {
    let payload = uuid + Array(json)
    var rbsp: [UInt8] = [5]
    var size = payload.count
    while size >= 255 { rbsp.append(255); size -= 255 }
    rbsp.append(UInt8(size))
    rbsp += payload
    rbsp.append(0x80)
    var sei = Data(hevc ? [0, 0, 0, 1, 39 << 1, 1] : [0, 0, 0, 1, 6]); var zeros = 0
    for byte in rbsp {
      if zeros >= 2, byte <= 3 { sei.append(3); zeros = 0 }
      sei.append(byte); zeros = byte == 0 ? zeros + 1 : 0
    }
    sei.append(data)
    return sei
  }

  static func layout(in data: Data) -> Data? {
    let bytes = Array(data.prefix(16_384))
    var index = 0
    var starts: [Int] = []
    while index + 3 < bytes.count {
      if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 { starts.append(index + 3); index += 3 } else { index += 1 }
    }
    for (offset, start) in starts.enumerated() where start + 1 < bytes.count {
      let header: Int
      if (bytes[start] >> 1) & 63 == 39 { header = 2 } else if bytes[start] & 31 == 6 { header = 1 } else { continue }
      let end = offset + 1 < starts.count ? starts[offset + 1] - 3 : bytes.count
      guard end > start + header else { continue }
      var rbsp: [UInt8] = []; var zeros = 0
      for byte in bytes[(start + header)..<end] {
        if zeros >= 2, byte == 3 { zeros = 0; continue }
        rbsp.append(byte); zeros = byte == 0 ? zeros + 1 : 0
      }
      guard rbsp.first == 5 else { continue }
      var cursor = 1, size = 0
      while cursor < rbsp.count, rbsp[cursor] == 255 { size += 255; cursor += 1 }
      guard cursor < rbsp.count else { continue }
      size += Int(rbsp[cursor]); cursor += 1
      guard size >= 16, cursor + size <= rbsp.count, Array(rbsp[cursor..<(cursor + 16)]) == uuid else { continue }
      return Data(rbsp[(cursor + 16)..<(cursor + size)])
    }
    return nil
  }
}
