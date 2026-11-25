import Foundation

/// An empty poll was cut short because frames are waiting to go out.
struct WatchPollWoken: Error {}

/// The gateway refused a poll's numbering (409), e.g. `request_out_of_order` or `poll_in_progress`.
struct WatchPollRefused: LocalizedError {
  let code: String
  var errorDescription: String? { "网关连接失败（409 \(code)）" }
}

/// The gateway is up but can't serve right now (a restart behind the proxy, its session limit,
/// backpressure): worth waiting out, unlike an auth or protocol refusal.
struct WatchGatewayUnavailable: LocalizedError {
  let status: Int
  let code: String
  var errorDescription: String? { "网关暂时不可用（\(status)）" }
}

/// Rides out transient failures for a while, backing off, before the relay is given up. A watch's
/// network drops whenever the wrist goes down or it hands over between Wi-Fi, iPhone and LTE.
struct WatchRetry {
  static let window: TimeInterval = 18
  private var since: Date?
  private var count = 0

  /// The pause before trying again, or nil when the error is fatal or has lasted too long.
  mutating func delay(after error: Error, now: Date = Date()) -> UInt64? {
    guard Self.transient(error) else { return nil }
    let start = since ?? now
    since = start
    guard now.timeIntervalSince(start) < Self.window else { return nil }
    count += 1
    return UInt64(min(4, 0.25 * pow(2, Double(count))) * 1_000_000_000)
  }

