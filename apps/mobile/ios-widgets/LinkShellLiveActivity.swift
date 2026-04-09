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
                // ── Expanded Leading ──
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

                // ── Expanded Trailing ──
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

                // ── Expanded Center ──
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

                // ── Expanded Bottom ──
                DynamicIslandExpandedRegion(.bottom) {
                    if let t = focused {
                        if t.hasPermission, let fe = focusedExt, !fe.permissionTool.isEmpty {
                            PermissionCard(terminal: t, ext: fe, compact: true)
                        } else {
                            VStack(spacing: 4) {
                                if let fe = focusedExt, !fe.toolDescription.isEmpty {
                                    Text(fe.toolDescription)
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
                                if otherCount > 0 {
                                    OtherTerminalsBar(terminals: all, focusedSid: t.sid, focusedTid: t.tid, maxShow: 3)
                                }
                            }
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
                        if !t.tool.isEmpty {
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

// MARK: - Lock Screen View

@available(iOS 16.2, *)
struct LockScreenView: View {
    let context: ActivityViewContext<LinkShellAttributes>

    var body: some View {
        let focused = context.state.focusedTerminal
        let all = context.state.terminals
        let ext = LiveActivityStore.readExtendedData()
        let focusedExt = focused.flatMap { ext["\($0.sid):\($0.tid)"] }
        let permTerminals = all.filter { $0.hasPermission }

        VStack(spacing: 8) {
            // Header row
            HStack(spacing: 12) {
                if let t = focused {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(providerColor(t.provider).opacity(0.15))
                            .frame(width: 40, height: 40)
                        ProviderLogo(provider: t.provider, size: 24)
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
                        HStack(spacing: 6) {
                            Text(t.project)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                            PhasePill(phase: t.phase)
                            Spacer()
                            Text(formatElapsed(t.elapsed))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(.white.opacity(0.4))
                        }

                        if !t.tool.isEmpty {
                            HStack(spacing: 4) {
                                ToolBadge(name: t.tool, fontSize: 10)
                                if let fe = focusedExt, !fe.toolDescription.isEmpty {
                                    Text(fe.toolDescription)
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundColor(.white.opacity(0.5))
                                        .lineLimit(1)
                                }
                            }
                        } else if let fe = focusedExt, !fe.contextLines.isEmpty, permTerminals.isEmpty {
                            Text(fe.contextLines)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.white.opacity(0.5))
                                .lineLimit(1)
                        }
                    }
                }
            }

            // Permission cards (list style)
            if !permTerminals.isEmpty {
                VStack(spacing: 6) {
                    ForEach(Array(permTerminals.prefix(2).enumerated()), id: \.offset) { _, t in
                        if let e = ext["\(t.sid):\(t.tid)"] {
                            PermissionCard(terminal: t, ext: e, compact: false)
                        }
                    }
                    if permTerminals.count > 2 {
                        Text("还有 \(permTerminals.count - 2) 个待处理")
                            .font(.system(size: 10))
                            .foregroundColor(.white.opacity(0.4))
                    }
                }
            }

            // Other terminals bar
            if all.count > 1, permTerminals.isEmpty, let t = focused {
                OtherTerminalsBar(terminals: all, focusedSid: t.sid, focusedTid: t.tid, maxShow: 3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.black.opacity(0.85))
    }
}

// MARK: - Permission Card (List Style)

@available(iOS 16.2, *)
struct PermissionCard: View {
    let terminal: TerminalSnapshot
    let ext: ExtendedTerminalData
    let compact: Bool

    var body: some View {
        let fontSize: CGFloat = compact ? 10 : 11

        VStack(spacing: 4) {
            // Header: tool name + context
            HStack {
                Image(systemName: "lock.shield")
                    .font(.system(size: fontSize))
                    .foregroundColor(.cyan)
                Text(ext.permissionTool)
                    .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                    .foregroundColor(.cyan)
                    .lineLimit(1)
                Spacer()
                Text(terminal.project)
                    .font(.system(size: fontSize - 1))
                    .foregroundColor(.white.opacity(0.4))
                    .lineLimit(1)
            }

            if !ext.permissionContext.isEmpty {
                Text(ext.permissionContext)
                    .font(.system(size: fontSize - 1, design: .monospaced))
                    .foregroundColor(.white.opacity(0.6))
                    .lineLimit(compact ? 2 : 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Action list (vertical)
            VStack(spacing: 0) {
                ForEach(Array(ext.quickActions.enumerated()), id: \.offset) { idx, action in
                    ActionRow(
                        action: action,
                        terminal: terminal,
                        requestId: ext.permissionRequestId,
                        fontSize: fontSize
                    )
                    if idx < ext.quickActions.count - 1 {
                        Divider().background(.white.opacity(0.1))
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(.white.opacity(0.06))
            )

            if terminal.permCount > 1 {
                Text("+\(terminal.permCount - 1) 待处理")
                    .font(.system(size: fontSize - 2))
                    .foregroundColor(.white.opacity(0.35))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(.white.opacity(0.06))
        )
    }
}

// MARK: - Action Row (List Item)

@available(iOS 16.2, *)
struct ActionRow: View {
    let action: QuickAction
    let terminal: TerminalSnapshot
    let requestId: String
    let fontSize: CGFloat

    private var isAllow: Bool {
        let l = action.label.lowercased()
        return l.contains("允许") || l.contains("allow") || l.contains("yes") || l.contains("approve")
    }

    private var isDeny: Bool {
        let l = action.label.lowercased()
        return l.contains("拒绝") || l.contains("deny") || l.contains("no") || l.contains("reject")
    }

    private var color: Color {
        if isDeny { return .red.opacity(0.8) }
        if isAllow { return .green }
        return .blue
    }

    private var icon: String {
        if isDeny { return "xmark.circle.fill" }
        if isAllow { return "checkmark.circle.fill" }
        return "arrow.right.circle.fill"
    }

    var body: some View {
        if #available(iOS 17.0, *) {
            Button(intent: QuickActionIntent(
                sessionId: terminal.sid,
                terminalId: terminal.tid,
                inputData: action.input,
                requestId: requestId
            )) {
                rowContent
            }
            .buttonStyle(.plain)
        } else {
            Link(destination: actionURL(terminal.sid, terminal.tid, action)) {
                rowContent
            }
        }
    }

    private var rowContent: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: fontSize + 1))
                .foregroundColor(color)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(action.label)
                    .font(.system(size: fontSize, weight: .medium))
                    .foregroundColor(.white)
                if let desc = action.desc, !desc.isEmpty {
                    Text(desc)
                        .font(.system(size: fontSize - 2))
                        .foregroundColor(.white.opacity(0.4))
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: fontSize - 2))
                .foregroundColor(.white.opacity(0.3))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
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
struct OtherTerminalsBar: View {
    let terminals: [TerminalSnapshot]
    let focusedSid: String
    let focusedTid: String
    let maxShow: Int

    var body: some View {
        let others = terminals.filter { !($0.sid == focusedSid && $0.tid == focusedTid) }
        HStack(spacing: 8) {
            ForEach(Array(others.prefix(maxShow).enumerated()), id: \.offset) { _, t in
                HStack(spacing: 3) {
                    PhaseDot(phase: t.phase, size: 5)
                    ProviderLogo(provider: t.provider, size: 10)
                    Text(t.project)
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
