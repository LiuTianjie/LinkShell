import ActivityKit
import WidgetKit
import SwiftUI

@available(iOS 16.2, *)
struct LinkShellLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LinkShellAttributes.self) { context in
            LockScreenView(context: context)
        } dynamicIsland: { context in
            let active = context.state.activeSession
            let sessions = context.state.sessions
            let otherCount = sessions.count - 1

            return DynamicIsland {
                // ── Expanded: Leading ──
                DynamicIslandExpandedRegion(.leading) {
                    if let s = active {
                        HStack(spacing: 5) {
                            providerIcon(s.provider)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(providerColor(s.provider))
                            Text(s.projectName)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                        }
                    }
                }

                // ── Expanded: Trailing ──
                DynamicIslandExpandedRegion(.trailing) {
                    if let s = active {
                        HStack(spacing: 6) {
                            statusPill(s.status)
                            if otherCount > 0 {
                                Text("+\(otherCount)")
                                    .font(.system(size: 10, weight: .bold, design: .rounded))
                                    .foregroundColor(.white.opacity(0.5))
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(
                                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                                            .fill(.white.opacity(0.1))
                                    )
                            }
                        }
                    }
                }

                // ── Expanded: Center (below notch) ──
                DynamicIslandExpandedRegion(.center) {
                    // Show elapsed time
                    if let s = active {
                        Text(formatElapsed(s.elapsedSeconds))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.white.opacity(0.4))
                    }
                }

                // ── Expanded: Bottom ──
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        // Last output line
                        if let s = active, !s.lastLine.isEmpty {
                            Text(s.lastLine)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(.white.opacity(0.7))
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 4)
                        }

                        // Quick actions
                        if let s = active, !s.quickActions.isEmpty {
                            HStack(spacing: 8) {
                                ForEach(s.quickActions, id: \.self) { action in
                                    Link(destination: inputURL(context.state.activeSessionId, action.input)) {
                                        Text(action.label)
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundColor(.white)
                                            .padding(.horizontal, 16)
                                            .padding(.vertical, 6)
                                            .background(
                                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                                    .fill(providerColor(active?.provider ?? "claude").opacity(0.3))
                                            )
                                    }
                                }
                            }
                        }

                        // Other sessions summary (if multiple)
                        if otherCount > 0 {
                            HStack(spacing: 6) {
                                ForEach(sessions.filter { $0.sessionId != context.state.activeSessionId }.prefix(3), id: \.self) { s in
                                    HStack(spacing: 3) {
                                        statusDot(s.status)
                                        Text(s.projectName)
                                            .font(.system(size: 10))
                                            .foregroundColor(.white.opacity(0.5))
                                            .lineLimit(1)
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                        }
                    }
                }
            } compactLeading: {
                // Provider icon with status ring
                if let s = active {
                    ZStack {
                        Circle()
                            .stroke(statusColor(s.status), lineWidth: 1.5)
                            .frame(width: 18, height: 18)
                        providerIcon(s.provider)
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(providerColor(s.provider))
                    }
                }
            } compactTrailing: {
                // Status text + session count
                if let s = active {
                    HStack(spacing: 3) {
                        Text(statusEmoji(s.status))
                            .font(.system(size: 10))
                        if otherCount > 0 {
                            Text("·\(sessions.count)")
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                                .foregroundColor(.white.opacity(0.5))
                        }
                    }
                }
            } minimal: {
                if let s = active {
                    ZStack {
                        Circle()
                            .stroke(statusColor(s.status), lineWidth: 1.5)
                            .frame(width: 16, height: 16)
                        providerIcon(s.provider)
                            .font(.system(size: 8, weight: .bold))
                            .foregroundColor(providerColor(s.provider))
                    }
                }
            }
        }
    }
}

// MARK: - Lock Screen View

@available(iOS 16.2, *)
struct LockScreenView: View {
    let context: ActivityViewContext<LinkShellAttributes>

