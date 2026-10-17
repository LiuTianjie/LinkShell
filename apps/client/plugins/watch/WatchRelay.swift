import Foundation

struct WatchMachine: Codable, Equatable, Identifiable {
  let id: String
  let signKey: String
  let boxKey: String
  let name: String
  let platform: String?
  var online: Bool
  let via: String
  var identity: WatchPeerIdentity { WatchPeerIdentity(id: id, signKey: signKey, boxKey: boxKey) }
}

// Session credentials must never be forwarded to a redirect supplied by a gateway.
final class WatchHTTPDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class WatchRelay {
  var onReady: (() -> Void)?
  var onEvent: ((String, [String: Any]) -> Void)?
  var onFrame: ((WatchPeerIdentity, [String: Any]) -> Void)?
  var onClosed: ((Error) -> Void)?
  private(set) var ready = false
  private var loop: Task<Void, Never>?
  private var outbox: [String] = []
  private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
  private var timeouts: [Int: Task<Void, Never>] = [:]
  private var nextID = 0
  private var generation = 0
  private let http: URLSession
  private let identity: WatchIdentity
  private let url: URL
  private let accountToken: String?

  init(url: URL, identity: WatchIdentity, token: String?, http: URLSession? = nil) {
    self.url = url; self.identity = identity; accountToken = token
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 35
    config.urlCache = nil
    self.http = http ?? URLSession(configuration: config, delegate: WatchHTTPDelegate(), delegateQueue: nil)
  }

  static func normalizeGateway(_ text: String) throws -> URL {
    let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var parts = URLComponents(string: raw.contains("://") ? raw : "https://" + raw),
          let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
          parts.query == nil, parts.fragment == nil else { throw WatchLinkError("请输入有效的网关地址") }
    if parts.scheme == "wss" { parts.scheme = "https" }
    // Loopback HTTP is only for the native interoperability test/simulator.
    #if DEBUG || !os(watchOS)
    let testHTTP = parts.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(host)
    #else
    let testHTTP = false
    #endif
    guard parts.scheme == "https" || testHTTP else { throw WatchLinkError("网关必须使用 HTTPS") }
    guard parts.path.isEmpty || parts.path == "/" || parts.path == "/v2/connect" else { throw WatchLinkError("请输入网关域名，不要附加路径") }
    parts.path = ""
    guard let url = parts.url else { throw WatchLinkError("网关地址无效") }
    return url
  }

  func start() {
    guard loop == nil else { return }
    generation += 1
    let epoch = generation
    loop = Task { [weak self] in
      guard let self else { return }
      do {
        let opened = try await post(url.appendingPathComponent("v2/poll"), body: [:], token: nil)
        guard let id = opened["id"] as? String, let token = opened["token"] as? String,
              !id.isEmpty, !token.isEmpty else { throw WatchLinkError("网关未返回连接凭证") }
        let endpoint = url.appendingPathComponent("v2/poll/\(id)")
        var ack = 0, requestNumber = 0
        while !Task.isCancelled && generation == epoch {
          requestNumber += 1
          let sending = outbox
          outbox.removeAll()
          let body: [String: Any] = ["request": requestNumber, "ack": ack, "frames": sending, "waitMs": 1_000]
          var reply: [String: Any]?
          for attempt in 0..<3 {
            do { reply = try await post(endpoint, body: body, token: token); break }
            catch {
              if Task.isCancelled || generation != epoch { throw CancellationError() }
              // Retry the exact numbered exchange; the gateway deduplicates it.
              guard attempt < 2, (error as? URLError) != nil else { throw error }
              try await Task.sleep(nanoseconds: UInt64(attempt + 1) * 500_000_000)
            }
          }
          guard generation == epoch, !Task.isCancelled else { throw CancellationError() }
          for entry in reply?["frames"] as? [[String: Any]] ?? [] {
            guard let seq = entry["seq"] as? Int, let frame = entry["frame"] as? String else { throw WatchLinkError("网关数据格式无效") }
            if seq <= ack { continue }
            guard seq == ack + 1 else { throw WatchLinkError("连接数据缺失，请重连") }
            try receive(frame)
            ack = seq
          }
          if let reason = reply?["closed"] as? String { throw WatchLinkError("连接已关闭（\(reason)）") }
        }
      } catch {
        if generation == epoch && !Task.isCancelled { fail(error) }
      }
    }
  }

