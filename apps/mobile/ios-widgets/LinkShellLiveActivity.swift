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
            let state = context.state
            let ext = LiveActivityStore.readExtendedData()

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        ProviderLogo(provider: state.provider, size: 24)
                        Text(state.project)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                    }
                }

                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 6) {
                        PhasePill(phase: state.phase)
                        if state.otherCount > 0 {
                            Text("+\(state.otherCount)")
                                .font(.system(size: 11, weight: .bold, design: .rounded))
                                .foregroundColor(.white.opacity(0.5))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(
                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                        .fill(.white.opacity(0.1))
                                )
                        }
                    }
                }

                DynamicIslandExpandedRegion(.center) {
                    HStack(spacing: 6) {
                        if !state.tool.isEmpty {
                            ToolBadge(name: state.tool, fontSize: 11)
                        }
                        Text(formatElapsed(state.elapsed))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.white.opacity(0.4))
                    }
                }

                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        if state.hasPermission, let ext = ext, !ext.permissionTool.isEmpty {
                            // Permission: tool name + context + action list
                            VStack(spacing: 6) {
                                HStack(spacing: 5) {
                                    Image(systemName: "lock.shield")
                                        .font(.system(size: 12))
                                        .foregroundColor(.cyan)
                                    Text(ext.permissionTool)
                                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                        .foregroundColor(.cyan)
                                        .lineLimit(1)
                                    Spacer()
                                    if state.permCount > 1 {
                                        Text("+\(state.permCount - 1)")
                                            .font(.system(size: 10))
                                            .foregroundColor(.white.opacity(0.35))
                                    }
                                }

                                if !ext.permissionContext.isEmpty {
                                    Text(ext.permissionContext)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundColor(.white.opacity(0.6))
                                        .lineLimit(2)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(8)
                                        .background(
                                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                                .fill(.white.opacity(0.06))
                                        )
                                }

                                VStack(spacing: 0) {
                                    ForEach(Array(ext.quickActions.prefix(2).enumerated()), id: \.offset) { idx, action in
                                        if idx > 0 {
                                            Divider().background(.white.opacity(0.1))
                                        }
                                        ActionRow(action: action, state: state, requestId: ext.permissionRequestId)
                                    }
                                }
                                .background(
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .fill(.white.opacity(0.06))
                                )
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

                                if ext.quickActions.isEmpty {
                                    Link(destination: URL(string: "linkshell://open?session=\(state.sid)")!) {
                                        Text("打开查看")
                                            .font(.system(size: 11, weight: .medium))
                                            .foregroundColor(.blue)
                                    }
                                }
                            }
                            .padding(8)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .strokeBorder(.orange.opacity(0.3), lineWidth: 0.5)
                            )
                        } else if let ext = ext, !ext.toolDescription.isEmpty {
                            Text(ext.toolDescription)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundColor(.white.opacity(0.7))
                                .lineLimit(3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                                .background(
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .fill(.white.opacity(0.06))
                                )
                        } else if let ext = ext, !ext.contextLines.isEmpty {
                            Text(ext.contextLines)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundColor(.white.opacity(0.6))
                                .lineLimit(3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                                .background(
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .fill(.white.opacity(0.06))
                                )
                        }

                        // Secondary terminals
                        if !state.hasPermission, let ext = ext, !ext.secondaryTerminals.isEmpty {
                            HStack(spacing: 8) {
                                ForEach(Array(ext.secondaryTerminals.prefix(4).enumerated()), id: \.offset) { _, t in
                                    HStack(spacing: 4) {
                                        ProviderLogo(provider: t.provider, size: 14)
                                        PhaseDot(phase: t.phase, size: 6)
                                    }
                                }
                                Spacer()
                                Text("\(state.otherCount) 个终端运行中")
                                    .font(.system(size: 10))
                                    .foregroundColor(.white.opacity(0.55))
                            }
                        }
                    }
                }
            } compactLeading: {
                ProviderLogo(provider: state.provider, size: 18)
            } compactTrailing: {
                HStack(spacing: 3) {
                    PhaseDot(phase: state.phase, size: 6)
                    if state.hasPermission {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 10))
                            .foregroundColor(.orange)
                    } else if !state.tool.isEmpty {
                        Text(state.tool.prefix(4))
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundColor(.white.opacity(0.7))
                            .lineLimit(1)
                    } else if state.otherCount > 0 {
                        Text("\(state.otherCount + 1)")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundColor(.white)
                            .contentTransition(.numericText())
                    }
                }
            } minimal: {
                ZStack {
                    ProviderLogo(provider: state.provider, size: 14)
                    Circle()
                        .strokeBorder(phaseColor(state.phase), lineWidth: 1.5)
                        .frame(width: 20, height: 20)
                }
            }
        }
    }
}

// MARK: - Action Row (left desc, right "选择" button)

@available(iOS 16.2, *)
struct ActionRow: View {
    let action: QuickAction
    let state: LinkShellAttributes.ContentState
    let requestId: String

    var body: some View {
        HStack(spacing: 8) {
            if let desc = action.desc, desc != action.label {
                Text(desc)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(.white.opacity(0.7))
                    .lineLimit(1)
            }
            Spacer()
            if #available(iOS 17.0, *) {
                Button(intent: QuickActionIntent(
                    sessionId: state.sid,
                    terminalId: state.tid,
                    inputData: action.input,
                    requestId: requestId
                )) {
                    actionButton
                }
                .buttonStyle(.plain)
            } else {
                Link(destination: actionURL(state.sid, state.tid, action)) {
                    actionButton
                }
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
    }

    private var actionButton: some View {
        Text(action.label)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(buttonColor.opacity(0.25))
            )
    }

