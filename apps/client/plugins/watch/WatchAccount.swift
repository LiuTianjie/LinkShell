import Foundation
import Security

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

@MainActor
final class WatchAccount {
  private(set) var session: WatchAccountSession?
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
    refreshTask?.cancel(); refreshTask = nil
    if let userID = session?.userID { try writeSecret("identity.\(userID)", nil) }
    try writeSecret("account", nil)
    session = nil
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
      throw WatchLinkError(grant == "password" ? "邮箱或密码不正确，或邮箱尚未验证" : "登录已过期，请重新登录")
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
