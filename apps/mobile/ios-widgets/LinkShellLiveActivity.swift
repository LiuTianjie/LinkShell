import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - Widget Entry

@available(iOS 16.2, *)
struct LinkShellLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LinkShellAttributes.self) { context in
            LockScreenView(context: context)
        } dynamicIsland: { context in
            let active = context.state.activeSnapshot
            let all = context.state.snapshots
            let ext = LiveActivityStore.readExtendedData()
            let activeExt = active.flatMap { ext[$0.sid] }
            let otherCount = all.count - 1

            return DynamicIsland {
                // ── Expanded Leading ──
                DynamicIslandExpandedRegion(.leading) {
                    if let s = active {
                        HStack(spacing: 5) {
                            ProviderLogo(provider: s.provider, size: 16)
                            Text(s.project)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                        }
                    }
                }

                // ── Expanded Trailing ──
                DynamicIslandExpandedRegion(.trailing) {
                    if let s = active {
                        HStack(spacing: 6) {
                            PhasePill(phase: s.phase)
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

                // ── Expanded Center ──
                DynamicIslandExpandedRegion(.center) {
                    if let s = active {
                        HStack(spacing: 6) {
                            if !s.tool.isEmpty {
                                ToolBadge(name: s.tool, fontSize: 10)
                            }
                            Text(formatElapsed(s.elapsed))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.white.opacity(0.4))
                        }
                    }
                }

                // ── Expanded Bottom ──
                DynamicIslandExpandedRegion(.bottom) {
                    if let s = active {
                        if s.hasPermission, let ae = activeExt, !ae.permissionTool.isEmpty {
                            // Permission card
                            PermissionCard(
                                snapshot: s,
                                ext: ae,
                                compact: true
                            )
                        } else {
                            VStack(spacing: 4) {
                                // Tool description or context
                                if let ae = activeExt, !ae.toolDescription.isEmpty {
                                    Text(ae.toolDescription)
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundColor(.white.opacity(0.6))
                                        .lineLimit(3)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(6)
                                        .background(
                                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                                .fill(.white.opacity(0.05))
                                        )
                                }

                                // Other sessions
                                if otherCount > 0 {
                                    OtherSessionsBar(
                                        snapshots: all,
                                        excludeSid: s.sid,
                                        maxShow: 3
                                    )
                                }
                            }
                        }
                    }
                }
            } compactLeading: {
                if let s = active {
                    ProviderLogo(provider: s.provider, size: 18)
                }
            } compactTrailing: {
                if let s = active {
                    HStack(spacing: 3) {
                        PhaseDot(phase: s.phase, size: 6)
                        if !s.tool.isEmpty {
                            Text(s.tool.prefix(4))
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundColor(.white.opacity(0.7))
                                .lineLimit(1)
                        } else {
                            Text("\(all.count)")
                                .font(.system(size: 12, weight: .semibold, design: .rounded))
                                .foregroundColor(.white)
                                .contentTransition(.numericText())
                        }
                    }
                }
            } minimal: {
                if let s = active {
                    ZStack {
                        ProviderLogo(provider: s.provider, size: 14)
                        Circle()
                            .strokeBorder(phaseColor(s.phase), lineWidth: 1.5)
                            .frame(width: 20, height: 20)
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
        let active = context.state.activeSnapshot
        let all = context.state.snapshots
        let ext = LiveActivityStore.readExtendedData()
        let activeExt = active.flatMap { ext[$0.sid] }
        let permSessions = all.filter { $0.hasPermission }

        VStack(spacing: 8) {
            // Header row
            HStack(spacing: 12) {
                if let s = active {
                    // Provider badge
                    ZStack {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(providerColor(s.provider).opacity(0.15))
                            .frame(width: 40, height: 40)
                        ProviderLogo(provider: s.provider, size: 24)
                        if all.count > 1 {
                            Text("\(all.count)")
                                .font(.system(size: 9, weight: .bold, design: .rounded))
                                .foregroundColor(.white)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.blue))
                                .offset(x: 14, y: -14)
                        }
                    }

                    VStack(alignment: .leading, spacing: 3) {
                        // Project + phase + elapsed
                        HStack(spacing: 6) {
                            Text(s.project)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                            PhasePill(phase: s.phase)
                            Spacer()
                            Text(formatElapsed(s.elapsed))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(.white.opacity(0.4))
                        }

                        // Tool + description
                        if !s.tool.isEmpty {
                            HStack(spacing: 4) {
                                ToolBadge(name: s.tool, fontSize: 10)
                                if let ae = activeExt, !ae.toolDescription.isEmpty {
                                    Text(ae.toolDescription)
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundColor(.white.opacity(0.5))
                                        .lineLimit(1)
                                }
                            }
                        } else if let ae = activeExt, !ae.contextLines.isEmpty, permSessions.isEmpty {
                            Text(ae.contextLines)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.white.opacity(0.5))
                                .lineLimit(1)
                        }
                    }
                }
            }

            // Permission cards
            if !permSessions.isEmpty {
                VStack(spacing: 6) {
                    ForEach(Array(permSessions.prefix(2).enumerated()), id: \.offset) { _, s in
                        if let e = ext[s.sid] {
                            PermissionCard(snapshot: s, ext: e, compact: false)
                        }
                    }
                    if permSessions.count > 2 {
                        Text("还有 \(permSessions.count - 2) 个待处理")
                            .font(.system(size: 10))
                            .foregroundColor(.white.opacity(0.4))
                    }
                }
            } else if let ae = activeExt, !ae.quickActions.isEmpty, let s = active {
                // Quick actions
                QuickActionList(
                    actions: ae.quickActions,
                    sessionId: s.sid,
                    terminalId: s.tid,
                    fontSize: 12,
                    vPadding: 6
                )
            }

            // Other sessions bar
            if all.count > 1, permSessions.isEmpty, let s = active {
                OtherSessionsBar(snapshots: all, excludeSid: s.sid, maxShow: 3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.black.opacity(0.85))
    }
}

// MARK: - Permission Card

@available(iOS 16.2, *)
struct PermissionCard: View {
    let snapshot: SessionSnapshot
    let ext: ExtendedSessionData
    let compact: Bool

    var body: some View {
        let contextLimit = compact ? 2 : 3
        let fontSize: CGFloat = compact ? 10 : 11
        let btnFontSize: CGFloat = compact ? 11 : 12

        VStack(spacing: 4) {
            // Header
            HStack {
                Image(systemName: "lock.shield")
                    .font(.system(size: fontSize))
                    .foregroundColor(.cyan)
                Text(ext.permissionTool)
                    .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                    .foregroundColor(.cyan)
                    .lineLimit(1)
                Spacer()
                Text(snapshot.project)
                    .font(.system(size: fontSize - 1))
                    .foregroundColor(.white.opacity(0.4))
                    .lineLimit(1)
            }

            // Context
            if !ext.permissionContext.isEmpty {
                Text(ext.permissionContext)
                    .font(.system(size: fontSize - 1, design: .monospaced))
                    .foregroundColor(.white.opacity(0.6))
                    .lineLimit(contextLimit)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Action buttons
            HStack(spacing: 6) {
                ForEach(Array(ext.quickActions.enumerated()), id: \.offset) { _, action in
                    ActionButton(
                        action: action,
                        snapshot: snapshot,
                        requestId: ext.permissionRequestId,
                        fontSize: btnFontSize
                    )
                }
                Spacer()
                if snapshot.permCount > 1 {
                    Text("+\(snapshot.permCount - 1) 待处理")
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
    }
}

// MARK: - Action Button

@available(iOS 16.2, *)
struct ActionButton: View {
    let action: QuickAction
    let snapshot: SessionSnapshot
    let requestId: String
    let fontSize: CGFloat

    private var isAllow: Bool {
        let l = action.label.lowercased()
        return l.contains("允许") || l.contains("allow") || l.contains("yes") || l.contains("approve")
    }

    private var color: Color { isAllow ? .green : .red.opacity(0.8) }
    private var icon: String { isAllow ? "checkmark.circle.fill" : "xmark.circle.fill" }

    var body: some View {
        if #available(iOS 17.0, *) {
            Button(intent: QuickActionIntent(
                sessionId: snapshot.sid,
                terminalId: snapshot.tid,
                inputData: action.input,
                requestId: requestId
            )) {
                buttonLabel
            }
            .buttonStyle(.plain)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(color.opacity(0.15))
            )
        } else {
            Link(destination: actionURL(snapshot.sid, snapshot.tid, action)) {
                buttonLabel
            }
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(color.opacity(0.15))
            )
        }
    }

    private var buttonLabel: some View {
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
}

// MARK: - Quick Action List

@available(iOS 16.2, *)
struct QuickActionList: View {
    let actions: [QuickAction]
    let sessionId: String
    let terminalId: String
    let fontSize: CGFloat
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
                            .font(.system(size: fontSize + 2))
                            .foregroundColor(action.needsInput ? .orange : .green)
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

// MARK: - Shared Components

@available(iOS 16.2, *)
struct ProviderLogo: View {
    let provider: String
    let size: CGFloat

    var body: some View {
        Group {
            if provider == "claude" {
                Image("claudecode-logo")
                    .resizable()
                    .renderingMode(.original)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else if provider == "codex" {
                Image("codex-logo")
                    .resizable()
                    .renderingMode(.original)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else if provider == "gemini" {
                Image("gemini-logo")
                    .resizable()
                    .renderingMode(.original)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else if provider == "copilot" {
                Image("copilot-logo")
                    .resizable()
                    .renderingMode(.original)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
                Image(systemName: "terminal.fill")
                    .font(.system(size: size * 0.5, weight: .bold))
                    .foregroundColor(providerColor("custom"))
            }
        }
        .contentTransition(.interpolate)
    }
}

@available(iOS 16.2, *)
struct PhasePill: View {
    let phase: String

    var body: some View {
        let (text, color) = phaseDisplay(phase)
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(color.opacity(0.15))
            )
    }
}

@available(iOS 16.2, *)
struct PhaseDot: View {
    let phase: String
    let size: CGFloat

    var body: some View {
        Circle()
            .fill(phaseColor(phase))
            .frame(width: size, height: size)
    }
}

@available(iOS 16.2, *)
struct ToolBadge: View {
    let name: String
    let fontSize: CGFloat

    var body: some View {
        Text(name)
            .font(.system(size: fontSize, weight: .medium, design: .monospaced))
            .foregroundColor(.cyan)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(.cyan.opacity(0.12))
            )
    }
}

@available(iOS 16.2, *)
struct OtherSessionsBar: View {
    let snapshots: [SessionSnapshot]
    let excludeSid: String
    let maxShow: Int

    var body: some View {
        let others = snapshots.filter { $0.sid != excludeSid }
        HStack(spacing: 8) {
            ForEach(Array(others.prefix(maxShow).enumerated()), id: \.offset) { _, s in
                HStack(spacing: 3) {
                    PhaseDot(phase: s.phase, size: 5)
                    Text(s.project)
                        .font(.system(size: 10))
                        .foregroundColor(.white.opacity(0.5))
                        .lineLimit(1)
                }
            }
            if others.count > maxShow {
                Text("+\(others.count - maxShow)")
                    .font(.system(size: 9))
                    .foregroundColor(.white.opacity(0.35))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Helpers

@available(iOS 16.2, *)
extension LinkShellAttributes.ContentState {
    var activeSnapshot: SessionSnapshot? {
        snapshots.first { $0.sid == activeSessionId } ?? snapshots.first
    }
}

func actionURL(_ sessionId: String, _ terminalId: String, _ action: QuickAction) -> URL {
    let bg = action.needsInput ? "" : "&bg=1"
    let encoded = action.input.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
    return URL(string: "linkshell://input?session=\(sessionId)&terminal=\(terminalId)&data=\(encoded)\(bg)")!
}

func providerColor(_ provider: String) -> Color {
    switch provider {
    case "claude": return Color(red: 0.82, green: 0.58, blue: 0.35)
    case "codex": return Color(red: 0.4, green: 0.8, blue: 0.6)
    case "gemini": return Color(red: 0.53, green: 0.55, blue: 1.0)
    case "copilot": return Color(red: 0.9, green: 0.35, blue: 0.55)
    default: return Color(red: 0.68, green: 0.78, blue: 1.0)
    }
}

func phaseColor(_ phase: String) -> Color {
    switch phase {
    case "thinking": return .yellow
    case "outputting": return .green
    case "tool_use": return .cyan
    case "waiting": return .orange
    case "error": return .red
    default: return .gray
    }
}

func phaseDisplay(_ phase: String) -> (String, Color) {
    switch phase {
    case "thinking": return ("思考中", .yellow)
    case "outputting": return ("输出中", .green)
    case "tool_use": return ("执行工具", .cyan)
    case "waiting": return ("等待输入", .orange)
    case "error": return ("出错", .red)
    default: return ("空闲", .gray)
    }
}

func formatElapsed(_ seconds: Int) -> String {
    let m = seconds / 60
    let s = seconds % 60
    if m > 0 { return String(format: "%d:%02d", m, s) }
    return "\(s)s"
}
