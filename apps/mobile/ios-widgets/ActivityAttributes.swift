import ActivityKit
import WidgetKit
import SwiftUI

struct LinkShellAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var sessions: [SessionState]  // all active sessions
        var activeSessionId: String   // currently focused session
    }

    var startedAt: Date
}

struct SessionState: Codable, Hashable {
    var sessionId: String
    var terminalId: String
    var status: String        // "thinking", "waiting", "outputting", "idle"
    var lastLine: String      // last line of terminal output (truncated)
    var contextLines: String  // multi-line context for decision making
    var projectName: String
    var provider: String      // "claude", "codex", "custom"
    var quickActions: [QuickAction]
    var permissionRequest: PermissionRequestState?  // top of permission stack
    var pendingRequestCount: Int?  // total pending permissions in stack (incl. top)
    var tokensUsed: Int       // estimated tokens (from output length)
    var elapsedSeconds: Int   // seconds since session connected
}

struct PermissionRequestState: Codable, Hashable {
    var requestId: String       // unique ID for AppIntent
    var toolName: String        // "Bash", "Write", "Edit", etc.
    var contextLines: String    // permission request description
    var quickActions: [QuickAction]
}

struct QuickAction: Codable, Hashable {
    var label: String   // display text: "Yes", "No", "Continue"
    var input: String   // actual terminal input to send
    var needsInput: Bool // true = jump to app for user input, false = send in background
}