    private var buttonColor: Color {
        let l = action.input.lowercased()
        if l.contains("deny") || l.contains("no") { return .red }
        if l.contains("allow") || l.contains("yes") { return .green }
        return .blue
    }
}

// MARK: - Lock Screen View

@available(iOS 16.2, *)
struct LockScreenView: View {
    let context: ActivityViewContext<LinkShellAttributes>

    var body: some View {
        let state = context.state
        let ext = LiveActivityStore.readExtendedData()

        VStack(spacing: 8) {
            // Header: agent logo + project + phase + elapsed
            HStack(spacing: 8) {
                ProviderLogo(provider: state.provider, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.project)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        if !state.tool.isEmpty {
                            ToolBadge(name: state.tool, fontSize: 10)
                        }
                        Text(formatElapsed(state.elapsed))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.white.opacity(0.65))
                    }
                }
                Spacer()
                PhasePill(phase: state.phase)
            }

            // Content area
            if !state.hasPermission {
                // Tool description or context
                if let ext = ext, !ext.toolDescription.isEmpty {
                    Text(ext.toolDescription)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.white.opacity(0.75))
                        .lineLimit(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(.white.opacity(0.05))
                        )
                } else if let ext = ext, !ext.contextLines.isEmpty {
                    Text(ext.contextLines)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.white.opacity(0.65))
                        .lineLimit(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(.white.opacity(0.05))
                        )
                }
            }

            // Permission area
            if state.hasPermission, let ext = ext, !ext.permissionTool.isEmpty {
                VStack(spacing: 6) {
                    // Permission header
                    HStack(spacing: 5) {
                        Image(systemName: "lock.shield")
                            .font(.system(size: 11))
                            .foregroundColor(.cyan)
                        Text(ext.permissionTool)
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(.cyan)
                            .lineLimit(1)
                        Spacer()
                        if state.permCount > 1 {
                            Text("+\(state.permCount - 1)")
                                .font(.system(size: 9))
                                .foregroundColor(.white.opacity(0.35))
                        }
                    }

                    // Permission context
                    if !ext.permissionContext.isEmpty {
                        Text(ext.permissionContext)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.white.opacity(0.65))
                            .lineLimit(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    // Action list: each row = left desc, right button
                    VStack(spacing: 0) {
                        ForEach(Array(ext.quickActions.enumerated()), id: \.offset) { idx, action in
                            if idx > 0 {
                                Divider().background(.white.opacity(0.1))
                            }
                            LockScreenActionRow(action: action, state: state, requestId: ext.permissionRequestId)
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(.white.opacity(0.05))
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .padding(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(.orange.opacity(0.3), lineWidth: 0.5)
                )
            }

            // Non-permission quick actions
            if !state.hasPermission, let ext = ext, !ext.quickActions.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(ext.quickActions.prefix(6).enumerated()), id: \.offset) { idx, action in
                        if idx > 0 {
                            Divider().background(.white.opacity(0.1))
                        }
                        LockScreenActionRow(action: action, state: state, requestId: ext.permissionRequestId)
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(.white.opacity(0.05))
                )
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }

            // Secondary terminals summary
            if let ext = ext, !ext.secondaryTerminals.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(ext.secondaryTerminals.prefix(4).enumerated()), id: \.offset) { _, t in
                        HStack(spacing: 3) {
                            ProviderLogo(provider: t.provider, size: 12)
                            PhaseDot(phase: t.phase, size: 5)
                        }
                    }
                    if state.otherCount > 4 {
                        Text("+\(state.otherCount - 4)")
                            .font(.system(size: 9))
                            .foregroundColor(.white.opacity(0.35))
                    }
                    Spacer()
                    Text("\(state.otherCount) 个终端运行中")
                        .font(.system(size: 9))
                        .foregroundColor(.white.opacity(0.55))
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .activityBackgroundTint(.black.opacity(0.6))
    }
}

// MARK: - Lock Screen Action Row

@available(iOS 16.2, *)
struct LockScreenActionRow: View {
    let action: QuickAction
    let state: LinkShellAttributes.ContentState
    let requestId: String

    var body: some View {
        HStack(spacing: 8) {
            if let desc = action.desc, desc != action.label {
                Text(desc)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.white.opacity(0.75))
                    .lineLimit(2)
            }
            Spacer()
            if #available(iOS 17.0, *) {
                Button(intent: QuickActionIntent(
                    sessionId: state.sid,
                    terminalId: state.tid,
                    inputData: action.input,
                    requestId: requestId
                )) {
                    lockScreenButton
                }
                .buttonStyle(.plain)
            } else {
                Link(destination: actionURL(state.sid, state.tid, action)) {
                    lockScreenButton
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private var lockScreenButton: some View {
        Text(action.label)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(buttonColor.opacity(0.25))
            )
    }

    private var buttonColor: Color {
        let l = action.input.lowercased()
        if l.contains("deny") || l.contains("no") { return .red }
        if l.contains("allow") || l.contains("yes") { return .green }
        return .blue
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

func actionURL(_ sessionId: String, _ terminalId: String, _ action: QuickAction) -> URL {
    var components = URLComponents()
    components.scheme = "linkshell"
    components.host = "input"
    var items = [
        URLQueryItem(name: "session", value: sessionId),
        URLQueryItem(name: "terminal", value: terminalId),
        URLQueryItem(name: "data", value: action.input),
    ]
    if !action.needsInput {
        items.append(URLQueryItem(name: "bg", value: "1"))
    }
    components.queryItems = items
    return components.url!
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
