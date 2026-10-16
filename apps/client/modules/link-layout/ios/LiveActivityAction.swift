import Foundation

public struct LiveActivityAction: Codable, Hashable, Identifiable {
  public var id: String
  public var label: String
  public var role: String
  public var kind: String
  public var computerKey: String
  public var sessionId: String
  public var requestId: String
  public var optionId: String
  public var questionId: String?
}

/// Only App Intents write this queue; an externally opened URL cannot create a choice.
public enum LiveActivityActionQueue {
  public static let notification = Notification.Name("LinkShellLiveActivityAction")
  private static let prefix = "LinkShellLiveActivity.selection."
  private static let lifetime: TimeInterval = 120
  private static let lock = NSLock()

  private struct Entry: Codable {
    let createdAt: TimeInterval
    let action: LiveActivityAction
  }

  public static func enqueue(_ action: LiveActivityAction, defaults: UserDefaults = .standard, now: Date = Date()) throws -> String {
    lock.lock()
    defer { lock.unlock() }
    let pending = pendingEntries(defaults: defaults, now: now)
    // Repeated taps before the app opens refer to the same selected request.
    if let existing = pending.first(where: { $0.1.action.computerKey == action.computerKey && $0.1.action.sessionId == action.sessionId && $0.1.action.requestId == action.requestId }) {
      return String(existing.0.dropFirst(prefix.count))
    }
    for (key, _) in pending.sorted(by: { $0.1.createdAt > $1.1.createdAt }).dropFirst(15) { defaults.removeObject(forKey: key) }
    let id = UUID().uuidString
    let entry = Entry(createdAt: now.timeIntervalSince1970, action: action)
    defaults.set(try JSONEncoder().encode(entry), forKey: prefix + id)
    return id
  }

  public static func pendingID(defaults: UserDefaults = .standard, now: Date = Date()) -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard let newest = pendingEntries(defaults: defaults, now: now).max(by: { $0.1.createdAt < $1.1.createdAt }) else { return nil }
    return String(newest.0.dropFirst(prefix.count))
  }

  public static func consume(_ id: String, defaults: UserDefaults = .standard, now: Date = Date()) -> LiveActivityAction? {
    lock.lock()
    defer { lock.unlock() }
    guard UUID(uuidString: id) != nil, let data = defaults.data(forKey: prefix + id) else { return nil }
    defaults.removeObject(forKey: prefix + id)
    guard let entry = try? JSONDecoder().decode(Entry.self, from: data),
          (0..<lifetime).contains(now.timeIntervalSince1970 - entry.createdAt) else { return nil }
    return entry.action
  }

  private static func pendingEntries(defaults: UserDefaults, now: Date) -> [(String, Entry)] {
    defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(prefix) }.compactMap { key in
      guard let data = defaults.data(forKey: key), let entry = try? JSONDecoder().decode(Entry.self, from: data),
            (0..<lifetime).contains(now.timeIntervalSince1970 - entry.createdAt) else {
        defaults.removeObject(forKey: key)
        return nil
      }
      return (key, entry)
    }
  }
}
