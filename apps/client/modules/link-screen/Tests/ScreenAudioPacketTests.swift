import XCTest
@testable import ScreenTiming

final class ScreenAudioPacketTests: XCTestCase {
  func testEncodeAndDecodeRoundTripPreservesHeaderAndPayload() {
    let payload = Data([0x11, 0x22, 0x33, 0x44, 0x55])
    let packet = ScreenAudioPacket(
      codec: .opus,
      seq: 0x1234,
      timestampMs: 0x89ABCDEF,
      payload: payload
    )

    let encoded = packet.encode()
    XCTAssertEqual(encoded.count, ScreenAudioConstants.headerBytes + payload.count)
    XCTAssertEqual(Array(encoded.prefix(8)), [0x01, 0x01, 0x12, 0x34, 0x89, 0xAB, 0xCD, 0xEF])

    let decoded = ScreenAudioPacket.decode(encoded)
    XCTAssertEqual(decoded, packet)
  }

  func testDecodePCM16HighSeqAndTimestampValues() {
    let raw = Data([
      0x01, // version 1
      0x02, // codec pcm16
      0xFF, 0xFE, // seq 65534 BE
      0x00, 0x01, 0x02, 0x03, // timestampMs 66051 BE
      0x00, 0x10, 0xFF, 0xF0, // 1 stereo PCM16 sample frame
    ])
    let decoded = ScreenAudioPacket.decode(raw)
    XCTAssertNotNil(decoded)
    XCTAssertEqual(decoded?.version, 1)
    XCTAssertEqual(decoded?.codec, .pcm16)
    XCTAssertEqual(decoded?.seq, 65534)
    XCTAssertEqual(decoded?.timestampMs, 0x00010203)
    XCTAssertEqual(decoded?.payload, Data([0x00, 0x10, 0xFF, 0xF0]))
  }

  func testDecodeSliceWithNonZeroStartIndex() {
    let prefix = Data([0xAA, 0xBB, 0x01, 0x01, 0x00, 0x07, 0x00, 0x00, 0x00, 0x2A, 0x7F])
    let slice = prefix.dropFirst(2)
    let decoded = ScreenAudioPacket.decode(slice)
    XCTAssertEqual(decoded?.codec, .opus)
    XCTAssertEqual(decoded?.seq, 7)
    XCTAssertEqual(decoded?.timestampMs, 42)
    XCTAssertEqual(decoded?.payload, Data([0x7F]))
  }

  func testRejectsShortOrMalformedHeaders() {
    XCTAssertNil(ScreenAudioPacket.decode(Data()))
    XCTAssertNil(ScreenAudioPacket.decode(Data([0x01, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00])))
    XCTAssertNil(ScreenAudioPacket.decode(Data([0x02, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0xFF])))
    XCTAssertNil(ScreenAudioPacket.decode(Data([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0xFF])))
    XCTAssertNil(ScreenAudioPacket.decode(Data([0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0xFF])))
    XCTAssertNil(ScreenAudioPacket.decode(Data([0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0xFF])))
  }

  func testHeaderOnlyPacketDecodesWithEmptyPayload() {
    let decoded = ScreenAudioPacket.decode(Data([0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
    XCTAssertEqual(decoded?.seq, 0)
    XCTAssertEqual(decoded?.timestampMs, 0)
    XCTAssertEqual(decoded?.payload, Data())
  }
}
