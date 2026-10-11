import CoreVideo
import XCTest
@testable import LinkShell

final class MediaQualityTests: XCTestCase {
  func testTheDecodersFullRangeOutputIsComparedToNormalizedCaptureLuma() throws {
    for (limited, full): (UInt8, UInt8) in [(16, 0), (235, 255), (125, 127)] {
      let source = try XCTUnwrap(MediaQuality(picture(luma: limited, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)))
      let decoded = try XCTUnwrap(MediaQuality(picture(luma: full, format: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)))
      let difference = try XCTUnwrap(source.compare(decoded))
      XCTAssertEqual(difference.psnr, 99)
      XCTAssertEqual(difference.largeErrors, 0)
    }
  }

  func testACompletelyWrongReferenceFrameCannotLookLikeGoodQuality() throws {
    let source = try XCTUnwrap(MediaQuality(picture(luma: 0, format: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)))
    let wrong = try XCTUnwrap(MediaQuality(picture(luma: 255, format: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)))
    let difference = try XCTUnwrap(source.compare(wrong))
    XCTAssertEqual(difference.psnr, 0)
    XCTAssertEqual(difference.largeErrors, 100)
  }

  private func picture(luma: UInt8, format: OSType) throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    XCTAssertEqual(CVPixelBufferCreate(nil, 16, 16, format, nil, &buffer), kCVReturnSuccess)
    let made = try XCTUnwrap(buffer)
    CVPixelBufferLockBaseAddress(made, [])
    defer { CVPixelBufferUnlockBaseAddress(made, []) }
    let address = try XCTUnwrap(CVPixelBufferGetBaseAddressOfPlane(made, 0))
    memset(address, Int32(luma), CVPixelBufferGetBytesPerRowOfPlane(made, 0) * 16)
    return made
  }
}
