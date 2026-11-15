import Foundation
import XCTest
@testable import LinkShell

/// The Swift side of the shared protocol fixtures (packages/wire/test/fixtures/fusion), which
/// packages/wire/test/fusion.test.ts validates against the schema.
final class FusionProtocolTests: XCTestCase {
  private func fixture(_ name: String) throws -> [[String: Any]] {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("../../packages/wire/test/fixtures/fusion/\(name)").standardized
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
  }

  func testEveryFixtureTypeIsKnownHereAndEveryKnownTypeHasAFixture() throws {
    let seen = Set(try fixture("messages.json").compactMap { $0["t"] as? String })
    XCTAssertEqual(seen, FusionProtocol.types)
  }

  func testChromeFromTheWireIsWhatTheStubReads() throws {
    let opens = try fixture("messages.json").filter { $0["t"] as? String == "wopen" }
    let mac = FusionProtocol.chrome(opens[0]["chrome"])
    XCTAssertEqual(mac.style, "mac")
    XCTAssertTrue(mac.toolbar)
    XCTAssertEqual(mac.radius, 26)
    XCTAssertEqual(mac.buttons["close"], [12, 12, 14, 14])
    XCTAssertEqual(mac.buttons["min"], [32, 12, 14, 14])
    XCTAssertEqual(mac.buttons["zoom"], [52, 12, 14, 14])
    XCTAssertEqual(mac.hitrects, [[300, 8, 400, 30]])
    let windows = FusionProtocol.chrome(opens[1]["chrome"])
    XCTAssertEqual(windows.style, "windows")
    XCTAssertEqual(windows.buttons["close"], [274, 0, 46, 32])
  }

  func testTheRemotesMeasurementsRoundTrip() {
    let sent = FusionProtocol.chrome(toolbar: false, radius: 17, buttons: ["close": [1, 2, 3, 4], "min": [5, 6, 7, 8], "zoom": [9, 10, 11, 12]], hitrects: [[1, 1, 10, 10], [2, 2]])
    let read = FusionProtocol.chrome(sent)
    XCTAssertEqual(read, FusionProtocol.Chrome(style: "mac", toolbar: false, radius: 17,
                                               buttons: ["close": [1, 2, 3, 4], "min": [5, 6, 7, 8], "zoom": [9, 10, 11, 12]],
                                               hitrects: [[1, 1, 10, 10]]))
    XCTAssertTrue(JSONSerialization.isValidJSONObject(sent))
  }

  func testDisplaysFromHelloAreReadAsTheRemoteBuildsThem() throws {
    let hello = try XCTUnwrap(try fixture("messages.json").first { $0["t"] as? String == "hello" })
    let displays = try XCTUnwrap(hello["displays"] as? [[String: Any]])
    XCTAssertEqual(Fusion.rect(displays[1]["frame"]), CGRect(x: 1512, y: -200, width: 2560, height: 1440))
    // Windows' 150% and a Retina 2x both become 2x virtual displays; 1x stays 1x.
    XCTAssertEqual(FusionProtocol.backingScale(Fusion.number(displays[1]["scale"])), 2)
    XCTAssertEqual(FusionProtocol.backingScale(2), 2)
    XCTAssertEqual(FusionProtocol.backingScale(1), 1)
    XCTAssertEqual(FusionProtocol.displaysSignature(displays), FusionProtocol.displaysSignature(displays))
    XCTAssertNotEqual(FusionProtocol.displaysSignature(displays), FusionProtocol.displaysSignature(Array(displays.prefix(1))))
  }

  func testInputNamesItsWindowInStreamAndAKeyKeepsItsName() {
    // Shared vectors with apps/desktop-ui/test/screen-input.test.ts.
    let key = FusionProtocol.inputEvent(["t": "key", "k": "return", "m": ["cmd"]], stream: "w12", number: 7)
    XCTAssertEqual(key["k"] as? String, "return")
    XCTAssertEqual(key["stream"] as? String, "w12")
    XCTAssertEqual(key["i"] as? Int, 7)
    XCTAssertEqual(FusionProtocol.inputStream(key), "w12")
    // No `k` of its own: the stream is there too, for a 0.10.106 remote.
    let move = FusionProtocol.inputEvent(["t": "move", "x": 0.5, "y": 0.25], stream: "w12", number: 8)
    XCTAssertEqual(move["k"] as? String, "w12")
    XCTAssertEqual(FusionProtocol.inputStream(move), "w12")
    // From a 0.10.106 local: only `k`.
    XCTAssertEqual(FusionProtocol.inputStream(["t": "down", "b": "left", "k": "d0", "i": 3]), "d0")
    XCTAssertNil(FusionProtocol.inputStream(["t": "move", "x": 0, "y": 0]))
  }

  func testALiveProcessIsNotTakenForAnEndedApp() {
    // This test's own process: not an application the system lists, and alive.
    XCTAssertFalse(FusionProtocol.processEnded(getpid()))
    // A pid nothing has: ended.
    XCTAssertTrue(FusionProtocol.processEnded(99_999_999))
  }

  func testAnOffersCodecNamesAreTheOnesTheDecoderFactoryLists() {
    // As a Windows host up to 0.10.106 offered it: answered as "h264", no decoder was found.
    let offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=rtpmap:96 h264/90000\r\na=fmtp:96 profile-level-id=42e02a\r\na=rtpmap:97 rtx/90000\r\n"
    let fixed = DesktopScreenCodec.canonicalNames(inOffer: offer)
    XCTAssertTrue(fixed.contains("a=rtpmap:96 H264/90000\r\n"))
    XCTAssertTrue(fixed.contains("a=rtpmap:97 rtx/90000\r\n"))
    XCTAssertEqual(DesktopScreenCodec.canonicalNames(inOffer: fixed), fixed)
    XCTAssertTrue(DesktopScreenCodec.canonicalNames(inOffer: "a=rtpmap:98 h265/90000\r\n").contains("H265/90000"))
  }

  func testIconFileNamesMatchTheDesktops() {
    // Shared vector with apps/desktop/test/fusion-wire.test.mjs (fusionIconFile).
    XCTAssertEqual(FusionProtocol.iconFile("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe"), "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}_notepad.exe")
    XCTAssertEqual(FusionProtocol.iconFile("com.apple.Safari"), "com.apple.Safari")
    XCTAssertEqual(FusionProtocol.iconFile("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")
  }
}
