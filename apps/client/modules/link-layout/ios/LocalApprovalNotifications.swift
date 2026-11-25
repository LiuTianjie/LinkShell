import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

/// Persists iOS local approval notification actions so cold-start taps survive app launch until
/// JS calls `pendingNotificationActionId` + `consumeNotificationAction`.
final class LocalNotificationActionQueue {
  static let shared = LocalNotificationActionQueue()
  static let notification = Notification.Name("LinkShellLocalNotificationAction")
  private static let storageKey = "linkshell.localNotificationActions"
  private static let maxItems = 32
  private static let ttlMilliseconds: Double = 5 * 60 * 1000
  private static let maxBackgroundSeconds: TimeInterval = 25
  private static let postConsumeBackgroundGrace: TimeInterval = 12

  private let lock = NSLock()
  private let defaults: UserDefaults
  #if canImport(UIKit)
  private var backgroundTasks: [String: UIBackgroundTaskIdentifier] = [:]
  #endif

  private init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  private static func isFresh(_ item: [String: Any], nowMs: Double) -> Bool {
    guard let createdAt = item["createdAt"] as? Double, createdAt > 0 else { return false }
    let age = nowMs - createdAt
    return age <= ttlMilliseconds && age >= -60_000
  }

  @discardableResult
  func enqueue(
    actionId: String,
    kind: String,
    computerKey: String?,
    sessionId: String?,
    requestId: String?,
    optionId: String?,
    deepLink: String?
  ) -> String {
    let id = UUID().uuidString
    let nowMs = Date().timeIntervalSince1970 * 1000.0
    var item: [String: Any] = [
      "id": id,
      "actionId": actionId,
      "kind": kind,
      "createdAt": nowMs,
    ]
    if let computerKey, !computerKey.isEmpty { item["computerKey"] = computerKey }
    if let sessionId, !sessionId.isEmpty { item["sessionId"] = sessionId }
    if let requestId, !requestId.isEmpty { item["requestId"] = requestId }
    if let optionId, !optionId.isEmpty { item["optionId"] = optionId }
    if let deepLink, !deepLink.isEmpty { item["deepLink"] = deepLink }

    lock.lock()
    var queue = (defaults.array(forKey: Self.storageKey) as? [[String: Any]] ?? [])
      .filter { Self.isFresh($0, nowMs: nowMs) }
    if queue.count >= Self.maxItems {
      queue.removeFirst(queue.count - (Self.maxItems - 1))
    }
    queue.append(item)
    defaults.set(queue, forKey: Self.storageKey)
    lock.unlock()

    DispatchQueue.main.async {
      NotificationCenter.default.post(name: Self.notification, object: self, userInfo: ["id": id])
    }
    return id
  }

  func pendingId() -> String? {
    let nowMs = Date().timeIntervalSince1970 * 1000.0
    lock.lock()
    defer { lock.unlock() }
    let raw = defaults.array(forKey: Self.storageKey) as? [[String: Any]] ?? []
    let fresh = raw.filter { Self.isFresh($0, nowMs: nowMs) }
    if fresh.count != raw.count {
      defaults.set(fresh, forKey: Self.storageKey)
    }
    return fresh.first?["id"] as? String
  }

  func consume(id: String) -> [String: Any]? {
    let nowMs = Date().timeIntervalSince1970 * 1000.0
    lock.lock()
    let raw = defaults.array(forKey: Self.storageKey) as? [[String: Any]] ?? []
    var fresh = raw.filter { Self.isFresh($0, nowMs: nowMs) }
    let matchedIndex = fresh.firstIndex(where: { ($0["id"] as? String) == id })
    let item = matchedIndex.map { fresh.remove(at: $0) }
    if matchedIndex != nil || fresh.count != raw.count {
      defaults.set(fresh, forKey: Self.storageKey)
    }
    lock.unlock()

    if item != nil {
      // Allow JS time to reconnect and deliver the approval RPC after consuming the queued tap.
      endBackgroundTask(for: id, after: Self.postConsumeBackgroundGrace)
    } else {
      endBackgroundTask(for: id, after: 0)
    }
    return item
  }

