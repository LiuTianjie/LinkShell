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
                            ProviderLogoView(provider: s.provider, status: s.status, size: 16)
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
                    if let s = active {
                        Text(formatElapsed(s.elapsedSeconds))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.white.opacity(0.4))
                    }
                }

                // ── Expanded: Bottom ──
                DynamicIslandExpandedRegion(.bottom) {
                    if let s = active {
                        VStack(spacing: 6) {
                            // Context lines (what Claude is asking)
                            if !s.contextLines.isEmpty {
                                Text(s.contextLines)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(.white.opacity(0.6))
                                    .lineLimit(4)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 4)
                                    .background(
                                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                                            .fill(.white.opacity(0.05))
                                    )
                            } else if !s.lastLine.isEmpty {
                                Text(s.lastLine)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(.white.opacity(0.7))
                                    .lineLimit(2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 4)
                            }

                            // Quick action list
                            if !s.quickActions.isEmpty {
                                VStack(spacing: 0) {
                                    ForEach(Array(s.quickActions.enumerated()), id: \.offset) { idx, action in
                                        Link(destination: actionURL(context.state.activeSessionId, s.terminalId, action)) {
                                            HStack {
                                                Text(action.label)
                                                    .font(.system(size: 13, weight: .medium))
                                                    .foregroundColor(.white)
                                                Spacer()
                                                Image(systemName: action.needsInput ? "arrow.right.circle.fill" : "checkmark.circle.fill")
                                                    .font(.system(size: 16))
                                                    .foregroundColor(action.needsInput ? .orange : providerColor(s.provider))
                                            }
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 8)
                                        }
                                        if idx < s.quickActions.count - 1 {
                                            Divider().background(.white.opacity(0.1))
                                        }
                                    }
                                }
                                .background(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .fill(.white.opacity(0.08))
                                )
                            }

                            // Other sessions summary
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
                }
            } compactLeading: {
                if let s = active {
                    ProviderLogoView(provider: s.provider, status: s.status, size: 18)
                }
            } compactTrailing: {
                if let s = active {
                    HStack(spacing: 3) {
                        Circle()
                            .fill(statusColor(s.status))
                            .frame(width: 6, height: 6)
                        Text("\(sessions.count)")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundColor(.white)
                            .contentTransition(.numericText())
                    }
                }
            } minimal: {
                if let s = active {
                    ProviderLogoView(provider: s.provider, status: s.status, size: 14)
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

        VStack(spacing: 8) {
            HStack(spacing: 12) {
                // Provider icon badge
                if let s = active {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(providerColor(s.provider).opacity(0.15))
                            .frame(width: 40, height: 40)
                        ProviderLogoView(provider: s.provider, status: s.status, size: 24)
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

                        // Context or last line
                        if !s.contextLines.isEmpty {
                            Text(s.contextLines)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.white.opacity(0.6))
                                .lineLimit(2)
                        } else if !s.lastLine.isEmpty {
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
            }

            // Quick actions as list
            if let s = active, !s.quickActions.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(s.quickActions.enumerated()), id: \.offset) { idx, action in
                        Link(destination: actionURL(context.state.activeSessionId, s.terminalId, action)) {
                            HStack {
                                Text(action.label)
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundColor(.white)
                                Spacer()
                                Image(systemName: action.needsInput ? "arrow.right.circle.fill" : "checkmark.circle.fill")
                                    .font(.system(size: 14))
                                    .foregroundColor(action.needsInput ? .orange : providerColor(s.provider))
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                        }
                        if idx < s.quickActions.count - 1 {
                            Divider().background(.white.opacity(0.1))
                        }
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(.white.opacity(0.08))
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.black.opacity(0.85))
    }
}

// MARK: - Claude Sparkle Logo (SwiftUI Path)

@available(iOS 16.1, *)
struct ClaudeSparkleShape: Shape {
    func path(in rect: CGRect) -> Path {
        // Claude's sparkle/star logo: a 4-pointed star with rounded tips
        let cx = rect.midX
        let cy = rect.midY
        let outer = min(rect.width, rect.height) / 2
        let inner = outer * 0.28

        var path = Path()
        let points = 4
        for i in 0..<(points * 2) {
            let angle = (Double(i) * .pi / Double(points)) - .pi / 2
            let r = i % 2 == 0 ? outer : inner
            let x = cx + CGFloat(cos(angle)) * r
            let y = cy + CGFloat(sin(angle)) * r
            if i == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        path.closeSubpath()
        return path
    }
}

@available(iOS 16.1, *)
struct ProviderLogoView: View {
    let provider: String
    let status: String
    let size: CGFloat

    var body: some View {
        ZStack {
            if provider == "claude" {
                ClaudeSparkleShape()
                    .fill(providerColor("claude"))
                    .frame(width: size, height: size)
            } else if provider == "codex" {
                Text("</>")
                    .font(.system(size: size * 0.45, weight: .bold, design: .monospaced))
                    .foregroundColor(providerColor("codex"))
            } else {
                Image(systemName: "terminal.fill")
                    .font(.system(size: size * 0.5, weight: .bold))
                    .foregroundColor(providerColor("custom"))
            }
        }
        .contentTransition(.interpolate)
    }
}

// MARK: - Helpers

@available(iOS 16.1, *)
extension LinkShellAttributes.ContentState {
    var activeSession: SessionState? {
        sessions.first { $0.sessionId == activeSessionId } ?? sessions.first
    }
}

func actionURL(_ sessionId: String, _ terminalId: String, _ action: QuickAction) -> URL {
    let bg = action.needsInput ? "" : "&bg=1"
    return URL(string: "linkshell://input?session=\(sessionId)&terminal=\(terminalId)&data=\(action.input.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")\(bg)")!
}

@available(iOS 16.1, *)
func providerIcon(_ provider: String) -> Image {
    switch provider {
    case "claude": return Image(systemName: "brain.head.profile.fill")
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
    case "thinking": return "◐"
    case "outputting": return "▸"
    case "waiting": return "◉"
    case "tool_use": return "⚙"
    case "error": return "✕"
    default: return "○"
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
