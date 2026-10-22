import Foundation
import Security
import Combine

// Secrets stay on this watch and never enter the shared widget defaults/container.
enum WatchKeychain {
  static func read(_ name: String) throws -> Data? {
    var query = base(name)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data else { throw WatchLinkError("无法读取手表钥匙串，请解锁后重试") }
    return data
  }
  static func write(_ name: String, data: Data?) throws {
    let query = base(name)
    guard let data else {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw WatchLinkError("无法清除手表登录状态") }
      return
    }
    let values: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      guard SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw WatchLinkError("无法保存手表登录状态") }
    } else if status != errSecSuccess { throw WatchLinkError("无法保存手表登录状态") }
  }
  private static func base(_ name: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "\(Bundle.main.bundleIdentifier ?? "com.bd.linkshell.watchkitapp").independent", kSecAttrAccount as String: name]
  }
}

struct WatchAccountSession: Codable {
  var accessToken: String
  var refreshToken: String
  var expiresAt: Date
  let userID: String
  let email: String?
}

/// The account service refused the refresh token. Only this means the login is gone: a network
/// failure or an outage leaves the session as it is, to be refreshed on a later try.
struct WatchAuthExpired: LocalizedError {
  var errorDescription: String? { "登录已过期，请重新登录" }
}

enum WatchMembership: Equatable {
  case unknown
  case free
  case pro(expiresAt: Date)
}

@MainActor
final class WatchAccount: ObservableObject {
  @Published private(set) var session: WatchAccountSession?
  @Published private(set) var membership: WatchMembership = .unknown
  @Published private(set) var membershipLoading = false
  @Published private(set) var redeeming = false
  @Published private(set) var membershipError: String?
  @Published private(set) var redemptionNotice: String?
  private var refreshTask: Task<WatchAccountSession, Error>?
  private var generation = 0
  private let http: URLSession
  private let authURL: URL
  private let anonKey: String
  private let readSecret: (String) throws -> Data?
  private let writeSecret: (String, Data?) throws -> Void

  init(http: URLSession? = nil, authURL: URL? = nil, anonKey: String? = nil,
       readSecret: @escaping (String) throws -> Data? = WatchKeychain.read,
       writeSecret: @escaping (String, Data?) throws -> Void = { try WatchKeychain.write($0, data: $1) }) throws {
    self.http = http ?? URLSession(configuration: .ephemeral, delegate: WatchHTTPDelegate(), delegateQueue: nil)
    self.readSecret = readSecret; self.writeSecret = writeSecret
    guard let url = authURL ?? URL(string: Bundle.main.object(forInfoDictionaryKey: "LinkShellAuthURL") as? String ?? ""),
          url.scheme == "https" else { throw WatchLinkError("缺少账号服务配置") }
    self.authURL = url
    self.anonKey = anonKey ?? Bundle.main.object(forInfoDictionaryKey: "LinkShellAuthAnonKey") as? String ?? ""
    if let data = try readSecret("account") { session = try JSONDecoder().decode(WatchAccountSession.self, from: data) }
  }

  func identity() throws -> WatchIdentity {
    // Gateway keys are account-bound. A signed-out watch must use a different
    // identity, otherwise the gateway would still grant its old account access.
    let key = "identity.\(session?.userID ?? "paired")"
    if let data = try readSecret(key) { return try JSONDecoder().decode(WatchIdentity.self, from: data) }
    let identity = WatchIdentity()
    try writeSecret(key, JSONEncoder().encode(identity))
    return identity
  }

