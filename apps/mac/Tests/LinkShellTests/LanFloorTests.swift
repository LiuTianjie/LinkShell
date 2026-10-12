import XCTest
@testable import LinkShell

/// When the bandwidth estimate gets a floor, and when the floor goes: with no network.
final class LanFloorTests: XCTestCase {
  private let host = LanFloor.Endpoint(type: "host", address: "192.168.100.126")
  private let phone = LanFloor.Endpoint(type: "host", address: "192.168.100.206")
  private let ceiling = 12_000_000

  private func second(rtt: Double, lost: Double = 0, local: LanFloor.Endpoint? = nil, remote: LanFloor.Endpoint? = nil) -> LanFloor.Second {
    .init(local: local ?? host, remote: remote ?? phone, rttMs: rtt, fractionLost: lost)
  }

  /// Seconds until the floor is set, or nil.
  private func applied(_ floor: inout LanFloor, _ seconds: [LanFloor.Second]) -> Int? {
    for (index, second) in seconds.enumerated() {
      if case .apply = floor.judge(second, ceiling: ceiling) { return index + 1 }
    }
    return nil
  }

  func testAQuietLocalPathGetsTheFloorAfterTheWindow() {
    var floor = LanFloor()
    XCTAssertEqual(applied(&floor, Array(repeating: second(rtt: 4), count: 10)), Tuning.lanFloorWindow)
    XCTAssertEqual(floor.floor, Tuning.lanFloor)
  }

  func testTheFloorIsNeverAboveTheCeiling() {
    var floor = LanFloor()
    for _ in 0..<Tuning.lanFloorWindow { _ = floor.judge(second(rtt: 4), ceiling: 3_000_000) }
    XCTAssertEqual(floor.floor, 3_000_000)
  }

  func testTheInternetNeverGetsAFloor() {
    var floor = LanFloor()
    let reflexive = LanFloor.Endpoint(type: "srflx", address: "58.48.8.16")
    let relayed = LanFloor.Endpoint(type: "relay", address: "192.168.1.2")
    let cgnat = LanFloor.Endpoint(type: "host", address: "100.116.180.12")
    for remote in [reflexive, relayed, cgnat] {
      XCTAssertNil(applied(&floor, Array(repeating: second(rtt: 4, remote: remote), count: 10)), "\(remote)")
    }
  }

  func testLocalAddressesAreRecognised() {
    for address in ["10.0.0.2", "172.16.4.1", "172.31.255.1", "192.168.0.9", "169.254.3.3", "127.0.0.1", "fe80::1", "fd7a::2", "abc-123.local"] {
      XCTAssertTrue(LanFloor.isLocal(.init(type: "host", address: address)), address)
    }
    for address in ["172.32.0.1", "8.8.8.8", "100.64.0.1", "2408:8000::1"] {
      XCTAssertFalse(LanFloor.isLocal(.init(type: "host", address: address)), address)
    }
  }

  /// A radio away for 90 ms every half second raises some round trips, not the lowest of them.
  func testMomentaryHoldsKeepTheFloor() {
    var floor = LanFloor()
    for _ in 0..<Tuning.lanFloorWindow { _ = floor.judge(second(rtt: 4), ceiling: ceiling) }
    XCTAssertNotNil(floor.floor)
    for index in 0..<30 { XCTAssertEqual(floor.judge(second(rtt: index % 2 == 0 ? 95 : 6), ceiling: ceiling), .keep) }
    XCTAssertNotNil(floor.floor)
  }

  func testAStandingQueueLiftsTheFloor() {
    var floor = LanFloor()
    for _ in 0..<Tuning.lanFloorWindow { _ = floor.judge(second(rtt: 4), ceiling: ceiling) }
    var lifted = false
    for _ in 0..<10 { if case .lift = floor.judge(second(rtt: 80), ceiling: ceiling) { lifted = true; break } }
    XCTAssertTrue(lifted)
    XCTAssertNil(floor.floor)
  }

  func testLossLiftsTheFloorAtOnce() {
    var floor = LanFloor()
    for _ in 0..<Tuning.lanFloorWindow { _ = floor.judge(second(rtt: 4), ceiling: ceiling) }
    guard case .lift = floor.judge(second(rtt: 4, lost: 0.1), ceiling: ceiling) else { return XCTFail("loss did not lift the floor") }
  }

  func testLeavingTheLocalNetworkLiftsTheFloor() {
    var floor = LanFloor()
    for _ in 0..<Tuning.lanFloorWindow { _ = floor.judge(second(rtt: 4), ceiling: ceiling) }
    let reflexive = LanFloor.Endpoint(type: "srflx", address: "58.48.8.16")
    guard case .lift = floor.judge(second(rtt: 4, remote: reflexive), ceiling: ceiling) else { return XCTFail("a new path kept the floor") }
  }

  /// After a lift the floor comes back only after a longer calm; after two lifts never.
  func testTheFloorComesBackAfterALongCalmAndNotAfterTwoLifts() {
    var floor = LanFloor()
    for _ in 0..<Tuning.lanFloorWindow { _ = floor.judge(second(rtt: 4), ceiling: ceiling) }
    _ = floor.judge(second(rtt: 4, lost: 0.2), ceiling: ceiling)
    let back = applied(&floor, Array(repeating: second(rtt: 4), count: 100))
    XCTAssertNotNil(back)
    XCTAssertGreaterThanOrEqual(back ?? 0, Tuning.lanFloorRecalm)
    _ = floor.judge(second(rtt: 4, lost: 0.2), ceiling: ceiling)
    XCTAssertEqual(floor.lifts, Tuning.lanFloorMaxLifts)
    XCTAssertNil(applied(&floor, Array(repeating: second(rtt: 4), count: 200)))
  }

  /// Packets queueing in the sender lift the floor before the round trip shows anything.
  func testSenderQueueingLiftsTheFloor() {
    var floor = LanFloor()
    for _ in 0..<Tuning.lanFloorWindow { _ = floor.judge(second(rtt: 4), ceiling: ceiling) }
    var queued = second(rtt: 4)
    queued.sendDelayMs = 300
    guard case .lift = floor.judge(queued, ceiling: ceiling) else { return XCTFail("queueing kept the floor") }
  }

  /// A busy sender queue keeps the floor from being set at all.
  func testNoFloorWhileTheSenderQueues() {
    var floor = LanFloor()
    var queued = second(rtt: 4)
    queued.sendDelayMs = 30
    XCTAssertNil(applied(&floor, Array(repeating: queued, count: 20)))
  }

  /// The log names the kind of path, never the addresses.
  func testPathDescription() {
    let lan = LanFloor.describe(local: .init(type: "host", address: "192.168.1.5"), remote: .init(type: "prflx", address: "abc.local"))
    XCTAssertEqual(lan, "over the local network (host → prflx)")
    XCTAssertEqual(LanFloor.describe(local: .init(type: "srflx", address: "58.48.8.16"), remote: .init(type: "srflx", address: "1.2.3.4")), "across the internet (srflx → srflx)")
    XCTAssertEqual(LanFloor.describe(local: .init(type: "host", address: "10.0.0.2"), remote: .init(type: "relay", address: "1.2.3.4")), "through a TURN relay (host → relay)")
  }
}
