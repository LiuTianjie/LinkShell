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

        let actionId = UUID().uuidString

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
            "actionId": actionId,
            "sessionId": sessionId,
            "terminalId": terminalId,
            "input": inputData,
            "requestId": requestId,
            "timestamp": "\(Date().timeIntervalSince1970)",
        ])
        defaults.set(queue, forKey: LiveActivityStore.pendingActionsKey)
        defaults.synchronize()

        // Optimistic update: clear permission from extended data
        let key = "\(sessionId):\(terminalId)"
        var extMap = LiveActivityStore.readExtendedData()
        if var ext = extMap[key] {
            ext.permissionTool = ""
            ext.permissionContext = ""
            ext.permissionRequestId = ""
            ext.quickActions = []
            extMap[key] = ext
            LiveActivityStore.writeExtendedData(Array(extMap.values))
        }

        // Optimistic update: set phase to "thinking" in ContentState
        if #available(iOS 16.2, *) {
            for activity in Activity<LinkShellAttributes>.activities {
                var terminals = activity.content.state.terminals
                if let idx = terminals.firstIndex(where: { $0.sid == sessionId && $0.tid == terminalId }) {
                    terminals[idx].phase = "thinking"
                    terminals[idx].hasPermission = false
                    terminals[idx].permCount = max(0, terminals[idx].permCount - 1)
                }
                let newState = LinkShellAttributes.ContentState(
                    terminals: terminals,
                    focusedSid: activity.content.state.focusedSid,
                    focusedTid: activity.content.state.focusedTid
                )
                await activity.update(ActivityContent(state: newState, staleDate: nil))
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
