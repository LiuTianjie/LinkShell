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
  private var handshakeTimeout: Task<Void, Never>?
  private var attempt = 0
  private var rpcPending: [String: CheckedContinuation<[String: Any], Error>] = [:]
  private var rpcTimeouts: [String: Task<Void, Never>] = [:]
  private var sessions: [String: [String: Any]] = [:]
  private var terminals: [String: [String: Any]] = [:]
  private var histories: [String: WatchHistory] = [:]
  private var outputs: [String: String] = [:]
  private var info: [String: Any] = [:]
  private var projects: [[String: Any]] = []
  private var subscribed: Set<String> = []
  private var attached: Set<String> = []
  private var sessionRevisions: [String: Int] = [:]
  private var terminalRevisions: [String: Int] = [:]
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
  func stop() {
    active = false
    resetConnection()
    status = "连接已暂停"
    publish()
  }
  private func resetConnection() {
    generation += 1
    connectionTask?.cancel(); connectionTask = nil
    reconnectTask?.cancel(); reconnectTask = nil
    refreshTask?.cancel(); refreshTask = nil
    handshakeTimeout?.cancel(); handshakeTimeout = nil
    relay?.stop(); relay = nil
    gatewayReady = false
    closeTunnel()
  }
  private func closeTunnel() {
    online = false; opening = nil; channel = nil
    handshakeTimeout?.cancel(); handshakeTimeout = nil
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
        let token = official ? try await account.token() : nil
        guard generation == epoch, active, !Task.isCancelled else { return }
        let device = official ? try account.identity() : try pairingIdentity(for: url)
        identity = device; gateway = url
        UserDefaults.standard.set(url.absoluteString, forKey: "LinkShellWatch.gateway")
        let next = WatchRelay(url: url, identity: device, token: token)
        relay = next
        next.onReady = { [weak self] in
          guard let self, self.generation == epoch else { return }
          self.gatewayReady = true; self.status = "正在获取电脑…"; self.attempt = 0
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
        scheduleReconnect()
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
    let delay = min(30, 2 << attempt)
    reconnectTask?.cancel()
    reconnectTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000)
      guard !Task.isCancelled, let self, self.active else { return }
      self.connect()
    }
  }
  func reconnect() { attempt = 0; active = true; connect() }
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
    sessions = [:]; terminals = [:]; histories = [:]; outputs = [:]; info = [:]; projects = []
    publish()
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
    if let opening, let machine { try? relay.send(to: machine.id, frame: ["k": "close", "ch": opening.channel]) }
    closeTunnel()
    refreshTask?.cancel(); refreshTask = nil
    machine = value
    sessions = [:]; terminals = [:]; histories = [:]; outputs = [:]; info = [:]; projects = []
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
      self.closeTunnel(); self.status = "电脑没有响应，正在重试"; self.publish(); self.scheduleReconnect()
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
            while !Task.isCancelled && self.opening?.channel == expected && self.online {
              try await self.refresh()
              try await Task.sleep(nanoseconds: 5_000_000_000)
            }
          } catch {
            if !Task.isCancelled && self.opening?.channel == expected { self.status = error.localizedDescription; self.closeTunnel(); self.publish(); self.scheduleReconnect() }
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
      case "refuse", "close": closeTunnel(); status = frame["message"] as? String ?? "电脑已断开，正在重连"; publish(); scheduleReconnect()
      default: break
      }
    } catch {
      if let relay = relay { try? relay.send(to: machine.id, frame: ["k": "close", "ch": opening.channel]) }
      closeTunnel(); status = error.localizedDescription; publish(); scheduleReconnect()
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
      if let summary = params["session"] as? [String: Any], let id = summary["id"] as? String { sessions[id] = summary; sessionRevisions[id, default: 0] += 1 }
    case "session.removed": sessionRevisions[sessionID, default: 0] += 1; sessions.removeValue(forKey: sessionID); histories.removeValue(forKey: sessionID)
    case "session.window": histories[sessionID] = WatchHistory(startSeq: params["startSeq"] as? Int ?? 0)
    case "session.event":
      histories[sessionID, default: WatchHistory()].append(params)
    case "terminal.output":
      if let id = params["terminalId"] as? String, let data = params["data"] as? String { outputs[id] = String(((outputs[id] ?? "") + data).suffix(8192)) }
    case "terminal.changed":
      if let terminal = params["terminal"] as? [String: Any], let id = terminal["id"] as? String {
        terminalRevisions[id, default: 0] += 1
        if params["closed"] as? Bool == true { terminals.removeValue(forKey: id); outputs.removeValue(forKey: id); attached.remove(id) }
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
    sessions = nextSessions; terminals = nextTerminals
    publish()
  }
  private func schedulePublish() {
    guard publishTask == nil else { return }
    publishTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 200_000_000)
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
    guard online, !key.isEmpty, key == selectedKey else { throw WatchLinkError("电脑已切换或离线，请同步状态后重试") }
    func call(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
      guard self.opening?.channel == expected, self.selectedKey == key else { throw WatchLinkError("连接已变化，操作未发送") }
      return try await self.rpc(method, params)
    }
    let sessionID = command["sessionId"] as? String ?? action["sessionId"] as? String ?? ""
    if kind == "open-session" || kind == "load-earlier" {
      guard sessions[sessionID] != nil else { throw WatchLinkError("会话已不可用") }
      if !subscribed.contains(sessionID) {
        // Subscribe only opened conversations; don't stream every session onto a watch.
        if subscribed.count >= 4, let old = subscribed.first {
          _ = try await call("sessions.unsubscribe", ["sessionId": old]); subscribed.remove(old)
        }
        subscribed.insert(sessionID)
        do {
          let response = try await call("sessions.subscribe", ["sessionId": sessionID, "fromSeq": 0, "lazyImages": true])
          if let session = response["session"] as? [String: Any] { sessions[sessionID] = session }
          histories[sessionID, default: WatchHistory()].startSeq = response["startSeq"] as? Int ?? 0
        } catch { subscribed.remove(sessionID); throw error }
      }
      if kind == "load-earlier" {
        histories[sessionID, default: WatchHistory()].visibleItems = min(100, (histories[sessionID]?.visibleItems ?? 30) + 20)
        if let start = histories[sessionID]?.startSeq, start > 0 {
          let page = try await call("sessions.history", ["sessionId": sessionID, "beforeSeq": start, "lazyImages": true])
          for event in page["events"] as? [[String: Any]] ?? [] { histories[sessionID, default: WatchHistory()].append(event) }
          histories[sessionID, default: WatchHistory()].startSeq = page["startSeq"] as? Int ?? 0
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
        if !attached.contains(id) {
          if attached.count >= 2, let old = attached.first { _ = try await call("terminals.detach", ["terminalId": old]); attached.remove(old) }
          attached.insert(id)
          do {
            let response = try await call("terminals.attach", ["terminalId": id])
            outputs[id] = String((response["replay"] as? String ?? "").suffix(8192))
          } catch { attached.remove(id); throw error }
        }
        publish(); return "已同步终端"
      }
      if kind == "terminal-input" {
        guard let data = command["data"] as? String, !data.isEmpty else { throw WatchLinkError("终端输入不能为空") }
        _ = try await call("terminals.input", ["terminalId": id, "data": data]); return "已发送终端输入"
      }
      _ = try await call("terminals.close", ["terminalId": id]); try? await refresh(); return "已关闭终端"
    }
    // Re-read before decisions so cached watch cards cannot authorize stale requests.
    try await refresh()
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
        try? await refresh()
        return result["delivery"] as? String == "queued" ? "已加入会话队列" : "已发送给 Agent"
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
    try? await refresh()
    return "操作已完成"
  }
}
