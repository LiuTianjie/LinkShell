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
