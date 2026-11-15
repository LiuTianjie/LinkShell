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
}
