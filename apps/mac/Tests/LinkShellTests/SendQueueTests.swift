import CoreVideo
import WebRTC
import XCTest
@testable import LinkShell

/// The sender's queue as the encoder reckons it, and what is not encoded behind it.
final class SendQueueTests: XCTestCase {
  func testAnOrdinaryFrameLeavesAtOnce() {
    var queue = SendQueue()
    queue.set(encoderRate: 8_000_000, now: 0)
    // 8 Mbit/s at 60 frames: 16.7 KB a frame, gone in two fifths of a frame's time.
    queue.made(bytes: 16_700, now: 0)
    XCTAssertEqual(queue.wait(now: 0) * 1000, 6.7, accuracy: 0.1)
    XCTAssertEqual(queue.wait(now: 1.0 / 60), 0)
  }

  func testALargeFrameTakesItsSizeOverThePacersRate() {
    var queue = SendQueue()
    queue.set(encoderRate: 8_000_000, now: 0)
    queue.made(bytes: 300_000, now: 0)
    XCTAssertEqual(queue.wait(now: 0) * 1000, 120, accuracy: 0.1)
    XCTAssertGreaterThan(queue.wait(now: 0.069) * 1000, Tuning.sendQueueAdmitMs)
    XCTAssertLessThan(queue.wait(now: 0.071) * 1000, Tuning.sendQueueAdmitMs)
    XCTAssertEqual(queue.wait(now: 1), 0)
  }

  func testAFallenRateEmptiesTheSameQueueSlower() {
    var queue = SendQueue()
    queue.set(encoderRate: 8_000_000, now: 0)
    queue.made(bytes: 300_000, now: 0)
    // Half of it has gone when the estimate falls to a quarter.
    queue.set(encoderRate: 2_000_000, now: 0.06)
    XCTAssertEqual(queue.wait(now: 0.06) * 1000, 240, accuracy: 0.5)
    // And it is never reckoned slower than the lowest rate allows.
    queue.set(encoderRate: 0, now: 0.06)
    XCTAssertEqual(queue.rate, Double(Tuning.sendQueueLowestRate) * Tuning.pacerFactor)
  }

  func testAKeyFramesBudgetIsAFifthOfASecondOfTheRate() {
    XCTAssertEqual(Tuning.keyFrameBudget(bitrate: 8_000_000), 200_000)
    XCTAssertEqual(Tuning.keyFrameBudget(bitrate: 2_000_000), 50_000)
    XCTAssertEqual(Tuning.keyFrameBudget(bitrate: 0), 1024)
  }

  /// With the real encoder: after a large frame nothing is encoded until it is reckoned sent, a
  /// key frame asked for meanwhile is made then, and without the admission every frame is taken.
  func testNothingIsEncodedBehindALargeFrame() throws {
    for admission in [true, false] {
      var now = 100.0
      let counting = Counting()
      let encoder = LowLatencyH264Encoder(
        info: RTCVideoCodecInfo(name: "H264", parameters: ["profile-level-id": "640c1f", "packetization-mode": "1"]),
        keyBudget: false, queueAdmission: admission, clock: { now },
        makeCompressor: { setup in counting.inner = try VideoCompressor(setup); return counting })
      let sizes = Locked([Int]())
      let came = DispatchSemaphore(value: 0)
      encoder.setCallback { image, _ in sizes.withLock { $0.append(image.buffer.count) }; came.signal(); return true }
      let settings = RTCVideoEncoderSettings()
      settings.name = "H264"; settings.width = 1280; settings.height = 720; settings.maxFramerate = 60
      settings.startBitrate = 1_000; settings.mode = .screensharing
      guard encoder.startEncode(with: settings, numberOfCores: 2) == 0, counting.inner != nil else { throw XCTSkip("no low-latency hardware encoder here") }
      XCTAssertEqual(encoder.setBitrate(1_000, framerate: 60), 0)
      let key = [NSNumber(value: RTCFrameType.videoFrameKey.rawValue)], delta = [NSNumber(value: RTCFrameType.videoFrameDelta.rawValue)]
      // A page of noise: its key frame is many times what 2.5 Mbit/s sends in 50 ms (15 KB).
      XCTAssertEqual(encoder.encode(try Self.noise(1280, 720, at: 1), codecSpecificInfo: nil, frameTypes: key), 0)
      XCTAssertEqual(came.wait(timeout: .now() + 5), .success)
      let first = try XCTUnwrap(sizes.withLock { $0.first })
      try XCTSkipIf(first < 40_000, "the key frame came out too small to queue (\(first) bytes)")
      let reckoned = Double(first * 8) / 2_500_000
      // A frame's time later the queue is still there.
      now += 1.0 / 60
      XCTAssertEqual(encoder.encode(try Self.noise(1280, 720, at: 2), codecSpecificInfo: nil, frameTypes: key), 0)
      if admission {
        XCTAssertEqual(counting.keys.count, 1, "a picture was encoded behind the queue")
      } else {
        // Taken by the encoder; its own rate control may still drop it, to pay for the first.
        XCTAssertEqual(counting.keys.count, 2)
        XCTAssertEqual(encoder.release(), 0)
        continue
      }
      // Once it is reckoned sent, the next picture is taken, as the key frame that was asked for.
      now += reckoned
      XCTAssertEqual(encoder.encode(try Self.noise(1280, 720, at: 3), codecSpecificInfo: nil, frameTypes: delta), 0)
      XCTAssertEqual(counting.keys, [true, true])
      XCTAssertEqual(encoder.release(), 0)
    }
  }

  private final class Counting: ScreenCompression {
    var inner: VideoCompressor?
    var keys: [Bool] = []
    var mode: String { inner?.mode ?? "none" }
    var keyPlan: VideoCompressor.KeyPlan? { get { inner?.keyPlan } set { inner?.keyPlan = newValue } }
    func setRates(bitrate: Int, ceiling: Int?, fps: Int) { inner?.setRates(bitrate: bitrate, ceiling: ceiling, fps: fps) }
    func encode(_ buffer: CVPixelBuffer, at time: CMTime, key: Bool, done: @escaping (Result<VideoCompressor.Frame?, VideoCompressor.Failure>) -> Void) {
      keys.append(key)
      inner?.encode(buffer, at: time, key: key, done: done)
    }
  }

  private static func noise(_ width: Int, _ height: Int, at index: Int64) throws -> RTCVideoFrame {
    var made: CVPixelBuffer?
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary, &made)
    let buffer = try XCTUnwrap(made)
    CVPixelBufferLockBaseAddress(buffer, [])
    var seed = UInt64(index) &* 0x9E3779B97F4A7C15 | 1
    for plane in 0..<2 {
      let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane)!.assumingMemoryBound(to: UInt8.self)
      let count = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane)
      for i in stride(from: 0, to: count, by: 8) {
        seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17
        var word = seed
        memcpy(base + i, &word, min(8, count - i))
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: buffer), rotation: ._0, timeStampNs: index * 16_000_000)
  }
}
