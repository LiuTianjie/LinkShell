import Combine
import Foundation
import SwiftUI
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif
#if canImport(WatchKit)
import WatchKit
#endif
#if canImport(WidgetKit)
import WidgetKit
#endif

public enum WatchHaptics {
  public static func click() {
    #if canImport(WatchKit)
    WKInterfaceDevice.current().play(.click)
    #endif
  }

  public static func success() {
    #if canImport(WatchKit)
    WKInterfaceDevice.current().play(.success)
    #endif
  }

  public static func failure() {
    #if canImport(WatchKit)
    WKInterfaceDevice.current().play(.failure)
    #endif
  }

  public static func stop() {
    #if canImport(WatchKit)
    WKInterfaceDevice.current().play(.stop)
    #endif
  }

  public static func attention() {
    #if canImport(WatchKit)
    WKInterfaceDevice.current().play(.notification)
    #endif
  }

  public static func start() {
    #if canImport(WatchKit)
    WKInterfaceDevice.current().play(.start)
    #endif
  }
}

@MainActor
public final class WatchSessionStore: NSObject, ObservableObject {
  @Published public private(set) var snapshot: WatchSnapshot = .empty
  @Published public private(set) var isPhoneReachable: Bool = false
  @Published public private(set) var pendingCommandId: String? = nil
  @Published public private(set) var loadingEarlierSessionId: String? = nil
  @Published public var bannerNotice: (ok: Bool, text: String)? = nil

  @Published public private(set) var independent = UserDefaults.standard.object(forKey: "LinkShellWatch.independent") as? Bool ?? true
  let direct = WatchDirectClient()
  private var directChanges: AnyCancellable?
  public var transportReachable: Bool { independent ? direct.online : isPhoneReachable }

  public func setIndependent(_ value: Bool) {
    guard independent != value, pendingCommandId == nil else { return }
    direct.stop()
    independent = value
    UserDefaults.standard.set(value, forKey: "LinkShellWatch.independent")
    snapshot = .empty
    resetHapticBaseline()
    if let data = try? JSONEncoder().encode(WatchSnapshot.empty), let json = String(data: data, encoding: .utf8) { applySnapshotJSON(json, force: true) }
    if value { direct.start() } else { requestRefresh(silent: true) }
  }

