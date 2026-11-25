import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif

public enum WatchCommandQueue {
  public static let notification = Notification.Name("LinkShellWatchCommand")
  public static let statusNotification = Notification.Name("LinkShellWatchStatus")
  private static let prefix = "LinkShellWatch.command."
  private static let snapshotKey = "LinkShellWatch.snapshot.v1"
  private static let lifetime: TimeInterval = 120
  /// The watch gives up on a command after 15 s and tells the user it may not have happened.
  /// A decision still queued after that must not run later — e.g. when the phone app next
  /// comes to the foreground — behind the user's back. Reads may wait longer.
  static let decisionLifetime: TimeInterval = 12
  private static let readKinds: Set<String> = ["refresh", "open-session", "load-earlier", "open-terminal"]
  private static let lock = NSLock()
  private static var replyHandlers: [String: ([String: Any]) -> Void] = [:]

  private struct Entry: Codable {
    let id: String
    let createdAt: TimeInterval
    let commandJSON: String
    /// Absent in entries written by an older app: those keep the general lifetime.
    var expiresIn: TimeInterval?
    var lifetime: TimeInterval { expiresIn ?? WatchCommandQueue.lifetime }
  }

  public static var sharedDefaults: UserDefaults {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "LinkShellLiveActivityAppGroup") as? String,
          let defaults = UserDefaults(suiteName: group) else {
      return .standard
    }
    return defaults
  }

  public static func saveSnapshotJSON(_ json: String, defaults: UserDefaults = sharedDefaults) {
    lock.lock()
    defer { lock.unlock() }
    defaults.set(json, forKey: snapshotKey)
  }

  public static func latestSnapshotJSON(defaults: UserDefaults = sharedDefaults) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return defaults.string(forKey: snapshotKey)
  }

  public static func enqueue(
    commandJSON: String,
    defaults: UserDefaults = sharedDefaults,
    now: Date = Date(),
    replyHandler: (([String: Any]) -> Void)? = nil
  ) -> String? {
    guard let data = commandJSON.data(using: .utf8),
          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let rawId = object["id"] as? String,
          !rawId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let kind = object["kind"] as? String,
          !kind.isEmpty else {
      replyHandler?(["ok": false, "message": "无效的手表指令"])
      return nil
    }

    lock.lock()
    let pending = pendingEntries(defaults: defaults, now: now)
    if let existing = pending.first(where: { $0.1.id == rawId }) {
      let superseded = replyHandler != nil ? replyHandlers[existing.1.id] : nil
      if let replyHandler {
        replyHandlers[existing.1.id] = replyHandler
      }
      lock.unlock()
      // Never drop a WatchConnectivity replyHandler when a duplicate command id supersedes it.
      if let superseded {
        DispatchQueue.main.async {
          superseded(["ok": false, "message": "已有更新的重试请求"])
        }
      }
      return existing.1.id
    }
    for (key, entry) in pending.sorted(by: { $0.1.createdAt > $1.1.createdAt }).dropFirst(15) {
      defaults.removeObject(forKey: key)
      rejectReplyLocked(entry.id, message: "待处理操作过多，请刷新后重试")
    }
    let entry = Entry(id: rawId, createdAt: now.timeIntervalSince1970, commandJSON: commandJSON,
                      expiresIn: readKinds.contains(kind) ? lifetime : decisionLifetime)
    guard let encoded = try? JSONEncoder().encode(entry) else {
      lock.unlock()
      replyHandler?(["ok": false, "message": "无法记录手表指令"])
      return nil
    }
    defaults.set(encoded, forKey: prefix + rawId)
    if let replyHandler {
      replyHandlers[rawId] = replyHandler
    }
    lock.unlock()
    return rawId
  }

  public static func pendingID(defaults: UserDefaults = sharedDefaults, now: Date = Date()) -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard let oldest = pendingEntries(defaults: defaults, now: now).min(by: { $0.1.createdAt < $1.1.createdAt }) else {
      return nil
    }
    return oldest.1.id
  }

  public static func consume(_ id: String, defaults: UserDefaults = sharedDefaults, now: Date = Date()) -> [String: Any]? {
    lock.lock()
    let key = prefix + id
    guard let data = defaults.data(forKey: key) else {
      lock.unlock()
      return nil
    }
    defaults.removeObject(forKey: key)
    guard let entry = try? JSONDecoder().decode(Entry.self, from: data),
          (0..<entry.lifetime).contains(now.timeIntervalSince1970 - entry.createdAt),
          let cmdData = entry.commandJSON.data(using: .utf8),
          let dict = (try? JSONSerialization.jsonObject(with: cmdData)) as? [String: Any] else {
      let expiredReply = replyHandlers.removeValue(forKey: id)
      lock.unlock()
      // Invoke WatchConnectivity replyHandler outside NSLock to prevent reentrancy deadlocks.
      expiredReply?(["ok": false, "message": "操作已过期，请在手表上重试"])
      endBackgroundWork(id, after: 0)
      return nil
    }
    lock.unlock()
    return dict
  }

  public static func complete(_ id: String, ok: Bool, message: String?) {
    lock.lock()
    let handler = replyHandlers.removeValue(forKey: id)
    let snapshotJSON = sharedDefaults.string(forKey: snapshotKey)
    lock.unlock()
    var response: [String: Any] = ["ok": ok]
    if let message, !message.isEmpty {
      response["message"] = message
    }
    if let snapshotJSON, !snapshotJSON.isEmpty {
      response["snapshotJSON"] = snapshotJSON
    }
    handler?(response)
    endBackgroundWork(id, after: backgroundGrace)
  }

  #if canImport(UIKit)
  /// A watch message wakes the phone app in the background, and the system may suspend it
  /// again as soon as the delegate returns: halfway through the RPC, with the reply never
  /// sent. Each command synchronously claims background execution time before returning.
  private static var backgroundTasks: [String: UIBackgroundTaskIdentifier] = [:]
  #endif
  /// The snapshot a command produced goes out just before its reply; give it time to leave.
  static let backgroundGrace: TimeInterval = 2
  static let backgroundLimit: TimeInterval = 25

  static func beginBackgroundWork(_ id: String) {
    #if canImport(UIKit)
    // Must be called synchronously before WCSessionDelegate's didReceiveMessage returns so iOS
    // cannot suspend the woken app before the JS command runs.
    let task = UIApplication.shared.beginBackgroundTask(withName: "LinkShell watch command") {
      WatchCommandQueue.endBackgroundWork(id, after: 0)
    }
    guard task != .invalid else { return }
    var previous: UIBackgroundTaskIdentifier?
    lock.lock()
    previous = backgroundTasks.updateValue(task, forKey: id)
    lock.unlock()
    if let previous, previous != .invalid {
      UIApplication.shared.endBackgroundTask(previous)
    }
    endBackgroundWork(id, after: backgroundLimit)
    #endif
  }

  static func endBackgroundWork(_ id: String, after delay: TimeInterval) {
    #if canImport(UIKit)
    let finish = {
      lock.lock()
      let task = backgroundTasks.removeValue(forKey: id)
      lock.unlock()
      if let task, task != .invalid {
        UIApplication.shared.endBackgroundTask(task)
      }
    }
    if delay > 0 {
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay, execute: finish)
    } else {
      finish()
    }
    #endif
  }

  // Dispatch outside the queue lock: WatchConnectivity callbacks must not reenter it.
  private static func rejectReplyLocked(_ id: String, message: String) {
    let reply = replyHandlers.removeValue(forKey: id)
    #if canImport(UIKit)
    let task = backgroundTasks.removeValue(forKey: id)
    #endif
    DispatchQueue.main.async {
      #if canImport(UIKit)
      if let task, task != .invalid {
        UIApplication.shared.endBackgroundTask(task)
      }
      #endif
      reply?(["ok": false, "message": message])
    }
  }

  private static func pendingEntries(defaults: UserDefaults, now: Date) -> [(String, Entry)] {
    defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(prefix) }.compactMap { key in
      guard let data = defaults.data(forKey: key),
            let entry = try? JSONDecoder().decode(Entry.self, from: data),
            (0..<entry.lifetime).contains(now.timeIntervalSince1970 - entry.createdAt) else {
        defaults.removeObject(forKey: key)
        rejectReplyLocked(String(key.dropFirst(prefix.count)), message: "操作已过期，请刷新后重试")
        return nil
      }
      return (key, entry)
    }
  }
}

