import XCTest
@testable import LinkShell

final class DesktopWorkspaceTests: XCTestCase {
  private let token = String(repeating: "a", count: 43)
  private var origin: URL { URL(string: "http://127.0.0.1:49312/#desktop=\(token)")! }

  func testReadyAddressRequiresLoopbackAndCapability() throws {
    let data = try JSONSerialization.data(withJSONObject: ["url": origin.absoluteString])
    XCTAssertEqual(try DesktopWorkspacePolicy.readyURL(from: data), origin)
    for value in ["https://127.0.0.1:49312/", "http://localhost:49312/", "http://example.com:49312/", "file:///tmp/index.html", "http://user@127.0.0.1:49312/", "http://127.0.0.1:49312/path", "http://127.0.0.1:49312/?token=x"] {
      let input = try JSONSerialization.data(withJSONObject: ["url": value + "#desktop=" + token])
      XCTAssertThrowsError(try DesktopWorkspacePolicy.readyURL(from: input), value)
    }
    XCTAssertThrowsError(try DesktopWorkspacePolicy.readyURL(from: Data(#"{"url":"http://127.0.0.1:49312/"}"#.utf8)))
  }

  func testNativeBridgeRequiresTheExactMainFrameOrigin() {
    let policy = DesktopWorkspacePolicy(origin: origin)
    XCTAssertTrue(policy.allowsBridge(from: URL(string: "http://127.0.0.1:49312/"), mainFrame: true))
    XCTAssertFalse(policy.allowsBridge(from: origin, mainFrame: false))
    for url in ["http://localhost:49312/", "http://127.0.0.1:49313/", "https://127.0.0.1:49312/", "http://127.0.0.1.example.com:49312/", "about:srcdoc", "file:///tmp/index.html"] {
      XCTAssertFalse(policy.allowsBridge(from: URL(string: url), mainFrame: true), url)
    }
  }

  func testScreenAndPreviewFramesRetainTheirIsolatedRoutes() {
    let policy = DesktopWorkspacePolicy(origin: origin)
    XCTAssertTrue(policy.allowsSubframe(URL(string: "about:srcdoc")!))
    XCTAssertTrue(policy.allowsSubframe(URL(string: "http://localhost:49312/preview/bridge.html#channel")!))
    XCTAssertTrue(policy.allowsSubframe(URL(string: "blob:http://127.0.0.1:49312/example")!))
    XCTAssertFalse(policy.allowsSubframe(URL(string: "http://localhost:4000/")!))
    XCTAssertFalse(policy.allowsSubframe(URL(string: "file:///Users/example/private.txt")!))
  }

  func testExternalLinksCannotLaunchScriptsFilesOrLoopback() {
    XCTAssertTrue(DesktopWorkspacePolicy.externalURL(URL(string: "https://itool.tech/en/auth/linkshell")!))
    for value in ["javascript:alert(1)", "file:///etc/passwd", "linkshell://pair", "https://user:password@example.com/", "http://127.0.0.1:8000/", "http://localhost:8000/", "http://[::1]:8000/"] {
      XCTAssertFalse(DesktopWorkspacePolicy.externalURL(URL(string: value)!), value)
    }
  }

  func testVisibilityHasAnInitialValueAndAnEvent() {
    let script = DesktopWorkspacePolicy.visibilityScript(false)
    XCTAssertTrue(script.contains("window.__LINKSHELL_DESKTOP_VISIBLE__ = false"))
    XCTAssertTrue(script.contains("linkshell-desktop-visibility"))
    XCTAssertTrue(script.contains("detail:{visible:false}"))
  }

  func testAppearanceUsesOnlyKnownValuesAndHasAnInitialValue() {
    for value in ["light", "dark", "system"] { XCTAssertTrue(DesktopWorkspacePolicy.validAppearance(value)) }
    XCTAssertFalse(DesktopWorkspacePolicy.validAppearance("dark'; alert(1);"))
    let script = DesktopWorkspacePolicy.appearanceScript("light")
    XCTAssertTrue(script.contains("__LINKSHELL_DESKTOP_APPEARANCE__ = 'light'"))
    XCTAssertTrue(script.contains("linkshell-desktop-appearance"))
    XCTAssertTrue(script.contains("detail:{appearance:'light'}"))
    XCTAssertFalse(DesktopWorkspacePolicy.appearanceScript("dark'; alert(1);").contains("alert(1)"))
  }
}