  static func transient(_ error: Error) -> Bool {
    if error is WatchGatewayUnavailable { return true }
    guard let error = error as? URLError else { return false }
    let codes: [URLError.Code] = [.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost,
      .cannotFindHost, .dnsLookupFailed, .secureConnectionFailed, .dataNotAllowed, .internationalRoamingOff]
    return codes.contains(error.code)
  }
}

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
  /// The poll in flight, and whether it carried nothing (so it can be cut short for new frames).
  private var exchanging: Task<[String: Any], Error>?
  private var exchangingEmpty = false
  private var waking = false
  /// Frames taken from the outbox are in an exchange that hasn't been answered yet.
  private var carrying = false
  /// Best-effort shutdown drain: avoid parking for new server frames once `finish()` is called.
  private var finishing = false
  private var stopped = false
  private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
  private var timeouts: [Int: Task<Void, Never>] = [:]
  private var nextID = 0
  private var generation = 0
  private let http: URLSession
  private let ownsSession: Bool
  private let identity: WatchIdentity
  private let url: URL
  private let accountToken: String?

  init(url: URL, identity: WatchIdentity, token: String?, http: URLSession? = nil) {
    self.url = url; self.identity = identity; accountToken = token
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 40
    config.urlCache = nil
    ownsSession = http == nil
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
    guard loop == nil, !stopped else { return }
    generation += 1
    let epoch = generation
    loop = Task { [weak self] in
      guard let self else { return }
      do {
        var opening = WatchRetry()
        var opened: [String: Any] = [:]
        while true {
          do { opened = try await post(url.appendingPathComponent("v2/poll"), body: [:], token: nil); break }
          catch {
            if Task.isCancelled || generation != epoch { throw CancellationError() }
            guard let delay = opening.delay(after: error) else { throw error }
            try await Task.sleep(nanoseconds: delay)
          }
        }
        guard let id = opened["id"] as? String, let token = opened["token"] as? String,
              !id.isEmpty, !token.isEmpty else { throw WatchLinkError("网关未返回连接凭证") }
        let endpoint = url.appendingPathComponent("v2/poll/\(id)")
        var ack = 0, requestNumber = 0, idlePolls = 0
        // Earliest consecutive empty poll cut short for new frames: the gateway may not have seen
        // one or more of them, so step back down to `cutShortFrom` on `request_out_of_order`.
        var cutShortFrom: Int?
        while !Task.isCancelled && generation == epoch {
          // A reply resumes the RPCs waiting on it; let them queue their next request (a chained
          // call) so it goes out with this poll instead of behind one parked for up to `waitMs`.
          await Task.yield()
          guard generation == epoch, !Task.isCancelled else { throw CancellationError() }
          requestNumber += 1
          let highestRequested = requestNumber
          let sending = outbox
          outbox.removeAll()
          carrying = !sending.isEmpty
          defer { carrying = false }
          var reply: [String: Any]?
          var retry = WatchRetry()
          var busySince: Date?
          var busyRetries = 0
          exchange: while true {
            // Drain immediately when finishing or new frames arrived mid-retry; keep active bursts
            // short so non-aborting proxies cannot trap outgoing frames, and ramp to 20s when idle
            // so steady-state watch radio wakeups drop 20x.
            let waitMs: Int
            if finishing || !outbox.isEmpty {
              waitMs = 0
            } else if !sending.isEmpty || idlePolls == 0 {
              waitMs = 1_000
            } else if idlePolls == 1 {
              waitMs = 4_000
            } else {
              waitMs = 20_000
            }
            let body: [String: Any] = ["request": requestNumber, "ack": ack, "frames": sending, "waitMs": waitMs]
            do {
              reply = try await exchange(endpoint, body: body, token: token)
              cutShortFrom = nil
              break exchange
            } catch is WatchPollWoken {
              // Nothing was in it, so nothing is lost or repeated: the next poll carries the new frames.
              if cutShortFrom == nil { cutShortFrom = requestNumber }
              idlePolls = 0
              break exchange
            } catch let refused as WatchPollRefused where refused.code == "request_out_of_order" && (cutShortFrom.map { requestNumber > $0 } ?? false) {
              // One or more cut-short polls never reached the gateway: step back to claim their number.
              requestNumber -= 1
            } catch let refused as WatchPollRefused where refused.code == "request_conflict" && requestNumber < highestRequested {
              // It did arrive after all, just later, and holds that number: advance past it.
              requestNumber += 1
              if let earliest = cutShortFrom, requestNumber > earliest { cutShortFrom = requestNumber }
            } catch let refused as WatchPollRefused where refused.code == "poll_in_progress" {
              // If a long-poll's TCP close was delayed across a proxy or NAT/LTE, wait up to 22s with
              // progressive backoff instead of tearing down and thrashing reconnects.
              let now = Date()
              let start = busySince ?? now
              busySince = start
              guard now.timeIntervalSince(start) < 22 else { throw refused }
              busyRetries += 1
              let capNs = busyRetries <= 8 ? 250_000_000 : 500_000_000
              let waitNs = UInt64(min(capNs, 50_000_000 * busyRetries))
              try await Task.sleep(nanoseconds: waitNs)
            } catch {
              if Task.isCancelled || generation != epoch { throw CancellationError() }
              // Retry the exact numbered exchange; the gateway deduplicates it.
              guard let delay = retry.delay(after: error) else { throw error }
              try await Task.sleep(nanoseconds: delay)
            }
            guard generation == epoch, !Task.isCancelled else { throw CancellationError() }
          }
          guard generation == epoch, !Task.isCancelled else { throw CancellationError() }
          guard let reply else { continue }
          let incoming = reply["frames"] as? [[String: Any]] ?? []
          if !sending.isEmpty || !incoming.isEmpty {
            idlePolls = 0
          } else {
            idlePolls = min(idlePolls + 1, 2)
          }
          for entry in incoming {
            guard let seq = entry["seq"] as? Int, let frame = entry["frame"] as? String else { throw WatchLinkError("网关数据格式无效") }
            if seq <= ack { continue }
            guard seq == ack + 1 else { throw WatchLinkError("连接数据缺失，请重连") }
            try receive(frame)
            ack = seq
          }
          if let reason = reply["closed"] as? String { throw WatchLinkError("连接已关闭（\(reason)）") }
        }
      } catch {
        if generation == epoch && !Task.isCancelled { fail(error) }
      }
    }
  }

  /// Ends this relay for good; a new connection is a new relay.
  func stop() {
    generation += 1
    finishing = false
    loop?.cancel(); loop = nil
    exchanging?.cancel(); exchanging = nil
    ready = false; outbox.removeAll()
    rejectPending(WatchLinkError("连接已断开，未确认操作请先刷新状态"))
    // A session holds its delegate until invalidated: without this every relay would leak one.
    if ownsSession && !stopped { http.invalidateAndCancel() }
    stopped = true
  }
  /// Delivers what is already queued (a tunnel's close) before stopping, best effort: the host
  /// would otherwise keep a dead tunnel and stream to it until the gateway expires this transport.
  func finish(within seconds: TimeInterval = 1.5) async {
    finishing = true
    onReady = nil; onEvent = nil; onFrame = nil; onClosed = nil
    if exchangingEmpty, !waking, let exchanging {
      waking = true
      exchanging.cancel()
    }
    let deadline = Date().addingTimeInterval(seconds)
    while ready, loop != nil, !outbox.isEmpty || carrying, Date() < deadline {
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    stop()
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
    // A poll parked with nothing to send would hold this frame until it returns.
    if exchangingEmpty, !waking, let exchanging {
      waking = true
      exchanging.cancel()
    }
  }

  /// One poll, run apart from the loop so a new frame can cut short an empty one.
  private func exchange(_ endpoint: URL, body: [String: Any], token: String) async throws -> [String: Any] {
    let task = Task { try await self.post(endpoint, body: body, token: token) }
    exchanging = task
    let emptyFrames = (body["frames"] as? [String])?.isEmpty ?? false
    let parked = ((body["waitMs"] as? Int) ?? 0) > 0
    exchangingEmpty = emptyFrames && parked
    waking = false
    defer { exchanging = nil; exchangingEmpty = false }
    do { return try await task.value }
    catch {
      if waking { waking = false; throw WatchPollWoken() }
      throw error
    }
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
    let code = response.statusCode == 200 ? "" : ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String ?? ""
    if [502, 503, 504].contains(response.statusCode) || (response.statusCode == 429 && code == "backpressure") {
      throw WatchGatewayUnavailable(status: response.statusCode, code: code)
    }
    if response.statusCode == 429 { throw WatchLinkError("连接过于频繁，请稍后重试") }
    if response.statusCode == 409 { throw WatchPollRefused(code: code) }
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
