import ActivityKit
import Foundation

public struct LiveActivityTask: Codable, Hashable {
  public var id: String
  public var kind: String
  public var phase: String
  public var title: String
  public var subtitle: String
  public var project: String
  public var agent: String
  public var selectionKey: String { kind + ":" + id }
}

@available(iOS 16.2, *)
public struct LinkShellAttentionAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var phase: String
    public var title: String
    public var subtitle: String
    public var project: String
    public var agent: String
    public var agents: [String]?
    public var actions: [LiveActivityAction]?
    public var hasMoreActions: Bool?
    public var tasks: [LiveActivityTask]?
    public var noticeId: String?
    public var selectionVersion: String?
    public var remotePending: Bool?
    public var waitingCount: Int
    public var runningCount: Int
    public var failedCount: Int
    public var deepLink: String

    public var workloadKey: String {
      // Progress text changes frequently; dismissing a card suppresses this
      // workload until its membership or attention state changes.
      let entries = tasks?.map { $0.selectionKey + ":" + $0.phase }.sorted() ?? [deepLink + ":" + phase]
      return (try? String(data: JSONEncoder().encode(entries), encoding: .utf8)) ?? ""
    }

    public func selectedIndex(activityID: String) -> Int? {
      guard let tasks, !tasks.isEmpty else { return nil }
      if let key = LiveActivityBrowsing.selection(activityID: activityID, noticeID: noticeId),
         let index = tasks.firstIndex(where: { $0.selectionKey == key }) { return index }
      let query = URLComponents(string: deepLink)?.queryItems ?? []
      if let index = tasks.firstIndex(where: { task in query.contains(where: { $0.name == task.kind && $0.value == task.id }) }) { return index }
      return nil
    }

    public func displayingSelection(activityID: String, computerKey: String?) -> Self {
      guard let index = selectedIndex(activityID: activityID), let task = tasks?[index] else { return self }
      var display = self
      let link = LiveActivityBrowsing.detailLink(computerKey: computerKey, task: task)
      // Buttons belong to the exact request that produced the original card.
      // Browsing another task offers its detail route, never another task's approval.
      let query = URLComponents(string: deepLink)?.queryItems ?? []
      let featured = query.contains(where: { $0.name == task.kind && $0.value == task.id })
      if featured { return self }
      if !featured {
        display.actions = []
        display.hasMoreActions = task.phase == "waiting_for_input" || task.phase == "waiting_for_approval"
      }
      display.phase = task.phase
      display.title = task.title
      display.subtitle = task.subtitle
      display.project = task.project
      display.agent = task.agent
      display.deepLink = link
      return display
    }
  }
  public var computerName: String
  public var computerKey: String?
  public var remoteUpdates: Bool?
}

public enum LiveActivityBrowsing {
  private struct Selection: Codable {
    var taskKey: String
    var noticeID: String
    var expiresAt: TimeInterval
  }

  private static var defaults: UserDefaults {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "LinkShellLiveActivityAppGroup") as? String,
          let defaults = UserDefaults(suiteName: group) else { return .standard }
    return defaults
  }

  public static func selection(activityID: String, noticeID: String?) -> String? {
    guard let data = defaults.data(forKey: "activity.selection." + activityID),
          let selection = try? JSONDecoder().decode(Selection.self, from: data),
          selection.noticeID == (noticeID ?? ""), selection.expiresAt > Date().timeIntervalSince1970 else { return nil }
    return selection.taskKey
  }

  public static func select(activityID: String, taskKey: String, noticeID: String?) {
    let value = Selection(taskKey: taskKey, noticeID: noticeID ?? "", expiresAt: Date().addingTimeInterval(600).timeIntervalSince1970)
    defaults.set(try? JSONEncoder().encode(value), forKey: "activity.selection." + activityID)
  }

  public static func clear(activityID: String) { defaults.removeObject(forKey: "activity.selection." + activityID) }

  public static func detailLink(computerKey: String?, task: LiveActivityTask) -> String {
    var url = URLComponents()
    url.scheme = "linkshell"
    url.host = ""
    url.path = "/activity"
    url.queryItems = [URLQueryItem(name: "computer", value: computerKey ?? ""), URLQueryItem(name: task.kind, value: task.id)]
    return url.string ?? "linkshell:///"
  }
}
