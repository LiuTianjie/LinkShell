import XCTest
@testable import LinkShell

/// Which ICE candidates are offered and which are dropped: pure parsing, no live interfaces.
final class NetworksTests: XCTestCase {
  private let lan = "candidate:1 1 udp 2122260223 192.168.100.126 53975 typ host generation 0"
  private let bridge = "candidate:2 1 udp 2122194687 192.168.128.1 61645 typ host generation 0"
  private let reflexive = "candidate:3 1 udp 1686052607 58.48.8.16 40909 typ srflx raddr 192.168.100.126 rport 53975"

  func testReadsTheAddressFromACandidate() {
    XCTAssertEqual(Networks.candidateAddress(lan), "192.168.100.126")
    XCTAssertEqual(Networks.candidateAddress(reflexive), "58.48.8.16")
    XCTAssertNil(Networks.candidateAddress("candidate:bad"))
  }

  func testDropsOnlyHostCandidatesOnAVirtualInterface() {
    let virtual: Set<String> = ["192.168.128.1"]
    XCTAssertTrue(Networks.isUselessHost(bridge, virtual: virtual))
    // The real LAN is kept even though it is private.
    XCTAssertFalse(Networks.isUselessHost(lan, virtual: virtual))
    // A reflexive candidate carries the public address and is never dropped, whatever the set.
    XCTAssertFalse(Networks.isUselessHost(reflexive, virtual: ["58.48.8.16"]))
  }

  func testKnowsTheVirtualInterfacePrefixes() {
    for name in ["bridge100", "awdl0", "llw0", "vmenet0"] { XCTAssertTrue(Networks.isVirtual(name), name) }
    for name in ["en0", "en8", "utun10", "lo0"] { XCTAssertFalse(Networks.isVirtual(name), name) }
  }
}
