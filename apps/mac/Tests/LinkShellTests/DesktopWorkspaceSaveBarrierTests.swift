import XCTest
@testable import LinkShell

final class DesktopWorkspaceSaveBarrierTests: XCTestCase {
  @MainActor func testAcknowledgementWaitsForThePageAndOnlyCompletesOnce() async {
    var acknowledge: ((Bool) -> Void)?
    var finished = false
    let waiting = Task { @MainActor in
      let saved = await DesktopWorkspaceSaveBarrier.wait { acknowledge = $0 }
      finished = true
      return saved
    }
    await Task.yield()
    XCTAssertFalse(finished)
    XCTAssertNotNil(acknowledge)
    acknowledge?(true)
    acknowledge?(false)
    let saved = await waiting.value
    XCTAssertTrue(saved)
  }

  @MainActor func testAStalledJavaScriptPromiseHasABoundedFailureAndIgnoresLateSuccess() async {
    var acknowledge: ((Bool) -> Void)?
    let started = Date()
    let saved = await DesktopWorkspaceSaveBarrier.wait(timeoutNanoseconds: 30_000_000) { acknowledge = $0 }
    XCTAssertFalse(saved)
    XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    acknowledge?(true)
  }

  @MainActor func testPersistenceFailureIsNotReportedAsSuccessfulShutdown() async {
    let saved = await DesktopWorkspaceSaveBarrier.wait { $0(false) }
    XCTAssertFalse(saved)
  }
}