  /// `true` for active and inactive alike: lowering the wrist, the Always On dim, a notification
  /// or Control Center only make the app inactive, and it comes straight back.
  public func setForeground(_ value: Bool) {
    guard independent else { return }
    backgroundStop?.cancel(); backgroundStop = nil
    if value { direct.resume(); return }
    let stop = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 3_000_000_000)
      guard !Task.isCancelled, let self else { return }
      await self.direct.pause()
    }
    backgroundStop = stop
    Self.holdBackgroundTime(until: stop)
  }

  /// Asks watchOS for the seconds it takes to close the tunnel properly, instead of suspending
  /// the app with the host still streaming to it.
  private static func holdBackgroundTime(until task: Task<Void, Never>) {
    #if os(watchOS)
    let done = DispatchSemaphore(value: 0)
    Task { await task.value; done.signal() }
    ProcessInfo.processInfo.performExpiringActivity(withReason: "关闭电脑连接") { expired in
      if expired { done.signal() } else { _ = done.wait(timeout: .now() + 6) }
    }
    #endif
  }

  public static let cacheKey = WatchSnapshot.cacheKey
  public static let defaultAppGroup = "group.com.bd.linkshell"
  // Haptics compare with the last snapshot in which the computer was reachable: an offline one
  // in between (paused, reconnecting) neither announces nor resets anything.
  private var baselineKey: String?
  private var lastUnanswerable = 0
  private var lastPhasesById: [String: String] = [:]
  private var announcedRequestIds: Set<String> = []
  private var lastGeneratedAt: Double = 0
  private var lastPersistedAt: Double = 0
  private var backgroundStop: Task<Void, Never>?
  /// A prompt whose result never arrived. Sending the same text again reuses its id, which the
  /// host deduplicates, so a retry can't deliver it twice.
  private var unsettledPrompt: (id: String, sessionId: String, text: String, at: Date)?
  private var noticeTask: Task<Void, Never>?
  private var commandTimeoutTask: Task<Void, Never>?
  private var simPollTask: Task<Void, Never>?

  public override init() {
    super.init()
    #if targetEnvironment(simulator)
    if let mode = ProcessInfo.processInfo.environment["LINKSHELL_WATCH_MODE"] { independent = mode != "companion" }
    #endif
    loadCachedSnapshot()
    directChanges = direct.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    direct.onSnapshot = { [weak self] json in
      guard let self, self.independent else { return }
      self.applySnapshotJSON(json)
    }
    if let injected = ProcessInfo.processInfo.environment["LINKSHELL_WATCH_SNAPSHOT_JSON"],
       !injected.isEmpty {
      applySnapshotJSON(injected)
    }
    activateSession()
    #if targetEnvironment(simulator)
    startSimulatorBridgeLoop()
    #endif
  }

  deinit {
    simPollTask?.cancel()
    commandTimeoutTask?.cancel()
  }

  public static var appGroupIdentifier: String {
    if let group = Bundle.main.object(forInfoDictionaryKey: "LinkShellWatchAppGroup") as? String,
       !group.isEmpty {
      return group
    }
    return defaultAppGroup
  }

  private static var defaults: UserDefaults {
    if let shared = UserDefaults(suiteName: appGroupIdentifier) {
      return shared
    }
    return .standard
  }

  private static var sharedContainerSnapshotURL: URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
      .appendingPathComponent("linkshell-watch-snapshot.json")
  }

  private func loadCachedSnapshot() {
    var rawJSON = Self.defaults.string(forKey: Self.cacheKey)
    if (rawJSON == nil || rawJSON?.isEmpty == true),
       let fileURL = Self.sharedContainerSnapshotURL,
       let fileText = try? String(contentsOf: fileURL, encoding: .utf8) {
      rawJSON = fileText
    }
    #if targetEnvironment(simulator)
    if rawJSON == nil || rawJSON?.isEmpty == true {
      let simURL = URL(fileURLWithPath: "/tmp/linkshell-watch-snapshot.json")
      if let simText = try? String(contentsOf: simURL, encoding: .utf8) {
        rawJSON = simText
      }
    }
    #endif
    guard let json = rawJSON,
          let data = json.data(using: .utf8),
          let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data) else {
      return
    }
    snapshot = decoded
    lastGeneratedAt = decoded.generatedAt
    if decoded.online { setHapticBaseline(decoded) }
  }

  private func resetHapticBaseline() {
    baselineKey = nil; lastUnanswerable = 0; lastPhasesById = [:]; announcedRequestIds = []
  }
  private func setHapticBaseline(_ value: WatchSnapshot) {
    if baselineKey != value.computerKey { announcedRequestIds = [] }
    baselineKey = value.computerKey
    lastUnanswerable = Self.waitingWithoutActions(value)
    lastPhasesById = Dictionary(value.sessions.map { ($0.id, $0.phase) }, uniquingKeysWith: { _, new in new })
    let current = Self.requestIds(value)
    // Remembered beyond the current list, so a request that disappears and comes back is not news.
    announcedRequestIds = announcedRequestIds.count > 200 ? current : announcedRequestIds.union(current)
  }
  private static func requestIds(_ value: WatchSnapshot) -> Set<String> {
    Set(value.sessions.flatMap { ($0.actions ?? []).map(\.requestId) })
  }
  /// Requests the watch can't answer carry no request id; their count stands in for one.
  private static func waitingWithoutActions(_ value: WatchSnapshot) -> Int {
    value.sessions.filter { $0.phase.hasPrefix("waiting") && ($0.actions ?? []).isEmpty }.count
  }

  /// `force` stores it even when it looks like nothing changed (switching modes clears the caches).
  public func applySnapshotJSON(_ json: String, force: Bool = false) {
    guard let data = json.data(using: .utf8),
          let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data) else {
      return
    }
    // Nothing new to show: skip the stores, but let the face's age move on now and then.
    var unchanged = decoded
    unchanged.generatedAt = snapshot.generatedAt
    if !force && unchanged == snapshot && decoded.generatedAt - lastPersistedAt < 60_000 { return }
    // Paused or reconnecting to the same computer, the face keeps the last real picture (its counts
    // fade with age) rather than "离线 / –". Another computer, or none, replaces it.
    let persist = force || !independent || decoded.online || decoded.computerKey != snapshot.computerKey || snapshot.isUnsynced
    if persist {
      lastPersistedAt = decoded.generatedAt
      Self.defaults.set(json, forKey: Self.cacheKey)
      Self.defaults.set(json, forKey: WatchSnapshot.widgetCacheKey)
      UserDefaults.standard.set(json, forKey: Self.cacheKey)
      if let fileURL = Self.sharedContainerSnapshotURL {
        try? json.write(to: fileURL, atomically: true, encoding: .utf8)
      }
      #if targetEnvironment(simulator)
      try? json.write(to: URL(fileURLWithPath: "/tmp/linkshell-watch-snapshot.json"), atomically: true, encoding: .utf8)
      #endif
    }

    // Proactive haptic feedback on state transitions, only for what is new since the computer was
    // last reachable: requests never announced before, and turns that ended in between.
    let comparable = decoded.online && baselineKey == decoded.computerKey
    let incomingReqIds = Self.requestIds(decoded)
    if comparable && (!incomingReqIds.subtracting(announcedRequestIds).isEmpty || Self.waitingWithoutActions(decoded) > lastUnanswerable) {
      WatchHaptics.attention()
    } else if comparable {
      var didFail = false
      var didComplete = false
      for s in decoded.sessions {
        if let prev = lastPhasesById[s.id], (prev == "running" || prev == "starting") {
          if s.phase == "failed" {
            didFail = true
          } else if s.phase == "completed" {
            didComplete = true
          }
        }
      }
      if didFail {
        WatchHaptics.failure()
      } else if didComplete {
        WatchHaptics.success()
      }
    }

    let structureChanged = persist && (
      decoded.waitingCount != snapshot.waitingCount ||
      decoded.runningCount != snapshot.runningCount ||
      decoded.failedCount != snapshot.failedCount ||
      decoded.sessions.first?.id != snapshot.sessions.first?.id ||
      decoded.sessions.first?.phase != snapshot.sessions.first?.phase)

    lastGeneratedAt = decoded.generatedAt
    if decoded.online { setHapticBaseline(decoded) }

    withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
      snapshot = decoded
      loadingEarlierSessionId = nil
    }
    #if canImport(WidgetKit)
    if structureChanged {
      WidgetCenter.shared.reloadAllTimelines()
    }
    #endif
  }

  private func activateSession() {
    #if canImport(WatchConnectivity)
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    session.delegate = self
    session.activate()
    #endif
  }

  #if targetEnvironment(simulator)
  private func startSimulatorBridgeLoop() {
    let disablePoll = ProcessInfo.processInfo.environment["LINKSHELL_WATCH_DISABLE_SIM_POLL"] == "1"
    guard !disablePoll else { return }
    simPollTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        await self?.pollSimulatorBridge()
        try? await Task.sleep(nanoseconds: 1_200_000_000)
      }
    }
  }

  private func pollSimulatorBridge() async {
    guard !independent else { return }
    guard let url = URL(string: "http://127.0.0.1:7879/snapshot") else { return }
    var req = URLRequest(url: url)
    req.timeoutInterval = 1.0
    guard let (data, response) = try? await URLSession.shared.data(for: req),
          let http = response as? HTTPURLResponse,
          http.statusCode == 200,
          let json = String(data: data, encoding: .utf8),
          !json.isEmpty else {
      isPhoneReachable = false
      return
    }
    guard !independent else { return }
    isPhoneReachable = true
    if let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data),
       decoded.generatedAt != lastGeneratedAt ||
       snapshot.computerKey != decoded.computerKey ||
       snapshot.sessions.count != decoded.sessions.count ||
       snapshot.terminals.count != decoded.terminals.count ||
       snapshot.sessions.map({ ($0.items ?? []).count }) != decoded.sessions.map({ ($0.items ?? []).count }) ||
       snapshot.sessions.map({ $0.hasEarlier ?? false }) != decoded.sessions.map({ $0.hasEarlier ?? false }) {
      isPhoneReachable = true
      applySnapshotJSON(json)
    }
  }
  #endif

  public func requestRefresh(silent: Bool = false) {
    // Silent refreshes follow reachability changes: tapping the wrist for them is noise.
    if !silent { WatchHaptics.click() }
    if independent || !snapshot.computerKey.isEmpty {
      sendCommand(
        [
          "id": "watch-refresh-\(UUID().uuidString)",
          "kind": "refresh",
          "computerKey": snapshot.computerKey,
        ],
        optimisticMessage: "已同步最新状态",
        silent: silent
      )
      return
    }
    #if canImport(WatchConnectivity)
    if WCSession.isSupported() {
      let session = WCSession.default
      if let json = session.receivedApplicationContext["snapshotJSON"] as? String {
        applySnapshotJSON(json)
      }
      if session.isReachable {
        session.sendMessage(["type": "requestSnapshot"]) { [weak self] reply in
          Task { @MainActor in
            guard let self, !self.independent else { return }
            if let json = reply["snapshotJSON"] as? String {
              self.applySnapshotJSON(json)
            }
            self.showNotice(ok: true, text: "已同步最新状态")
          }
        } errorHandler: { [weak self] _ in
          Task { @MainActor in
            self?.showNotice(ok: false, text: "请确认 iPhone 已打开 LinkShell")
          }
        }
        return
      }
    }
    #endif
    #if targetEnvironment(simulator)
    Task { @MainActor in
      await pollSimulatorBridge()
      showNotice(ok: snapshot.online, text: snapshot.online ? "已同步最新状态" : "请在 iPhone 上打开 LinkShell")
    }
    #else
    loadCachedSnapshot()
    showNotice(ok: snapshot.online, text: snapshot.online ? "已刷新缓存状态" : "请在 iPhone 上打开 LinkShell")
    #endif
  }

  public func openSession(sessionId: String) {
    guard !snapshot.computerKey.isEmpty, !sessionId.isEmpty else { return }
    sendCommand(
      [
        "id": "watch-open-sess-\(UUID().uuidString)",
        "kind": "open-session",
        "computerKey": snapshot.computerKey,
        "sessionId": sessionId,
      ],
      optimisticMessage: "",
      silent: true
    )
  }

  public func loadEarlierMessages(sessionId: String) {
    guard !snapshot.computerKey.isEmpty, !sessionId.isEmpty else { return }
    guard loadingEarlierSessionId != sessionId else { return }
    WatchHaptics.click()
    loadingEarlierSessionId = sessionId
    sendCommand(
      [
        "id": "watch-earlier-\(UUID().uuidString)",
        "kind": "load-earlier",
        "computerKey": snapshot.computerKey,
        "sessionId": sessionId,
      ],
      optimisticMessage: "已加载更早消息",
      silent: true
    )
    Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      if self?.loadingEarlierSessionId == sessionId {
        self?.loadingEarlierSessionId = nil
      }
    }
  }

  public func createSession(agent: String, cwd: String, prompt: String?) {
    guard !snapshot.computerKey.isEmpty, !agent.isEmpty, !cwd.isEmpty else { return }
    WatchHaptics.start()
    let trimmedPrompt = prompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    var payload: [String: Any] = [
      "id": "watch-create-sess-\(UUID().uuidString)",
      "kind": "create-session",
      "computerKey": snapshot.computerKey,
      "agent": agent,
      "cwd": cwd,
    ]
    if !trimmedPrompt.isEmpty {
      payload["prompt"] = trimmedPrompt
    }
    sendCommand(payload, optimisticMessage: "正在启动 \(WatchAgent(id: agent).name) 会话…")
  }

  public func createTerminal(cwd: String?, command: String?) {
    guard !snapshot.computerKey.isEmpty else { return }
    WatchHaptics.start()
    var payload: [String: Any] = [
      "id": "watch-create-term-\(UUID().uuidString)",
      "kind": "create-terminal",
      "computerKey": snapshot.computerKey,
    ]
    if let cwd, !cwd.isEmpty {
      payload["cwd"] = cwd
    }
    if let command, !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      payload["command"] = command.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    sendCommand(payload, optimisticMessage: "已新建终端")
  }

  public func openTerminal(terminalId: String) {
    guard !snapshot.computerKey.isEmpty, !terminalId.isEmpty else { return }
    sendCommand(
      [
        "id": "watch-open-term-\(UUID().uuidString)",
        "kind": "open-terminal",
        "computerKey": snapshot.computerKey,
        "terminalId": terminalId,
      ],
      optimisticMessage: "",
      silent: true
    )
  }

  public func sendTerminalInput(terminalId: String, data: String) {
    guard !snapshot.computerKey.isEmpty, !terminalId.isEmpty, !data.isEmpty else { return }
    let isInterrupt = data == "\u{0003}"
    if isInterrupt {
      WatchHaptics.stop()
    } else {
      WatchHaptics.click()
    }
    let label = isInterrupt ? "已发送 Ctrl+C" : "已发送命令"
    sendCommand(
      [
        "id": "watch-term-in-\(UUID().uuidString)",
        "kind": "terminal-input",
        "computerKey": snapshot.computerKey,
        "terminalId": terminalId,
        "data": data,
      ],
      optimisticMessage: label
    )
  }

  public func closeTerminal(terminalId: String) {
    guard !snapshot.computerKey.isEmpty, !terminalId.isEmpty else { return }
    WatchHaptics.stop()
    sendCommand(
      [
        "id": "watch-term-close-\(UUID().uuidString)",
        "kind": "close-terminal",
        "computerKey": snapshot.computerKey,
        "terminalId": terminalId,
      ],
      optimisticMessage: "已关闭终端"
    )
  }

  public func performAction(_ action: WatchAction) {
    guard let actionData = try? JSONEncoder().encode(action),
          let actionDict = (try? JSONSerialization.jsonObject(with: actionData)) as? [String: Any] else {
      return
    }
    let rejected = action.role == "reject" || action.role == "stop"
    if rejected {
      WatchHaptics.stop()
    } else {
      WatchHaptics.click()
    }
    sendCommand(
      [
        "id": "watch-act-\(UUID().uuidString)",
        "kind": "action",
        "action": actionDict,
      ],
      optimisticMessage: "已处理：\(action.label)"
    )
  }

  public func sendPrompt(sessionId: String, text: String, now: Bool = false) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !snapshot.computerKey.isEmpty else { return }
    WatchHaptics.click()
    var id = "watch-prompt-\(UUID().uuidString)"
    if let previous = unsettledPrompt, previous.sessionId == sessionId, previous.text == trimmed,
       Date().timeIntervalSince(previous.at) < 600 { id = previous.id }
    unsettledPrompt = (id, sessionId, trimmed, Date())
    sendCommand(
      [
        "id": id,
        "kind": "prompt",
        "computerKey": snapshot.computerKey,
        "sessionId": sessionId,
        "text": trimmed,
        "now": now,
      ],
      optimisticMessage: "已发送给 Agent"
    )
  }

  public func setSessionConfig(sessionId: String, optionId: String, value: String, label: String) {
    guard !snapshot.computerKey.isEmpty, !sessionId.isEmpty, !optionId.isEmpty else { return }
    WatchHaptics.click()
    sendCommand(
      [
        "id": "watch-cfg-\(UUID().uuidString)",
        "kind": "set-config",
        "computerKey": snapshot.computerKey,
        "sessionId": sessionId,
        "optionId": optionId,
        "value": value,
      ],
      optimisticMessage: "已切换为 \(label)"
    )
  }

  public func cancelSession(sessionId: String) {
    guard !snapshot.computerKey.isEmpty else { return }
    WatchHaptics.stop()
    sendCommand(
      [
        "id": "watch-cancel-\(UUID().uuidString)",
        "kind": "cancel",
        "computerKey": snapshot.computerKey,
        "sessionId": sessionId,
      ],
      optimisticMessage: "已停止当前轮次"
    )
  }

  public func takeoverSession(sessionId: String) {
    guard !snapshot.computerKey.isEmpty else { return }
    WatchHaptics.start()
    sendCommand(
      [
        "id": "watch-takeover-\(UUID().uuidString)",
        "kind": "takeover",
        "computerKey": snapshot.computerKey,
        "sessionId": sessionId,
      ],
      optimisticMessage: "已在腕表接管会话"
    )
  }

  public func releaseSession(sessionId: String) {
    guard !snapshot.computerKey.isEmpty else { return }
    WatchHaptics.click()
    sendCommand(
      [
        "id": "watch-release-\(UUID().uuidString)",
        "kind": "release",
        "computerKey": snapshot.computerKey,
        "sessionId": sessionId,
      ],
      optimisticMessage: "已交还电脑终端"
    )
  }

  public func selectComputer(computerKey: String) {
    guard !computerKey.isEmpty else { return }
    WatchHaptics.click()
    let targetName = snapshot.computers.first { $0.key == computerKey }?.name ?? "电脑"
    sendCommand(
      [
        "id": "watch-select-\(UUID().uuidString)",
        "kind": "select-computer",
        "computerKey": computerKey,
      ],
      optimisticMessage: "已切换到 \(targetName)"
    )
  }

  private func finishCommand(id: String, ok: Bool, message: String, silent: Bool) {
    if ok, unsettledPrompt?.id == id { unsettledPrompt = nil }
    if !silent {
      guard pendingCommandId == id else { return }
      commandTimeoutTask?.cancel()
      pendingCommandId = nil
      if ok { WatchHaptics.success() } else { WatchHaptics.failure() }
      if !message.isEmpty { showNotice(ok: ok, text: message) }
    }
  }

  private func sendCommand(_ payload: [String: Any], optimisticMessage: String, silent: Bool = false) {
    // Serialize user decisions, but allow read-only timeline refreshes while waiting.
    guard silent || pendingCommandId == nil else {
      showNotice(ok: false, text: "上一项操作正在确认，请稍候")
      return
    }
    guard let id = payload["id"] as? String,
          let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    if !silent {
      pendingCommandId = id
      commandTimeoutTask?.cancel()
      let awaitsRPC = independent
      commandTimeoutTask = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: 15_000_000_000)
        guard !Task.isCancelled, let self else { return }
        // The RPC itself is still alive (until the host answers, it times out, or the tunnel
        // closes); letting a retry start now could make the host carry the command out twice.
        if awaitsRPC { if self.pendingCommandId == id { self.showNotice(ok: false, text: "电脑尚未回应，正在等待结果") }; return }
        self.finishCommand(id: id, ok: false, message: "尚未收到结果，请同步状态后再操作", silent: false)
      }
    }

    if independent {
      Task { @MainActor [weak self] in
        guard let self else { return }
        do {
          let message = try await direct.execute(payload)
          finishCommand(id: id, ok: true, message: message.isEmpty ? optimisticMessage : message, silent: silent)
        } catch {
          finishCommand(id: id, ok: false, message: error.localizedDescription, silent: silent)
          if silent { showNotice(ok: false, text: error.localizedDescription) }
        }
      }
      return
    }

    #if canImport(WatchConnectivity)
    if WCSession.isSupported(), WCSession.default.isReachable {
      WCSession.default.sendMessage(["commandJSON": json]) { [weak self] reply in
        Task { @MainActor in
          guard let self, !self.independent else { return }
          let ok = (reply["ok"] as? Bool) ?? false
          if let snapshotJSON = reply["snapshotJSON"] as? String {
            self.applySnapshotJSON(snapshotJSON)
          }
          self.finishCommand(id: id, ok: ok,
            message: (reply["message"] as? String) ?? (ok ? optimisticMessage : "操作未生效"), silent: silent)
        }
      } errorHandler: { [weak self] _ in
        Task { @MainActor in
          self?.finishCommand(id: id, ok: false, message: "连接中断，请同步状态确认操作结果", silent: silent)
        }
      }
      return
    }
    #endif

    #if targetEnvironment(simulator)
    Task { @MainActor [weak self] in
      guard let self, let url = URL(string: "http://127.0.0.1:7879/commands/enqueue") else { return }
      var req = URLRequest(url: url)
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "content-type")
      req.httpBody = data
      req.timeoutInterval = 4.0
      if let (respData, resp) = try? await URLSession.shared.data(for: req),
         let http = resp as? HTTPURLResponse, http.statusCode == 200,
         let obj = (try? JSONSerialization.jsonObject(with: respData)) as? [String: Any] {
        guard !self.independent else { return }
        if let snapJSON = obj["snapshotJSON"] as? String { self.applySnapshotJSON(snapJSON) }
        let ok = (obj["ok"] as? Bool) ?? false
        self.finishCommand(id: id, ok: ok,
          message: (obj["message"] as? String) ?? (ok ? optimisticMessage : "操作未生效"), silent: silent)
        await self.pollSimulatorBridge()
      } else {
        self.finishCommand(id: id, ok: false, message: "模拟器桥接未连接，操作未发送", silent: silent)
      }
    }
    #else
    // Decisions must not execute unexpectedly after the user has left the watch.
    finishCommand(id: id, ok: false, message: "请在 iPhone 上打开 LinkShell 后重试", silent: silent)
    #endif
  }

  public func showNotice(ok: Bool, text: String) {
    noticeTask?.cancel()
    withAnimation(.easeInOut(duration: 0.22)) {
      bannerNotice = (ok: ok, text: text)
    }
    noticeTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 2_200_000_000)
      guard !Task.isCancelled else { return }
      withAnimation(.easeInOut(duration: 0.25)) {
        self?.bannerNotice = nil
      }
    }
  }
}

