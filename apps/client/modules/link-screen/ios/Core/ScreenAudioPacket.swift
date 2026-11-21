import Foundation

/// Wire constants matching `packages/wire/src/screen-audio.ts`:
/// `[u8 version=1][u8 codec][u16 seq BE][u32 timestampMs BE][payload]`
enum ScreenAudioConstants {
  static let version: UInt8 = 1
  static let codecOpus: UInt8 = 1
  static let codecPCM16: UInt8 = 2
  static let sampleRate: Int = 48_000
  static let channels: Int = 2
  static let frameMs: Int = 20
  static let frameSamples: Int = sampleRate * frameMs / 1000 // 960 frames
  static let headerBytes: Int = 8
  static let pcm16FrameBytes: Int = frameSamples * channels * MemoryLayout<Int16>.size // 3840 bytes
  static let maxPacketBytes: Int = 65_536
}

enum ScreenAudioCodec: UInt8, Equatable {
  case opus = 1
  case pcm16 = 2
}

struct ScreenAudioPacket: Equatable {
  let version: UInt8
  let codec: ScreenAudioCodec
  let seq: UInt16
  let timestampMs: UInt32
  let payload: Data

  init(
    version: UInt8 = ScreenAudioConstants.version,
    codec: ScreenAudioCodec,
    seq: UInt16,
    timestampMs: UInt32,
    payload: Data
  ) {
    self.version = version
    self.codec = codec
    self.seq = seq
    self.timestampMs = timestampMs
    self.payload = payload
  }

  func encode() -> Data {
    var out = Data(capacity: ScreenAudioConstants.headerBytes + payload.count)
    out.append(version)
    out.append(codec.rawValue)
    out.append(UInt8(truncatingIfNeeded: seq >> 8))
    out.append(UInt8(truncatingIfNeeded: seq))
    out.append(UInt8(truncatingIfNeeded: timestampMs >> 24))
    out.append(UInt8(truncatingIfNeeded: timestampMs >> 16))
    out.append(UInt8(truncatingIfNeeded: timestampMs >> 8))
    out.append(UInt8(truncatingIfNeeded: timestampMs))
    out.append(payload)
    return out
  }

  static func decode(_ data: Data) -> ScreenAudioPacket? {
    guard data.count >= ScreenAudioConstants.headerBytes else { return nil }
    let start = data.startIndex
    let version = data[start]
    guard version == ScreenAudioConstants.version,
          let codec = ScreenAudioCodec(rawValue: data[start + 1]) else {
      return nil
    }
    let seq = (UInt16(data[start + 2]) << 8) | UInt16(data[start + 3])
    let timestampMs = (UInt32(data[start + 4]) << 24)
      | (UInt32(data[start + 5]) << 16)
      | (UInt32(data[start + 6]) << 8)
      | UInt32(data[start + 7])
    let payload = Data(data[(start + ScreenAudioConstants.headerBytes)...])
    return ScreenAudioPacket(version: version, codec: codec, seq: seq, timestampMs: timestampMs, payload: payload)
  }
}
