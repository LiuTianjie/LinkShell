import XCTest
@testable import LinkShell

final class DesktopStartupTests: XCTestCase {
  func testStoppedHostStartsAfterUpdateRecovery() throws {
    var actions: [String] = []
    let snapshot = try DesktopStartup.run { arguments in
      actions.append(arguments.last!)
      return Data((actions.count == 1 ? #"{"status":"stopped"}"# : #"{"status":"running"}"#).utf8)
    }
    XCTAssertEqual(actions, ["recover-update", "start"])
    XCTAssertEqual(snapshot.status, "running")
  }

  func testExistingAndUnreachableHostsAreNotReplaced() throws {
    for status in ["running", "unreachable", "unknown"] {
      var calls = 0
      let snapshot = try DesktopStartup.run { _ in
        calls += 1
        return Data("{\"status\":\"\(status)\"}".utf8)
      }
      XCTAssertEqual(calls, 1)
      XCTAssertEqual(snapshot.status, status)
    }
  }

  func testFailedRecoveryPreventsOrdinaryStart() {
    var calls = 0
    XCTAssertThrowsError(try DesktopStartup.run { _ in
      calls += 1
      throw NSError(domain: "recovery", code: 1)
    }) { error in
      guard case DesktopStartup.Failure.recovery = error else { return XCTFail("Must retain recovery failure") }
    }
    XCTAssertEqual(calls, 1)
  }

  func testOrdinaryStartFailureIsDistinctFromUpdateRecoveryFailure() {
    XCTAssertThrowsError(try DesktopStartup.run { arguments in
      if arguments.last == "recover-update" { return Data(#"{"status":"stopped"}"#.utf8) }
      throw NSError(domain: "start", code: 1)
    }) { error in
      guard case DesktopStartup.Failure.start = error else { return XCTFail("Ordinary startup errors may clear when the host recovers") }
    }
  }
}
