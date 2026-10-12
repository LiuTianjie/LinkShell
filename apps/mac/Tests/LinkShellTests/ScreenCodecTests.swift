import CoreMedia
import WebRTC
import XCTest
@testable import LinkShell

final class ScreenCodecTests: XCTestCase {
  private func h264(_ profile: String, packetization: String = "1") -> RTCVideoCodecInfo {
    RTCVideoCodecInfo(name: "H264", parameters: [
      "profile-level-id": profile, "packetization-mode": packetization, "level-asymmetry-allowed": "1",
    ])
  }

  func testHighIsOfferedToBrowsersWithoutReplacingNativeProfiles() {
    let original = [h264("640c1f"), h264("42e01f"), RTCVideoCodecInfo(name: "VP8")]
    let supported = ScreenEncoderFactory.browserCompatible(original)
    XCTAssertEqual(Array(supported.prefix(original.count)), original)
    XCTAssertEqual(supported.last?.parameters, h264("64001f").parameters)
    XCTAssertEqual(supported.count, original.count + 1)
    XCTAssertEqual(ScreenEncoderFactory.browserCompatible(supported), supported)
  }

  func testHighKeepsEachSupportedLevelAndPacketizationMode() {
    let supported = ScreenEncoderFactory.browserCompatible([h264("640c33"), h264("640c1f", packetization: "0")])
    XCTAssertEqual(supported[2].parameters, h264("640033").parameters)
    XCTAssertEqual(supported[3].parameters, h264("64001f", packetization: "0").parameters)
    XCTAssertEqual(ScreenEncoderFactory.browserCompatible([h264("42e01f")]).count, 1)
  }

  func testRealSenderCapabilitiesPreferBothHighProfilesBeforeBaseline() {
    let codecs = Codecs.preferences("h264", from: Engine.factory.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs).codecs
    let profiles = codecs.filter { $0.name == "H264" }.compactMap { $0.parameters["profile-level-id"] }
    XCTAssertEqual(Array(profiles.prefix(2)), ["640c1f", "64001f"])
    XCTAssertTrue(profiles.contains("42e01f"))
  }

  /// H.264 viewers keep H.264 first; a viewer that asked for HEVC gets it first, H.264 after.
  func testHEVCIsOfferedFirstOnlyWhenAskedFor() {
    let capabilities = Engine.factory.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs
    XCTAssertEqual(Codecs.preferences("h264", from: capabilities).codecs.first?.name, "H264")
    let hevc = Codecs.preferences("hevc", from: capabilities)
    XCTAssertEqual(hevc.found, ScreenEncoderFactory.supportsHEVC)
    XCTAssertEqual(hevc.codecs.first?.name, ScreenEncoderFactory.supportsHEVC ? "H265" : "H264")
    XCTAssertEqual(hevc.codecs.first { $0.name != "H265" }?.name, "H264")
  }

  /// The sender's own HEVC, as the receiver's decoder takes it: Annex B with VPS/SPS/PPS in
  /// front of the key frame, and delta frames after it.
  func testHEVCFramesDecodeThroughTheReceiversDecoder() throws {
    try XCTSkipUnless(ScreenEncoderFactory.supportsHEVC && HEVCDecoder.available, "HEVC hardware encode/decode unavailable")
    let compressor = try VideoCompressor(.init(width: 640, height: 360, fps: 30, bitrate: 2_000_000, codec: kCMVideoCodecType_HEVC))
    XCTAssertEqual(compressor.mode, "low-latency")
    let decoder = HEVCDecoder()
    var decoded = 0
    decoder.setCallback { _ in decoded += 1 }
    var units: [(Data, Bool)] = []
    let done = expectation(description: "frames")
    done.expectedFulfillmentCount = 5
    for index in 0..<5 {
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(nil, 640, 360, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer)
      let picture = try XCTUnwrap(buffer)
      CVPixelBufferLockBaseAddress(picture, [])
      memset(CVPixelBufferGetBaseAddressOfPlane(picture, 0), Int32(40 + index * 30), CVPixelBufferGetBytesPerRowOfPlane(picture, 0) * 360)
      memset(CVPixelBufferGetBaseAddressOfPlane(picture, 1), 128, CVPixelBufferGetBytesPerRowOfPlane(picture, 1) * 180)
      CVPixelBufferUnlockBaseAddress(picture, [])
      compressor.encode(picture, at: CMTime(value: Int64(index), timescale: 30), key: index == 0) { result in
        if case .success(let frame?) = result, let unit = frame.accessUnit() { units.append((unit, frame.key)) }
        done.fulfill()
      }
    }
    wait(for: [done], timeout: 10)
    XCTAssertEqual(units.first?.1, true)
    let kinds = HEVCDecoder.units(of: try XCTUnwrap(units.first?.0)).map { ($0[$0.startIndex] >> 1) & 0x3f }
    XCTAssertEqual(Array(kinds.prefix(3)), [32, 33, 34])
    for (unit, key) in units {
      let image = RTCEncodedImage()
      image.buffer = unit
      image.frameType = key ? .videoFrameKey : .videoFrameDelta
      XCTAssertEqual(decoder.decode(image, missingFrames: false, codecSpecificInfo: nil, renderTimeMs: 0), 0)
    }
    XCTAssertEqual(decoded, units.count)
  }
}
