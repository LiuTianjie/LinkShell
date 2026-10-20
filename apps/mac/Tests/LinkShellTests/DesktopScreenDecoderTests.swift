import CoreMedia
import CoreVideo
import Metal
import VideoToolbox
import WebRTC
import XCTest
@testable import LinkShell

final class DesktopScreenDecoderTests: XCTestCase {
  func testFactoryOnlyAdvertisesHardwareCodecsAndNeverCreatesSoftwareFallback() {
    let h264 = DesktopScreenDecoderFactory(onStatus: { _ in }, onFailure: { _ in }, hardwareAvailable: { $0 == kCMVideoCodecType_H264 })
    XCTAssertFalse(h264.supportedCodecs().isEmpty)
    XCTAssertTrue(h264.supportedCodecs().allSatisfy { $0.name == "H264" })
    let hevc = DesktopScreenDecoderFactory(onStatus: { _ in }, onFailure: { _ in }, hardwareAvailable: { $0 == kCMVideoCodecType_HEVC })
    XCTAssertEqual(hevc.supportedCodecs().map(\.name), ["H265"])

    var failures: [String] = []
    let absent = DesktopScreenDecoderFactory(onStatus: { _ in XCTFail("No hardware session exists") },
      onFailure: { failures.append($0) }, hardwareAvailable: { _ in false })
    XCTAssertTrue(absent.supportedCodecs().isEmpty)
    for name in ["H264", "H265", "VP8", "VP9", "AV1", "H264"] {
      XCTAssertNil(absent.createDecoder(RTCVideoCodecInfo(name: name)))
    }
    XCTAssertEqual(failures.count, 1)
  }

  func testAnnexBPreservesEmulationPreventionAndSkipsEmptyUnitsAndDelimiters() {
    let bytes = Data([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0, 0, 0, 1,
      0x67, 0x64, 0, 0, 3, 1, 0x80, 0, 0, 1, 0x68, 0x88,
      0, 0, 0, 1, 0x65, 0x42, 0, 0, 3, 1, 0x80, 0, 0])
    let access = DesktopScreenAccessUnit(bytes, codec: .h264)
    XCTAssertEqual(access.parameters[7], Data([0x67, 0x64, 0, 0, 3, 1, 0x80]))
    XCTAssertEqual(access.parameters[8], Data([0x68, 0x88]))
    XCTAssertEqual(access.body, Data([0, 0, 0, 7, 0x65, 0x42, 0, 0, 3, 1, 0x80]))
    XCTAssertTrue(access.hasKey)
    XCTAssertTrue(access.hasPicture)
    XCTAssertTrue(DesktopScreenAccessUnit(Data(), codec: .h264).body.isEmpty)
  }

  func testHEVCRejectsShortOrForbiddenHeaders() {
    let invalid = Data([0, 0, 1, 0x40, 0, 0, 1, 0x42, 0x08, 0, 0, 1, 0xc4, 0x01])
    let access = DesktopScreenAccessUnit(invalid, codec: .hevc)
    XCTAssertTrue(access.parameters.isEmpty)
    XCTAssertTrue(access.body.isEmpty)
    XCTAssertFalse(access.hasPicture)
  }

  func testDeltaBeforeKeyframeRequestsRecoveryWithoutReportingHardwareFailure() {
    let decoder = DesktopScreenDecoder(codec: .h264,
      onStatus: { _ in XCTFail("No session before parameter sets") },
      onFailure: { _ in XCTFail("Waiting for a keyframe is not hardware failure") })
    for _ in 0..<10 { XCTAssertEqual(decode(decoder, unit: Data([0, 0, 1, 0x41, 0x80]), key: false), -1) }
  }

  func testH264ActuallyDecodesInHardwareToMetalCompatiblePixelBuffers() throws {
    try roundTrip(.h264)
  }

  func testH264BaselineFromStandardEncoderAlsoUsesHardware() throws {
    try roundTrip(.h264, lowLatency: false)
  }

  func testHEVCActuallyDecodesInHardwareToMetalCompatiblePixelBuffers() throws {
    try XCTSkipUnless(ScreenEncoderFactory.supportsHEVC, "HEVC encoder unavailable")
    try roundTrip(.hevc)
  }

