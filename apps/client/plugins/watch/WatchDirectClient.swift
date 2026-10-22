import Foundation
import Combine

@MainActor
final class WatchDirectClient: ObservableObject {
  @Published private(set) var online = false
  @Published private(set) var gatewayReady = false
  @Published private(set) var status = "尚未连接"
  @Published private(set) var machines: [WatchMachine] = []
  @Published private(set) var email: String?
  @Published private(set) var working = false
  @Published var gatewayText = UserDefaults.standard.string(forKey: "LinkShellWatch.gateway") ?? "https://gateway.itool.tech"
  var onSnapshot: ((String) -> Void)?
  private(set) var machine: WatchMachine?
  private(set) var account: WatchAccount?
  private var relay: WatchRelay?
  private var opening: WatchTunnelOpening?
  private var channel: WatchSecureChannel?
  private var gateway: URL?
  private var identity: WatchIdentity?
  private var active = false
  private var generation = 0
  private var connectionTask: Task<Void, Never>?
  private var refreshTask: Task<Void, Never>?
  private var publishTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  /// What `reconnectTask` will do once its backoff is over, so returning to the app can do it now.
  private var retryNow: (() -> Void)?
  private var retiring: Task<Void, Never>?
  private var handshakeTimeout: Task<Void, Never>?
  private var attempt = 0
  private var tunnelFailures = 0
  /// Connected without an account token because refreshing it failed for a network reason.
  private var tokenless = false
  private var rpcPending: [String: CheckedContinuation<[String: Any], Error>] = [:]
  private var rpcTimeouts: [String: Task<Void, Never>] = [:]
  private var sessions: [String: [String: Any]] = [:]
  private var terminals: [String: [String: Any]] = [:]
  private var histories: [String: WatchHistory] = [:]
  private var outputs: [String: String] = [:]
  private var info: [String: Any] = [:]
  private var projects: [[String: Any]] = []
  /// What this tunnel is subscribed to / attached to; a new tunnel starts with neither.
  private var subscribed: Set<String> = []
  private var attached: Set<String> = []
  /// What the user opened, least recently first. It outlives tunnels, so a reconnect restores it.
  private var wantedSessions: [String] = []
  private var wantedTerminals: [String] = []
  private var outputSeqs: [String: Int] = [:]
  private var sessionRevisions: [String: Int] = [:]
  private var terminalRevisions: [String: Int] = [:]
  /// When each session's state was last confirmed by the host (a pushed summary or a full list).
  private var lastSummaryAt: [String: Date] = [:]
  private var refreshNumber = 0

  init() {
    do { account = try WatchAccount(); email = account?.session?.email }
    catch { status = error.localizedDescription }
  }
  var selectedKey: String { guard let gateway, let machine else { return "" }; return WatchSnapshotBuilder.computerKey(gateway: gateway, machine: machine) }
  var signedIn: Bool { account?.session != nil }

