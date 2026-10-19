import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, expect } from "vitest";

it.skipIf(process.platform !== "darwin")("Watch login refreshes tokens once and isolates account identity on logout", () => {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-watch-account-"));
  const swift = resolve(import.meta.dirname, "../plugins/watch");
  try {
    const harness = join(dir, "Harness.swift"), binary = join(dir, "account");
    writeFileSync(harness, String.raw`import Foundation
final class FakeHTTP: URLProtocol {
  static var grants: [String] = []
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let grant = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!
    Self.grants.append(grant)
    precondition(request.value(forHTTPHeaderField: "apikey") == "public-test-key")
    let result: [String: Any] = ["access_token": grant == "password" ? "first" : "renewed", "refresh_token": "refresh", "expires_in": grant == "password" ? 1 : 3600, "user": ["id": "user-a", "email": "test@example.com"]]
    client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client!.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: result))
    client!.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@main struct Harness {
  @MainActor static func main() async throws {
    var secrets: [String: Data] = [:]
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FakeHTTP.self]
    let account = try WatchAccount(http: URLSession(configuration: config), authURL: URL(string: "https://example.com"), anonKey: "public-test-key", readSecret: { secrets[$0] }, writeSecret: { secrets[$0] = $1 })
    let signedOut = try account.identity().peer.id
    try await account.signIn(email: "test@example.com", password: "test-only")
    let signedIn = try account.identity().peer.id
    precondition(signedIn != signedOut)
    async let first = account.token()
    async let second = account.token()
    let tokens = try await [first, second]
    precondition(tokens == ["renewed", "renewed"])
    precondition(FakeHTTP.grants == ["password", "refresh_token"])
    try account.signOut()
    precondition(account.session == nil && secrets["account"] == nil && secrets["identity.user-a"] == nil)
    let afterLogout = try account.identity().peer.id
    precondition(afterLogout == signedOut)
    print("account isolation passed")
  }
}
`);
    execFileSync("xcrun", ["swiftc", "-parse-as-library", join(swift, "WatchCrypto.swift"), join(swift, "WatchRelay.swift"), join(swift, "WatchAccount.swift"), harness, "-o", binary], { stdio: "pipe" });
    expect(execFileSync(binary, { encoding: "utf8" })).toContain("account isolation passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(process.platform !== "darwin")("Watch membership uses verified responses, deduplicates redemption and isolates old account requests", () => {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-watch-membership-"));
  const swift = resolve(import.meta.dirname, "../plugins/watch");
  try {
    const harness = join(dir, "Harness.swift"), binary = join(dir, "membership");
    writeFileSync(harness, String.raw`import Foundation
struct Reply {
  let path: String
  let status: Int
  let body: Any
  var held = false
  var bearer: String? = "Bearer fresh-a"
}
final class FakeHTTP: URLProtocol {
  static let lock = NSLock()
  static var replies: [Reply] = []
  static var pending: (FakeHTTP, Reply)?
  static var paths: [String] = []
  static func enqueue(_ reply: Reply) { lock.lock(); defer { lock.unlock() }; replies.append(reply) }
  static var isHolding: Bool { lock.lock(); defer { lock.unlock() }; return pending != nil }
  static var count: Int { lock.lock(); defer { lock.unlock() }; return paths.count }
  static func release() {
    lock.lock(); let held = pending!; pending = nil; lock.unlock()
    held.0.respond(held.1)
  }
  static func discardHeld() { lock.lock(); defer { lock.unlock() }; pending = nil }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.lock.lock()
    precondition(!Self.replies.isEmpty, "Unexpected HTTP request")
    let reply = Self.replies.removeFirst()
    Self.paths.append(request.url!.path)
    Self.lock.unlock()
    precondition(request.url!.path == reply.path)
    precondition(request.value(forHTTPHeaderField: "Authorization") == reply.bearer)
    if reply.path != "/auth/v1/token" {
      precondition(request.timeoutInterval == 15 && !request.httpShouldHandleCookies)
    }
    if reply.path == "/rest/v1/profiles" {
      precondition(request.httpMethod == "GET")
      precondition(request.value(forHTTPHeaderField: "apikey") == "public-test-key")
      let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
      precondition(query.contains(URLQueryItem(name: "select", value: "plan,plan_expires_at")))
      precondition(query.contains(URLQueryItem(name: "id", value: "eq.user-a")))
    }
    if reply.path == "/api/pro/redeem" {
      precondition(request.url!.absoluteString == "https://itool.tech/api/pro/redeem")
      precondition(request.httpMethod == "POST")
      precondition(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
      var data = request.httpBody ?? Data()
      if data.isEmpty, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var bytes = [UInt8](repeating: 0, count: 256)
        while stream.hasBytesAvailable { let count = stream.read(&bytes, maxLength: bytes.count); if count <= 0 { break }; data.append(contentsOf: bytes.prefix(count)) }
      }
      let body = try! JSONSerialization.jsonObject(with: data) as! [String: String]
      precondition(body == ["code": "test-code"])
    }
    if reply.held { Self.lock.lock(); Self.pending = (self, reply); Self.lock.unlock() }
    else { respond(reply) }
  }
  func respond(_ reply: Reply) {
    client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: ["Date": "Wed, 01 Jan 2020 00:00:00 GMT"])!, cacheStoragePolicy: .notAllowed)
    client!.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: reply.body))
    client!.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@main struct Harness {
  static let profile = "/rest/v1/profiles", redeem = "/api/pro/redeem", token = "/auth/v1/token"
  @MainActor static func hold() async throws {
    for _ in 0..<2000 {
      if FakeHTTP.isHolding { return }
      try await Task.sleep(nanoseconds: 1_000_000)
    }
    preconditionFailure("HTTP request did not start")
  }
  @MainActor static func main() async throws {
    var secrets: [String: Data] = [:]
    func restore(_ expiry: Date = Date().addingTimeInterval(3600)) throws {
      secrets["account"] = try JSONEncoder().encode(WatchAccountSession(accessToken: "fresh-a", refreshToken: "refresh-a", expiresAt: expiry, userID: "user-a", email: "a@example.com"))
    }
    try restore()
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FakeHTTP.self]
    func account() throws -> WatchAccount {
      try WatchAccount(http: URLSession(configuration: config), authURL: URL(string: "https://example.com"), anonKey: "public-test-key", readSecret: { secrets[$0] }, writeSecret: { secrets[$0] = $1 })
    }
    let current = try account()
    precondition(current.membership == .unknown)
    FakeHTTP.enqueue(Reply(path: profile, status: 503, body: [:]))
    await current.refreshMembership()
    precondition(current.membership == .unknown && current.membershipError != nil)
    let beforeUnknown = FakeHTTP.count
    let unknownRedemption = await current.redeemProCode("test-code")
    precondition(!unknownRedemption && FakeHTTP.count == beforeUnknown)
    FakeHTTP.enqueue(Reply(path: profile, status: 200, body: [["plan": "pro", "plan_expires_at": "2019-12-31T23:59:59Z"]]))
    await current.refreshMembership()
    precondition(current.membership == .free)
    let emptyRedemption = await current.redeemProCode(" \n ")
    precondition(!emptyRedemption && current.membershipError == "请输入激活码")

    for (status, expected) in [(422, "激活码无效或已不可用，请检查后重试"), (429, "操作太频繁，请稍后重试"), (401, "登录已失效，请重新登录后再试")] {
      FakeHTTP.enqueue(Reply(path: redeem, status: status, body: [:]))
      let result = await current.redeemProCode("test-code")
      precondition(!result && current.membership == .free && current.membershipError == expected)
    }
    FakeHTTP.enqueue(Reply(path: redeem, status: 200, body: ["ok": true]))
    let incomplete = await current.redeemProCode("test-code")
    precondition(!incomplete && current.membershipError == "兑换结果尚未确认，请刷新会员状态后重试")
    let expired: [String: Any] = ["ok": true, "valid": true, "idempotent": true, "months": 1, "plan_expires_at": "2019-12-31T23:59:59Z", "server_time": "2020-01-01T00:00:00.000Z"]
    FakeHTTP.enqueue(Reply(path: redeem, status: 200, body: expired))
    let past = await current.redeemProCode("test-code")
    precondition(!past && current.membershipError == "此激活码已兑换且权益已到期，请使用新的激活码")
    let success: [String: Any] = ["ok": true, "valid": true, "idempotent": false, "months": 12, "plan_expires_at": "2021-01-01T00:00:00.000Z", "server_time": "2020-01-01T00:00:00Z"]
    FakeHTTP.enqueue(Reply(path: redeem, status: 200, body: success, held: true))
    FakeHTTP.enqueue(Reply(path: profile, status: 503, body: [:]))
    let redeeming = Task { await current.redeemProCode("  test-code \n") }
    try await hold()
    precondition(current.redeeming)
    let requestCount = FakeHTTP.count
    let duplicate = await current.redeemProCode("test-code")
    precondition(!duplicate && FakeHTTP.count == requestCount)
    FakeHTTP.release()
    let redeemed = await redeeming.value
    precondition(redeemed && !current.redeeming && current.membershipError == nil)
    guard case .pro = current.membership else { preconditionFailure("Profile failure undid redemption") }
    precondition(current.redemptionNotice == "兑换成功，已开通 Pro")

    // The response Date, not the watch's local clock, determines profile expiry.
    FakeHTTP.enqueue(Reply(path: profile, status: 200, body: [["plan": "pro", "plan_expires_at": "2021-01-01T00:00:00Z"]]))
    await current.refreshMembership()
    guard case .pro = current.membership else { preconditionFailure("Ignored profile server date") }
    FakeHTTP.enqueue(Reply(path: profile, status: 200, body: [], held: true))
    let cancelled = Task { await current.refreshMembership() }
    try await hold(); cancelled.cancel(); await cancelled.value; FakeHTTP.discardHeld()
    guard case .pro = current.membership else { preconditionFailure("Cancellation undid membership") }
    precondition(current.membershipError == nil && !current.membershipLoading)
    FakeHTTP.enqueue(Reply(path: profile, status: 200, body: [], held: true))
    let oldProfile = Task { await current.refreshMembership() }
    try await hold(); try current.signOut(); FakeHTTP.release(); await oldProfile.value
    precondition(current.membership == .unknown && current.membershipError == nil && current.redemptionNotice == nil)

    try restore()
    let laggingProfile = try account()
    FakeHTTP.enqueue(Reply(path: profile, status: 200, body: []))
    await laggingProfile.refreshMembership()
    var idempotent = success; idempotent["idempotent"] = true
    FakeHTTP.enqueue(Reply(path: redeem, status: 200, body: idempotent))
    FakeHTTP.enqueue(Reply(path: profile, status: 200, body: []))
    let repeated = await laggingProfile.redeemProCode("test-code")
    precondition(repeated && laggingProfile.redemptionNotice == "此激活码已兑换，Pro 权益已同步")
    guard case .pro = laggingProfile.membership else { preconditionFailure("Stale profile undid redemption") }

    let switching = try account()
    FakeHTTP.enqueue(Reply(path: profile, status: 200, body: []))
    await switching.refreshMembership()
    FakeHTTP.enqueue(Reply(path: redeem, status: 200, body: success, held: true))
    let oldRedemption = Task { await switching.redeemProCode("test-code") }
    try await hold(); try switching.signOut()
    let loggedIn: [String: Any] = ["access_token": "fresh-b", "refresh_token": "refresh-b", "expires_in": 3600, "user": ["id": "user-b"]]
    FakeHTTP.enqueue(Reply(path: token, status: 200, body: loggedIn, bearer: nil))
    try await switching.signIn(email: "b@example.com", password: "test-only")
    FakeHTTP.release()
    let oldResult = await oldRedemption.value
    precondition(!oldResult && switching.session?.userID == "user-b" && switching.membership == .unknown && switching.redemptionNotice == nil && !switching.redeeming)

    // A token refresh that finishes after logout cannot send a profile request.
    try restore(Date().addingTimeInterval(-1))
    let refreshing = try account()
    let renewed: [String: Any] = ["access_token": "fresh-a", "refresh_token": "refresh-a", "expires_in": 3600, "user": ["id": "user-a"]]
    FakeHTTP.enqueue(Reply(path: token, status: 200, body: renewed, held: true, bearer: nil))
    let staleRefresh = Task { await refreshing.refreshMembership() }
    try await hold(); try refreshing.signOut(); FakeHTTP.release(); await staleRefresh.value
    precondition(refreshing.session == nil && refreshing.membership == .unknown && refreshing.membershipError == nil)
    precondition(FakeHTTP.replies.isEmpty)
    print("membership verification passed")
  }
}
`);
    execFileSync("xcrun", ["swiftc", "-parse-as-library", join(swift, "WatchCrypto.swift"), join(swift, "WatchRelay.swift"), join(swift, "WatchAccount.swift"), harness, "-o", binary], { stdio: "pipe" });
    expect(execFileSync(binary, { encoding: "utf8", timeout: 15_000 })).toContain("membership verification passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
