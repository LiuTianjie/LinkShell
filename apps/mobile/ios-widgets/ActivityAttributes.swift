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
    var status: String        // "thinking", "waiting", "outputting", "idle"
    var lastLine: String      // last line of terminal output (truncated)
    var projectName: String
    var provider: String      // "claude", "codex", "custom"
    var quickActions: [QuickAction]
    var tokensUsed: Int       // estimated tokens (from output length)
    var elapsedSeconds: Int   // seconds since session connected
}

struct QuickAction: Codable, Hashable {
    var label: String   // display text: "Yes", "No", "Continue"
    var input: String   // actual terminal input to send
}
