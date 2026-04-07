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
        let defaults = UserDefaults(suiteName: "group.com.bd.linkshell")!
        var queue = defaults.array(forKey: "pendingActions") as? [[String: String]] ?? []
        queue.append([
            "sessionId": sessionId,
            "terminalId": terminalId,
            "input": inputData,
            "requestId": requestId,
            "timestamp": "\(Date().timeIntervalSince1970)",
        ])
        defaults.set(queue, forKey: "pendingActions")
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
