import CoreVideo
import WebRTC
import XCTest
@testable import LinkShell

final class EncoderTests: XCTestCase {
  private let failure = VideoCompressor.Failure(what: "test encoder failure", status: -12903)
  private let info = RTCVideoCodecInfo(name: "H264", parameters: ["profile-level-id": "640c1f", "packetization-mode": "1"])
  private let delta = [NSNumber(value: RTCFrameType.videoFrameDelta.rawValue)]

  func testBrowserHighUsesTheExistingHighEncoder() {
    let browser = RTCVideoCodecInfo(name: "H264", parameters: ["profile-level-id": "64001f", "packetization-mode": "1"])
    let encoder = LowLatencyH264Encoder(info: browser, makeCompressor: { setup in
      XCTAssertEqual(setup.profile, .high)
      return Compression()
    })
    XCTAssertEqual(encoder.startEncode(with: settings(), numberOfCores: 2), 0)
    XCTAssertEqual(encoder.release(), 0)
  }

  func testInitializationFailureUsesStockAndKeepsTheCallback() {
    let stock = Stock()
    let encoder = LowLatencyH264Encoder(info: info, makeCompressor: { _ in throw self.failure }, makeStock: { _, _ in stock })
    encoder.setCallback { _, _ in true }
    XCTAssertEqual(encoder.startEncode(with: settings(), numberOfCores: 2), 0)
    XCTAssertEqual(stock.starts, 1)
    XCTAssertNotNil(stock.callback)
    XCTAssertEqual(encoder.implementationName(), "test-stock")
  }

  func testUnavailableLowLatencyModeUsesStockAndKeepsTheCallback() {
    let compression = Compression(mode: "real-time")
    let stock = Stock()
    let encoder = LowLatencyH264Encoder(info: info, makeCompressor: { _ in compression }, makeStock: { _, _ in stock })
    encoder.setCallback { _, _ in true }
    XCTAssertEqual(encoder.startEncode(with: settings(), numberOfCores: 2), 0)
    XCTAssertEqual(stock.starts, 1)
    XCTAssertNotNil(stock.callback)
    XCTAssertEqual(encoder.implementationName(), "test-stock")
  }

