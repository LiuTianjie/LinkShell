import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - ActivityKit Attributes

struct LinkShellAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var terminals: [TerminalSnapshot]
        var focusedSid: String
        var focusedTid: String
    }
    var startedAt: Date
}

// MARK: - Compact Snapshot (fits in 4KB ContentState, ~120 bytes each)

struct TerminalSnapshot: Codable, Hashable {
    var sid: String           // session ID
    var tid: String           // terminal ID
    var phase: String         // "thinking" | "outputting" | "tool_use" | "waiting" | "idle" | "error"
    var project: String       // 项目名（截断 20 字符）
    var provider: String      // "claude" | "codex" | "gemini" | "copilot" | "custom"
    var tool: String          // 当前工具名，空串表示无
    var elapsed: Int          // 秒
    var hasPermission: Bool   // 是否有待处理权限
    var permCount: Int        // 待处理权限总数
}

// MARK: - Extended Data (stored in UserDefaults, read by widget)
// Keyed by "sid:tid" composite key

struct ExtendedTerminalData: Codable {
    var sid: String
    var tid: String
    var toolDescription: String       // 工具描述（截断 200 字符）
    var contextLines: String          // 上下文（截断 300 字符）
    var permissionTool: String        // 权限请求的工具名
    var permissionContext: String     // 权限请求描述（截断 200 字符）
    var permissionRequestId: String   // 用于 AppIntent 去重
    var quickActions: [QuickAction]
}

struct QuickAction: Codable, Hashable {
    var label: String    // 显示文本: "允许", "本次允许", "拒绝"
    var input: String    // 实际发送的终端输入
    var needsInput: Bool // true = 跳转 app, false = 后台发送
    var desc: String?    // 可选描述，如 "本会话内不再询问"
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

    static func writeExtendedData(_ data: [ExtendedTerminalData]) {
        guard let defaults = defaults,
              let json = try? JSONEncoder().encode(data) else { return }
        defaults.set(json, forKey: extendedDataKey)
        defaults.synchronize()
    }

    /// Read extended data keyed by "sid:tid"
    static func readExtendedData() -> [String: ExtendedTerminalData] {
        guard let defaults = defaults,
              let data = defaults.data(forKey: extendedDataKey),
              let list = try? JSONDecoder().decode([ExtendedTerminalData].self, from: data)
        else { return [:] }
        return Dictionary(uniqueKeysWithValues: list.map { ("\($0.sid):\($0.tid)", $0) })
    }
}
