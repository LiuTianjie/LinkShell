import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - ActivityKit Attributes

struct LinkShellAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var conversationId: String
        var sessionId: String
        var provider: String
        var project: String
        var status: String          // "idle" | "running" | "waiting_permission" | "error"
        var phaseLabel: String
        var summary: String
        var hasPermission: Bool
        var permissionCount: Int
        var updatedAt: Double
    }

    var startedAt: Date
}

// MARK: - Extended Data (stored in UserDefaults, read by widget)

struct ExtendedActivityData: Codable {
    var conversationId: String
    var gatewayUrl: String?
    var deviceToken: String?
    var permissionProtocol: String?
    var terminalId: String?
    var agentSessionId: String?
    var permissionRequestId: String
    var permissionTitle: String
    var permissionContext: String
    var permissionOptions: [AgentPermissionOption]
    var currentToolName: String
    var currentToolInput: String
    var deepLink: String
}

struct AgentPermissionOption: Codable, Hashable {
    var id: String
    var label: String
    var kind: String?
}

// MARK: - UserDefaults Helpers

enum LiveActivityStore {
    static let suiteName = "group.com.bd.linkshell"
    static let extendedDataKey = "liveActivityExtended"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: suiteName)
    }

    static func writeExtendedData(_ data: ExtendedActivityData) {
        guard let defaults = defaults,
              let json = try? JSONEncoder().encode(data) else { return }
        defaults.set(json, forKey: extendedDataKey)
        defaults.synchronize()
    }

    static func readExtendedData() -> ExtendedActivityData? {
        guard let defaults = defaults,
              let data = defaults.data(forKey: extendedDataKey),
              let result = try? JSONDecoder().decode(ExtendedActivityData.self, from: data)
        else { return nil }
        return result
    }
}
