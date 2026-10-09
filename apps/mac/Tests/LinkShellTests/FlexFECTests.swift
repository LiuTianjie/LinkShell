import XCTest
@testable import LinkShell

final class FlexFECTests: XCTestCase {
  private let offer = """
  v=0
  m=video 9 UDP/TLS/RTP/SAVPF 96 118
  a=sendonly
  a=rtpmap:96 H264/90000
  a=rtpmap:118 flexfec-03/90000
  a=fmtp:118 repair-window=10000000
  a=ssrc-group:FEC-FR 123 456
  """
  private let answer = """
  v=0
  m=video 9 UDP/TLS/RTP/SAVPF 96 118
  a=recvonly
  a=rtpmap:96 H264/90000
  a=rtpmap:118 flexfec-03/90000
  a=fmtp:118 repair-window=10000000
  """

  func testNegotiatedRequiresTheAcceptedCodecAndSeparateRepairSSRC() {
    let result = FlexFEC.negotiation(offer: offer, answer: answer)
    XCTAssertEqual(result.state, "negotiated")
    XCTAssertEqual(result.payloadType, 118)
    XCTAssertEqual(result.mediaSSRC, 123)
    XCTAssertEqual(result.repairSSRC, 456)
    XCTAssertEqual(FlexFEC.negotiation(offer: offer.replacingOccurrences(of: "a=ssrc-group:FEC-FR 123 456", with: ""), answer: answer).state, "missing-ssrc")
  }

  func testAnUnsupportedViewerDeclinesWithoutBeingCalledEnabled() {
    let plain = answer.replacingOccurrences(of: "SAVPF 96 118", with: "SAVPF 96")
    XCTAssertEqual(FlexFEC.negotiation(offer: offer, answer: plain).state, "declined")
    XCTAssertEqual(FlexFEC.negotiation(offer: offer, answer: answer.replacingOccurrences(of: "m=video 9", with: "m=video 0")).state, "declined")
    XCTAssertEqual(FlexFEC.negotiation(offer: offer, answer: answer.replacingOccurrences(of: "a=recvonly", with: "a=inactive")).state, "declined")
  }

  func testAnOfferAloneIsNotNegotiation() {
    XCTAssertEqual(FlexFEC.negotiation(offer: offer, answer: nil).state, "awaiting-answer")
    XCTAssertEqual(FlexFEC.negotiation(offer: offer.replacingOccurrences(of: "SAVPF 96 118", with: "SAVPF 96"), answer: answer).state, "not-offered")
  }

  func testRepairGroupsOutsideTheVideoSectionDoNotCount() {
    let outside = offer.replacingOccurrences(of: "a=ssrc-group:FEC-FR 123 456", with: "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=ssrc-group:FEC-FR 123 456")
    XCTAssertEqual(FlexFEC.negotiation(offer: outside, answer: answer).state, "missing-ssrc")
  }
}