public final class WatchSessionBridge: NSObject {
  public static let shared = WatchSessionBridge()

  private static let remoteIndependentKey = "LinkShellWatch.remoteIndependent"
  private let stateLock = NSLock()
  private var watchIndependent: Bool = UserDefaults.standard.object(forKey: WatchSessionBridge.remoteIndependentKey) as? Bool ?? false

  private override init() {
    super.init()
  }

  private func currentWatchIndependent() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return watchIndependent
  }

  private func updateWatchIndependent(_ value: Bool) -> Bool {
    stateLock.lock()
    let changed = watchIndependent != value
    watchIndependent = value
    stateLock.unlock()
    UserDefaults.standard.set(value, forKey: Self.remoteIndependentKey)
    return changed
  }

  public func start() {
    #if canImport(WatchConnectivity)
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    if session.delegate !== self {
      session.delegate = self
    }
    if session.activationState == .notActivated {
      session.activate()
    }
    #endif
  }

  public func status() -> [String: Any] {
    #if canImport(WatchConnectivity)
    guard WCSession.isSupported() else {
      return ["supported": false, "paired": false, "installed": false, "reachable": false, "independent": false]
    }
    let session = WCSession.default
    let activated = session.activationState == .activated
    if activated, let reported = session.receivedApplicationContext["independent"] as? Bool {
      _ = updateWatchIndependent(reported)
    }
    return [
      "supported": true,
      "activated": activated,
      "paired": activated ? session.isPaired : false,
      "installed": activated ? session.isWatchAppInstalled : false,
      "reachable": activated ? session.isReachable : false,
      "independent": activated ? currentWatchIndependent() : false,
    ]
    #else
    return ["supported": false, "paired": false, "installed": false, "reachable": false, "independent": false]
    #endif
  }

  public func syncSnapshot(payload: [String: Any]) -> Bool {
    // Unescaped slashes: paths and links fill the snapshot, and the phone sized it without the escapes.
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes]),
          let json = String(data: data, encoding: .utf8) else {
      return false
    }
    WatchCommandQueue.saveSnapshotJSON(json)
    #if canImport(WatchConnectivity)
    pushComplicationIfNeeded(payload: payload, json: json)
    #endif
    #if canImport(WatchConnectivity)
    guard WCSession.isSupported() else { return true }
    let session = WCSession.default
    if session.activationState == .notActivated {
      session.delegate = self
      session.activate()
      return true
    }
    guard session.activationState == .activated else { return true }
    let envelope: [String: Any] = [
      "type": "snapshot",
      "snapshotJSON": json,
      "updatedAt": Date().timeIntervalSince1970,
    ]
    #if targetEnvironment(simulator)
    try? session.updateApplicationContext(envelope)
    #else
    if session.isPaired {
      try? session.updateApplicationContext(envelope)
    }
    #endif
    if session.isReachable {
      session.sendMessage(envelope, replyHandler: nil, errorHandler: nil)
    }
    #endif
    return true
  }

  #if canImport(WatchConnectivity)
  /// The application context only reaches the watch when its app runs, so a face would keep a
  /// request that was answered on the computer. A complication transfer wakes the watch in the
  /// background; the system allows a limited number a day, so it is spent only when what the face
  /// shows changes: the number waiting or failed, or the computer. The last key is kept across
  /// launches, so relaunching the app doesn't spend one on an unchanged face.
  private static let complicationKeyDefault = "LinkShellWatch.complicationKey"
  /// The link drops and comes back with network changes and app wakes; the face follows the
  /// computer's online state only once it has held this long.
  private static let onlineSettle: TimeInterval = 300
  private var lastComplicationKey: String? = UserDefaults.standard.string(forKey: WatchSessionBridge.complicationKeyDefault)
  private var observedOnline: Bool?
  private var observedOnlineSince = Date()
  private var settleWorkItem: DispatchWorkItem?
  private var latestComplicationPayload: [String: Any]?
  private var latestComplicationJSON: String?

  private func pushComplicationIfNeeded(payload: [String: Any], json: String) {
    guard WCSession.isSupported() else { return }
    let now = Date()
    let online = payload["online"] as? Bool ?? false
    let session = WCSession.default

    stateLock.lock()
    latestComplicationPayload = payload
    latestComplicationJSON = json
    if online != observedOnline {
      observedOnline = online
      observedOnlineSince = now
      settleWorkItem?.cancel()
      settleWorkItem = nil
    }
    let elapsed = now.timeIntervalSince(observedOnlineSince)
    let shownOnline = elapsed >= Self.onlineSettle
      ? online
      : lastComplicationKey.map { $0.hasSuffix("|true") } ?? online
    let key = Self.complicationKey(payload, online: shownOnline)
    let previousKey = lastComplicationKey

    // If an online/offline state change is being held back for `onlineSettle`, schedule a timer
    // so the face eventually transitions to offline even when no further snapshots arrive.
    if online != shownOnline && settleWorkItem == nil {
      let remaining = max(1.0, Self.onlineSettle - elapsed)
      let work = DispatchWorkItem { [weak self] in
        guard let self else { return }
        self.stateLock.lock()
        self.settleWorkItem = nil
        let pendingPayload = self.latestComplicationPayload
        let pendingJSON = self.latestComplicationJSON
        self.stateLock.unlock()
        if let pendingPayload, let pendingJSON {
          self.pushComplicationIfNeeded(payload: pendingPayload, json: pendingJSON)
        }
      }
      settleWorkItem = work
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + remaining, execute: work)
    }

    guard session.activationState == .activated,
          session.isPaired,
          session.isComplicationEnabled,
          key != previousKey,
          session.remainingComplicationUserInfoTransfers > 0 else {
      stateLock.unlock()
      return
    }
    lastComplicationKey = key
    if online == shownOnline {
      settleWorkItem?.cancel()
      settleWorkItem = nil
    }
    stateLock.unlock()

    UserDefaults.standard.set(key, forKey: Self.complicationKeyDefault)
    // Only the newest matters: an older transfer still queued would show a stale count first.
    for transfer in session.outstandingUserInfoTransfers where transfer.isCurrentComplicationInfo { transfer.cancel() }
    session.transferCurrentComplicationUserInfo(["type": "snapshot", "snapshotJSON": json, "updatedAt": now.timeIntervalSince1970])
  }
  #endif

  /// What a watch face shows; a transfer is spent only when this changes. Online is last.
  static func complicationKey(_ payload: [String: Any], online: Bool) -> String {
    [payload["computerKey"] as? String ?? "", "\(payload["waitingCount"] as? Int ?? 0)",
     "\(payload["failedCount"] as? Int ?? 0)", "\(online)"].joined(separator: "|")
  }

  private func handleIncomingPayload(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)?) {
    if let type = message["type"] as? String, type == "watchMode" {
      if let mode = message["independent"] as? Bool {
        let changed = updateWatchIndependent(mode)
        if changed {
          NotificationCenter.default.post(name: WatchCommandQueue.statusNotification, object: nil, userInfo: status())
        }
      }
      replyHandler?(["ok": true])
      return
    }

    if let type = message["type"] as? String, type == "requestSnapshot" || type == "ping" {
      let refreshJSON = #"{"id":"watch-refresh-\#(Int(Date().timeIntervalSince1970 * 1000))","kind":"refresh"}"#
      if let id = WatchCommandQueue.enqueue(commandJSON: refreshJSON) {
        WatchCommandQueue.beginBackgroundWork(id)
        NotificationCenter.default.post(name: WatchCommandQueue.notification, object: nil, userInfo: ["id": id])
      }
      if let snapshotJSON = WatchCommandQueue.latestSnapshotJSON() {
        replyHandler?(["ok": true, "snapshotJSON": snapshotJSON])
      } else {
        replyHandler?(["ok": true])
      }
      return
    }

    guard let commandJSON = message["commandJSON"] as? String else {
      replyHandler?(["ok": false, "message": "缺少手表指令内容"])
      return
    }
    if let id = WatchCommandQueue.enqueue(commandJSON: commandJSON, replyHandler: replyHandler) {
      // Synchronous claim before didReceiveMessage returns keeps the woken app alive for the RPC.
      WatchCommandQueue.beginBackgroundWork(id)
      NotificationCenter.default.post(name: WatchCommandQueue.notification, object: nil, userInfo: ["id": id])
    }
  }
}

