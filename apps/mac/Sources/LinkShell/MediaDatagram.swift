import CryptoKit
import Foundation

/// Transport experiments only. A fresh key belongs to one loopback run; this is not a remote
/// handshake or a replacement for the host's authenticated pairing/signalling protocol.
final class MediaDatagramCipher {
  enum Failure: Error { case malformed, replay, exhausted }
  static let maximumPacket = 1200
  static let maximumPayload = maximumPacket - 16 - 16
  private let key: SymmetricKey
  private let direction: UInt32
  private var sequence: UInt64 = 0
  private var replay = MediaReplayWindow()

  init(secret: SymmetricKey, direction: UInt32) {
    self.direction = direction
    key = HKDF<SHA256>.deriveKey(inputKeyMaterial: secret, salt: Data("linkshell-media-lab/v1".utf8),
      info: Data("direction-\(direction)".utf8), outputByteCount: 32)
  }

  func seal(_ payload: Data) throws -> Data {
    guard payload.count <= Self.maximumPayload else { throw Failure.malformed }
    guard sequence < UInt64.max else { throw Failure.exhausted }
    sequence += 1
    var header = Data()
    header.mediaAppend(UInt32(0x4c534d44)); header.mediaAppend(direction); header.mediaAppend(sequence)
    var nonce = Data(); nonce.mediaAppend(direction); nonce.mediaAppend(sequence)
    let sealed = try ChaChaPoly.seal(payload, using: key, nonce: ChaChaPoly.Nonce(data: nonce), authenticating: header)
    return header + sealed.ciphertext + sealed.tag
  }

  func open(_ packet: Data) throws -> Data {
    guard packet.count >= 32, packet.count <= Self.maximumPacket else { throw Failure.malformed }
    var reader = MediaReader(packet)
    guard reader.uint32() == 0x4c534d44, reader.uint32() == direction, let sequence = reader.uint64() else { throw Failure.malformed }
    guard replay.containsNew(sequence) else { throw Failure.replay }
    var nonce = Data(); nonce.mediaAppend(direction); nonce.mediaAppend(sequence)
    let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce),
      ciphertext: packet.dropFirst(16).dropLast(16), tag: packet.suffix(16))
    let opened = try ChaChaPoly.open(box, using: key, authenticating: packet.prefix(16))
    // An unauthenticated counter must never move the replay window.
    replay.insert(sequence)
    return opened
  }
}

/// A bounded 256-packet window accepts limited reordering without accepting a packet twice.
struct MediaReplayWindow {
  private var highest: UInt64 = 0
  private var words: [UInt64] = [0, 0, 0, 0]
  func containsNew(_ value: UInt64) -> Bool {
    guard value > 0 else { return false }
    if value > highest { return true }
    let distance = highest - value
    return distance < 256 && words[Int(distance / 64)] & (1 << (distance % 64)) == 0
  }
  mutating func insert(_ value: UInt64) {
    guard containsNew(value) else { return }
    if value > highest {
      let shift = value - highest
      if shift >= 256 { words = [0, 0, 0, 0] }
      else {
        let whole = Int(shift / 64), bits = Int(shift % 64)
        let old = words
        for index in 0..<4 {
          let source = index - whole
          words[index] = source >= 0 ? old[source] << bits : 0
          if bits > 0, source > 0 { words[index] |= old[source - 1] >> (64 - bits) }
        }
      }
      highest = value
    }
    let distance = highest - value
    words[Int(distance / 64)] |= 1 << (distance % 64)
  }
}

struct MediaFrame: Equatable {
  let id: UInt32
  let previous: UInt32
  let capturedNs: UInt64
  let flags: UInt8
  let data: Data
  var key: Bool { flags & 1 != 0 }
  var refresh: Bool { flags & 2 != 0 }
  var reference: Bool { flags & 4 != 0 }
  var independent: Bool { key || refresh }
  static let maximumBytes = 4 * 1024 * 1024
  static let fragmentBytes = MediaDatagramCipher.maximumPayload - 26 - 8

  func fragments() -> [Data] {
    guard !data.isEmpty, data.count <= Self.maximumBytes else { return [] }
    let count = (data.count + Self.fragmentBytes - 1) / Self.fragmentBytes
    return (0..<count).map { index in
      var packet = Data([1, flags])
      packet.mediaAppend(id); packet.mediaAppend(previous); packet.mediaAppend(capturedNs)
      packet.mediaAppend(UInt16(index)); packet.mediaAppend(UInt16(count)); packet.mediaAppend(UInt32(data.count))
      packet.append(data.subdata(in: index * Self.fragmentBytes..<min(data.count, (index + 1) * Self.fragmentBytes)))
      return packet
    }
  }
}