#if canImport(WatchConnectivity)
extension WatchSessionStore: WCSessionDelegate {
  nonisolated public func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    let reachable = session.isReachable
    let contextJSON = session.receivedApplicationContext["snapshotJSON"] as? String
    Task { @MainActor in
      self.isPhoneReachable = reachable
      guard !self.independent else { return }
      if let contextJSON {
        self.applySnapshotJSON(contextJSON)
      }
      if reachable {
        self.requestRefresh(silent: true)
      }
    }
  }

  nonisolated public func sessionReachabilityDidChange(_ session: WCSession) {
    let reachable = session.isReachable
    Task { @MainActor in
      self.isPhoneReachable = reachable
      guard !self.independent else { return }
      if reachable {
        self.requestRefresh(silent: true)
      }
    }
  }

  nonisolated public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    guard let json = applicationContext["snapshotJSON"] as? String else { return }
    Task { @MainActor in
      guard !self.independent else { return }
      self.applySnapshotJSON(json)
    }
  }

  nonisolated public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    guard let json = message["snapshotJSON"] as? String else { return }
    Task { @MainActor in
      guard !self.independent else { return }
      self.applySnapshotJSON(json)
    }
  }

  /// The phone sends one when the number waiting changes (`transferCurrentComplicationUserInfo`).
  /// watchOS delivers it with background time even when this app isn't open, so the face can
  /// stop showing a request already answered on the computer.
  nonisolated public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    guard let json = userInfo["snapshotJSON"] as? String else { return }
    Task { @MainActor in self.applyBackgroundSnapshot(json) }
  }

  private func applyBackgroundSnapshot(_ json: String) {
    if !independent {
      applySnapshotJSON(json)
      return
    }
    // Connected on its own, the app keeps its own picture; the face may still take the phone's,
    // but only for the computer the watch is following.
    guard let data = json.data(using: .utf8),
          let incoming = try? JSONDecoder().decode(WatchSnapshot.self, from: data),
          let current = Self.widgetSnapshot(),
          current.computerName == incoming.computerName,
          incoming.generatedAt > current.generatedAt else { return }
    Self.defaults.set(json, forKey: WatchSnapshot.widgetCacheKey)
    #if canImport(WidgetKit)
    WidgetCenter.shared.reloadAllTimelines()
    #endif
  }

  private static func widgetSnapshot() -> WatchSnapshot? {
    guard let json = defaults.string(forKey: WatchSnapshot.widgetCacheKey) ?? defaults.string(forKey: cacheKey),
          let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WatchSnapshot.self, from: data)
  }
}
#endif