  func testH264ReconfiguresResolutionFromSeparatedParameterSets() throws {
    try requireHardware(.h264)
    let first = try encoded(.h264, width: 640, height: 360, count: 1)[0]
    let second = try encoded(.h264, width: 320, height: 180, count: 1)[0]
    var sizes: [(Int32, Int32)] = []
    var confirmations = 0
    let decoder = DesktopScreenDecoder(codec: .h264, onStatus: { status in
      XCTAssertEqual(status["hardware"] as? Bool, true)
      confirmations += 1
    }, onFailure: { XCTFail($0) })
    decoder.setCallback { frame in sizes.append((frame.width, frame.height)) }
    XCTAssertEqual(decode(decoder, unit: first.data, key: true), 0)
    let originalUnits = DesktopScreenAccessUnit.units(of: first.data)
    let originalParameters = originalUnits.filter { [UInt8(7), 8].contains($0[0] & 0x1f) }
    let originalBody = originalUnits.filter { ![UInt8(7), 8].contains($0[0] & 0x1f) }
    XCTAssertEqual(decode(decoder, unit: annexB(Array(originalParameters.reversed()) + originalBody), key: true), 0)
    XCTAssertEqual(confirmations, 1, "Parameter order alone must not recreate the decoder")
    let units = DesktopScreenAccessUnit.units(of: second.data)
    // Parameter-only packets are staged; they cannot tear down the active format halfway.
    for unit in units where [UInt8(7), 8].contains(unit[0] & 0x1f) {
      XCTAssertEqual(decode(decoder, unit: annexB([unit]), key: false), 0)
    }
    let body = units.filter { ![UInt8(7), 8].contains($0[0] & 0x1f) }
    XCTAssertEqual(decode(decoder, unit: annexB(body), key: true), 0)
    XCTAssertEqual(sizes.map { "\($0.0)x\($0.1)" }, ["640x360", "640x360", "320x180"])
    XCTAssertEqual(confirmations, 2, "The replacement session must prove hardware again")
  }

  func testCannotRenderWhenActualSessionHardwareUseIsFalseOrUnknown() throws {
    try requireHardware(.h264)
    let frame = try encoded(.h264, width: 320, height: 180, count: 1)[0]
    for proof in [false, nil] as [Bool?] {
      var failures: [String] = []
      let decoder = DesktopScreenDecoder(codec: .h264,
        onStatus: { _ in XCTFail("Unconfirmed hardware must not be reported ready") },
        onFailure: { failures.append($0) }, hardwareUse: { _ in proof })
      decoder.setCallback { _ in XCTFail("Unconfirmed decoder must not render") }
      for _ in 0..<5 { XCTAssertEqual(decode(decoder, unit: frame.data, key: true), -1) }
      XCTAssertEqual(failures.count, 1)
    }
  }

  func testRepeatedBadKeyframesStopPreviouslyWorkingDecoderAndReportOnce() throws {
    try requireHardware(.h264)
    let frames = try encoded(.h264, width: 320, height: 180, count: 2)
    var failures: [String] = []
    var rendered = 0
    let decoder = DesktopScreenDecoder(codec: .h264, onStatus: { _ in }, onFailure: { failures.append($0) })
    decoder.setCallback { _ in rendered += 1 }
    XCTAssertEqual(decode(decoder, unit: frames[0].data, key: true), 0)
    XCTAssertEqual(rendered, 1)
    for _ in 0..<3 {
      // An IDR without its required slice syntax cannot produce a picture.
      XCTAssertEqual(decode(decoder, unit: annexB([Data([0x65, 0xff])]), key: true), -1)
      XCTAssertEqual(decode(decoder, unit: frames[1].data, key: false), -1)
    }
    XCTAssertEqual(failures.count, 1)
    XCTAssertEqual(decode(decoder, unit: frames[0].data, key: true), -1)
    XCTAssertEqual(failures.count, 1)
    XCTAssertEqual(rendered, 1)
  }