#if canImport(WatchConnectivity)
extension WatchSessionBridge: WCSessionDelegate {
  public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    if activationState == .activated, let reported = session.receivedApplicationContext["independent"] as? Bool {
      _ = updateWatchIndependent(reported)
    }
    NotificationCenter.default.post(name: WatchCommandQueue.statusNotification, object: nil, userInfo: status())
    if activationState == .activated, !currentWatchIndependent(), let snapshotJSON = WatchCommandQueue.latestSnapshotJSON() {
      let envelope: [String: Any] = [
        "type": "snapshot",
        "snapshotJSON": snapshotJSON,
        "updatedAt": Date().timeIntervalSince1970,
      ]
      try? session.updateApplicationContext(envelope)
    }
  }

  public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    if let mode = applicationContext["independent"] as? Bool {
      let changed = updateWatchIndependent(mode)
      if changed {
        NotificationCenter.default.post(name: WatchCommandQueue.statusNotification, object: nil, userInfo: status())
      }
    }
  }

  public func sessionDidBecomeInactive(_ session: WCSession) {
    NotificationCenter.default.post(name: WatchCommandQueue.statusNotification, object: nil, userInfo: status())
  }

  public func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
    NotificationCenter.default.post(name: WatchCommandQueue.statusNotification, object: nil, userInfo: status())
  }

  public func sessionWatchStateDidChange(_ session: WCSession) {
    NotificationCenter.default.post(name: WatchCommandQueue.statusNotification, object: nil, userInfo: status())
  }

  public func sessionReachabilityDidChange(_ session: WCSession) {
    NotificationCenter.default.post(name: WatchCommandQueue.statusNotification, object: nil, userInfo: status())
    if session.isReachable, !currentWatchIndependent(), let snapshotJSON = WatchCommandQueue.latestSnapshotJSON() {
      session.sendMessage(["type": "snapshot", "snapshotJSON": snapshotJSON, "updatedAt": Date().timeIntervalSince1970], replyHandler: nil, errorHandler: nil)
    }
  }

  public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    handleIncomingPayload(message, replyHandler: nil)
  }

  public func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    handleIncomingPayload(message, replyHandler: replyHandler)
  }

  public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    handleIncomingPayload(userInfo, replyHandler: nil)
  }
}
#endif