  func stop() {
    generation += 1
    loop?.cancel(); loop = nil
    ready = false; outbox.removeAll()
    rejectPending(WatchLinkError("连接已断开，未确认操作请先刷新状态"))
  }
  func request(_ method: String, params: [String: Any] = [:]) async throws -> [String: Any] {
    guard ready else { throw WatchLinkError("网关尚未连接") }
    nextID += 1
    let id = nextID
    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      timeouts[id] = Task { [weak self] in
        try? await Task.sleep(nanoseconds: 40_000_000_000)
        guard !Task.isCancelled, let self else { return }
        self.pending.removeValue(forKey: id)?.resume(throwing: WatchLinkError("网关响应超时"))
        self.timeouts.removeValue(forKey: id)
      }
      do { try enqueue(["t": "req", "id": id, "method": method, "params": params]) }
      catch { pending.removeValue(forKey: id)?.resume(throwing: error); timeouts.removeValue(forKey: id)?.cancel() }
    }
  }
  func send(to machine: String, frame: [String: Any]) throws {
    guard ready else { throw WatchLinkError("网关尚未连接") }
    try enqueue(["t": "to", "to": machine, "d": String(decoding: JSONSerialization.data(withJSONObject: frame), as: UTF8.self)])
  }
  private func enqueue(_ frame: [String: Any]) throws {
    guard outbox.count < 32 else { throw WatchLinkError("连接繁忙，请稍后重试") }
    outbox.append(String(decoding: try JSONSerialization.data(withJSONObject: frame), as: UTF8.self))
  }
  private func receive(_ text: String) throws {
    guard let frame = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], let type = frame["t"] as? String else { throw WatchLinkError("网关消息无效") }
    switch type {
    case "challenge":
      guard let nonce = frame["nonce"] as? String, !ready else { throw WatchLinkError("网关握手无效") }
      let peer = try identity.peer
      var auth: [String: Any] = ["t": "auth", "role": "device", "name": "Apple Watch", "platform": "watchos",
        "identity": ["id": peer.id, "signKey": peer.signKey, "boxKey": peer.boxKey],
        "signature": try identity.sign("linkshell-gateway-v2:\(nonce)")]
      if let accountToken { auth["token"] = accountToken }
      try enqueue(auth)
    case "ready": ready = true; onReady?()
    case "res":
      guard let id = frame["id"] as? Int else { return }
      timeouts.removeValue(forKey: id)?.cancel()
      let continuation = pending.removeValue(forKey: id)
      if let error = frame["error"] as? [String: Any] {
        continuation?.resume(throwing: WatchLinkError(Self.message(error)))
      } else { continuation?.resume(returning: frame["result"] as? [String: Any] ?? [:]) }
    case "event": onEvent?(frame["name"] as? String ?? "", frame["data"] as? [String: Any] ?? [:])
    case "from":
      guard let from = frame["from"], let data = frame["d"] as? String,
            let tunnel = try JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else { throw WatchLinkError("加密通道消息无效") }
      let peer = try JSONDecoder().decode(WatchPeerIdentity.self, from: JSONSerialization.data(withJSONObject: from))
      try peer.validate()
      onFrame?(peer, tunnel)
    case "undeliverable": onEvent?("undeliverable", frame)
    case "error": throw WatchLinkError(Self.message(frame))
    default: break
    }
  }
  private func fail(_ error: Error) {
    stop()
    onClosed?(error)
  }
  private func rejectPending(_ error: Error) {
    let values = pending.values
    pending.removeAll()
    for timer in timeouts.values { timer.cancel() }
    timeouts.removeAll()
    for continuation in values { continuation.resume(throwing: error) }
  }
  private func post(_ endpoint: URL, body: [String: Any], token: String?) async throws -> [String: Any] {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await http.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw WatchLinkError("网关没有响应") }
    if response.statusCode == 404 { throw WatchLinkError("网关尚不支持手表独立连接，请升级网关或使用 iPhone 模式") }
    if response.statusCode == 429 { throw WatchLinkError("连接过于频繁，请稍后重试") }
    guard response.statusCode == 200 else { throw WatchLinkError("网关连接失败（\(response.statusCode)）") }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw WatchLinkError("网关响应无效") }
    return object
  }
  private static func message(_ error: [String: Any]) -> String {
    switch error["code"] as? String {
    case "bad_code", "not_found", "expired": return "配对码无效或已过期，请在电脑上重新生成"
    case "not_paired", "not_allowed": return "电脑不再信任此手表，请重新配对"
    case "rejected", "declined": return "电脑拒绝了配对请求"
    case "accounts_disabled": return "此网关仅支持配对码连接"
    case "token_invalid": return "登录已过期，请重新登录"
    default: return error["message"] as? String ?? "连接未能完成"
    }
  }
}
