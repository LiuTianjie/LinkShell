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

  private func makeLocal(_ key: String, name: String) -> FusionLocal {
    let local = FusionLocal(host: "127.0.0.1", port: 47391, token: "tok-test", computerKey: key,
                            initialLaunch: "", homeDirectory: tempHome.path, hostName: name)
    local.terminate = {}
    return local
  }

  private let welcome: [String: Any] = [
    "t": "welcome", "proto": 2, "platform": "macos", "features": ["menubar", "keys"], "session": "s-test", "resumed": false,
  ]

  func testEarlyAppsFrameWritesCatalogBeforeReadyWithoutCreatingAnyWindow() throws {
    let local = makeLocal("wss://gateway.itool.tech#test-mac", name: "StudioM4")
    let beforeWindows = NSApplication.shared.windows.count

    local.receive(welcome)
    local.receive([
      "t": "apps",
      "apps": [
        ["app": "com.apple.Safari", "name": "Safari", "category": "public.app-category.productivity", "system": false],
        ["app": "com.apple.dt.Xcode", "name": "Xcode", "category": "public.app-category.developer-tools", "system": false],
      ],
    ])

    // Keyed by the computer, not its name (two computers may share "StudioM4").
    let slug = Fusion.slug(computerKey: "wss://gateway.itool.tech#test-mac")
    let catalogURL = tempHome.appendingPathComponent(".linkshell/fusion-icons/\(slug)/catalog.json")
    XCTAssertTrue(FileManager.default.fileExists(atPath: catalogURL.path))
    let data = try Data(contentsOf: catalogURL)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["computerKey"] as? String, "wss://gateway.itool.tech#test-mac")
    XCTAssertEqual(json["hostSlug"] as? String, slug)
    XCTAssertEqual(json["hostLabel"] as? String, "StudioM4")
    let apps = try XCTUnwrap(json["apps"] as? [[String: Any]])
    XCTAssertEqual(apps.count, 2)
    XCTAssertEqual(apps[0]["bundle"] as? String, "com.apple.Safari")
    XCTAssertEqual(apps[0]["category"] as? String, "效率")
    XCTAssertEqual(apps[1]["bundle"] as? String, "com.apple.dt.Xcode")
    XCTAssertEqual(apps[1]["category"] as? String, "开发工具")
    XCTAssertEqual(NSApplication.shared.windows.count, beforeWindows)

    // `ready` carries displays only and keeps the catalog.
    local.receive(["t": "ready", "displays": [[String: Any]]()])
    let postReadyData = try Data(contentsOf: catalogURL)
    let postReadyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: postReadyData) as? [String: Any])
    XCTAssertEqual((postReadyJSON["apps"] as? [[String: Any]])?.count, 2)
    XCTAssertEqual(NSApplication.shared.windows.count, beforeWindows)
  }

  func testNothingCountsBeforeWelcome() throws {
    let local = makeLocal("wss://gateway.itool.tech#early", name: "Early")
    local.receive(["t": "layout", "windows": [[String: Any]]()])
    local.receive(["t": "alert", "kind": "locked", "message": "x"])
    let slug = Fusion.slug(computerKey: "wss://gateway.itool.tech#early")
    let catalogURL = tempHome.appendingPathComponent(".linkshell/fusion-icons/\(slug)/catalog.json")
    XCTAssertFalse(FileManager.default.fileExists(atPath: catalogURL.path))
  }

  /// A 0.10.10x remote answers `hello` with `apps` (and no `welcome`): the hub says the versions
  /// differ instead of showing an empty launchpad.
  func testAV1RemoteIsReportedAsOutdated() throws {
    var terminated = false
    let local = makeLocal("wss://gateway.itool.tech#legacy-mac", name: "LegacyMini")
    local.terminate = { terminated = true }
    local.receive(["t": "apps", "apps": [["name": "Notes", "bundle": "com.apple.Notes", "category": "", "system": "1"]]])
    XCTAssertTrue(terminated)
    let slug = Fusion.slug(computerKey: "wss://gateway.itool.tech#legacy-mac")
    let status = tempHome.appendingPathComponent(".linkshell/fusion-\(slug).status.json")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: status)) as? [String: Any])
    XCTAssertEqual(json["reason"] as? String, "proto")
    XCTAssertTrue((json["message"] as? String ?? "").contains("升级"))
  }

  func testByeFromTheRemoteEndsWithItsMessage() throws {
    var terminated = false
    let local = makeLocal("wss://gateway.itool.tech#bye", name: "Bye")
    local.terminate = { terminated = true }
    local.receive(welcome)
    local.receive(["t": "bye", "reason": "replaced", "message": "另一台电脑开启了与这台 Mac 的融合模式"])
    XCTAssertTrue(terminated)
    let slug = Fusion.slug(computerKey: "wss://gateway.itool.tech#bye")
    let status = tempHome.appendingPathComponent(".linkshell/fusion-\(slug).status.json")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: status)) as? [String: Any])
    XCTAssertEqual(json["reason"] as? String, "replaced")
    XCTAssertEqual(json["message"] as? String, "另一台电脑开启了与这台 Mac 的融合模式")
  }

  func testSelfPoisonedFusionShortcutsAreFilteredFromCatalog() throws {
    let local = makeLocal("wss://gateway.itool.tech#win-remote", name: "TurningCode")
    local.receive(welcome)
    local.receive([
      "t": "apps",
      "apps": [
        ["app": "Chrome", "name": "Google Chrome", "category": "", "system": false],
        ["app": "LinkShell.Fusion.057b62d9e881.f3d365f50a79", "name": "Google Chrome", "category": "", "system": false],
        ["app": "com.bd.linkshell.host", "name": "LinkShell", "category": "", "system": false],
      ],
    ])
    XCTAssertEqual(local.apps.map(\.bundle), ["Chrome"])
  }

  func testAppExitedEvictsDyingStubImmediatelyAndCachesEarlyWindowFrameBeforeStubRegisters() throws {
    let local = makeLocal("wss://gateway.itool.tech#handoff", name: "PackMac")
    local.receive(welcome)
    local.receive(["t": "ready", "displays": [["index": 0, "frame": ["x": 0, "y": 0, "w": 1440, "h": 900]]]])

    var fds: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    defer { if fds[1] >= 0 { Darwin.close(fds[1]) } }
    let dyingStub = StubClient(fd: fds[0], owner: local)
    dyingStub.bundle = "com.google.Chrome"
    dyingStub.pid = getpid()
    local.stubs["com.google.Chrome"] = dyingStub
    local.syncFastState()

    // `app.exited` must evict `stubs[bundle]` synchronously so a follow-up `wopen` never writes into a dying stub.
    local.receive(["t": "app.exited", "app": "com.google.Chrome"])
    XCTAssertNil(local.stubs["com.google.Chrome"])
    XCTAssertTrue(dyingStub.closed)

    // A new window opens before the replacement Stub process has finished launching and registering.
    local.receive([
      "t": "wopen", "id": 7701, "app": "com.google.Chrome", "title": "新标签页",
      "activate": true, "frame": ["x": 100, "y": 80, "w": 1200, "h": 800],
      "chrome": ["style": "mac", "toolbar": true], "stream": "w7701",
    ])
    XCTAssertEqual(local.windows[7701]?.activate, true)

    // A static window's initial IOSurface frame arrives while `stubs["com.google.Chrome"]` is still nil:
    // it must be retained in `latestWindowFrames` so `stubDidRegister` can present it at 0 ms!
    var pixelBuffer: CVPixelBuffer?
    let attrs: [CFString: Any] = [
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any],
      kCVPixelBufferWidthKey: 1440,
      kCVPixelBufferHeightKey: 900,
    ]
    XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 1440, 900, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pixelBuffer), kCVReturnSuccess)
    let sei = try JSONSerialization.data(withJSONObject: [100.0, 80.0, 1200.0, 800.0, 0.0, 0.0, 0.8, 0.8, 0.0, 0.0, 1200.0, 800.0, 2.0, 0.0, 7701.0])
    local.handleWindowPictureFast(id: 7701, key: "w7701", buffer: try XCTUnwrap(pixelBuffer), sei: sei)

    local.fastLock.lock()
    let cachedBeforeClose = local.latestWindowFrames[7701] != nil
    local.fastLock.unlock()
    XCTAssertTrue(cachedBeforeClose, "early frame before Stub registration must be cached for replay")

    local.receive(["t": "wclose", "id": 7701])
    local.fastLock.lock()
    let cachedAfterClose = local.latestWindowFrames[7701] != nil
    local.fastLock.unlock()
    XCTAssertFalse(cachedAfterClose, "closing the window evicts its cached frame")
  }
}
