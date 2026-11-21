import AVFoundation
import Foundation
import XCTest
@testable import LinkShell

final class ScreenAudioTests: XCTestCase {
  func testPacketHeaderMatchesWireSpecByteForByte() {
    let payload = Data([0x11, 0x22, 0x33, 0x44])
    let packet = ScreenAudioPacket(
      version: ScreenAudioConstants.version,
      codec: .opus,
      seq: 0x1234,
      timestampMs: 0x01020304,
      payload: payload
    )
    let encoded = packet.encode()
    XCTAssertEqual(encoded, Data([
      0x01,             // version = 1
      0x01,             // codec = opus (1)
      0x12, 0x34,       // seq BE = 0x1234
      0x01, 0x02, 0x03, 0x04, // timestampMs BE = 0x01020304
      0x11, 0x22, 0x33, 0x44,
    ]))

    let decoded = ScreenAudioPacket.decode(encoded)
    XCTAssertEqual(decoded, packet)

    let pcmPacket = ScreenAudioPacket(codec: .pcm16, seq: 65_535, timestampMs: 1_000, payload: Data([0x00, 0x01]))
    let pcmEncoded = pcmPacket.encode()
    XCTAssertEqual([UInt8](pcmEncoded.prefix(8)), [0x01, 0x02, 0xFF, 0xFF, 0x00, 0x00, 0x03, 0xE8])
    XCTAssertEqual(ScreenAudioPacket.decode(pcmEncoded), pcmPacket)
  }

  func testPacketDecodeRejectsInvalidHeaderVersionAndCodec() {
    XCTAssertNil(ScreenAudioPacket.decode(Data([1, 1, 0, 0, 0, 0, 0]))) // truncated 7 bytes
    XCTAssertNil(ScreenAudioPacket.decode(Data([2, 1, 0, 0, 0, 0, 0, 0]))) // bad version
    XCTAssertNil(ScreenAudioPacket.decode(Data([1, 0, 0, 0, 0, 0, 0, 0]))) // unknown codec 0
    XCTAssertNil(ScreenAudioPacket.decode(Data([1, 3, 0, 0, 0, 0, 0, 0]))) // unknown codec 3
  }

  func testPCM16EncoderFrames20msChunksAndDecodesAccurately() throws {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
    var emitted: [Data] = []
    let encoder = ScreenAudioEncoder(preferOpus: false) { emitted.append($0) }
    XCTAssertEqual(encoder.activeCodec, .pcm16)

    // Send 480 + 480 + 960 frames (= 1920 frames -> two 20ms frames at 960 samples/frame).
    for (count, amp) in [(480, Float(0.25)), (480, Float(0.25)), (960, Float(-0.5))] {
      let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
      buf.frameLength = AVAudioFrameCount(count)
      let ch = buf.floatChannelData!
      for i in 0..<count {
        ch[0][i] = amp
        ch[1][i] = -amp
      }
      encoder.append(pcmBuffer: buf)
    }

    XCTAssertEqual(emitted.count, 2)
    let p0 = try XCTUnwrap(ScreenAudioPacket.decode(emitted[0]))
    let p1 = try XCTUnwrap(ScreenAudioPacket.decode(emitted[1]))
    XCTAssertEqual(p0.codec, .pcm16)
    XCTAssertEqual(p0.seq, 0)
    XCTAssertEqual(p0.timestampMs, 0)
    XCTAssertEqual(p0.payload.count, ScreenAudioConstants.pcm16FrameBytes)
    XCTAssertEqual(p1.codec, .pcm16)
    XCTAssertEqual(p1.seq, 1)
    XCTAssertEqual(p1.timestampMs, 20)
    XCTAssertEqual(p1.payload.count, ScreenAudioConstants.pcm16FrameBytes)

    let player = ScreenAudioPlayer(muted: false, outputEnabled: false)
    defer { player.stop() }
    let decoded0 = try XCTUnwrap(player.decodePacket(emitted[0]))
    let decoded1 = try XCTUnwrap(player.decodePacket(emitted[1]))
    XCTAssertEqual(decoded0.frameLength, AVAudioFrameCount(ScreenAudioConstants.frameSamples))
    XCTAssertEqual(decoded0.floatChannelData![0][0], 0.25, accuracy: 0.001)
    XCTAssertEqual(decoded0.floatChannelData![1][0], -0.25, accuracy: 0.001)
    XCTAssertEqual(decoded1.floatChannelData![0][0], -0.5, accuracy: 0.001)
    XCTAssertEqual(decoded1.floatChannelData![1][0], 0.5, accuracy: 0.001)
  }

  func testOpusEncoderAndPlayerRoundTripAndMuteLifecycle() throws {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
    var emitted: [Data] = []
    let encoder = ScreenAudioEncoder(preferOpus: true) { emitted.append($0) }
    XCTAssertEqual(encoder.activeCodec, .opus)

    let player = ScreenAudioPlayer(muted: false, outputEnabled: false)
    defer { player.stop() }

    for frameIdx in 0..<3 {
      let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(ScreenAudioConstants.frameSamples))!
      buf.frameLength = AVAudioFrameCount(ScreenAudioConstants.frameSamples)
      let ch = buf.floatChannelData!
      for i in 0..<ScreenAudioConstants.frameSamples {
        let phase = Float(frameIdx * ScreenAudioConstants.frameSamples + i) * 2.0 * .pi * 440.0 / 48_000.0
        ch[0][i] = sin(phase) * 0.4
        ch[1][i] = sin(phase) * 0.4
      }
      encoder.append(pcmBuffer: buf)
    }

    XCTAssertEqual(emitted.count, 3)
    for (idx, packetData) in emitted.enumerated() {
      let packet = try XCTUnwrap(ScreenAudioPacket.decode(packetData))
      XCTAssertEqual(packet.codec, .opus)
      XCTAssertEqual(packet.seq, UInt16(idx))
      XCTAssertEqual(packet.timestampMs, UInt32(idx * 20))
      XCTAssertGreaterThan(packet.payload.count, 0)

      let decoded = try XCTUnwrap(player.decodePacket(packetData))
      XCTAssertEqual(decoded.format.sampleRate, 48_000)
      XCTAssertEqual(decoded.format.channelCount, 2)
      XCTAssertGreaterThan(decoded.frameLength, 0)
    }

    player.setMuted(true)
    XCTAssertTrue(player.isMuted)
    player.enqueue(emitted[0])
    player.setMuted(false)
    XCTAssertFalse(player.isMuted)
    player.stop()
  }
}
