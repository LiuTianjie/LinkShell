import AppIntents
import ActivityKit
import Foundation

@available(iOS 17.0, *)
struct QuickActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Respond to Agent Permission"
    static var description = IntentDescription("Respond to a LinkShell Agent permission request")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Action Kind")
    var kind: String

    @Parameter(title: "Session ID")
    var sessionId: String

    @Parameter(title: "Conversation ID")
    var conversationId: String

    @Parameter(title: "Request ID")
    var requestId: String

    @Parameter(title: "Outcome")
    var outcome: String

    @Parameter(title: "Option ID")
    var optionId: String

    init() {}

    init(
        kind: String = "agent_permission",
        sessionId: String,
        conversationId: String,
        requestId: String,
        outcome: String,
        optionId: String = ""
    ) {
        self.kind = kind
        self.sessionId = sessionId
        self.conversationId = conversationId
        self.requestId = requestId
        self.outcome = outcome
        self.optionId = optionId
    }

    func perform() async throws -> some IntentResult {
        guard let defaults = LiveActivityStore.defaults else {
            return .result()
        }

        // Enqueue action for main app
        var queue = defaults.array(forKey: LiveActivityStore.pendingActionsKey) as? [[String: String]] ?? []
        queue.append([
            "actionId": UUID().uuidString,
            "kind": kind,
            "sessionId": sessionId,
            "conversationId": conversationId,
            "requestId": requestId,
            "outcome": outcome,
            "optionId": optionId,
            "timestamp": "\(Date().timeIntervalSince1970)",
        ])
        defaults.set(queue, forKey: LiveActivityStore.pendingActionsKey)
        defaults.synchronize()

        // Optimistic update: clear permission from extended data
        if !requestId.isEmpty, var ext = LiveActivityStore.readExtendedData(), ext.permissionRequestId == requestId {
            ext.permissionTitle = ""
            ext.currentToolName = ""
            ext.currentToolInput = ""
            ext.permissionContext = ""
            ext.permissionRequestId = ""
            ext.permissionOptions = []
            LiveActivityStore.writeExtendedData(ext)
        }

        // Optimistic update: show the Agent as running again.
        for activity in Activity<LinkShellAttributes>.activities {
            var state = activity.content.state
            if state.conversationId == conversationId {
                state.status = "running"
                state.phaseLabel = "运行中"
                if !requestId.isEmpty {
                    state.hasPermission = false
                    state.permissionCount = max(0, state.permissionCount - 1)
                }
            }
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }

        // Darwin notification to wake main app
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName("com.bd.linkshell.quickAction" as CFString),
            nil, nil, true
        )

        return .result()
    }
}
