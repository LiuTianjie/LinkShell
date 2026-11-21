import Foundation
import UserNotifications

/// Persists iOS local approval notification actions so cold-start taps survive app launch until
/// JS calls `pendingNotificationActionId` + `consumeNotificationAction`.
final class LocalNotificationActionQueue {
  static let shared = LocalNotificationActionQueue()
  static let notification = Notification.Name("LinkShellLocalNotificationAction")
  private static let storageKey = "linkshell.localNotificationActions"
  private static let maxItems = 32

  private let lock = NSLock()
  private let defaults: UserDefaults

  private init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
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
    var item: [String: Any] = [
      "id": id,
      "actionId": actionId,
      "kind": kind,
      "createdAt": Date().timeIntervalSince1970 * 1000.0,
    ]
    if let computerKey, !computerKey.isEmpty { item["computerKey"] = computerKey }
    if let sessionId, !sessionId.isEmpty { item["sessionId"] = sessionId }
    if let requestId, !requestId.isEmpty { item["requestId"] = requestId }
    if let optionId, !optionId.isEmpty { item["optionId"] = optionId }
    if let deepLink, !deepLink.isEmpty { item["deepLink"] = deepLink }

    lock.lock()
    var queue = defaults.array(forKey: Self.storageKey) as? [[String: Any]] ?? []
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
    lock.lock()
    defer { lock.unlock() }
    let queue = defaults.array(forKey: Self.storageKey) as? [[String: Any]] ?? []
    return queue.first?["id"] as? String
  }

  func consume(id: String) -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    var queue = defaults.array(forKey: Self.storageKey) as? [[String: Any]] ?? []
    guard let index = queue.firstIndex(where: { ($0["id"] as? String) == id }) else {
      return nil
    }
    let item = queue.remove(at: index)
    defaults.set(queue, forKey: Self.storageKey)
    return item
  }
}

/// Manages the local actionable `UNUserNotificationCenter` approval fallback (`LINKSHELL_APPROVAL`),
/// chaining onto any existing notification center delegate rather than replacing push handlers.
final class LocalApprovalNotifications: NSObject, UNUserNotificationCenterDelegate {
  static let shared = LocalApprovalNotifications()
  static let categoryIdentifier = "LINKSHELL_APPROVAL"
  static let allowActionIdentifier = "LINKSHELL_APPROVAL_ALLOW"
  static let denyActionIdentifier = "LINKSHELL_APPROVAL_DENY"
  private static let requestPrefix = "linkshell-local-approval-"

  private weak var previousDelegate: UNUserNotificationCenterDelegate?
  private var installed = false

  func install() {
    let center = UNUserNotificationCenter.current()
    registerCategory(on: center)
    if let existing = center.delegate, existing !== self {
      previousDelegate = existing
    }
    if center.delegate !== self {
      center.delegate = self
    }
    installed = true
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

  func sync(payload: [String: Any], completion: @escaping (Bool) -> Void) {
    if !installed {
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
    UNUserNotificationCenter.current().add(request) { error in
      completion(error == nil)
    }
  }

  func cancel(id: String) {
    guard !id.isEmpty else { return }
    let requestId = Self.requestPrefix + id
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [requestId])
    center.removeDeliveredNotifications(withIdentifiers: [requestId])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let userInfo = notification.request.content.userInfo
    if (userInfo["linkshellApproval"] as? Bool) == true ||
        notification.request.identifier.hasPrefix(Self.requestPrefix) {
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

  func userNotificationCenter(
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
      LocalNotificationActionQueue.shared.enqueue(
        actionId: resolved.actionId,
        kind: resolved.kind,
        computerKey: userInfo["computerKey"] as? String,
        sessionId: userInfo["sessionId"] as? String,
        requestId: userInfo["requestId"] as? String,
        optionId: resolved.optionId,
        deepLink: userInfo["deepLink"] as? String
      )
    }
    center.removeDeliveredNotifications(withIdentifiers: [response.notification.request.identifier])
    completionHandler()
  }

  @available(iOS 12.0, *)
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    openSettingsFor notification: UNNotification?
  ) {
    if let previous = previousDelegate,
       previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:openSettingsFor:))) {
      previous.userNotificationCenter?(center, openSettingsFor: notification)
    }
  }
}
