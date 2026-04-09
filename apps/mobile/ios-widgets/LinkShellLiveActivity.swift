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
            let focused = context.state.focusedTerminal
            let all = context.state.terminals
            let ext = LiveActivityStore.readExtendedData()
            let focusedExt = focused.flatMap { ext["\($0.sid):\($0.tid)"] }
            let otherCount = all.count - 1

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    if let t = focused {
                        HStack(spacing: 5) {
                            ProviderLogo(provider: t.provider, size: 16)
                            Text(t.project)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                        }
                    }
                }

                DynamicIslandExpandedRegion(.trailing) {
                    if let t = focused {
                        HStack(spacing: 6) {
                            PhasePill(phase: t.phase)
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

                DynamicIslandExpandedRegion(.center) {
                    if let t = focused {
                        HStack(spacing: 6) {
                            if !t.tool.isEmpty {
                                ToolBadge(name: t.tool, fontSize: 10)
                            }
                            Text(formatElapsed(t.elapsed))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.white.opacity(0.4))
                        }
                    }
                }

                DynamicIslandExpandedRegion(.bottom) {
                    if let t = focused {
                        if t.hasPermission, let fe = focusedExt, !fe.permissionTool.isEmpty {
                            // Compact permission: tool name + inline action buttons
                            CompactPermission(terminal: t, ext: fe)
                        } else if let fe = focusedExt, !fe.toolDescription.isEmpty {
                            Text(fe.toolDescription)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.white.opacity(0.6))
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(4)
                                .background(
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .fill(.white.opacity(0.05))
                                )
                        }
                    }
                }
            } compactLeading: {
                if let t = focused {
                    ProviderLogo(provider: t.provider, size: 18)
                }
            } compactTrailing: {
                if let t = focused {
                    HStack(spacing: 3) {
                        PhaseDot(phase: t.phase, size: 6)
                        if t.hasPermission {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.system(size: 10))
                                .foregroundColor(.orange)
                        } else if !t.tool.isEmpty {
                            Text(t.tool.prefix(4))
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
                if let t = focused {
                    ZStack {
                        ProviderLogo(provider: t.provider, size: 14)
                        Circle()
                            .strokeBorder(phaseColor(t.phase), lineWidth: 1.5)
                            .frame(width: 20, height: 20)
                    }
                }
            }
        }
    }
}

// MARK: - Compact Permission (for Dynamic Island expanded)

@available(iOS 16.2, *)
struct CompactPermission: View {
    let terminal: TerminalSnapshot
    let ext: ExtendedTerminalData

    var body: some View {
        VStack(spacing: 3) {
            // Tool name + context in one line
            HStack(spacing: 4) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 9))
                    .foregroundColor(.cyan)
                Text(ext.permissionTool)
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundColor(.cyan)
                    .lineLimit(1)
                if !ext.permissionContext.isEmpty {
                    Text(ext.permissionContext)
                        .font(.system(size: 8, design: .monospaced))
                        .foregroundColor(.white.opacity(0.5))
                        .lineLimit(1)
                }
                Spacer()
            }

            // Horizontal action buttons (compact)
            HStack(spacing: 4) {
                ForEach(Array(ext.quickActions.enumerated()), id: \.offset) { _, action in
                    ActionChip(action: action, terminal: terminal, requestId: ext.permissionRequestId)
                }
                if terminal.permCount > 1 {
                    Text("+\(terminal.permCount - 1)")
                        .font(.system(size: 8))
                        .foregroundColor(.white.opacity(0.35))
                }
            }
        }
    }
}

// MARK: - Action Chip (compact horizontal button)

@available(iOS 16.2, *)
struct ActionChip: View {
    let action: QuickAction
    let terminal: TerminalSnapshot
    let requestId: String

    private var isAllow: Bool {
        let l = action.label.lowercased()
        return l.contains("允许") || l.contains("allow") || l.contains("yes")
    }
    private var isDeny: Bool {
        let l = action.label.lowercased()
        return l.contains("拒绝") || l.contains("deny") || l.contains("no")
    }
    private var color: Color {
        if isDeny { return .red.opacity(0.8) }
        if isAllow { return .green }
        return .blue
    }

