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
}
