import XCTest
@testable import ScreenTiming

final class ScreenRenderThreadTests: XCTestCase {
  func testTheRendererProgressesWhileTheCallingThreadIsBlocked() {
    let worker = ScreenRenderThread()
    let completed = DispatchSemaphore(value: 0)
    let onMain = ScreenShared(true)
    worker.perform { onMain.update { $0 = Thread.isMainThread }; completed.signal() }
    XCTAssertEqual(completed.wait(timeout: .now() + 1), .success)
    XCTAssertFalse(onMain.read())
    worker.stop()
    XCTAssertTrue(worker.waitUntilStopped(seconds: 1))
  }

  func testStopIsOrderedAndRejectsWorkThatCouldResurrectTheDisplayLink() {
    let worker = ScreenRenderThread()
    let events = ScreenShared<[Int]>([])
    worker.perform { events.update { $0.append(1) } }
    worker.perform { events.update { $0.append(2) } }
    worker.stop { events.update { $0.append(3) } }
    XCTAssertFalse(worker.perform { events.update { $0.append(4) } })
    worker.stop { events.update { $0.append(5) } }
    XCTAssertTrue(worker.waitUntilStopped(seconds: 1))
    XCTAssertEqual(events.read(), [1, 2, 3])
  }

  func testImmediateShutdownDoesNotLoseCleanupDuringThreadStartup() {
    for _ in 0..<20 {
      let worker = ScreenRenderThread()
      let cleaned = ScreenShared(false)
      worker.stop { cleaned.update { $0 = true } }
      XCTAssertTrue(worker.waitUntilStopped(seconds: 1))
      XCTAssertTrue(cleaned.read())
    }
  }
}
