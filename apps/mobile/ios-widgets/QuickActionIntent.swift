import AppIntents
import ActivityKit
import Foundation

@available(iOS 17.0, *)
struct QuickActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Execute Quick Action"
    static var description = IntentDescription("Send input to a LinkShell terminal session")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Session ID")
    var sessionId: String

    @Parameter(title: "Terminal ID")
    var terminalId: String

    @Parameter(title: "Input Data")
    var inputData: String

    @Parameter(title: "Request ID")
    var requestId: String

    init() {}

    init(sessionId: String, terminalId: String, inputData: String, requestId: String) {
        self.sessionId = sessionId
        self.terminalId = terminalId
        self.inputData = inputData
        self.requestId = requestId
    }

    func perform() async throws -> some IntentResult {
        guard let defaults = LiveActivityStore.defaults else {
            return .result()
        }

        // Dedup: check if this requestId was already processed
        var processed = defaults.array(forKey: LiveActivityStore.processedActionsKey) as? [String] ?? []
        if processed.contains(requestId) {
            return .result()
        }

        // Mark as processed (keep last 50)
        processed.append(requestId)
        if processed.count > 50 { processed = Array(processed.suffix(50)) }
        defaults.set(processed, forKey: LiveActivityStore.processedActionsKey)

        // Enqueue action for main app
        var queue = defaults.array(forKey: LiveActivityStore.pendingActionsKey) as? [[String: String]] ?? []
        queue.append([
            "actionId": UUID().uuidString,
            "sessionId": sessionId,
            "terminalId": terminalId,
            "input": inputData,
            "requestId": requestId,
            "timestamp": "\(Date().timeIntervalSince1970)",
        ])
        defaults.set(queue, forKey: LiveActivityStore.pendingActionsKey)
        defaults.synchronize()

        // Optimistic update: clear permission from extended data
        if var ext = LiveActivityStore.readExtendedData(), ext.permissionRequestId == requestId {
            ext.permissionTool = ""
            ext.permissionContext = ""
            ext.permissionRequestId = ""
            ext.quickActions = []
            LiveActivityStore.writeExtendedData(ext)
        }

        // Optimistic update: set phase to "thinking" in ContentState
        if #available(iOS 16.2, *) {
            for activity in Activity<LinkShellAttributes>.activities {
                var state = activity.content.state
                if state.sid == sessionId && state.tid == terminalId {
                    state.phase = "thinking"
                    state.hasPermission = false
                    state.permCount = max(0, state.permCount - 1)
                    state.totalPermCount = max(0, state.totalPermCount - 1)
                }
                await activity.update(ActivityContent(state: state, staleDate: nil))
            }
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
