import AppIntents
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

        // Enqueue action
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

        // Darwin notification to wake main app
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName("com.bd.linkshell.quickAction" as CFString),
            nil, nil, true
        )

        return .result()
    }
}
