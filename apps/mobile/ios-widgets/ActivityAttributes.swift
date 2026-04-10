import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - ActivityKit Attributes

struct LinkShellAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var sid: String
        var tid: String
        var phase: String         // "thinking" | "outputting" | "tool_use" | "waiting" | "idle" | "error"
        var project: String       // 项目名（截断 30 字符）
        var provider: String      // "claude" | "codex" | "gemini" | "copilot" | "custom"
        var tool: String          // 当前工具名，空串表示无
        var elapsed: Int          // 秒
        var hasPermission: Bool   // 是否有待处理权限
        var permCount: Int        // 当前终端待处理权限数
        var otherCount: Int       // 其他活跃终端数量
        var totalPermCount: Int   // 所有终端权限总数
    }
    var startedAt: Date
}

// MARK: - Extended Data (stored in UserDefaults, read by widget)

struct ExtendedActivityData: Codable {
    var sid: String
    var tid: String
    var toolDescription: String       // 工具描述（截断 500 字符）
    var contextLines: String          // 上下文（截断 500 字符）
    var permissionTool: String        // 权限请求的工具名
    var permissionContext: String     // 权限请求描述（截断 400 字符）
    var permissionRequestId: String   // 用于 AppIntent 去重
    var quickActions: [QuickAction]   // 最多 6 个
    var secondaryTerminals: [SecondaryTerminal]
}

struct SecondaryTerminal: Codable, Hashable {
    var sid: String
    var tid: String
    var provider: String
    var phase: String
    var hasPermission: Bool
}

struct QuickAction: Codable, Hashable {
    var label: String    // 按钮文本: "选择"
    var input: String    // 实际发送的终端输入
    var needsInput: Bool // true = 跳转 app, false = 后台发送
    var desc: String?    // 左侧描述文字
}

// MARK: - UserDefaults Helpers

enum LiveActivityStore {
    static let suiteName = "group.com.bd.linkshell"
    static let extendedDataKey = "liveActivityExtended"
    static let pendingActionsKey = "pendingActions"
    static let processedActionsKey = "processedActions"

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