  private func roundTrip(_ codec: DesktopScreenCodec, lowLatency: Bool = true) throws {
    try requireHardware(codec)
    let frames = try encoded(codec, width: 640, height: 360, count: 4, lowLatency: lowLatency)
    var statuses: [[String: Any]] = []
    var output: [RTCVideoFrame] = []
    let factory = DesktopScreenDecoderFactory(onStatus: { statuses.append($0) }, onFailure: { XCTFail($0) })
    let decoder = try XCTUnwrap(factory.createDecoder(RTCVideoCodecInfo(name: codec.name)))
    decoder.setCallback { output.append($0) }
    XCTAssertEqual(decoder.startDecode(withNumberOfCores: 2), 0)
    for (index, frame) in frames.enumerated() {
      XCTAssertEqual(decode(decoder, unit: frame.data, key: frame.key, timestamp: UInt32(index + 123)), 0)
    }
    XCTAssertEqual(output.count, frames.count)
    XCTAssertEqual(statuses.count, 1)
    XCTAssertEqual(statuses.first?["hardware"] as? Bool, true)
    XCTAssertEqual(statuses.first?["codec"] as? String, codec.name)
    XCTAssertEqual(statuses.first?["decoder"] as? String, decoder.implementationName())
    XCTAssertTrue(decoder.implementationName().contains("Hardware"))
    let pixel = try XCTUnwrap(output.first?.buffer as? RTCCVPixelBuffer).pixelBuffer
    XCTAssertEqual(CVPixelBufferGetPixelFormatType(pixel), kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    XCTAssertNotNil(CVPixelBufferGetIOSurface(pixel), "Native rendering must keep the IOSurface")
    let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
    var cache: CVMetalTextureCache?
    XCTAssertEqual(CVMetalTextureCacheCreate(nil, nil, device, nil, &cache), kCVReturnSuccess)
    var texture: CVMetalTexture?
    XCTAssertEqual(CVMetalTextureCacheCreateTextureFromImage(nil, try XCTUnwrap(cache), pixel, nil,
      .r8Unorm, 640, 360, 0, &texture), kCVReturnSuccess)
    XCTAssertNotNil(CVMetalTextureGetTexture(try XCTUnwrap(texture)))
    XCTAssertEqual(output.map { UInt32(bitPattern: $0.timeStamp) }, [123, 124, 125, 126])
    XCTAssertEqual(decoder.release(), 0)
  }

  private func requireHardware(_ codec: DesktopScreenCodec) throws {
    try XCTSkipUnless(VTIsHardwareDecodeSupported(codec.type), "\(codec.label) hardware decoder unavailable")
  }

  private func decode(_ decoder: RTCVideoDecoder, unit: Data, key: Bool, timestamp: UInt32 = 0) -> Int {
    let image = RTCEncodedImage()
    image.buffer = unit
    image.frameType = key ? .videoFrameKey : .videoFrameDelta
    image.timeStamp = timestamp
    image.captureTimeMs = Int64(timestamp)
    return decoder.decode(image, missingFrames: false, codecSpecificInfo: nil, renderTimeMs: 0)
  }

  private func encoded(_ codec: DesktopScreenCodec, width: Int, height: Int, count: Int, lowLatency: Bool = true) throws -> [(data: Data, key: Bool)] {
    let compressor = try VideoCompressor(.init(width: width, height: height, fps: 30, bitrate: 2_000_000,
      lowLatency: lowLatency, codec: codec.type))
    var units: [(data: Data, key: Bool)] = []
    let done = expectation(description: "encoded \(codec.name)")
    done.expectedFulfillmentCount = count
    for index in 0..<count {
      var buffer: CVPixelBuffer?
      XCTAssertEqual(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer), kCVReturnSuccess)
      let picture = try XCTUnwrap(buffer)
      CVPixelBufferLockBaseAddress(picture, [])
      memset(CVPixelBufferGetBaseAddressOfPlane(picture, 0), Int32(40 + index * 30), CVPixelBufferGetBytesPerRowOfPlane(picture, 0) * height)
      memset(CVPixelBufferGetBaseAddressOfPlane(picture, 1), 128, CVPixelBufferGetBytesPerRowOfPlane(picture, 1) * height / 2)
      CVPixelBufferUnlockBaseAddress(picture, [])
      compressor.encode(picture, at: CMTime(value: Int64(index), timescale: 30), key: index == 0) { result in
        switch result {
        case .success(let frame?):
          if let unit = frame.accessUnit() { units.append((unit, frame.key)) }
          else { XCTFail("Missing Annex B output") }
        case .failure(let error): XCTFail(error.description)
        default: XCTFail("Test frame dropped")
        }
        done.fulfill()
      }
    }
    compressor.finish()
    wait(for: [done], timeout: 10)
    XCTAssertEqual(units.count, count)
    return units
  }

  private func annexB(_ units: [Data]) -> Data {
    units.reduce(into: Data()) { data, unit in data.append(contentsOf: [0, 0, 0, 1]); data.append(unit) }
  }
}
