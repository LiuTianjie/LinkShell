import CoreMedia
import CoreVideo
import XCTest
@testable import LinkShell

/// How long the hardware encoder takes over a frame, with and without
/// `PrioritizeEncodingSpeedOverQuality`, on a scrolling page of text-like marks. Needs no screen
/// and no permission; run with `LINKSHELL_ENCODER_BENCH=1 swift test --filter EncoderSpeedBench`.
final class EncoderSpeedBenchTests: XCTestCase {
  func testEncodeTimeWithAndWithoutSpeedFirst() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["LINKSHELL_ENCODER_BENCH"] == "1", "a benchmark, run on request")
    let cases: [(String, Int, Int, Int, Int, CMVideoCodecType)] = [
      ("H264 1920x1080@120", 1920, 1080, 120, 12_000_000, kCMVideoCodecType_H264),
      ("HEVC 1920x1080@120", 1920, 1080, 120, 12_000_000, kCMVideoCodecType_HEVC),
      ("H264 2560x1440@60", 2560, 1440, 60, 14_000_000, kCMVideoCodecType_H264),
      ("HEVC 2560x1440@60", 2560, 1440, 60, 14_000_000, kCMVideoCodecType_HEVC),
    ]
    for (label, width, height, fps, bitrate, codec) in cases {
      let pictures = try Self.pictures(width: width, height: height)
      // Each way twice, turn about: whatever else the encoder is doing meanwhile falls on both.
      for round in 0..<2 {
        for speedFirst in (round == 0 ? [false, true] : [true, false]) {
          let line = try Self.run(pictures, width: width, height: height, fps: fps, bitrate: bitrate, codec: codec, speedFirst: speedFirst)
          print("BENCH \(label) speedFirst=\(speedFirst ? 1 : 0) \(line)")
        }
      }
    }
  }

  /// How large the frames at a change of scene and at a key frame come out, and what a key
  /// frame budget (`LINKSHELL_BENCH_KEY_BUDGET`, bytes) makes of the key frames.
  func testFrameSizesAtASceneChange() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["LINKSHELL_ENCODER_BENCH"] == "1", "a benchmark, run on request")
    let width = 1920, height = 1080, fps = 60
    let bitrate = ProcessInfo.processInfo.environment["LINKSHELL_BENCH_BITRATE"].flatMap(Int.init) ?? 8_000_000
    // LINKSHELL_BENCH_KEY_BUDGET: bytes a key frame may take (`VideoCompressor.keyPlan`).
    let budget = ProcessInfo.processInfo.environment["LINKSHELL_BENCH_KEY_BUDGET"].flatMap(Int.init)
    let first = try Self.pictures(width: width, height: height, seed: 1)
    let second = try Self.pictures(width: width, height: height, seed: 2)
    for codec in [kCMVideoCodecType_H264, kCMVideoCodecType_HEVC] {
      for cap in [Int?.none] {
        let compressor = try VideoCompressor(.init(width: width, height: height, fps: fps, bitrate: bitrate, codec: codec))
        if let budget { compressor.keyPlan = .init(budget: budget, finest: nil) }
        let sizes = Locked([Int: (bytes: Int, key: Bool, dropped: Bool)]())
        let group = DispatchGroup()
        let start = CACurrentMediaTime()
        for index in 0..<240 {
          let wait = start + Double(index) / Double(fps) - CACurrentMediaTime()
          if wait > 0 { Thread.sleep(forTimeInterval: wait) }
          // A new page every half second; a key frame asked for at two and three seconds.
          let page = (index / 30) % 2 == 0 ? first : second
          group.enter()
          compressor.encode(page[index % page.count], at: CMTime(value: Int64(index), timescale: Int32(fps)), key: index == 0 || index == 120 || index == 180) { result in
            sizes.withLock { all in
              if case .success(let frame?) = result { all[index] = (CMSampleBufferGetTotalSampleSize(frame.sample), frame.key, false) }
              else { all[index] = (0, false, true) }
            }
            group.leave()
          }
        }
        group.wait()
        let all = sizes.withLock { $0 }
        let changes = stride(from: 30, to: 240, by: 30).filter { $0 != 120 && $0 != 180 }.compactMap { all[$0]?.bytes }
        let keys = [120, 180].compactMap { all[$0] }.map { "\($0.bytes / 1024)KB\($0.key ? "" : "(not key)")" }
        let steady = all.filter { $0.key % 30 > 5 }.map(\.value.bytes)
        let dropped = all.values.filter(\.dropped).count
        // The most any tenth of a second carried.
        var most = 0
        for from in 30..<234 { most = max(most, (from..<from + 6).reduce(0) { $0 + (all[$1]?.bytes ?? 0) }) }
        print("SIZES \(codec == kCMVideoCodecType_H264 ? "H264" : "HEVC") cap=\(cap.map { "\($0 / 1000)KB/0.1s" } ?? "none") scene changes: \(changes.map { "\($0 / 1024)KB" }.joined(separator: " ")) keys: \(keys.joined(separator: " ")) steady mean \(steady.reduce(0, +) / max(1, steady.count) / 1024)KB most in 0.1s \(most / 1024)KB dropped \(dropped)")
      }
    }
  }

  private static func run(_ pictures: [CVPixelBuffer], width: Int, height: Int, fps: Int, bitrate: Int, codec: CMVideoCodecType, speedFirst: Bool) throws -> String {
    let compressor = try VideoCompressor(.init(width: width, height: height, fps: fps, bitrate: bitrate, codec: codec, speedFirst: speedFirst))
    let results = Locked((times: [Double](), bytes: 0, quantizers: [Int](), largest: 0, dropped: 0))
    let frames = fps * 5 / 2
    let group = DispatchGroup()
    let start = CACurrentMediaTime()
    for index in 0..<frames {
      let due = start + Double(index) / Double(fps)
      let wait = due - CACurrentMediaTime()
      if wait > 0 { Thread.sleep(forTimeInterval: wait) }
      let began = CACurrentMediaTime()
      group.enter()
      compressor.encode(pictures[index % pictures.count], at: CMTime(value: Int64(index), timescale: Int32(fps)), key: index == 0) { result in
        let took = (CACurrentMediaTime() - began) * 1000
        results.withLock { r in
          // The first frames are the session warming up and the key frame.
          guard index >= fps / 2 else { return }
          if case .success(let frame?) = result {
            let size = CMSampleBufferGetTotalSampleSize(frame.sample)
            r.times.append(took); r.bytes += size; r.largest = max(r.largest, size)
            if let q = frame.quantizer { r.quantizers.append(q) }
          } else { r.dropped += 1 }
        }
        group.leave()
      }
    }
    group.wait()
    return results.withLock { r in
      let sorted = r.times.sorted()
      guard !sorted.isEmpty else { return "no frames" }
      let mean = sorted.reduce(0, +) / Double(sorted.count)
      let seconds = Double(sorted.count + r.dropped) / Double(fps)
      let qp = r.quantizers.isEmpty ? "-" : String(format: "%.1f", Double(r.quantizers.reduce(0, +)) / Double(r.quantizers.count))
      return String(format: "mode=%@ mean=%.2fms p50=%.2f p95=%.2f max=%.2f kbit/s=%.0f largest=%dKB qp=%@ dropped=%d",
                    compressor.mode, mean, sorted[sorted.count / 2], sorted[Int(Double(sorted.count) * 0.95)], sorted.last!,
                    Double(r.bytes) * 8 / seconds / 1000, r.largest / 1024, qp, r.dropped)
    }
  }

  /// A page of dark marks on a light ground, at sixty scroll positions (down, then back up).
  private static func pictures(width: Int, height: Int, seed start: UInt64 = 0) throws -> [CVPixelBuffer] {
    let tall = height + 600
    var page = [UInt8](repeating: 235, count: width * tall)
    var seed: UInt64 = 0x9E3779B97F4A7C15 &+ start &* 0x2545F4914F6CDD1D
    func next() -> UInt64 { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; return seed }
    var y = 12
    while y + 14 < tall {
      var x = 24
      let end = width - 24 - Int(next() % UInt64(width / 3))
      while x + 8 < end {
        if next() % 6 != 0 {
          let bits = next()
          for gy in 0..<12 { for gx in 0..<7 where bits >> UInt64((gy * 7 + gx) % 64) & 1 == 1 { page[(y + gy) * width + x + gx] = 30 } }
        }
        x += 9
      }
      y += 20
    }
    let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
    return try (0..<60).map { step in
      let offset = (step < 30 ? step : 60 - step) * 16
      var made: CVPixelBuffer?
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &made)
      let buffer = try XCTUnwrap(made)
      CVPixelBufferLockBaseAddress(buffer, [])
      defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
      let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!
      let lumaRow = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
      page.withUnsafeBufferPointer { source in
        for row in 0..<height { memcpy(luma + row * lumaRow, source.baseAddress! + (row + offset) * width, width) }
      }
      let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)!
      memset(chroma, 128, CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) * CVPixelBufferGetHeightOfPlane(buffer, 1))
      return buffer
    }
  }
}