  func start() {
    guard !active || relay == nil else { return }
    active = true
    connect()
  }
  /// Back in front: whatever is waiting out a backoff tries now.
  func resume() {
    guard active else { start(); return }
    if let retry = retryNow { cancelRetry(); retry() }
  }
  func stop() {
    active = false
    resetConnection()
    status = "连接已暂停"
    publish()
  }
  /// `stop`, then waits (briefly) until the tunnel's close has gone out.
  func pause() async {
    stop()
    await retiring?.value
  }
  private func resetConnection() {
    generation += 1
    connectionTask?.cancel(); connectionTask = nil
    cancelRetry()
    closeTunnel(notifyHost: true)
    if let old = relay {
      relay = nil
      let previous = retiring
      retiring = Task { await previous?.value; await old.finish() }
    }
    gatewayReady = false
  }
  private func cancelRetry() { reconnectTask?.cancel(); reconnectTask = nil; retryNow = nil }
  /// Ends the tunnel; the computer's data stays, so the next tunnel continues where this one left off.
  private func closeTunnel(notifyHost: Bool = false) {
    if notifyHost, let relay, relay.ready, let machine, let channel = opening?.channel {
      try? relay.send(to: machine.id, frame: ["k": "close", "ch": channel])
    }
    online = false; opening = nil; channel = nil
    handshakeTimeout?.cancel(); handshakeTimeout = nil
    refreshTask?.cancel(); refreshTask = nil
    subscribed.removeAll(); attached.removeAll()
    publishTask?.cancel(); publishTask = nil
    refreshNumber += 1
    let pending = rpcPending.values; rpcPending.removeAll()
    for timer in rpcTimeouts.values { timer.cancel() }; rpcTimeouts.removeAll()
    for continuation in pending { continuation.resume(throwing: WatchLinkError("电脑连接已断开，未确认操作请先同步状态")) }
  }
  private func connect() {
    guard active else { return }
    resetConnection()
    let epoch = generation
    status = "正在连接网关…"
    connectionTask = Task { [weak self] in
      guard let self else { return }
      do {
        let url = try WatchRelay.normalizeGateway(gatewayText)
        guard let account else { throw WatchLinkError("账号服务配置不可用") }
        // Only the official gateway receives iTool account credentials. Custom
        // gateways connect using a separate pairing identity, without tokens.
        let official = url.host == "gateway.itool.tech" && (url.port == nil || url.port == 443)
        var token: String?
        var withoutToken = false
        if official {
          do { token = try await account.token() }
          catch let error as WatchAuthExpired { throw error }
          catch is CancellationError { return }
          catch {
            // The gateway keeps an account-bound key's account when it comes without a token
            // (relay.ts authenticate), so an unreachable account service needn't keep this offline.
            withoutToken = account.session != nil
          }
        }
        guard generation == epoch, active, !Task.isCancelled else { return }
        let device = official ? try account.identity() : try pairingIdentity(for: url)
        // Another gateway or account sees other computers: what was shown belongs to the old one.
        if let gateway, gateway != url || identity?.signSecret != device.signSecret { clearComputer() }
        identity = device; gateway = url; tokenless = withoutToken
        UserDefaults.standard.set(url.absoluteString, forKey: "LinkShellWatch.gateway")
        let next = WatchRelay(url: url, identity: device, token: token)
        relay = next
        next.onReady = { [weak self] in
          guard let self, self.generation == epoch else { return }
          self.gatewayReady = true; self.status = "正在获取电脑…"
          Task { [weak self] in
            do { try await self?.reloadMachines(epoch: epoch) }
            catch { if self?.generation == epoch { self?.status = error.localizedDescription } }
          }
        }
        next.onFrame = { [weak self] peer, frame in
          guard let self, self.generation == epoch else { return }
          self.receive(peer: peer, frame: frame)
        }
        next.onEvent = { [weak self] name, data in
          guard let self, self.generation == epoch else { return }
          if name == "presence" || name == "machines.changed" {
            Task { try? await self.reloadMachines(epoch: epoch) }
          } else if name == "undeliverable", data["to"] as? String == self.machine?.id {
            self.closeTunnel(); self.status = "电脑暂时离线"; self.publish()
          }
        }
        next.onClosed = { [weak self] error in
          guard let self, self.generation == epoch else { return }
          self.gatewayReady = false; self.closeTunnel(); self.status = error.localizedDescription; self.publish()
          self.scheduleReconnect()
        }
        next.start()
      } catch {
        guard generation == epoch, active, !Task.isCancelled else { return }
        status = error.localizedDescription
        // Only signing in again helps; retrying would just ask the account service again.
        if !(error is WatchAuthExpired) { scheduleReconnect() }
      }
    }
  }
  private func pairingIdentity(for url: URL) throws -> WatchIdentity {
    let key = "pairing.\(url.absoluteString)"
    if let data = try WatchKeychain.read(key) { return try JSONDecoder().decode(WatchIdentity.self, from: data) }
    let value = WatchIdentity(); try WatchKeychain.write(key, data: JSONEncoder().encode(value)); return value
  }
  private func scheduleReconnect() {
    guard active else { return }
    attempt = min(attempt + 1, 5)
    // The first try is quick: after a suspension the gateway has usually just expired the transport.
    retry(after: attempt == 1 ? 1 : Double(min(30, 2 << attempt))) { [weak self] in self?.connect() }
  }
  private func retry(after seconds: Double, _ action: @escaping () -> Void) {
    cancelRetry()
    retryNow = action
    reconnectTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      guard !Task.isCancelled, let self, self.active, let action = self.retryNow else { return }
      self.reconnectTask = nil; self.retryNow = nil
      action()
    }
  }
  /// A tunnel that failed while the relay still works is opened again over that relay. Only
  /// repeated failures rebuild the gateway connection as well; healthy refreshes reset the count.
  private func tunnelFailed(_ message: String, notifyHost: Bool) {
    closeTunnel(notifyHost: notifyHost); status = message; publish()
    tunnelFailures += 1
    guard tunnelFailures < 3, gatewayReady, relay != nil else { tunnelFailures = 0; scheduleReconnect(); return }
    let epoch = generation
    retry(after: tunnelFailures == 1 ? 1 : 4) { [weak self] in
      Task { [weak self] in
        guard let self, self.generation == epoch else { return }
        do { try await self.reloadMachines(epoch: epoch) }
        catch { if self.generation == epoch, !self.online, self.opening == nil { self.tunnelFailed(error.localizedDescription, notifyHost: false) } }
      }
    }
  }
  func reconnect() { attempt = 0; tunnelFailures = 0; active = true; connect() }
  func signIn(email: String, password: String) async throws {
    guard let account else { throw WatchLinkError("账号服务配置不可用") }
    working = true; defer { working = false }
    try await account.signIn(email: email, password: password)
    self.email = account.session?.email
    gatewayText = "https://gateway.itool.tech"
    clearComputer()
    if active { connect() }
  }
  func signOut() throws {
    stop()
    try account?.signOut()
    email = nil
    clearComputer()
    start()
  }
  private func clearComputer() {
    machine = nil; machines = []
    clearData()
    publish()
  }
  private func clearData() {
    sessions = [:]; terminals = [:]; histories = [:]; outputs = [:]; info = [:]; projects = []
    wantedSessions = []; wantedTerminals = []; outputSeqs = [:]; lastSummaryAt = [:]
  }
  func pair(code: String) async throws {
    let digits = code.filter(\.isNumber)
    guard digits.count == 6, let relay, gatewayReady, let identity else { throw WatchLinkError("请先连接网关，再输入电脑上的六位配对码") }
    let epoch = generation
    working = true; defer { working = false }
    status = "等待电脑确认配对…"
    let result = try await relay.request("pair.claim", params: ["code": digits, "proof": identity.pairingProof(digits)])
    guard generation == epoch else { throw WatchLinkError("连接已切换，请重新配对") }
    guard let object = result["machine"] else { throw WatchLinkError("电脑未返回配对结果") }
    let value = try JSONDecoder().decode(WatchMachine.self, from: JSONSerialization.data(withJSONObject: object))
    try value.identity.validate()
    if !machines.contains(where: { $0.id == value.id }) { machines.append(value) }
    try select(value)
  }
  func reloadMachines() async throws { try await reloadMachines(epoch: generation) }
  private func reloadMachines(epoch: Int) async throws {
    guard let relay else { return }
    let result = try await relay.request("machines.list")
    guard generation == epoch else { return }
    let found = try JSONDecoder().decode([WatchMachine].self, from: JSONSerialization.data(withJSONObject: result["machines"] ?? []))
    for value in found { try value.identity.validate() }
    machines = found
    if let machine, let replacement = found.first(where: { $0.id == machine.id }) {
      guard replacement.identity == machine.identity else { closeTunnel(); throw WatchLinkError("电脑密钥发生变化，请重新配对") }
      self.machine = replacement
      if !replacement.online { closeTunnel(); status = "电脑离线" }
      else if !online && opening == nil { try select(replacement) }
    } else if machine != nil {
      // Without a token the gateway may not have counted this watch's account in: wait for one.
      if tokenless { status = "暂时无法验证账号，正在重试"; publish(); scheduleReconnect(); return }
      closeTunnel(); clearComputer(); machines = found; status = "电脑已取消配对或不再可用"
    } else {
      let last = UserDefaults.standard.string(forKey: "LinkShellWatch.selected.\(gateway?.absoluteString ?? "")")
      if let next = found.first(where: { $0.id == last }) ?? found.first(where: \.online) ?? found.first { try select(next) }
      else { status = "登录账号或输入配对码添加电脑" }
    }
    publish()
  }
  func select(_ value: WatchMachine) throws {
    guard let relay, gatewayReady, let gateway, let identity else { throw WatchLinkError("网关尚未连接") }
    closeTunnel(notifyHost: true)
    // The same computer again (a reconnect) keeps what it showed; the new tunnel catches up.
    if machine?.id != value.id { clearData() }
    machine = value
    UserDefaults.standard.set(value.id, forKey: "LinkShellWatch.selected.\(gateway.absoluteString)")
    guard value.online else { status = "电脑离线"; publish(); return }
    let pending = try WatchTunnelOpening(identity: identity, machine: value.identity)
    opening = pending
    status = "正在连接 \(value.name)…"
    try relay.send(to: value.id, frame: pending.hello)
    let expected = pending.channel
    handshakeTimeout = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      guard !Task.isCancelled, let self, self.opening?.channel == expected, !self.online else { return }
      self.tunnelFailed("电脑没有响应，正在重试", notifyHost: true)
    }
    publish()
  }
  private func receive(peer: WatchPeerIdentity, frame: [String: Any]) {
    guard let machine, peer.id == machine.id, let opening, frame["ch"] as? String == opening.channel else { return }
    do {
      guard peer == machine.identity else { throw WatchLinkError("电脑身份不匹配") }
      switch frame["k"] as? String {
      case "welcome":
        guard channel == nil else { throw WatchLinkError("重复的握手响应") }
        channel = try opening.accept(frame)
        handshakeTimeout?.cancel(); handshakeTimeout = nil
        online = true; status = "已独立连接"
        cancelRetry()
        let expected = opening.channel
        refreshTask = Task { [weak self] in
          guard let self else { return }
          do {
            let details = try await self.rpc("machine.info")
            guard self.opening?.channel == expected else { return }
            self.info = details
            let projectList = try? await self.rpc("projects.list", ["limit": 30])
            guard self.opening?.channel == expected else { return }
            self.projects = projectList?["projects"] as? [[String: Any]] ?? []
            var restored = false
            while !Task.isCancelled && self.opening?.channel == expected && self.online {
              try await self.refresh()
              // A refresh answered end to end: the relay and the tunnel both work.
              self.attempt = 0; self.tunnelFailures = 0
              if !restored { restored = true; await self.restore(expected) }
              try await Task.sleep(nanoseconds: 5_000_000_000)
            }
          } catch {
            if !Task.isCancelled && self.opening?.channel == expected { self.tunnelFailed(error.localizedDescription, notifyHost: true) }
          }
        }
      case "data":
        guard let channel, let box = frame["box"] as? String else { throw WatchLinkError("加密连接尚未建立") }
        let plaintext = try channel.open(box)
        for line in plaintext.split(separator: "\n") {
          let parsed = try JSONSerialization.jsonObject(with: Data(line.utf8))
          if let entries = parsed as? [[String: Any]] { for entry in entries { receiveRPC(entry) } }
          else if let entry = parsed as? [String: Any] { receiveRPC(entry) }
        }
      case "refuse", "close": tunnelFailed(frame["message"] as? String ?? "电脑已断开，正在重连", notifyHost: false)
      default: break
      }
    } catch {
      tunnelFailed(error.localizedDescription, notifyHost: true)
    }
  }
  private func rpc(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
    guard online, let relay, let machine, let opening, let channel else { throw WatchLinkError("电脑尚未连接") }
    let id = UUID().uuidString
    return try await withCheckedThrowingContinuation { continuation in
      rpcPending[id] = continuation
      rpcTimeouts[id] = Task { [weak self] in
        try? await Task.sleep(nanoseconds: 30_000_000_000)
        guard !Task.isCancelled, let self else { return }
        self.rpcPending.removeValue(forKey: id)?.resume(throwing: WatchLinkError("尚未收到电脑结果，请同步状态后再操作"))
        self.rpcTimeouts.removeValue(forKey: id)
      }
      do {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "method": method, "params": params]), as: UTF8.self)
        try relay.send(to: machine.id, frame: ["k": "data", "ch": opening.channel, "box": channel.seal(json)])
      } catch {
        rpcPending.removeValue(forKey: id)?.resume(throwing: error)
        rpcTimeouts.removeValue(forKey: id)?.cancel()
      }
    }
  }
  private func receiveRPC(_ message: [String: Any]) {
    if let id = message["id"] as? String, message["method"] == nil {
      rpcTimeouts.removeValue(forKey: id)?.cancel()
      let pending = rpcPending.removeValue(forKey: id)
      if let error = message["error"] as? [String: Any] { pending?.resume(throwing: WatchLinkError(error["message"] as? String ?? "电脑未能完成操作")) }
      else { pending?.resume(returning: message["result"] as? [String: Any] ?? [:]) }
      return
    }
    let params = message["params"] as? [String: Any] ?? [:]
    let sessionID = params["sessionId"] as? String ?? ""
    switch message["method"] as? String {
    case "session.summary":
      if let summary = params["session"] as? [String: Any], let id = summary["id"] as? String {
        sessions[id] = summary; sessionRevisions[id, default: 0] += 1; lastSummaryAt[id] = Date()
      }
    case "session.removed":
      sessionRevisions[sessionID, default: 0] += 1; sessions.removeValue(forKey: sessionID); histories.removeValue(forKey: sessionID)
      wantedSessions.removeAll { $0 == sessionID }
    case "session.window": histories[sessionID, default: WatchHistory()].window(params["startSeq"] as? Int ?? 0)
    case "session.event":
      histories[sessionID, default: WatchHistory()].append(params)
    case "terminal.output":
      if let id = params["terminalId"] as? String, let data = params["data"] as? String {
        let seq = params["seq"] as? Int
        if let seq, let held = outputSeqs[id], seq <= held { return }
        outputs[id] = String(((outputs[id] ?? "") + data).suffix(8192)); outputSeqs[id] = seq ?? outputSeqs[id]
      }
    case "terminal.changed":
      if let terminal = params["terminal"] as? [String: Any], let id = terminal["id"] as? String {
        terminalRevisions[id, default: 0] += 1
        if params["closed"] as? Bool == true {
          terminals.removeValue(forKey: id); outputs.removeValue(forKey: id); outputSeqs.removeValue(forKey: id)
          attached.remove(id); wantedTerminals.removeAll { $0 == id }
        }
        else { terminals[id] = terminal }
      }
    default: return
    }
    schedulePublish()
  }
  func refresh() async throws {
    refreshNumber += 1
    let number = refreshNumber, expected = opening?.channel
    let previousSessions = sessionRevisions, previousTerminals = terminalRevisions
    let list = try await rpc("sessions.list", ["limit": 100])
    guard opening?.channel == expected else { return }
    let terms = try await rpc("terminals.list")
    guard opening?.channel == expected, number == refreshNumber else { return }
    var nextSessions = Dictionary((list["sessions"] as? [[String: Any]] ?? []).compactMap { value in (value["id"] as? String).map { ($0, value) } }, uniquingKeysWith: { _, new in new })
    var nextTerminals = Dictionary((terms["terminals"] as? [[String: Any]] ?? []).compactMap { value in (value["id"] as? String).map { ($0, value) } }, uniquingKeysWith: { _, new in new })
    // Notifications arriving after a list request are newer than its snapshot.
    for (id, revision) in sessionRevisions where previousSessions[id] != revision { nextSessions[id] = sessions[id] }
    for (id, revision) in terminalRevisions where previousTerminals[id] != revision { nextTerminals[id] = terminals[id] }
    let listed = Date()
    for id in nextSessions.keys where previousSessions[id] == sessionRevisions[id] { lastSummaryAt[id] = listed }
    sessions = nextSessions; terminals = nextTerminals
    publish()
  }
  private func schedulePublish() {
    guard publishTask == nil else { return }
    // A streaming reply sends many events a second; each publish re-serialises and stores everything.
    publishTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 500_000_000)
      guard !Task.isCancelled, let self else { return }
      self.publishTask = nil; self.publish()
    }
  }
  private func publish() {
    guard let gateway else { return }
    do { onSnapshot?(try WatchSnapshotBuilder.snapshot(gateway: gateway, machine: machine, machines: machines, online: online,
      sessions: sessions, terminals: terminals, histories: histories, outputs: outputs, info: info, projects: projects)) }
    catch { status = "无法显示电脑数据：\(error.localizedDescription)" }
  }

  func execute(_ command: [String: Any]) async throws -> String {
    let kind = command["kind"] as? String ?? ""
    if kind == "select-computer" {
      guard let gateway, let key = command["computerKey"] as? String,
            let target = machines.first(where: { WatchSnapshotBuilder.computerKey(gateway: gateway, machine: $0) == key }) else { throw WatchLinkError("未找到这台电脑") }
      try select(target)
      return "正在连接 \(target.name)"
    }
    if kind == "refresh" {
      if online { try await refresh() }
      else if gatewayReady { try await reloadMachines() }
      else { reconnect() }
      return online ? "已同步最新状态" : "正在重新连接"
    }
    let action = command["action"] as? [String: Any] ?? [:]
    let key = command["computerKey"] as? String ?? action["computerKey"] as? String ?? ""
    let expected = opening?.channel
    let sessionID = command["sessionId"] as? String ?? action["sessionId"] as? String ?? ""
    if !online, !key.isEmpty, key == selectedKey {
      // Reconnecting: remember what was opened; the next tunnel takes it up (`restore`).
      if kind == "open-session", sessions[sessionID] != nil {
        Self.touch(sessionID, in: &wantedSessions)
        while wantedSessions.count > 4 { histories.removeValue(forKey: wantedSessions.removeFirst()) }
        return ""
      }
      if kind == "open-terminal", let id = command["terminalId"] as? String, terminals[id] != nil {
        Self.touch(id, in: &wantedTerminals)
        while wantedTerminals.count > 2 { outputSeqs.removeValue(forKey: wantedTerminals.removeFirst()) }
        return ""
      }
    }
    guard online, !key.isEmpty, key == selectedKey else { throw WatchLinkError("电脑已切换或离线，请同步状态后重试") }
    func call(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
      guard self.opening?.channel == expected, self.selectedKey == key else { throw WatchLinkError("连接已变化，操作未发送") }
      return try await self.rpc(method, params)
    }
    if kind == "open-session" || kind == "load-earlier" {
      guard sessions[sessionID] != nil else { throw WatchLinkError("会话已不可用") }
      Self.touch(sessionID, in: &wantedSessions)
      // Subscribe only opened conversations; don't stream every session onto a watch. The one
      // opened last (the one on screen) is never the one let go.
      while wantedSessions.count > 4 {
        let old = wantedSessions.removeFirst()
        histories.removeValue(forKey: old)
        if subscribed.remove(old) != nil { _ = try await call("sessions.unsubscribe", ["sessionId": old]) }
      }
      if !subscribed.contains(sessionID) { try await follow(sessionID, call) }
      if kind == "load-earlier" {
        histories[sessionID, default: WatchHistory()].visibleItems = min(WatchHistory.maxVisibleItems, (histories[sessionID]?.visibleItems ?? 30) + 20)
        if let start = histories[sessionID]?.startSeq, start > 0 {
          // `startSeq` is the seq before the first one held, and the page ends at `beforeSeq - 1`.
          let page = try await call("sessions.history", ["sessionId": sessionID, "beforeSeq": start + 1, "lazyImages": true])
          // The history may have started over meanwhile (`session.window` after a reconnect).
          guard histories[sessionID]?.startSeq == start else { publish(); return "已同步会话" }
          histories[sessionID, default: WatchHistory()].prepend(page["events"] as? [[String: Any]] ?? [], startSeq: page["startSeq"] as? Int ?? 0)
        }
      }
      publish(); return "已同步会话"
    }
    if kind == "create-session" {
      guard let agent = command["agent"] as? String, let cwd = command["cwd"] as? String, !cwd.isEmpty,
            (info["agents"] as? [[String: Any]] ?? []).contains(where: { $0["id"] as? String == agent && $0["installed"] as? Bool == true }) else { throw WatchLinkError("请选择可用 Agent 和工作目录") }
      var params: [String: Any] = ["agent": agent, "cwd": cwd, "clientMessageId": command["id"] as? String ?? UUID().uuidString]
      if let prompt = command["prompt"] as? String, !prompt.isEmpty { params["prompt"] = [["type": "text", "text": prompt]] }
      _ = try await call("sessions.create", params)
      try? await refresh(); return "已创建会话"
    }
    if kind == "create-terminal" {
      var params: [String: Any] = ["cols": 80, "rows": 24]
      params["cwd"] = command["cwd"]; params["command"] = command["command"]
      _ = try await call("terminals.create", params)
      try? await refresh(); return "已创建终端"
    }
    if ["open-terminal", "terminal-input", "close-terminal"].contains(kind) {
      guard let id = command["terminalId"] as? String, terminals[id] != nil else { throw WatchLinkError("终端已不可用") }
      if kind == "open-terminal" {
        Self.touch(id, in: &wantedTerminals)
        while wantedTerminals.count > 2 {
          let old = wantedTerminals.removeFirst()
          outputSeqs.removeValue(forKey: old)
          if attached.remove(old) != nil { _ = try await call("terminals.detach", ["terminalId": old]) }
        }
        if !attached.contains(id) { try await attach(id, call) }
        publish(); return "已同步终端"
      }
      if kind == "terminal-input" {
        guard let data = command["data"] as? String, !data.isEmpty else { throw WatchLinkError("终端输入不能为空") }
        _ = try await call("terminals.input", ["terminalId": id, "data": data]); return "已发送终端输入"
      }
      _ = try await call("terminals.close", ["terminalId": id]); try? await refresh(); return "已关闭终端"
    }
    // Re-read before decisions so cached watch cards cannot authorize stale requests. The host
    // pushes every summary change, so a recent one is as fresh as a list call; only an old one
    // costs the extra round trip.
    if Date().timeIntervalSince(lastSummaryAt[sessionID] ?? .distantPast) > 5 || sessions[sessionID] == nil {
      try await refresh()
    }
    guard opening?.channel == expected, let session = sessions[sessionID], session["archived"] as? Bool != true else { throw WatchLinkError("会话状态已变化，请刷新后重试") }
    switch kind {
    case "action":
      guard session["driver"] as? String != "desktop",
            WatchSnapshotBuilder.actions(session, key: key).contains(where: {
              $0["requestId"] as? String == action["requestId"] as? String &&
              $0["optionId"] as? String == action["optionId"] as? String &&
              $0["questionId"] as? String == action["questionId"] as? String &&
              $0["kind"] as? String == action["kind"] as? String
            }), let requestID = action["requestId"] as? String, let option = action["optionId"] as? String else { throw WatchLinkError("这个请求或选项已过期，请刷新后重试") }
      if action["kind"] as? String == "permission" {
        _ = try await call("sessions.permission", ["sessionId": sessionID, "requestId": requestID, "optionId": option])
      } else if action["kind"] as? String == "answer", let questionID = action["questionId"] as? String {
        _ = try await call("sessions.answer", ["sessionId": sessionID, "requestId": requestID, "answers": [["id": questionID, "values": [option]]]])
      } else {
        guard let question = (session["asyncQuestions"] as? [[String: Any]])?.first(where: { $0["id"] as? String == requestID }) else { throw WatchLinkError("问题已过期") }
        let entries = [["questionItemId": requestID, "question": question["title"] as? String ?? "", "answer": option]]
        let text = "<send_user_message_question_reply>\n" + String(decoding: try JSONSerialization.data(withJSONObject: entries), as: UTF8.self) + "\n</send_user_message_question_reply>\n"
        let messageID = command["id"] as? String ?? UUID().uuidString
        let result = try await call("sessions.prompt", ["sessionId": sessionID, "clientMessageId": messageID, "content": [["type": "text", "text": text]]])
        if result["delivery"] as? String == "queued" {
          do { _ = try await call("sessions.sendQueued", ["sessionId": sessionID, "clientMessageId": messageID]) }
          catch { _ = try? await call("sessions.unqueue", ["sessionId": sessionID, "clientMessageId": messageID]); throw error }
        }
      }
    case "prompt":
      guard session["driver"] as? String != "desktop", let text = command["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw WatchLinkError("请先接管会话并输入消息") }
      if let permission = session["permission"] as? [String: Any], let questions = permission["questions"] as? [[String: Any]], !questions.isEmpty {
        guard questions.count == 1, let q = questions.first, q["kind"] as? String == "text", q["secret"] as? Bool != true,
              let request = permission["requestId"] as? String, let id = q["id"] as? String else { throw WatchLinkError("此表单请在手机或电脑上完成") }
        _ = try await call("sessions.answer", ["sessionId": sessionID, "requestId": request, "answers": [["id": id, "values": [text]]]])
      } else {
        var params: [String: Any] = ["sessionId": sessionID, "clientMessageId": command["id"] as? String ?? UUID().uuidString, "content": [["type": "text", "text": text]]]
        if command["now"] as? Bool != true { params["whenBusy"] = "queue" }
        let result = try await call("sessions.prompt", params)
        Task { [weak self] in try? await self?.refresh() }
        switch result["delivery"] as? String {
        case "queued": return "已加入会话队列"
        // A retry of a prompt whose answer was lost: the host already has it and dropped this copy.
        case "duplicate": return "消息此前已送达"
        default: return "已发送给 Agent"
        }
      }
    case "set-config":
      guard session["driver"] as? String != "desktop", let option = command["optionId"] as? String, let value = command["value"] as? String,
            histories[sessionID]?.configuration.contains(where: { $0["id"] as? String == option && ($0["values"] as? [[String: Any]] ?? []).contains { $0["value"] as? String == value } }) == true else { throw WatchLinkError("配置选项已变化，请重新打开会话") }
      _ = try await call("sessions.setConfig", ["sessionId": sessionID, "optionId": option, "value": value])
    case "cancel":
      guard ["running", "waiting", "unknown"].contains(session["state"] as? String ?? "") else { throw WatchLinkError("会话已经停止") }
      _ = try await call("sessions.cancel", ["sessionId": sessionID])
    case "takeover":
      guard session["driver"] as? String == "desktop" else { throw WatchLinkError("会话已不在电脑终端中") }
      _ = try await call("sessions.takeover", ["sessionId": sessionID])
    case "release":
      guard session["driver"] as? String == "remote" else { throw WatchLinkError("会话状态已变化") }
      _ = try await call("sessions.release", ["sessionId": sessionID])
    default: throw WatchLinkError("不支持此操作")
    }
    // The host already pushes the new state; this list only backs it up, so the reply doesn't wait.
    Task { [weak self] in try? await self?.refresh() }
    return "操作已完成"
  }
  private typealias Call = (String, [String: Any]) async throws -> [String: Any]
  private static func touch(_ id: String, in list: inout [String]) { list.removeAll { $0 == id }; list.append(id) }
  /// Subscribes from the last event held, so a reconnect continues the conversation without a gap
  /// (or, when the host can't, it sends `session.window` first and the history starts over).
  private func follow(_ id: String, _ call: Call) async throws {
    subscribed.insert(id)
    let from = histories[id]?.lastSeq ?? 0
    do {
      let response = try await call("sessions.subscribe", ["sessionId": id, "fromSeq": from, "lazyImages": true])
      if let session = response["session"] as? [String: Any] { sessions[id] = session }
      // Continuing, `startSeq` is just `fromSeq`; where the history begins is unchanged.
      if from == 0 { histories[id, default: WatchHistory()].startSeq = response["startSeq"] as? Int ?? 0 }
    } catch { subscribed.remove(id); throw error }
  }
  private func attach(_ id: String, _ call: Call) async throws {
    attached.insert(id)
    var params: [String: Any] = ["terminalId": id]
    if let seq = outputSeqs[id] { params["fromSeq"] = seq }
    do {
      let response = try await call("terminals.attach", params)
      let replay = response["replay"] as? String ?? ""
      let continued = params["fromSeq"] != nil && response["reset"] as? Bool == false
      outputs[id] = String(((continued ? outputs[id] ?? "" : "") + replay).suffix(8192))
      outputSeqs[id] = response["seq"] as? Int
    } catch { attached.remove(id); throw error }
  }
  /// A new tunnel has no subscriptions: take up again what the user had open, newest first.
  private func restore(_ channel: String) async {
    func call(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
      guard opening?.channel == channel else { throw WatchLinkError("连接已变化") }
      return try await rpc(method, params)
    }
    wantedSessions.removeAll { sessions[$0] == nil }
    wantedTerminals.removeAll { terminals[$0] == nil }
    for id in wantedSessions.reversed() where opening?.channel == channel && !subscribed.contains(id) { try? await follow(id, call) }
    for id in wantedTerminals.reversed() where opening?.channel == channel && !attached.contains(id) { try? await attach(id, call) }
    if opening?.channel == channel { publish() }
  }
}
