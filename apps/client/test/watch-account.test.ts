import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

it.skipIf(process.platform !== "darwin")("Watch membership reads the itool.tech entitlement and isolates old account requests", () => {
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
    if reply.path == "/api/membership/entitlement" {
      precondition(request.url!.absoluteString == "https://itool.tech/api/membership/entitlement?product=linkshell")
      precondition(request.httpMethod == "GET")
    }
    if reply.held { Self.lock.lock(); Self.pending = (self, reply); Self.lock.unlock() }
    else { respond(reply) }
  }
  func respond(_ reply: Reply) {
    client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client!.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: reply.body))
    client!.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@main struct Harness {
  static let entitlement = "/api/membership/entitlement", token = "/auth/v1/token"
  static func answer(active: Bool, until: String?, tier: String = "monthly") -> [String: Any] {
    ["ok": true, "product": "linkshell", "required_tier": "monthly", "active": active, "valid_until": until ?? NSNull(), "tier": active ? tier : "free", "server_time": "2020-01-01T00:00:00.000Z"]
  }
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
    FakeHTTP.enqueue(Reply(path: entitlement, status: 503, body: ["ok": false, "code": "temporarily_unavailable"]))
    await current.refreshMembership()
    precondition(current.membership == .unknown && current.membershipError == "会员服务暂时不可用，请稍后重试")

    FakeHTTP.enqueue(Reply(path: entitlement, status: 200, body: answer(active: false, until: nil)))
    await current.refreshMembership()
    precondition(current.membership == .free && current.membershipError == nil)

    // The server clock, not the watch's, decides whether an expiry has passed.
    FakeHTTP.enqueue(Reply(path: entitlement, status: 200, body: answer(active: true, until: "2019-12-31T23:59:59Z")))
    await current.refreshMembership()
    precondition(current.membership == .free)

    FakeHTTP.enqueue(Reply(path: entitlement, status: 200, body: answer(active: true, until: "2021-01-01T00:00:00Z", tier: "yearly")))
    await current.refreshMembership()
    guard case .pro(_, let yearly) = current.membership, yearly else { preconditionFailure("Yearly membership not shown") }

    // An outage keeps the last known state; a refused token does not.
    FakeHTTP.enqueue(Reply(path: entitlement, status: 502, body: [:]))
    await current.refreshMembership()
    guard case .pro = current.membership else { preconditionFailure("Outage undid membership") }
    FakeHTTP.enqueue(Reply(path: entitlement, status: 401, body: ["ok": false, "code": "login_required"]))
    await current.refreshMembership()
    precondition(current.membership == .unknown && current.membershipError == "登录已失效，请重新登录后再试")
    FakeHTTP.enqueue(Reply(path: entitlement, status: 200, body: ["ok": true, "active": "yes"]))
    await current.refreshMembership()
    precondition(current.membership == .unknown && current.membershipError == "会员状态返回异常，请稍后重试")

    FakeHTTP.enqueue(Reply(path: entitlement, status: 200, body: answer(active: true, until: "2021-01-01T00:00:00Z")))
    await current.refreshMembership()
    guard case .pro(_, let monthlyYearly) = current.membership, !monthlyYearly else { preconditionFailure("Monthly membership not shown") }
    FakeHTTP.enqueue(Reply(path: entitlement, status: 200, body: answer(active: false, until: nil), held: true))
    let cancelled = Task { await current.refreshMembership() }
    try await hold(); cancelled.cancel(); await cancelled.value; FakeHTTP.discardHeld()
    guard case .pro = current.membership else { preconditionFailure("Cancellation undid membership") }
    precondition(current.membershipError == nil && !current.membershipLoading)
    FakeHTTP.enqueue(Reply(path: entitlement, status: 200, body: answer(active: false, until: nil), held: true))
    let oldRead = Task { await current.refreshMembership() }
    try await hold(); try current.signOut(); FakeHTTP.release(); await oldRead.value
    precondition(current.membership == .unknown && current.membershipError == nil)

    try restore()
    let switching = try account()
    FakeHTTP.enqueue(Reply(path: entitlement, status: 200, body: answer(active: true, until: "2021-01-01T00:00:00Z"), held: true))
    let oldAccount = Task { await switching.refreshMembership() }
    try await hold(); try switching.signOut()
    let loggedIn: [String: Any] = ["access_token": "fresh-b", "refresh_token": "refresh-b", "expires_in": 3600, "user": ["id": "user-b"]]
    FakeHTTP.enqueue(Reply(path: token, status: 200, body: loggedIn, bearer: nil))
    try await switching.signIn(email: "b@example.com", password: "test-only")
    FakeHTTP.release(); await oldAccount.value
    precondition(switching.session?.userID == "user-b" && switching.membership == .unknown)

    // A token refresh that finishes after logout cannot send a membership request.
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

it("Watch membership screen offers no purchase", () => {
  const views = readFileSync(resolve(import.meta.dirname, "../plugins/watch/WatchConnectionViews.swift"), "utf8");
  const membership = views.slice(views.indexOf("struct WatchMembershipView"), views.indexOf("struct WatchLoginView"));
  expect(membership).not.toMatch(/Link\(|openURL|TextField|itool\.tech\/pro|checkout=|¥|\$[0-9]|激活码|https?:\/\//);
  expect(membership).toContain("可在电脑端 LinkShell 管理账户状态");
});
