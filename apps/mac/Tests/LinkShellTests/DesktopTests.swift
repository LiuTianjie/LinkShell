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
    XCTAssertEqual(try decode("2028-01-02T00:00:00Z").membership(at: now), .pro(expected, .monthly))
    XCTAssertEqual(try decode("2028-01-02T08:00:00.000+08:00").membership(at: now), .pro(expected, .monthly))
    let yearly = try JSONDecoder().decode(DesktopSnapshot.Account.self, from: Data(#"{"state":"signed-in","userId":"one","plan":"pro","tier":"yearly","planExpiresAt":"2028-01-02T00:00:00Z"}"#.utf8))
    XCTAssertEqual(yearly.membership(at: now), .pro(expected, .yearly))
    XCTAssertEqual(DesktopMembershipTier.yearly.label, "iTool 年度会员")
    XCTAssertEqual(try decode("2028-01-02T00:00:00Z").membership(at: expected), .free)
    XCTAssertEqual(try decode("invalid").membership(at: now), .unknown)
    let missing = try JSONDecoder().decode(DesktopSnapshot.Account.self, from: Data(#"{"state":"signed-in","userId":"one","plan":"pro","planExpiresAt":null}"#.utf8))
    XCTAssertEqual(missing.membership(at: now), .unknown)
  }

  func testAnOlderCliAccountDoesNotInventAFreeMembership() throws {
    let account = try JSONDecoder().decode(DesktopSnapshot.Account.self, from: Data(#"{"state":"signed-in","userId":"one"}"#.utf8))
    XCTAssertEqual(account.membership(), .unknown)
  }

  func testAccountChangesClearThePreviousAccountsMessage() async throws {
    let first = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"status":"stopped","account":{"state":"signed-in","userId":"one","plan":"free"}}"#.utf8))
    let second = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"status":"stopped","account":{"state":"signed-in","userId":"two","plan":"free"}}"#.utf8))
    let signedOut = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"status":"stopped","account":{"state":"signed-out"}}"#.utf8))
    await MainActor.run {
      let model = DesktopModel()
      model.snapshot = first
      XCTAssertEqual(model.membership, .free)
      model.accountMessage = "旧账号的提示"
      model.snapshot = second
      XCTAssertTrue(model.accountMessage.isEmpty)
      model.snapshot = signedOut
      XCTAssertEqual(model.membership, .signedOut)
    }
  }

  func testAnAccountRefreshResponseCarriesItsWarning() throws {
    let result = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"{"status":"running","account":{"state":"signed-in","userId":"one","plan":"pro","tier":"monthly","planExpiresAt":"2099-01-01T00:00:00Z"},"accountWarning":"会员已开通，网关连接待刷新。"}"#.utf8))
    XCTAssertEqual(result.accountWarning, "会员已开通，网关连接待刷新。")
    guard case .pro(_, .monthly) = result.account?.membership() ?? .unknown else { return XCTFail("An active membership should be shown with its tier") }
  }

  func testTrialBadgeRenewalThresholdAndLocaleAwareMembershipURLs() throws {
    let now = Date(timeIntervalSince1970: 1_798_761_600)
    let activeTrial = try JSONDecoder().decode(
      DesktopSnapshot.Account.self,
      from: Data(#"{"state":"signed-in","userId":"one","plan":"pro","tier":"monthly","isTrial":true,"daysRemaining":5,"planExpiresAt":"2027-01-06T00:00:00Z"}"#.utf8)
    )
    XCTAssertEqual(activeTrial.badgeLabel(at: now), "7 天免费试用 · 剩余 5 天")
    XCTAssertFalse(activeTrial.isTrialExpiringSoon(at: now))

    let expiringTrial = try JSONDecoder().decode(
      DesktopSnapshot.Account.self,
      from: Data(#"{"state":"signed-in","userId":"one","plan":"pro","tier":"monthly","isTrial":true,"daysRemaining":2,"planExpiresAt":"2027-01-03T00:00:00Z"}"#.utf8)
    )
    XCTAssertEqual(expiringTrial.badgeLabel(at: now), "7 天免费试用 · 剩余 2 天")
    XCTAssertTrue(expiringTrial.isTrialExpiringSoon(at: now))

    XCTAssertEqual(ITool.membershipURL(locale: "zh-Hans-CN"), "https://www.itool.tech/zh/pro?from=linkshell")
    XCTAssertEqual(ITool.membershipURL(locale: "en-US"), "https://www.itool.tech/en/pro?from=linkshell")
    XCTAssertEqual(ITool.yearlyUpgradeURL(locale: "ja-JP"), "https://www.itool.tech/en/pro?from=linkshell&checkout=yearly")
  }

  func testScreenPrivacyCurtainAndAutoLockLifecycle() {
    var curtainCalls: [Bool] = []
    var lockCount = 0
    let privacy = ScreenPrivacy(
      applyCurtain: { enabled in
        curtainCalls.append(enabled)
        return enabled ? [42, 99] : []
      },
      lockHost: { lockCount += 1 }
    )

    let enabled = privacy.apply(curtain: true, lockOnDisconnect: true)
    XCTAssertEqual(enabled["curtain"] as? Bool, true)
    XCTAssertEqual(enabled["lockOnDisconnect"] as? Bool, true)
    XCTAssertEqual(privacy.curtainWindowIDs(), [42, 99])
    XCTAssertEqual(curtainCalls, [true])

    // While another viewer remains connected, neither curtain teardown nor lock fires.
    XCTAssertFalse(privacy.viewerDisconnected(remainingViewers: 1))
    XCTAssertEqual(lockCount, 0)
    XCTAssertEqual(privacy.curtainWindowIDs(), [42, 99])

    // Last viewer disconnecting lifts the curtain and locks the Mac once.
    XCTAssertTrue(privacy.viewerDisconnected(remainingViewers: 0))
    XCTAssertEqual(curtainCalls, [true, false])
    XCTAssertEqual(lockCount, 1)
    XCTAssertTrue(privacy.curtainWindowIDs().isEmpty)
    XCTAssertEqual(privacy.currentState()["curtain"] as? Bool, false)
    XCTAssertEqual(privacy.currentState()["lockOnDisconnect"] as? Bool, false)
  }
}