  func signIn(email: String, password: String) async throws {
    generation += 1
    resetMembership()
    let epoch = generation
    refreshTask?.cancel(); refreshTask = nil
    let next = try await grant("password", body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password])
    guard generation == epoch else { throw CancellationError() }
    try save(next)
  }
  func token() async throws -> String? {
    guard let session else { return nil }
    if session.expiresAt.timeIntervalSinceNow > 90 { return session.accessToken }
    if let refreshTask { return try await refreshTask.value.accessToken }
    let epoch = generation
    let task = Task { try await grant("refresh_token", body: ["refresh_token": session.refreshToken]) }
    refreshTask = task
    defer { if epoch == generation { refreshTask = nil } }
    let next = try await task.value
    guard generation == epoch else { throw CancellationError() }
    try save(next)
    return next.accessToken
  }
  func signOut() throws {
    generation += 1
    resetMembership()
    refreshTask?.cancel(); refreshTask = nil
    if let userID = session?.userID { try writeSecret("identity.\(userID)", nil) }
    try writeSecret("account", nil)
    session = nil
  }
  private func resetMembership() {
    membership = .unknown; membershipLoading = false; redeeming = false
    membershipError = nil; redemptionNotice = nil
  }
  private func checkAccount(_ epoch: Int, _ userID: String) throws {
    guard epoch == generation, session?.userID == userID, !Task.isCancelled else { throw CancellationError() }
  }
  func refreshMembership() async {
    guard let userID = session?.userID, !membershipLoading, !redeeming else { return }
    let epoch = generation
    membershipLoading = true; membershipError = nil
    defer { if generation == epoch { membershipLoading = false } }
    do { membership = try await fetchMembership(epoch: epoch, userID: userID) }
    catch {
      guard generation == epoch, !Task.isCancelled, !(error is CancellationError) else { return }
      membership = .unknown; membershipError = Self.message(error)
    }
  }
  @discardableResult
  func redeemProCode(_ rawCode: String) async -> Bool {
    guard let userID = session?.userID, !redeeming, !membershipLoading, membership == .free else { return false }
    let code = rawCode.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !code.isEmpty else { membershipError = "请输入激活码"; return false }
    let epoch = generation
    redeeming = true; membershipError = nil; redemptionNotice = nil
    defer { if generation == epoch { redeeming = false } }
    do {
      guard let token = try await token() else { throw WatchLinkError("登录已失效，请重新登录后再试") }
      try checkAccount(epoch, userID)
      var request = URLRequest(url: URL(string: "https://itool.tech/api/pro/redeem")!)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
      let (data, response) = try await membershipRequest(request)
      try checkAccount(epoch, userID)
      guard (200..<300).contains(response.statusCode) else { throw WatchLinkError(Self.redemptionError(data, status: response.statusCode)) }
      struct Result: Decodable {
        let ok: Bool; let valid: Bool; let idempotent: Bool; let months: Double
        let plan_expires_at: String; let server_time: String
      }
      guard let result = try? JSONDecoder().decode(Result.self, from: data), result.ok, result.valid,
            result.months.isFinite, result.months >= 0,
            let expiry = Self.date(result.plan_expires_at), let now = Self.date(result.server_time) else {
        throw WatchLinkError("兑换结果尚未确认，请刷新会员状态后重试")
      }
      guard expiry > now else {
        throw WatchLinkError(result.idempotent ? "此激活码已兑换且权益已到期，请使用新的激活码" : "兑换结果尚未确认，请刷新会员状态后重试")
      }
      membership = .pro(expiresAt: expiry)
      redemptionNotice = result.idempotent ? "此激活码已兑换，Pro 权益已同步" : "兑换成功，已开通 Pro"
      // A delayed profile read must not undo the server's confirmed redemption.
      if let refreshed = try? await fetchMembership(epoch: epoch, userID: userID), case .pro = refreshed {
        membership = refreshed
      }
      try checkAccount(epoch, userID)
      return true
    } catch {
      guard generation == epoch, !Task.isCancelled, !(error is CancellationError) else { return false }
      membershipError = Self.message(error)
      return false
    }
  }
  private func fetchMembership(epoch: Int, userID: String) async throws -> WatchMembership {
    guard let token = try await token() else { throw WatchLinkError("登录已失效，请重新登录后再试") }
    try checkAccount(epoch, userID)
    let url = authURL.appendingPathComponent("rest/v1/profiles").appending(queryItems: [
      URLQueryItem(name: "select", value: "plan,plan_expires_at"),
      URLQueryItem(name: "id", value: "eq.\(userID)"), URLQueryItem(name: "limit", value: "1")
    ])
    var request = URLRequest(url: url)
    request.setValue(anonKey, forHTTPHeaderField: "apikey")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await membershipRequest(request)
    try checkAccount(epoch, userID)
    if response.statusCode == 401 || response.statusCode == 403 { throw WatchLinkError("登录已失效，请重新登录后再试") }
    guard (200..<300).contains(response.statusCode) else { throw WatchLinkError("暂时无法获取会员状态，请稍后重试") }
    struct Profile: Decodable { let plan: String; let plan_expires_at: String? }
    guard let profiles = try? JSONDecoder().decode([Profile].self, from: data) else { throw WatchLinkError("会员状态返回异常，请稍后重试") }
    guard let profile = profiles.first, profile.plan == "pro" else { return .free }
    guard let rawExpiry = profile.plan_expires_at, let expiry = Self.date(rawExpiry) else { return .free }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    let now = response.value(forHTTPHeaderField: "Date").flatMap(formatter.date(from:)) ?? Date()
    return expiry > now ? .pro(expiresAt: expiry) : .free
  }
  private func membershipRequest(_ original: URLRequest) async throws -> (Data, HTTPURLResponse) {
    var request = original
    request.timeoutInterval = 15; request.httpShouldHandleCookies = false
    let (data, response) = try await http.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw WatchLinkError("账号服务没有响应") }
    return (data, response)
  }
  private static func date(_ raw: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: raw) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: raw)
  }
  private static func message(_ error: Error) -> String {
    guard let urlError = error as? URLError else { return error.localizedDescription }
    return urlError.code == .timedOut ? "请求超时，请稍后重试" : "网络连接失败，请检查网络后重试"
  }
  private static func redemptionError(_ data: Data, status: Int) -> String {
    let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let code = body?["code"] as? String ?? (body?["error"] as? [String: Any])?["code"] as? String
    let statusCodes = [400: "malformed_request", 401: "login_required", 403: "login_required", 413: "request_too_large", 422: "invalid_or_unavailable", 429: "rate_limited", 503: "temporarily_unavailable"]
    let messages = [
      "malformed_request": "激活码格式不正确，请检查后重试", "login_required": "登录已失效，请重新登录后再试",
      "request_too_large": "激活码内容过长，请检查后重试", "invalid_or_unavailable": "激活码无效或已不可用，请检查后重试",
      "rate_limited": "操作太频繁，请稍后重试", "temporarily_unavailable": "兑换服务暂时不可用，请稍后重试"
    ]
    return code.flatMap { messages[$0] } ?? statusCodes[status].flatMap { messages[$0] } ?? "兑换失败，请稍后重试"
  }
  private func save(_ next: WatchAccountSession) throws {
    try writeSecret("account", JSONEncoder().encode(next))
    session = next
  }
  private func grant(_ grant: String, body: [String: String]) async throws -> WatchAccountSession {
    let url = authURL.appendingPathComponent("auth/v1/token").appending(queryItems: [URLQueryItem(name: "grant_type", value: grant)])
    var request = URLRequest(url: url)
    request.httpMethod = "POST"; request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(anonKey, forHTTPHeaderField: "apikey")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await http.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw WatchLinkError("账号服务没有响应") }
    guard response.statusCode == 200 else {
      if response.statusCode == 429 { throw WatchLinkError("登录尝试过于频繁，请稍后重试") }
      if response.statusCode >= 500 { throw WatchLinkError("账号服务暂时不可用，请稍后重试") }
      if grant != "password" { throw WatchAuthExpired() }
      throw WatchLinkError("邮箱或密码不正确，或邮箱尚未验证")
    }
    struct Token: Decodable {
      let access_token: String; let refresh_token: String; let expires_in: Double
      let user: User
      struct User: Decodable { let id: String; let email: String? }
    }
    let token = try JSONDecoder().decode(Token.self, from: data)
    guard !token.access_token.isEmpty, !token.refresh_token.isEmpty, token.expires_in > 0 else { throw WatchLinkError("账号服务返回了无效凭证") }
    return WatchAccountSession(accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: Date().addingTimeInterval(token.expires_in), userID: token.user.id, email: token.user.email)
  }
}