/// Incomplete frames are bounded in count, bytes and age. Complete P frames are released only
/// after their predecessor; an authenticated IDR/LTR refresh can replace an abandoned chain.
struct MediaFrameAssembler {
  private struct Assembly {
    let id: UInt32, previous: UInt32, captured: UInt64, flags: UInt8, bytes: Int
    let arrived: Double
    var pieces: [Data?]
    var received = 0
  }
  private var pending: [UInt32: Assembly] = [:]
  private var complete: [UInt32: MediaFrame] = [:]
  private(set) var rejected = 0
  private(set) var expired = 0
  var bufferedBytes: Int { pending.values.reduce(0) { $0 + $1.bytes } + complete.values.reduce(0) { $0 + $1.data.count } }
  var bufferedFrames: Int { pending.count + complete.count }

  mutating func receive(_ packet: Data, at now: Double) {
    expire(at: now)
    var reader = MediaReader(packet)
    guard reader.uint8() == 1, let flags = reader.uint8(), flags & ~7 == 0,
          let id = reader.uint32(), id > 0, let previous = reader.uint32(), previous < id,
          let captured = reader.uint64(), let index = reader.uint16(), let count = reader.uint16(),
          let bytes = reader.uint32(), bytes > 0, bytes <= MediaFrame.maximumBytes,
          count == (Int(bytes) + MediaFrame.fragmentBytes - 1) / MediaFrame.fragmentBytes,
          index < count else { rejected += 1; return }
    let part = reader.rest
    guard Double(captured) / 1e9 <= now + 0.01, Double(captured) / 1e9 >= max(0, now - 0.8) else { expired += 1; return }
    let expected = min(MediaFrame.fragmentBytes, Int(bytes) - Int(index) * MediaFrame.fragmentBytes)
    guard part.count == expected, complete[id] == nil else { rejected += 1; return }
    if pending[id] == nil {
      if flags & 3 != 0 {
        // Make room for the frame that can end a loss episode; incomplete old deltas must
        // not occupy every assembly slot until their timeouts while blocking that refresh.
        pending = pending.filter { $0.key >= id }
        complete = complete.filter { $0.key >= id }
      }
      guard bufferedFrames < 8, bufferedBytes + Int(bytes) <= MediaFrame.maximumBytes else { rejected += 1; return }
      pending[id] = Assembly(id: id, previous: previous, captured: captured, flags: flags,
        bytes: Int(bytes), arrived: now, pieces: Array(repeating: nil, count: Int(count)))
    }
    guard var frame = pending[id], frame.previous == previous, frame.captured == captured,
          frame.flags == flags, frame.bytes == bytes, frame.pieces.count == count else { rejected += 1; return }
    guard frame.pieces[Int(index)] == nil else { return }
    frame.pieces[Int(index)] = part; frame.received += 1
    if frame.received == frame.pieces.count {
      pending[id] = nil
      var bytes = Data(); bytes.reserveCapacity(frame.bytes)
      for piece in frame.pieces { bytes.append(piece!) }
      complete[id] = MediaFrame(id: id, previous: previous, capturedNs: captured, flags: flags, data: bytes)
    } else { pending[id] = frame }
  }

  mutating func take(after previous: UInt32, needsRefresh: Bool) -> MediaFrame? {
    let latestRefresh = complete.values.filter { $0.id > previous && $0.independent }.max { $0.id < $1.id }
    let next = complete.values.filter { $0.id > previous && $0.previous == previous }.min { $0.id < $1.id }
    guard let frame = latestRefresh ?? (needsRefresh ? nil : next) else { return nil }
    complete = complete.filter { $0.key > frame.id }
    pending = pending.filter { $0.key > frame.id }
    return frame
  }

  mutating func expire(at now: Double) {
    let old = pending.count
    pending = pending.filter { now - $0.value.arrived <= 0.8 }
    expired += old - pending.count
    let cutoff = max(0, now - 0.8) * 1e9
    let ready = complete.count
    complete = complete.filter { Double($0.value.capturedNs) >= cutoff }
    expired += ready - complete.count
  }
}

struct MediaReader {
  private let bytes: [UInt8]
  private var index = 0
  init(_ data: Data) { bytes = Array(data) }
  mutating func uint8() -> UInt8? { guard index < bytes.count else { return nil }; defer { index += 1 }; return bytes[index] }
  private mutating func integer(_ size: Int) -> UInt64? {
    guard index + size <= bytes.count else { return nil }
    var value: UInt64 = 0
    for _ in 0..<size { value = (value << 8) | UInt64(bytes[index]); index += 1 }
    return value
  }
  mutating func uint16() -> UInt16? { integer(2).map(UInt16.init) }
  mutating func uint32() -> UInt32? { integer(4).map(UInt32.init) }
  mutating func uint64() -> UInt64? { integer(8) }
  var rest: Data { Data(bytes.dropFirst(index)) }
}

extension Data {
  mutating func mediaAppend<T: FixedWidthInteger>(_ value: T) {
    var big = value.bigEndian
    Swift.withUnsafeBytes(of: &big) { append(contentsOf: $0) }
  }
}
