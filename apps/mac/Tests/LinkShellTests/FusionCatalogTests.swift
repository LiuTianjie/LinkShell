import AppKit
import Foundation
import XCTest
@testable import LinkShell

final class FusionCatalogTests: XCTestCase {
  private var tempHome: URL!

  override func setUpWithError() throws {
    tempHome = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("ls-fusion-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempHome, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let tempHome {
      try? FileManager.default.removeItem(at: tempHome)
    }
  }

  func testEarlyAppsFrameWritesCatalogBeforeReadyWithoutCreatingAnyWindow() throws {
    let local = FusionLocal(
      host: "127.0.0.1",
      port: 47391,
      token: "tok-test",
      computerKey: "wss://gateway.itool.tech#test-mac",
      initialLaunch: "",
      homeDirectory: tempHome.path,
      hostName: "StudioM4"
    )
    let beforeWindows = NSApplication.shared.windows.count

    local.receive([
      "t": "apps",
      "apps": [
        [
          "name": "Safari",
          "bundle": "com.apple.Safari",
          "category": "public.app-category.productivity",
          "system": "0",
        ],
        [
          "name": "Xcode",
          "bundle": "com.apple.dt.Xcode",
          "category": "public.app-category.developer-tools",
          "system": "0",
        ],
      ],
    ])

    let catalogURL = tempHome.appendingPathComponent(".linkshell/fusion-icons/studiom4/catalog.json")
    XCTAssertTrue(FileManager.default.fileExists(atPath: catalogURL.path))
    let data = try Data(contentsOf: catalogURL)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["computerKey"] as? String, "wss://gateway.itool.tech#test-mac")
    XCTAssertEqual(json["hostSlug"] as? String, "studiom4")
    let apps = try XCTUnwrap(json["apps"] as? [[String: Any]])
    XCTAssertEqual(apps.count, 2)
    XCTAssertEqual(apps[0]["bundle"] as? String, "com.apple.Safari")
    XCTAssertEqual(apps[0]["category"] as? String, "效率")
    XCTAssertEqual(apps[1]["bundle"] as? String, "com.apple.dt.Xcode")
    XCTAssertEqual(apps[1]["category"] as? String, "开发工具")
    XCTAssertEqual(NSApplication.shared.windows.count, beforeWindows)

    // Subsequent `ready` without `apps` preserves the early catalog.
    local.receive(["t": "ready", "displays": [[String: Any]]()])
    let postReadyData = try Data(contentsOf: catalogURL)
    let postReadyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: postReadyData) as? [String: Any])
    XCTAssertEqual((postReadyJSON["apps"] as? [[String: Any]])?.count, 2)
    XCTAssertEqual(NSApplication.shared.windows.count, beforeWindows)
  }

  func testReadyOnlyPayloadRemainsBackwardCompatibleWith0_10_102Hosts() throws {
    let local = FusionLocal(
      host: "127.0.0.1",
      port: 47391,
      token: "tok-legacy",
      computerKey: "wss://gateway.itool.tech#legacy-mac",
      initialLaunch: "",
      homeDirectory: tempHome.path,
      hostName: "LegacyMini"
    )
    local.receive([
      "t": "ready",
      "displays": [[String: Any]](),
      "apps": [
        [
          "name": "Notes",
          "bundle": "com.apple.Notes",
          "category": "public.app-category.productivity",
          "system": "1",
        ],
      ],
    ])

    let catalogURL = tempHome.appendingPathComponent(".linkshell/fusion-icons/legacymini/catalog.json")
    let data = try Data(contentsOf: catalogURL)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let apps = try XCTUnwrap(json["apps"] as? [[String: Any]])
    XCTAssertEqual(apps.count, 1)
    XCTAssertEqual(apps[0]["bundle"] as? String, "com.apple.Notes")
    XCTAssertEqual(apps[0]["isSystem"] as? Bool, true)
  }
}
