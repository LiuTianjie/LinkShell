import AppIntents
import ActivityKit
import Foundation

@available(iOS 17.0, *)
struct QuickActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Respond to Agent Permission"
    static var description = IntentDescription("Respond to a LinkShell Agent permission request")
    static var openAppWhenRun: Bool = false

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
        guard let extended = LiveActivityStore.readExtendedData() else {
            NSLog("[LiveActivityAction] intent no extended data sessionId=%@ conversationId=%@ requestId=%@ outcome=%@", sessionId, conversationId, requestId, outcome)
            return .result()
        }
        if !extended.permissionRequestId.isEmpty && extended.permissionRequestId != requestId {
            NSLog("[LiveActivityAction] stale intent requestId=%@ current=%@ sessionId=%@ conversationId=%@", requestId, extended.permissionRequestId, sessionId, conversationId)
            await markPermissionStale(currentRequestId: extended.permissionRequestId)
            return .result()
        }

        let result = await sendPermissionResponse(extended: extended)
        guard result.ok else {
            NSLog("[LiveActivityAction] gateway respond failed sessionId=%@ conversationId=%@ requestId=%@ outcome=%@ protocol=%@ status=%d error=%@", sessionId, conversationId, requestId, outcome, extended.permissionProtocol ?? "v2", result.status, result.message)
            await markPermissionResponseFailed()
            return .result()
        }

        NSLog("[LiveActivityAction] gateway respond ok sessionId=%@ conversationId=%@ requestId=%@ outcome=%@ protocol=%@", sessionId, conversationId, requestId, outcome, extended.permissionProtocol ?? "v2")
        clearStoredPermission(extended: extended)

        var updatedCount = 0
        for activity in Activity<LinkShellAttributes>.activities {
            var state = activity.content.state
            if state.sessionId == sessionId || state.conversationId == conversationId {
                state.status = "running"
                state.phaseLabel = "运行中"
                state.hasPermission = false
                state.permissionCount = 0
                state.updatedAt = Date().timeIntervalSince1970 * 1000
                await activity.update(ActivityContent(state: state, staleDate: nil))
                updatedCount += 1
            }
        }
        NSLog("[LiveActivityAction] cleared delivered live activity permission sessionId=%@ conversationId=%@ requestId=%@ updated=%d", sessionId, conversationId, requestId, updatedCount)

        return .result()
    }

    private func markPermissionStale(currentRequestId: String) async {
        var updatedCount = 0
        for activity in Activity<LinkShellAttributes>.activities {
            var state = activity.content.state
            if state.sessionId == sessionId || state.conversationId == conversationId {
                state.phaseLabel = "授权已更新，请重新选择"
                state.updatedAt = Date().timeIntervalSince1970 * 1000
                await activity.update(ActivityContent(state: state, staleDate: nil))
                updatedCount += 1
            }
        }
        NSLog("[LiveActivityAction] refreshed stale live activity requestId=%@ current=%@ updated=%d", requestId, currentRequestId, updatedCount)
    }

    private func markPermissionResponseFailed() async {
        var updatedCount = 0
        for activity in Activity<LinkShellAttributes>.activities {
            var state = activity.content.state
            if state.sessionId == sessionId || state.conversationId == conversationId {
                state.status = "error"
                state.phaseLabel = "授权未送达，请回 App 查看"
                state.summary = "授权未送达，请回 App 查看"
                state.hasPermission = false
                state.permissionCount = 0
                state.updatedAt = Date().timeIntervalSince1970 * 1000
                await activity.update(ActivityContent(state: state, staleDate: nil))
                updatedCount += 1
            }
        }
        NSLog("[LiveActivityAction] marked failed live activity response sessionId=%@ conversationId=%@ requestId=%@ updated=%d", sessionId, conversationId, requestId, updatedCount)
    }

    private func clearStoredPermission(extended: ExtendedActivityData) {
        guard !requestId.isEmpty else { return }
        var ext = LiveActivityStore.readExtendedData() ?? extended
        guard ext.permissionRequestId == requestId || ext.conversationId == conversationId else {
            NSLog("[LiveActivityAction] skip clearing stored permission requestId=%@ current=%@ conversationId=%@ currentConversationId=%@", requestId, ext.permissionRequestId, conversationId, ext.conversationId)
            return
        }
        ext.permissionTitle = ""
        ext.currentToolName = ""
        ext.currentToolInput = ""
        ext.permissionContext = ""
        ext.permissionRequestId = ""
        ext.permissionOptions = []
        LiveActivityStore.writeExtendedData(ext)
    }

    private func sendPermissionResponse(extended: ExtendedActivityData) async -> (ok: Bool, status: Int, message: String) {
        guard let gatewayUrl = extended.gatewayUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !gatewayUrl.isEmpty else {
            return (false, 0, "missing_gateway_url")
        }
        guard let deviceToken = extended.deviceToken?.trimmingCharacters(in: .whitespacesAndNewlines),
              !deviceToken.isEmpty else {
            return (false, 0, "missing_device_token")
        }

        let base = gatewayUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/agent/permission/respond") else {
            return (false, 0, "invalid_gateway_url")
        }

        let protocolName = normalizedProtocol(extended.permissionProtocol)
        var body: [String: Any] = [
            "sessionId": sessionId,
            "requestId": requestId,
            "outcome": outcome,
            "protocol": protocolName,
        ]
        if !optionId.isEmpty {
            body["optionId"] = optionId
        }

        switch protocolName {
        case "legacy":
            if let agentSessionId = extended.agentSessionId, !agentSessionId.isEmpty {
                body["agentSessionId"] = agentSessionId
            }
        case "terminal":
            if let terminalId = extended.terminalId, !terminalId.isEmpty {
                body["terminalId"] = terminalId
            }
        default:
            body["conversationId"] = conversationId
        }

        do {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) {
                return (true, status, "")
            }
            let text = String(data: data, encoding: .utf8) ?? ""
            return (false, status, text)
        } catch {
            return (false, 0, String(describing: error))
        }
    }

    private func normalizedProtocol(_ raw: String?) -> String {
        switch raw?.lowercased() {
        case "legacy":
            return "legacy"
        case "terminal":
            return "terminal"
        default:
            return "v2"
        }
    }
}
