import Foundation

/// The bits of a NAL unit after its one-byte header, without the bytes that keep start codes
/// out of it (the 03 in 00 00 03). Reading past the end gives zeros and sets `ended`.
struct Bits {
  /// The payload, unescaped.
  private(set) var bytes: [UInt8] = []
  /// How many bits have been read.
  private(set) var position = 0
  private(set) var ended = false

  init<Bytes: Collection>(_ unit: Bytes) where Bytes.Element == UInt8 {
    var zeros = 0
    for byte in unit.dropFirst() {
      if zeros >= 2, byte == 3 {
        zeros = 0
        continue
      }
      zeros = byte == 0 ? zeros + 1 : 0
      bytes.append(byte)
    }
  }

  mutating func u(_ count: Int) -> Int {
    var value = 0
    for _ in 0..<count {
      guard position >> 3 < bytes.count else {
        ended = true
        return 0
      }
      value = value << 1 | Int(bytes[position >> 3] >> (7 - UInt8(position & 7)) & 1)
      position += 1
    }
    return value
  }

  mutating func skip(_ count: Int) {
    _ = u(count)
  }

  /// An unsigned Exp-Golomb number.
  @discardableResult
  mutating func ue() -> Int {
    var zeros = 0
    while u(1) == 0 {
      zeros += 1
      if ended || zeros > 31 {
        ended = true
        return 0
      }
    }
    return (1 << zeros) - 1 + u(zeros)
  }

  /// A signed one.
  @discardableResult
  mutating func se() -> Int {
    let code = ue()
    return code % 2 == 1 ? (code + 1) / 2 : -code / 2
  }
}

/// Bits written one after another, for a NAL unit's payload.
struct BitWriter {
  private var bytes: [UInt8] = []
  private var count = 0

  mutating func put(_ value: Int, bits: Int) {
    for shift in stride(from: bits - 1, through: 0, by: -1) {
      if count & 7 == 0 { bytes.append(0) }
      if value >> shift & 1 == 1 { bytes[count >> 3] |= 0x80 >> UInt8(count & 7) }
      count += 1
    }
  }

  /// An unsigned Exp-Golomb number.
  mutating func ue(_ value: Int) {
    let coded = value + 1
    let length = Int.bitWidth - coded.leadingZeroBitCount
    put(0, bits: length - 1)
    put(coded, bits: length)
  }

  /// The first `bits` bits of a payload, as they are.
  mutating func copy(_ payload: [UInt8], bits: Int) {
    for index in 0..<bits { put(Int(payload[index >> 3] >> (7 - UInt8(index & 7)) & 1), bits: 1) }
  }

  /// The payload ended as the standard ends one (a 1, then zeros to the byte), with the bytes
  /// put back that keep start codes out of it.
  func finished() -> [UInt8] {
    var ending = self
    ending.put(1, bits: 1)
    var escaped: [UInt8] = []
    var zeros = 0
    for byte in ending.bytes {
      if zeros >= 2, byte <= 3 {
        escaped.append(3)
        zeros = 0
      }
      zeros = byte == 0 ? zeros + 1 : 0
      escaped.append(byte)
    }
    return escaped
  }
}