    var body: some View {
        let active = context.state.activeSession
        let sessions = context.state.sessions

        HStack(spacing: 12) {
            // Provider icon badge
            if let s = active {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(providerColor(s.provider).opacity(0.15))
                        .frame(width: 40, height: 40)
                    providerIcon(s.provider)
                        .font(.system(size: 18, weight: .bold))
                        .foregroundColor(providerColor(s.provider))
                    // Session count badge
                    if sessions.count > 1 {
                        Text("\(sessions.count)")
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .foregroundColor(.white)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.blue))
                            .offset(x: 14, y: -14)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                // Project name + status
                if let s = active {
                    HStack(spacing: 6) {
                        Text(s.projectName)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        statusPill(s.status)
                        Spacer()
                        Text(formatElapsed(s.elapsedSeconds))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.white.opacity(0.4))
                    }

                    // Last line
                    if !s.lastLine.isEmpty {
                        Text(s.lastLine)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.white.opacity(0.6))
                            .lineLimit(1)
                    }
                }

                // Other sessions
                if sessions.count > 1 {
                    HStack(spacing: 8) {
                        ForEach(sessions.filter { $0.sessionId != context.state.activeSessionId }.prefix(3), id: \.self) { s in
                            HStack(spacing: 3) {
                                statusDot(s.status)
                                Text(s.projectName)
                                    .font(.system(size: 10))
                                    .foregroundColor(.white.opacity(0.5))
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }

            // Quick actions
            if let s = active, !s.quickActions.isEmpty {
                VStack(spacing: 4) {
                    ForEach(s.quickActions.prefix(2), id: \.self) { action in
                        Link(destination: inputURL(context.state.activeSessionId, action.input)) {
                            Text(action.label)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .fill(providerColor(s.provider).opacity(0.3))
                                )
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.black.opacity(0.85))
    }
}

// MARK: - Helpers

@available(iOS 16.1, *)
extension LinkShellAttributes.ContentState {
    var activeSession: SessionState? {
        sessions.first { $0.sessionId == activeSessionId } ?? sessions.first
    }
}

func inputURL(_ sessionId: String, _ data: String) -> URL {
    URL(string: "linkshell://input?session=\(sessionId)&data=\(data.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")")!
}

@available(iOS 16.1, *)
func providerIcon(_ provider: String) -> Image {
    switch provider {
    case "claude": return Image(systemName: "sparkle")
    case "codex": return Image(systemName: "chevron.left.forwardslash.chevron.right")
    default: return Image(systemName: "terminal.fill")
    }
}

@available(iOS 16.1, *)
func providerColor(_ provider: String) -> Color {
    switch provider {
    case "claude": return Color(red: 0.82, green: 0.58, blue: 0.35)
    case "codex": return Color(red: 0.4, green: 0.8, blue: 0.6)
    default: return Color(red: 0.68, green: 0.78, blue: 1.0)
    }
}

func statusColor(_ status: String) -> Color {
    switch status {
    case "thinking": return .yellow
    case "outputting": return .green
    case "waiting": return .orange
    case "tool_use": return .cyan
    case "error": return .red
    default: return .gray
    }
}

func statusEmoji(_ status: String) -> String {
    switch status {
    case "thinking": return "🧠"
    case "outputting": return "📝"
    case "waiting": return "⏳"
    case "tool_use": return "🔧"
    case "error": return "❗"
    default: return "💤"
    }
}

@available(iOS 16.1, *)
func statusDot(_ status: String) -> some View {
    Circle()
        .fill(statusColor(status))
        .frame(width: 6, height: 6)
}

@available(iOS 16.1, *)
func statusPill(_ status: String) -> some View {
    let (text, color): (String, Color) = {
        switch status {
        case "thinking": return ("思考中", .yellow)
        case "outputting": return ("输出中", .green)
        case "waiting": return ("等待输入", .orange)
        case "tool_use": return ("执行工具", .cyan)
        case "error": return ("出错", .red)
        default: return ("空闲", .gray)
        }
    }()

    return Text(text)
        .font(.system(size: 10, weight: .medium))
        .foregroundColor(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(color.opacity(0.15))
        )
}

func formatElapsed(_ seconds: Int) -> String {
    let m = seconds / 60
    let s = seconds % 60
    if m > 0 {
        return String(format: "%d:%02d", m, s)
    }
    return "\(s)s"
}
