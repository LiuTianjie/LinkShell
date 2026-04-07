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
                    let sessionsWithPerms = sessions.filter { $0.permissionRequest != nil }

                    if !sessionsWithPerms.isEmpty {
                        VStack(spacing: 4) {
                            ForEach(Array(sessionsWithPerms.prefix(2).enumerated()), id: \.offset) { _, s in
                                PermissionCardView(session: s, compact: true)
                            }
                            if sessionsWithPerms.count > 2 {
                                Text("+\(sessionsWithPerms.count - 2) 个终端待处理")
                                    .font(.system(size: 9))
                                    .foregroundColor(.white.opacity(0.4))
                            }
                        }
                    } else if let s = active {
                        VStack(spacing: 6) {
                            // Context lines
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

                            // Quick action list (non-permission)
                            if !s.quickActions.isEmpty {
                                QuickActionListView(
                                    actions: s.quickActions,
                                    sessionId: context.state.activeSessionId,
                                    terminalId: s.terminalId,
                                    provider: s.provider,
                                    fontSize: 13,
                                    iconSize: 16,
                                    vPadding: 8
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

// MARK: - Permission Card View

@available(iOS 16.2, *)
struct PermissionCardView: View {
    let session: SessionState
    let compact: Bool  // true = Dynamic Island (smaller), false = Lock Screen (larger)

    var body: some View {
        guard let pr = session.permissionRequest else { return AnyView(EmptyView()) }
        let contextLimit = compact ? 3 : 4
        let fontSize: CGFloat = compact ? 10 : 11
        let btnFontSize: CGFloat = compact ? 11 : 12

        return AnyView(
            VStack(spacing: 3) {
                // Header: tool name + project name
                HStack {
                    Image(systemName: "lock.shield")
                        .font(.system(size: fontSize))
                        .foregroundColor(.cyan)
                    Text(pr.toolName)
                        .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                        .foregroundColor(.cyan)
                        .lineLimit(1)
                    Spacer()
                    Text(session.projectName)
                        .font(.system(size: fontSize - 1))
                        .foregroundColor(.white.opacity(0.4))
                        .lineLimit(1)
                }

                // Context
                if !pr.contextLines.isEmpty {
                    Text(pr.contextLines)
                        .font(.system(size: fontSize - 1, design: .monospaced))
                        .foregroundColor(.white.opacity(0.6))
                        .lineLimit(contextLimit)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                // Action buttons + pending count
                HStack(spacing: 6) {
                    ForEach(Array(pr.quickActions.enumerated()), id: \.offset) { _, action in
                        actionButton(action: action, pr: pr, fontSize: btnFontSize)
                    }
                    Spacer()
                    if (session.pendingRequestCount ?? 0) > 1 {
                        Text("+\(session.pendingRequestCount! - 1) pending")
                            .font(.system(size: fontSize - 2))
                            .foregroundColor(.white.opacity(0.35))
                    }
                }
            }
            .padding(6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.white.opacity(0.06))
            )
        )
    }

    @ViewBuilder
    private func actionButton(action: QuickAction, pr: PermissionRequestState, fontSize: CGFloat) -> some View {
        let isAllow = action.label.lowercased().contains("allow") || action.label.lowercased().contains("yes") || action.label.lowercased().contains("approve")
        let color: Color = isAllow ? .green : .red.opacity(0.8)
        let icon = isAllow ? "checkmark.circle.fill" : "xmark.circle.fill"

        if #available(iOS 17.0, *) {
            Button(intent: QuickActionIntent(
                sessionId: session.sessionId,
                terminalId: session.terminalId,
                inputData: action.input,
                requestId: pr.requestId
            )) {
                HStack(spacing: 4) {
                    Image(systemName: icon)
                        .font(.system(size: fontSize))
                        .foregroundColor(color)
                    Text(action.label)
                        .font(.system(size: fontSize, weight: .medium))
                        .foregroundColor(.white)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(color.opacity(0.15))
            )
        } else {
            Link(destination: actionURL(session.sessionId, session.terminalId, action)) {
                HStack(spacing: 4) {
                    Image(systemName: icon)
                        .font(.system(size: fontSize))
                        .foregroundColor(color)
                    Text(action.label)
                        .font(.system(size: fontSize, weight: .medium))
                        .foregroundColor(.white)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
            }
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(color.opacity(0.15))
            )
        }
    }
}

// MARK: - Quick Action List (non-permission)

@available(iOS 16.2, *)
struct QuickActionListView: View {
    let actions: [QuickAction]
    let sessionId: String
    let terminalId: String
    let provider: String
    let fontSize: CGFloat
    let iconSize: CGFloat
    let vPadding: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(actions.enumerated()), id: \.offset) { idx, action in
                Link(destination: actionURL(sessionId, terminalId, action)) {
                    HStack {
                        Text(action.label)
                            .font(.system(size: fontSize, weight: .medium))
                            .foregroundColor(.white)
                        Spacer()
                        Image(systemName: action.needsInput ? "arrow.right.circle.fill" : "checkmark.circle.fill")
                            .font(.system(size: iconSize))
                            .foregroundColor(action.needsInput ? .orange : providerColor(provider))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, vPadding)
                }
                if idx < actions.count - 1 {
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

// MARK: - Lock Screen View

@available(iOS 16.2, *)
struct LockScreenView: View {
    let context: ActivityViewContext<LinkShellAttributes>

    var body: some View {
        let active = context.state.activeSession
        let sessions = context.state.sessions
        let sessionsWithPerms = sessions.filter { $0.permissionRequest != nil }

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

                        // Context or last line (only when no permission cards)
                        if sessionsWithPerms.isEmpty {
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
                    }

                    // Other sessions
                    if sessions.count > 1 && sessionsWithPerms.isEmpty {
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

            // Permission request cards
            if !sessionsWithPerms.isEmpty {
                VStack(spacing: 6) {
                    ForEach(Array(sessionsWithPerms.prefix(3).enumerated()), id: \.offset) { _, s in
                        PermissionCardView(session: s, compact: false)
                    }
                    if sessionsWithPerms.count > 3 {
                        Text("打开 App 查看其余 \(sessionsWithPerms.count - 3) 个")
                            .font(.system(size: 10))
                            .foregroundColor(.white.opacity(0.4))
                    }
                }
            } else if let s = active, !s.quickActions.isEmpty {
                // Non-permission quick actions
                QuickActionListView(
                    actions: s.quickActions,
                    sessionId: context.state.activeSessionId,
                    terminalId: s.terminalId,
                    provider: s.provider,
                    fontSize: 12,
                    iconSize: 14,
                    vPadding: 6
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
