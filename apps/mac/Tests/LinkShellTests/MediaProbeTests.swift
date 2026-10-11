import Foundation
import XCTest
@testable import LinkShell

final class MediaProbeTests: XCTestCase {
  func testProbeTimestampRoundTripsWithoutAssumingEqualRtpOffsets() {
    for began in [0.000000001, 1, 65.537, 100_000.123456] {
      let video = Data([0, 0, 0, 1, 0x65, 0x88, 0x84])
      let measured = MediaStageProbe.attaching(to: video, began: began)
      XCTAssertEqual(MediaStageProbe.began(in: measured)!, began, accuracy: 0.000000002)
      XCTAssertTrue(measured.suffix(video.count).elementsEqual(video))
    }
    XCTAssertNil(MediaStageProbe.began(in: Data([0, 0, 0, 1, 0x65, 0x88, 0x84])))
  }
}
