import Foundation
import CoreVideo
import WebRTC

/// Exact encoder-input to decoded-frame matching for the single-session loopback tools. No
/// pixels are retained, and this is entirely off in normal use. This is not glass-to-glass time.
final class MediaStageProbe {
  static let enabled = Launch.has("--media-probe") && Launch.has("--loopback")
  static let shared = MediaStageProbe()
  private let lock = NSLock()
  private var frames: [UInt32: Double] = [:]
  private var ages: [Double] = []
  private var missing = 0
  private var references: [UInt64: MediaQuality] = [:]
  private var receivedReferences: [UInt32: UInt64] = [:]
  private var quality: [MediaQuality.Difference] = []

  /// RTP adds a random timestamp offset. Carry the measurement in an unregistered H.264 SEI
  /// instead of assuming sender and receiver RTP counters have the same origin.
  static func attaching(to data: Data, began: Double) -> Data {
    var payload = Data("LinkShellStage01".utf8)
    payload.mediaAppend(UInt64(began * 1e9))
    let rbsp = [UInt8(5), UInt8(payload.count)] + Array(payload) + [0x80]
    var sei = Data([0, 0, 0, 1, 6]); var zeros = 0
    for byte in rbsp {
      if zeros >= 2, byte <= 3 { sei.append(3); zeros = 0 }
      sei.append(byte); zeros = byte == 0 ? zeros + 1 : 0
    }
    sei.append(data)
    return sei
  }

  static func began(in data: Data) -> Double? {
    referenceKey(in: data).map { Double($0) / 1e9 }
  }

  private static func referenceKey(in data: Data) -> UInt64? {
    let bytes = Array(data.prefix(512))
    var starts: [Int] = []
    var index = 0
    while index + 3 < bytes.count {
      if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 { starts.append(index + 3); index += 3 }
      else { index += 1 }
    }
    for (offset, start) in starts.enumerated() where bytes[start] & 31 == 6 {
      let end = offset + 1 < starts.count ? starts[offset + 1] - 3 : bytes.count
      var rbsp: [UInt8] = []; var zeros = 0
      for byte in bytes[(start + 1)..<end] {
        if zeros >= 2, byte == 3 { zeros = 0; continue }
        rbsp.append(byte); zeros = byte == 0 ? zeros + 1 : 0
      }
      guard rbsp.count >= 26, rbsp[0] == 5, rbsp[1] == 24,
            Array(rbsp[2..<18]) == Array("LinkShellStage01".utf8) else { continue }
      var reader = MediaReader(Data(rbsp[18..<26]))
      return reader.uint64()
    }
    return nil
  }

  func reference(_ buffer: CVPixelBuffer, began: Double) {
    guard Self.enabled, Launch.has("--media-quality"), let picture = MediaQuality(buffer) else { return }
    lock.lock(); defer { lock.unlock() }
    if references.count >= 64, let oldest = references.keys.min() { references[oldest] = nil }
    references[UInt64(began * 1e9)] = picture
  }

  func decodedPicture(_ timestamp: UInt32, buffer: CVPixelBuffer) {
    guard Launch.has("--media-quality") else { return }
    lock.lock()
    let key = receivedReferences.removeValue(forKey: timestamp)
    let reference = key.flatMap { references.removeValue(forKey: $0) }
    lock.unlock()
    guard let reference, let picture = MediaQuality(buffer), let difference = reference.compare(picture) else { return }
    lock.lock(); quality.append(difference); lock.unlock()
  }

  func decoding(_ timestamp: UInt32, data: Data) {
    guard Self.enabled, let key = Self.referenceKey(in: data) else { return }
    let began = Double(key) / 1e9
    guard began <= ProcessInfo.processInfo.systemUptime else { return }
    lock.lock(); defer { lock.unlock() }
    if frames.count >= 2048 {
      let cutoff = ProcessInfo.processInfo.systemUptime - 15
      frames = frames.filter { $0.value >= cutoff }
      if frames.count >= 2048, let oldest = frames.min(by: { $0.value < $1.value }) { frames[oldest.key] = nil }
    }
    frames[timestamp] = began
    if references[key] != nil {
      receivedReferences = receivedReferences.filter { references[$0.value] != nil }
      receivedReferences[timestamp] = key
    }
  }

  func decoded(_ timestamp: UInt32) {
    guard Self.enabled else { return }
    let now = ProcessInfo.processInfo.systemUptime
    lock.lock(); defer { lock.unlock() }
    guard let began = frames.removeValue(forKey: timestamp) else { missing += 1; return }
    if ages.count < 512 { ages.append(max(0, now - began) * 1000) }
  }

  func take() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    let sorted = ages.sorted()
    let pixels = MediaQuality.report(quality)
    defer { ages.removeAll(keepingCapacity: true); quality.removeAll(keepingCapacity: true); missing = 0 }
    guard !sorted.isEmpty else { return ["n": 0, "unmatched": missing, "quality": pixels] }
    func at(_ q: Double) -> Double { sorted[min(sorted.count - 1, Int(ceil(Double(sorted.count) * q)) - 1)] }
    return ["n": sorted.count, "unmatched": missing, "meanMs": sorted.reduce(0, +) / Double(sorted.count),
      "p50Ms": at(0.5), "p95Ms": at(0.95), "maxMs": sorted.last!, "quality": pixels]
  }
}

final class MediaProbeDecoderFactory: NSObject, RTCVideoDecoderFactory {
  private let stock = RTCDefaultVideoDecoderFactory()
  func supportedCodecs() -> [RTCVideoCodecInfo] { stock.supportedCodecs() }
  func createDecoder(_ info: RTCVideoCodecInfo) -> RTCVideoDecoder? {
    guard let decoder = stock.createDecoder(info) else { return nil }
    return MediaProbeDecoder(decoder)
  }
}

private final class MediaProbeDecoder: NSObject, RTCVideoDecoder {
  private let decoder: RTCVideoDecoder
  init(_ decoder: RTCVideoDecoder) { self.decoder = decoder }
  func setCallback(_ callback: @escaping RTCVideoDecoderCallback) {
    decoder.setCallback { frame in
      if let native = frame.buffer as? RTCCVPixelBuffer {
        MediaStageProbe.shared.decodedPicture(UInt32(bitPattern: frame.timeStamp), buffer: native.pixelBuffer)
      }
      callback(frame)
    }
  }
  func startDecode(withNumberOfCores cores: Int32) -> Int { decoder.startDecode(withNumberOfCores: cores) }
  func release() -> Int { decoder.release() }
  func implementationName() -> String { decoder.implementationName() }
  func decode(_ image: RTCEncodedImage, missingFrames: Bool, codecSpecificInfo info: RTCCodecSpecificInfo?, renderTimeMs: Int64) -> Int {
    MediaStageProbe.shared.decoding(image.timeStamp, data: image.buffer)
    return decoder.decode(image, missingFrames: missingFrames, codecSpecificInfo: info, renderTimeMs: renderTimeMs)
  }
}
