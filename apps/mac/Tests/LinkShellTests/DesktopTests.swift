import XCTest
@testable import LinkShell

final class DesktopTests: XCTestCase {
  func testStoppedSnapshotDoesNotRequireOrInventLiveData() throws {
    let snapshot = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"schema":1,"status":"stopped","cliVersion":"1.0.0","source":"npm"}"#.utf8))
    XCTAssertEqual(snapshot.status, "stopped")
    XCTAssertNil(snapshot.machine)
    XCTAssertNil(snapshot.gateway)
    XCTAssertNil(snapshot.sessions)
  }
  func testPermissionRequestTakesPrecedenceOverRunningState() throws {
    let session = try JSONDecoder().decode(DesktopSession.self, from: Data(#"{"id":"codex:1","agent":"codex","cwd":"/projects/Example","state":"running","pendingPermissions":1,"updatedAt":123}"#.utf8))
    XCTAssertEqual(session.label, "等待确认")
    XCTAssertEqual(session.name, "Example")
  }
  func testUnrecognizedStateDoesNotLookHealthy() throws {
    let session = try JSONDecoder().decode(DesktopSession.self, from: Data(#"{"id":"codex:1","agent":"codex","title":"Task","cwd":"/projects/Example","state":"future-state","pendingPermissions":0,"updatedAt":123}"#.utf8))
    XCTAssertEqual(session.label, "未知")
  }
}
