import ActivityKit
import AppIntents

@available(iOS 17.0, *)
struct LinkShellActivityBrowseIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "切换实时活动中的任务"
  static var isDiscoverable: Bool = false
  static var openAppWhenRun: Bool = false
  static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  @Parameter(title: "实时活动") var activityID: String
  @Parameter(title: "方向") var direction: Int

  init() {}
  init(activityID: String, direction: Int) {
    self.activityID = activityID
    self.direction = direction
  }

  func perform() async throws -> some IntentResult {
    guard let activity = Activity<LinkShellAttentionAttributes>.activities.first(where: { $0.id == activityID }),
          activity.activityState == .active || activity.activityState == .stale,
          let tasks = activity.content.state.tasks, tasks.count > 1 else { return .result() }
    var state = activity.content.state
    let current = state.selectedIndex(activityID: activityID) ?? (direction < 0 ? 0 : -1)
    let next = (current + (direction < 0 ? tasks.count - 1 : 1)) % tasks.count
    LiveActivityBrowsing.select(activityID: activityID, taskKey: tasks[next].selectionKey, noticeID: state.noticeId)
    state.selectionVersion = UUID().uuidString
    // Presentation changes neither perform a task action nor manufacture fresh
    // host data. The shared selection survives ordinary background pushes.
    await activity.update(ActivityContent(state: state, staleDate: nil, relevanceScore: activity.content.relevanceScore))
    return .result()
  }
}
