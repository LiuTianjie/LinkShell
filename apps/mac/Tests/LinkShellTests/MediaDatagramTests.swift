import CryptoKit
import XCTest
@testable import LinkShell

final class MediaDatagramTests: XCTestCase {
  func testTamperingAndAnUnauthenticatedHighCounterCannotConsumeTheReplayWindow() throws {
    let key = SymmetricKey(size: .bits256)
    let sender = MediaDatagramCipher(secret: key, direction: 1)
    let receiver = MediaDatagramCipher(secret: key, direction: 1)
    let first = try sender.seal(Data("first".utf8))
    var forged = first; forged[8] ^= 0x40
    XCTAssertThrowsError(try receiver.open(forged))
    XCTAssertEqual(try receiver.open(first), Data("first".utf8))
    XCTAssertThrowsError(try receiver.open(first))
    var damaged = try sender.seal(Data("second".utf8)); damaged[20] ^= 1
    XCTAssertThrowsError(try receiver.open(damaged))
  }

  func testDirectionsAndFreshSessionsHaveDifferentKeys() throws {
    let key = SymmetricKey(size: .bits256)
    let packet = try MediaDatagramCipher(secret: key, direction: 1).seal(Data([1, 2, 3]))
    XCTAssertThrowsError(try MediaDatagramCipher(secret: key, direction: 2).open(packet))
    XCTAssertThrowsError(try MediaDatagramCipher(secret: SymmetricKey(size: .bits256), direction: 1).open(packet))
  }

  func testWindowAllowsReorderingButBoundsOldPackets() {
    var window = MediaReplayWindow()
    for n: UInt64 in [1, 64, 65, 129, 255, 256, 257] { XCTAssertTrue(window.containsNew(n)); window.insert(n) }
    for n: UInt64 in [64, 65, 129, 255, 256, 257] { XCTAssertFalse(window.containsNew(n)) }
    XCTAssertFalse(window.containsNew(1)); XCTAssertFalse(window.containsNew(0))
    XCTAssertTrue(window.containsNew(2)); window.insert(2); XCTAssertFalse(window.containsNew(2))
    window.insert(1024)
    XCTAssertFalse(window.containsNew(257)); XCTAssertTrue(window.containsNew(1023))
  }

  func testFragmentationSurvivesReorderingAndFitsTheEncryptedDatagram() throws {
    let frame = picture(1, previous: 0, flags: 1, bytes: 127_844)
    let pieces = frame.fragments()
    let cipher = MediaDatagramCipher(secret: SymmetricKey(size: .bits256), direction: 1)
    var assembler = MediaFrameAssembler()
    for piece in pieces.reversed() {
      var payload = Data(); payload.mediaAppend(UInt64(1)); payload.append(piece)
      XCTAssertLessThanOrEqual(try cipher.seal(payload).count, 1200)
      assembler.receive(piece, at: 1.01)
    }
    XCTAssertEqual(assembler.take(after: 0, needsRefresh: true), frame)
    XCTAssertEqual(assembler.bufferedBytes, 0)
  }

  func testMissingReferenceBlocksDeltasUntilARealRefreshArrives() {
    var assembler = MediaFrameAssembler()
    let delta = picture(3, previous: 2)
    delta.fragments().forEach { assembler.receive($0, at: 1.01) }
    XCTAssertNil(assembler.take(after: 1, needsRefresh: false))
    let refresh = picture(4, previous: 3, flags: 2)
    refresh.fragments().forEach { assembler.receive($0, at: 1.02) }
    XCTAssertEqual(assembler.take(after: 1, needsRefresh: true), refresh)
    XCTAssertEqual(assembler.bufferedFrames, 0)
  }

  func testIncompleteFramesHaveMemoryAndAgeBounds() {
    var assembler = MediaFrameAssembler()
    for id in 1...20 { assembler.receive(picture(UInt32(id), previous: UInt32(id - 1), bytes: 600_000).fragments()[0], at: 1.01) }
    XCTAssertLessThanOrEqual(assembler.bufferedFrames, 8)
    XCTAssertLessThanOrEqual(assembler.bufferedBytes, MediaFrame.maximumBytes)
    XCTAssertGreaterThan(assembler.rejected, 0)
    assembler.expire(at: 2)
    XCTAssertEqual(assembler.bufferedBytes, 0)
  }

  private func picture(_ id: UInt32, previous: UInt32, flags: UInt8 = 0, bytes: Int = 10) -> MediaFrame {
    MediaFrame(id: id, previous: previous, capturedNs: 1_000_000_000, flags: flags,
      data: Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0) }))
  }
}