  /// Synchronously acquires a UIKit background task before `didReceive`'s completionHandler returns
  /// so iOS does not suspend the woken app mid-RPC when the user taps Allow/Deny from the lock screen.
  func beginBackgroundTask(for id: String) {
    #if canImport(UIKit)
    let taskId = UIApplication.shared.beginBackgroundTask(withName: "LinkShell local approval action") { [weak self] in
      self?.endBackgroundTask(for: id, after: 0)
    }
    guard taskId != .invalid else { return }
    var replaced: UIBackgroundTaskIdentifier?
    lock.lock()
    replaced = backgroundTasks.updateValue(taskId, forKey: id)
    lock.unlock()
    if let replaced, replaced != .invalid {
      UIApplication.shared.endBackgroundTask(replaced)
    }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + Self.maxBackgroundSeconds) { [weak self] in
      self?.endBackgroundTask(for: id, after: 0)
    }
    #endif
  }

  func endBackgroundTask(for id: String, after delay: TimeInterval) {
    #if canImport(UIKit)
    let finish = { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let taskId = self.backgroundTasks.removeValue(forKey: id)
      self.lock.unlock()
      if let taskId, taskId != .invalid {
        UIApplication.shared.endBackgroundTask(taskId)
      }
    }
    if delay > 0 {
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay, execute: finish)
    } else {
      finish()
    }
    #endif
  }

  func endAllBackgroundTasks(after delay: TimeInterval) {
    #if canImport(UIKit)
    let finish = { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let tasks = Array(self.backgroundTasks.values)
      self.backgroundTasks.removeAll()
      self.lock.unlock()
      for taskId in tasks where taskId != .invalid {
        UIApplication.shared.endBackgroundTask(taskId)
      }
    }
    if delay > 0 {
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay, execute: finish)
    } else {
      finish()
    }
    #endif
  }
}

/// Manages the local actionable `UNUserNotificationCenter` approval fallback (`LINKSHELL_APPROVAL`),
/// chaining onto any existing notification center delegate rather than replacing push handlers.
public final class LocalApprovalNotifications: NSObject, UNUserNotificationCenterDelegate {
  public static let shared = LocalApprovalNotifications()
  public static let categoryIdentifier = "LINKSHELL_APPROVAL"
  public static let allowActionIdentifier = "LINKSHELL_APPROVAL_ALLOW"
  public static let denyActionIdentifier = "LINKSHELL_APPROVAL_DENY"
  private static let requestPrefix = "linkshell-local-approval-"
  private static let activeSessionPrefix = "__active_session__:"
  private static let staleDeliveredAge: TimeInterval = 5 * 60

  private let stateLock = NSLock()
  private weak var previousDelegate: UNUserNotificationCenterDelegate?
  private var installed = false
  private var activeSessionKey: String?

  public func setActiveSession(_ sessionKey: String?) {
    stateLock.lock()
    activeSessionKey = (sessionKey?.isEmpty == false) ? sessionKey : nil
    stateLock.unlock()
  }