    var body: some View {
        if #available(iOS 17.0, *) {
            Button(intent: QuickActionIntent(
                sessionId: terminal.sid,
                terminalId: terminal.tid,
                inputData: action.input,
                requestId: requestId
            )) {
                chipLabel
            }
            .buttonStyle(.plain)
        } else {
            Link(destination: actionURL(terminal.sid, terminal.tid, action)) {
                chipLabel
            }
        }
    }

    private var chipLabel: some View {
        Text(action.label)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(color.opacity(0.2))
            )
    }
}

// MARK: - Terminal Card (per-terminal)

@available(iOS 16.2, *)
struct TerminalCard: View {
    let terminal: TerminalSnapshot
    let ext: ExtendedTerminalData?
    let isFocused: Bool

    var body: some View {
        VStack(spacing: 4) {
            // Header: logo + project + phase + elapsed
            HStack(spacing: 6) {
                ProviderLogo(provider: terminal.provider, size: 16)
                Text(terminal.project)
                    .font(.system(size: 12, weight: isFocused ? .semibold : .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)
                PhasePill(phase: terminal.phase)
                Spacer()
                Text(formatElapsed(terminal.elapsed))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.white.opacity(0.35))
            }

            // Tool info (when not waiting for permission)
            if !terminal.hasPermission {
                if !terminal.tool.isEmpty {
                    HStack(spacing: 4) {
                        ToolBadge(name: terminal.tool, fontSize: 9)
                        if let e = ext, !e.toolDescription.isEmpty {
                            Text(e.toolDescription)
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundColor(.white.opacity(0.45))
                                .lineLimit(1)
                        }
                        Spacer()
                    }
                } else if let e = ext, !e.contextLines.isEmpty {
                    Text(e.contextLines)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundColor(.white.opacity(0.4))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            // Permission actions (inline)
            if terminal.hasPermission, let e = ext, !e.permissionTool.isEmpty {
                VStack(spacing: 2) {
                    HStack(spacing: 4) {
                        Image(systemName: "lock.shield")
                            .font(.system(size: 9))
                            .foregroundColor(.cyan)
                        Text(e.permissionTool)
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundColor(.cyan)
                            .lineLimit(1)
                        if !e.permissionContext.isEmpty {
                            Text(e.permissionContext)
                                .font(.system(size: 8, design: .monospaced))
                                .foregroundColor(.white.opacity(0.4))
                                .lineLimit(1)
                        }
                        Spacer()
                        if terminal.permCount > 1 {
                            Text("+\(terminal.permCount - 1)")
                                .font(.system(size: 8))
                                .foregroundColor(.white.opacity(0.3))
                        }
                    }
                    HStack(spacing: 4) {
                        ForEach(Array(e.quickActions.prefix(2).enumerated()), id: \.offset) { _, action in
                            ActionChip(action: action, terminal: terminal, requestId: e.permissionRequestId)
                        }
                        Spacer()
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isFocused ? .white.opacity(0.08) : .white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(
                    terminal.hasPermission ? .orange.opacity(0.4) : .clear,
                    lineWidth: 0.5
                )
        )
    }
}

// MARK: - Lock Screen View

@available(iOS 16.2, *)
struct LockScreenView: View {
    let context: ActivityViewContext<LinkShellAttributes>

    var body: some View {
        let all = context.state.terminals
        let ext = LiveActivityStore.readExtendedData()
        let focusedSid = context.state.focusedSid
        let focusedTid = context.state.focusedTid

        VStack(spacing: 4) {
            ForEach(Array(all.prefix(4).enumerated()), id: \.offset) { _, t in
                let e = ext["\(t.sid):\(t.tid)"]
                let isFocused = t.sid == focusedSid && t.tid == focusedTid
                TerminalCard(terminal: t, ext: e, isFocused: isFocused)
            }
            if all.count > 4 {
                Text("还有 \(all.count - 4) 个终端")
                    .font(.system(size: 9))
                    .foregroundColor(.white.opacity(0.35))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.black.opacity(0.85))
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
            .font(.system(size: 9, weight: .medium))
            .foregroundColor(color)
            .padding(.horizontal, 5)
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
        Circle().fill(phaseColor(phase)).frame(width: size, height: size)
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
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(.cyan.opacity(0.12))
            )
    }
}

// MARK: - Helpers

@available(iOS 16.2, *)
extension LinkShellAttributes.ContentState {
    var focusedTerminal: TerminalSnapshot? {
        terminals.first { $0.sid == focusedSid && $0.tid == focusedTid } ?? terminals.first
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
