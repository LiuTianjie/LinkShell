import AppIntents

@available(iOS 17.0, *)
struct LinkShellActivityActionIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "处理 Agent 请求"
  static var isDiscoverable: Bool = false
  static var openAppWhenRun: Bool = true
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "选中的操作") var selection: String

  init() {}

  init(action: LiveActivityAction) {
    selection = (try? String(data: JSONEncoder().encode(action), encoding: .utf8)) ?? ""
  }

  func perform() async throws -> some IntentResult {
    let action = try JSONDecoder().decode(LiveActivityAction.self, from: Data(selection.utf8))
    // LiveActivityIntent runs in the app process. The app reconnects through its
    // existing encrypted transport and checks the request before submitting.
    let id = try LiveActivityActionQueue.enqueue(action)
    NotificationCenter.default.post(name: LiveActivityActionQueue.notification, object: nil, userInfo: ["id": id])
    return .result()
  }
}
