import XCTest
@testable import LinkShell

final class DesktopTests: XCTestCase {
  func testStoppedSnapshotDoesNotRequireOrInventLiveData() throws {
    let snapshot = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"schema":1,"status":"stopped","cliVersion":"1.0.0","source":"npm"}"#.utf8))
    XCTAssertEqual(snapshot.status, "stopped")
    XCTAssertNil(snapshot.machine)
    XCTAssertNil(snapshot.gateway)
    XCTAssertNil(snapshot.sessions)
  }
  func testPermissionRequestTakesPrecedenceOverRunningState() throws {
    let session = try JSONDecoder().decode(DesktopSession.self, from: Data(#"{"id":"codex:1","agent":"codex","cwd":"/projects/Example","state":"running","pendingPermissions":1,"updatedAt":123}"#.utf8))
    XCTAssertEqual(session.label, "等待确认")
    XCTAssertEqual(session.name, "Example")
  }
  func testUnrecognizedStateDoesNotLookHealthy() throws {
    let session = try JSONDecoder().decode(DesktopSession.self, from: Data(#"{"id":"codex:1","agent":"codex","title":"Task","cwd":"/projects/Example","state":"future-state","pendingPermissions":0,"updatedAt":123}"#.utf8))
    XCTAssertEqual(session.label, "未知")
  }

  func testMembershipRequiresAValidFutureExpiry() throws {
    let now = Date(timeIntervalSince1970: 1_798_761_600)
    let decode: (String) throws -> DesktopSnapshot.Account = { expiry in
      try JSONDecoder().decode(DesktopSnapshot.Account.self, from: Data("{\"state\":\"signed-in\",\"userId\":\"one\",\"plan\":\"pro\",\"planExpiresAt\":\"\(expiry)\"}".utf8))
    }
    let expected = Date(timeIntervalSince1970: 1_830_384_000)
    XCTAssertEqual(try decode("2028-01-02T00:00:00Z").membership(at: now), .pro(expected))
    XCTAssertEqual(try decode("2028-01-02T08:00:00.000+08:00").membership(at: now), .pro(expected))
    XCTAssertEqual(try decode("2028-01-02T00:00:00Z").membership(at: expected), .free)
    XCTAssertEqual(try decode("invalid").membership(at: now), .unknown)
    let missing = try JSONDecoder().decode(DesktopSnapshot.Account.self, from: Data(#"{"state":"signed-in","userId":"one","plan":"pro","planExpiresAt":null}"#.utf8))
    XCTAssertEqual(missing.membership(at: now), .unknown)
  }

  func testAnOlderCliAccountDoesNotInventAFreeMembership() throws {
    let account = try JSONDecoder().decode(DesktopSnapshot.Account.self, from: Data(#"{"state":"signed-in","userId":"one"}"#.utf8))
    XCTAssertEqual(account.membership(), .unknown)
  }

  func testAccountChangesDiscardThePreviousRedemptionForm() async throws {
    let first = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"status":"stopped","account":{"state":"signed-in","userId":"one","plan":"free"}}"#.utf8))
    let second = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"status":"stopped","account":{"state":"signed-in","userId":"two","plan":"free"}}"#.utf8))
    let signedOut = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"status":"stopped","account":{"state":"signed-out"}}"#.utf8))
    await MainActor.run {
      let model = DesktopModel()
      model.snapshot = first
      model.redemptionCode = "sample-code"
      model.redemptionMessage = "旧账号的兑换提示"
      model.redemptionIsError = true
      model.snapshot = first
      XCTAssertEqual(model.redemptionCode, "sample-code")
      model.snapshot = second
      XCTAssertTrue(model.redemptionCode.isEmpty)
      XCTAssertTrue(model.redemptionMessage.isEmpty)
      XCTAssertFalse(model.redemptionIsError)
      model.redemptionCode = "another-sample"
      model.snapshot = signedOut
      XCTAssertTrue(model.redemptionCode.isEmpty)
      XCTAssertEqual(model.membership, .signedOut)
      XCTAssertFalse(model.canRedeem)
    }
  }

  func testRedemptionResponseIncludesMembershipAndGatewayWarning() throws {
    let result = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"status":"running","account":{"state":"signed-in","userId":"one","plan":"pro","planExpiresAt":"2099-01-01T00:00:00Z"},"redemption":{"userId":"one","idempotent":true},"accountWarning":"会员已开通，网关连接待刷新。"}"#.utf8))
    XCTAssertEqual(result.redemption?.userId, "one")
    XCTAssertEqual(result.redemption?.idempotent, true)
    XCTAssertEqual(result.accountWarning, "会员已开通，网关连接待刷新。")
    guard case .pro = result.account?.membership() ?? .unknown else { return XCTFail("Valid redeemed membership should be shown as Pro") }
  }
}