  func testRuntimeFailureTakesOverWithAKeyFrameAndTheCurrentBitrate() throws {
    let compression = Compression()
    let stock = Stock()
    let encoder = LowLatencyH264Encoder(info: info, makeCompressor: { _ in compression }, makeStock: { _, _ in stock })
    encoder.setCallback { _, _ in true }
    XCTAssertEqual(encoder.startEncode(with: settings(), numberOfCores: 2), 0)
    XCTAssertEqual(encoder.setBitrate(840, framerate: 30), 0)
    let picture = try frame()
    XCTAssertEqual(encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta), 0)
    compression.done?(.failure(failure))
    XCTAssertEqual(encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta), 0)
    XCTAssertEqual(stock.starts, 1)
    XCTAssertEqual(stock.bitrate, 840)
    XCTAssertEqual(stock.framerate, 30)
    XCTAssertEqual(stock.frames.first?.first?.uintValue, RTCFrameType.videoFrameKey.rawValue)
    XCTAssertEqual(encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta), 0)
    XCTAssertEqual(stock.frames.last?.first?.uintValue, RTCFrameType.videoFrameDelta.rawValue)
  }

  func testFailedStockInitializationIsReturnedToWebRTC() throws {
    let compression = Compression()
    let stock = Stock()
    stock.startResult = -13
    let encoder = LowLatencyH264Encoder(info: info, makeCompressor: { _ in compression }, makeStock: { _, _ in stock })
    encoder.setCallback { _, _ in true }
    XCTAssertEqual(encoder.startEncode(with: settings(), numberOfCores: 2), 0)
    let picture = try frame()
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    compression.done?(.failure(failure))
    XCTAssertEqual(encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta), -13)
    XCTAssertTrue(stock.frames.isEmpty)
  }

  func testOldCompressionCallbackDoesNotBreakTheReplacement() throws {
    let compression = Compression()
    let stock = Stock()
    let encoder = LowLatencyH264Encoder(info: info, makeCompressor: { _ in compression }, makeStock: { _, _ in stock })
    encoder.setCallback { _, _ in true }
    _ = encoder.startEncode(with: settings(), numberOfCores: 2)
    let picture = try frame()
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    let old = compression.done
    _ = encoder.release()
    _ = encoder.startEncode(with: settings(), numberOfCores: 2)
    old?(.failure(failure))
    XCTAssertEqual(encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta), 0)
    XCTAssertEqual(stock.starts, 0)
    XCTAssertEqual(encoder.implementationName(), LowLatencyH264Encoder.name)
  }

  func testSlowEncoderCannotAccumulateRawFramesAndKeepsAKeyframeRequest() throws {
    let compression = Compression()
    let encoder = LowLatencyH264Encoder(info: info, makeCompressor: { _ in compression })
    encoder.setCallback { _, _ in true }
    _ = encoder.startEncode(with: settings(), numberOfCores: 2)
    let picture = try frame()
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    let finish = try XCTUnwrap(compression.done)
    for _ in 0..<120 { _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta) }
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: [NSNumber(value: RTCFrameType.videoFrameKey.rawValue)])
    XCTAssertEqual(compression.keys, [false, false])
    finish(.success(nil))
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    XCTAssertEqual(compression.keys, [false, false, true])
  }

  func testDroppedKeyframeIsRequestedAgainOnTheNextAcceptedFrame() throws {
    let compression = Compression()
    let encoder = LowLatencyH264Encoder(info: info, makeCompressor: { _ in compression })
    encoder.setCallback { _, _ in true }
    _ = encoder.startEncode(with: settings(), numberOfCores: 2)
    let picture = try frame()
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: [NSNumber(value: RTCFrameType.videoFrameKey.rawValue)])
    compression.done?(.success(nil))
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    XCTAssertEqual(compression.keys, [true, true])
  }

  func testOldCallbacksDoNotFreeTheNewEncodersSlots() throws {
    let compression = Compression()
    let encoder = LowLatencyH264Encoder(info: info, makeCompressor: { _ in compression })
    encoder.setCallback { _, _ in true }
    _ = encoder.startEncode(with: settings(), numberOfCores: 2)
    let picture = try frame()
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    let old = compression.done
    _ = encoder.startEncode(with: settings(), numberOfCores: 2)
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    old?(.success(nil))
    _ = encoder.encode(picture, codecSpecificInfo: nil, frameTypes: delta)
    XCTAssertEqual(compression.keys.count, 3)
  }

  private func settings() -> RTCVideoEncoderSettings {
    let settings = RTCVideoEncoderSettings()
    settings.name = "H264"
    settings.width = 320
    settings.height = 180
    settings.maxFramerate = 60
    settings.startBitrate = 2_000
    settings.mode = .screensharing
    return settings
  }

  private func frame() throws -> RTCVideoFrame {
    var buffer: CVPixelBuffer?
    XCTAssertEqual(CVPixelBufferCreate(nil, 320, 180, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &buffer), kCVReturnSuccess)
    return RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: try XCTUnwrap(buffer)), rotation: ._0, timeStampNs: 1_000_000)
  }

  private final class Compression: ScreenCompression {
    let mode: String
    var keyPlan: VideoCompressor.KeyPlan?
    init(mode: String = "low-latency") { self.mode = mode }
    var done: ((Result<VideoCompressor.Frame?, VideoCompressor.Failure>) -> Void)?
    var keys: [Bool] = []
    func setRates(bitrate: Int, ceiling: Int?, fps: Int) {}
    func encode(_ buffer: CVPixelBuffer, at time: CMTime, key: Bool, done: @escaping (Result<VideoCompressor.Frame?, VideoCompressor.Failure>) -> Void) {
      self.done = done
      keys.append(key)
    }
  }

  private final class Stock: NSObject, RTCVideoEncoder {
    var callback: RTCVideoEncoderCallback?
    var starts = 0
    var startResult = 0
    var frames: [[NSNumber]] = []
    var bitrate: UInt32?
    var framerate: UInt32?
    func setCallback(_ callback: RTCVideoEncoderCallback?) { self.callback = callback }
    func startEncode(with settings: RTCVideoEncoderSettings, numberOfCores: Int32) -> Int { starts += 1; return startResult }
    func release() -> Int { 0 }
    func encode(_ frame: RTCVideoFrame, codecSpecificInfo info: RTCCodecSpecificInfo?, frameTypes: [NSNumber]) -> Int { frames.append(frameTypes); return 0 }
    func setBitrate(_ bitrateKbit: UInt32, framerate: UInt32) -> Int32 { bitrate = bitrateKbit; self.framerate = framerate; return 0 }
    func implementationName() -> String { "test-stock" }
    func scalingSettings() -> RTCVideoEncoderQpThresholds? { nil }
    let resolutionAlignment = 1
    let applyAlignmentToAllSimulcastLayers = false
    let supportsNativeHandle = true
  }
}