  private func currentActiveSession() -> String? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return activeSessionKey
  }

  public func install() {
    let center = UNUserNotificationCenter.current()
    registerCategory(on: center)
    if let existing = center.delegate, existing !== self {
      previousDelegate = existing
    }
    if center.delegate !== self {
      center.delegate = self
    }
    let firstInstall: Bool = {
      stateLock.lock()
      defer { stateLock.unlock() }
      let wasInstalled = installed
      installed = true
      return !wasInstalled
    }()
    if firstInstall {
      // Sweep expired approval notifications left over from prior sessions on startup.
      clearDeliveredApprovals(olderThan: Self.staleDeliveredAge)
    }
  }

  private func registerCategory(on center: UNUserNotificationCenter) {
    let allow = UNNotificationAction(
      identifier: Self.allowActionIdentifier,
      title: "允许",
      options: []
    )
    let deny = UNNotificationAction(
      identifier: Self.denyActionIdentifier,
      title: "拒绝",
      options: [.destructive]
    )
    let category = UNNotificationCategory(
      identifier: Self.categoryIdentifier,
      actions: [allow, deny],
      intentIdentifiers: [],
      options: []
    )
    center.getNotificationCategories { existing in
      var next = existing.filter { $0.identifier != Self.categoryIdentifier }
      next.insert(category)
      center.setNotificationCategories(next)
    }
  }

  /// Requests notification authorization lazily only when local approval fallback is actually needed.
  private func ensureAuthorized(on center: UNUserNotificationCenter, completion: @escaping (Bool) -> Void) {
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        completion(true)
      case .notDetermined:
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
          completion(granted)
        }
      default:
        completion(false)
      }
    }
  }

  func sync(payload: [String: Any], completion: @escaping (Bool) -> Void) {
    let isInstalled: Bool = {
      stateLock.lock()
      defer { stateLock.unlock() }
      return installed
    }()
    if !isInstalled {
      DispatchQueue.main.async { self.install() }
    }
    guard let id = payload["id"] as? String, !id.isEmpty,
          let title = payload["title"] as? String, !title.isEmpty,
          let body = payload["body"] as? String,
          let computerKey = payload["computerKey"] as? String, !computerKey.isEmpty,
          let sessionId = payload["sessionId"] as? String, !sessionId.isEmpty,
          let requestId = payload["requestId"] as? String, !requestId.isEmpty else {
      completion(false)
      return
    }

    let center = UNUserNotificationCenter.current()
    ensureAuthorized(on: center) { granted in
      guard granted else {
        completion(false)
        return
      }

      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      content.categoryIdentifier = Self.categoryIdentifier
      content.threadIdentifier = "\(computerKey):\(sessionId)"
      if #available(iOS 15.0, *) {
        content.interruptionLevel = .active
      }

      var userInfo: [String: Any] = [
        "linkshellApproval": true,
        "approvalId": id,
        "computerKey": computerKey,
        "sessionId": sessionId,
        "requestId": requestId,
      ]
      if let approveOptionId = payload["approveOptionId"] as? String, !approveOptionId.isEmpty {
        userInfo["approveOptionId"] = approveOptionId
      }
      if let denyOptionId = payload["denyOptionId"] as? String, !denyOptionId.isEmpty {
        userInfo["denyOptionId"] = denyOptionId
      }
      if let deepLink = payload["deepLink"] as? String, !deepLink.isEmpty {
        userInfo["deepLink"] = deepLink
      }
      content.userInfo = userInfo

      let request = UNNotificationRequest(
        identifier: Self.requestPrefix + id,
        content: content,
        trigger: nil
      )
      center.add(request) { error in
        completion(error == nil)
      }
    }
  }

  func cancel(id: String) {
    guard !id.isEmpty else { return }
    if id.hasPrefix(Self.activeSessionPrefix) {
      let token = String(id.dropFirst(Self.activeSessionPrefix.count))
      setActiveSession(token.isEmpty ? nil : token)
      return
    }
    if id == "*" {
      clearDeliveredApprovals(olderThan: nil)
      return
    }
    let requestId = Self.requestPrefix + id
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [requestId])
    center.removeDeliveredNotifications(withIdentifiers: [requestId])
    LocalNotificationActionQueue.shared.endAllBackgroundTasks(after: 1.0)
  }

  /// Removes delivered (and pending) LinkShell approval notifications via `getDeliveredNotifications`.
  func clearDeliveredApprovals(olderThan maxAge: TimeInterval?) {
    let center = UNUserNotificationCenter.current()
    let now = Date()
    center.getDeliveredNotifications { delivered in
      let ids = delivered.compactMap { notification -> String? in
        let id = notification.request.identifier
        guard id.hasPrefix(Self.requestPrefix) else { return nil }
        if let maxAge, now.timeIntervalSince(notification.date) < maxAge {
          return nil
        }
        return id
      }
      if !ids.isEmpty {
        center.removeDeliveredNotifications(withIdentifiers: ids)
      }
    }
    if maxAge == nil {
      center.getPendingNotificationRequests { pending in
        let ids = pending.map(\.identifier).filter { $0.hasPrefix(Self.requestPrefix) }
        if !ids.isEmpty {
          center.removePendingNotificationRequests(withIdentifiers: ids)
        }
      }
    }
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let userInfo = notification.request.content.userInfo
    if (userInfo["linkshellApproval"] as? Bool) == true ||
        notification.request.identifier.hasPrefix(Self.requestPrefix) {
      let notifSession = userInfo["sessionId"] as? String
      let notifComputer = userInfo["computerKey"] as? String
      if let active = currentActiveSession(), let notifSession, !notifSession.isEmpty {
        let matches = active == notifSession || (notifComputer != nil && active == "\(notifComputer!):\(notifSession)")
        if matches {
          // User is already looking at this exact session in the foreground: suppress redundant banner.
          completionHandler([])
          return
        }
      }
      if #available(iOS 14.0, *) {
        completionHandler([.banner, .list, .sound])
      } else {
        completionHandler([.alert, .sound])
      }
      return
    }
    if let previous = previousDelegate,
       previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
      previous.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
    } else {
      completionHandler([])
    }
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    let isOurs = (userInfo["linkshellApproval"] as? Bool) == true ||
      response.notification.request.identifier.hasPrefix(Self.requestPrefix)

    guard isOurs else {
      if let previous = previousDelegate,
         previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
        previous.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
      } else {
        completionHandler()
      }
      return
    }

    let resolved: (actionId: String, kind: String, optionId: String?)?
    switch response.actionIdentifier {
    case Self.allowActionIdentifier:
      resolved = ("approve", "approve", userInfo["approveOptionId"] as? String)
    case Self.denyActionIdentifier:
      resolved = ("deny", "deny", userInfo["denyOptionId"] as? String)
    case UNNotificationDefaultActionIdentifier:
      resolved = ("open", "open", nil)
    default:
      resolved = nil
    }

    if let resolved {
      let queuedId = LocalNotificationActionQueue.shared.enqueue(
        actionId: resolved.actionId,
        kind: resolved.kind,
        computerKey: userInfo["computerKey"] as? String,
        sessionId: userInfo["sessionId"] as? String,
        requestId: userInfo["requestId"] as? String,
        optionId: resolved.optionId,
        deepLink: userInfo["deepLink"] as? String
      )
      if resolved.kind == "approve" || resolved.kind == "deny" {
        LocalNotificationActionQueue.shared.beginBackgroundTask(for: queuedId)
      }
    }
    center.removeDeliveredNotifications(withIdentifiers: [response.notification.request.identifier])
    completionHandler()
  }

  @available(iOS 12.0, *)
  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    openSettingsFor notification: UNNotification?
  ) {
    if let previous = previousDelegate,
       previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:openSettingsFor:))) {
      previous.userNotificationCenter?(center, openSettingsFor: notification)
    }
  }
}
