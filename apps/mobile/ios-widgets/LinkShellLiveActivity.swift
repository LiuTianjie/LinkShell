import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 16.2, *)
struct LinkShellLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LinkShellAttributes.self) { context in
            AgentLockScreenView(context: context)
                .activityBackgroundTint(Color(red: 0.06, green: 0.07, blue: 0.08))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            let ext = LiveActivityStore.readExtendedData()

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ProviderHeader(provider: state.provider, project: state.project, compact: true)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    StatusBadge(status: state.status, permissionCount: state.permissionCount)
                }

                DynamicIslandExpandedRegion(.center) {
                    Text(centerLabel(state: state, ext: ext))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        if state.hasPermission, let ext {
                            Text(trimmed(ext.permissionContext.isEmpty ? state.summary : ext.permissionContext, max: 150))
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.white.opacity(0.72))
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            PermissionButtonRow(state: state, ext: ext, maxButtons: 2)
                        } else {
                            Text(state.summary.isEmpty ? state.phaseLabel : state.summary)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.white.opacity(0.7))
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            } compactLeading: {
                ProviderMark(provider: state.provider, size: 18)
            } compactTrailing: {
                CompactStatusDot(status: state.status, hasPermission: state.hasPermission)
            } minimal: {
                CompactStatusDot(status: state.status, hasPermission: state.hasPermission)
            }
            .widgetURL(agentURL(state: state, ext: ext))
        }
    }
}

@available(iOS 16.2, *)
struct AgentLockScreenView: View {
    let context: ActivityViewContext<LinkShellAttributes>

    var body: some View {
        let state = context.state
        let ext = LiveActivityStore.readExtendedData()

        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                ProviderHeader(provider: state.provider, project: state.project, compact: false)
                Spacer(minLength: 8)
                StatusBadge(status: state.status, permissionCount: state.permissionCount)
            }

            if state.hasPermission, let ext {
                PermissionSummary(state: state, ext: ext)
                PermissionButtonRow(state: state, ext: ext, maxButtons: 3)
            } else {
                RunningSummary(state: state, ext: ext)
            }
        }
        .padding(16)
        .widgetURL(agentURL(state: state, ext: ext))
    }
}

@available(iOS 16.2, *)
struct PermissionSummary: View {
    let state: LinkShellAttributes.ContentState
    let ext: ExtendedActivityData

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(ext.permissionTitle.isEmpty ? "Agent 需要授权" : ext.permissionTitle, systemImage: "checkmark.shield")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.white)
                .lineLimit(1)

            if !ext.currentToolName.isEmpty {
                Text(ext.currentToolName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(statusColor(state.status))
                    .lineLimit(1)
            }

            Text(trimmed(ext.permissionContext.isEmpty ? state.summary : ext.permissionContext, max: 220))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.72))
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@available(iOS 16.2, *)
struct RunningSummary: View {
    let state: LinkShellAttributes.ContentState
    let ext: ExtendedActivityData?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(state.phaseLabel.isEmpty ? statusLabel(state.status) : state.phaseLabel)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.white)
                .lineLimit(1)

            if let ext, !ext.currentToolName.isEmpty {
                Text(ext.currentToolName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.58))
                    .lineLimit(1)
            }

            Text(trimmed(state.summary.isEmpty ? ext?.currentToolInput ?? "" : state.summary, max: 220))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.7))
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@available(iOS 16.2, *)
struct PermissionButtonRow: View {
    let state: LinkShellAttributes.ContentState
    let ext: ExtendedActivityData
    let maxButtons: Int

    var body: some View {
        let options = normalizedOptions(ext.permissionOptions)
        HStack(spacing: 8) {
            ForEach(Array(options.prefix(maxButtons)), id: \.id) { option in
                if #available(iOS 17.0, *) {
                    Button(intent: QuickActionIntent(
                        sessionId: state.sessionId,
                        conversationId: state.conversationId,
                        requestId: ext.permissionRequestId,
                        outcome: outcome(for: option),
                        optionId: option.id
                    )) {
                        Label(option.label, systemImage: icon(for: option))
                            .font(.system(size: 12, weight: .bold))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(optionTint(for: option))
                } else {
                    Link(destination: agentURL(state: state, ext: ext)) {
                        Label(option.label, systemImage: icon(for: option))
                            .font(.system(size: 12, weight: .bold))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }
}

@available(iOS 16.2, *)
struct ProviderHeader: View {
    let provider: String
    let project: String
    let compact: Bool

    var body: some View {
        HStack(spacing: compact ? 7 : 9) {
            ProviderMark(provider: provider, size: compact ? 22 : 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(providerLabel(provider))
                    .font(.system(size: compact ? 11 : 12, weight: .bold))
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(1)
                Text(project.isEmpty ? "Agent" : project)
                    .font(.system(size: compact ? 13 : 16, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }
        }
    }
}

@available(iOS 16.2, *)
struct ProviderMark: View {
    let provider: String
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle().fill(providerColor(provider).opacity(0.25))
            Text(providerInitial(provider))
                .font(.system(size: size * 0.48, weight: .black))
                .foregroundStyle(providerColor(provider))
        }
        .frame(width: size, height: size)
    }
}

@available(iOS 16.2, *)
struct StatusBadge: View {
    let status: String
    let permissionCount: Int

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(statusColor(status))
                .frame(width: 7, height: 7)
            Text(permissionCount > 1 ? "\(permissionCount) 个授权" : statusLabel(status))
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(
            Capsule().fill(statusColor(status).opacity(0.22))
        )
    }
}

@available(iOS 16.2, *)
struct CompactStatusDot: View {
    let status: String
    let hasPermission: Bool

    var body: some View {
        Image(systemName: hasPermission ? "exclamationmark.circle.fill" : "sparkles")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(statusColor(status))
    }
}

func normalizedOptions(_ options: [AgentPermissionOption]) -> [AgentPermissionOption] {
    if options.isEmpty {
        return [
            AgentPermissionOption(id: "deny", label: "拒绝", kind: "deny"),
            AgentPermissionOption(id: "allow_once", label: "允许一次", kind: "allow"),
        ]
    }
    let deny = options.filter { $0.kind == "deny" }
    let allow = options.filter { $0.kind == "allow" }
    let other = options.filter { $0.kind != "deny" && $0.kind != "allow" }
    return deny + allow + other
}

func outcome(for option: AgentPermissionOption) -> String {
    if option.kind == "allow" { return "allow" }
    if option.kind == "deny" { return "deny" }
    return "cancelled"
}

func icon(for option: AgentPermissionOption) -> String {
    if option.kind == "allow" { return "checkmark.circle.fill" }
    if option.kind == "deny" { return "xmark.circle.fill" }
    return "ellipsis.circle.fill"
}

func optionTint(for option: AgentPermissionOption) -> Color {
    if option.kind == "allow" { return Color(red: 0.18, green: 0.57, blue: 0.96) }
    if option.kind == "deny" { return Color(red: 0.44, green: 0.45, blue: 0.48) }
    return Color(red: 0.36, green: 0.36, blue: 0.42)
}

func centerLabel(state: LinkShellAttributes.ContentState, ext: ExtendedActivityData?) -> String {
    if state.hasPermission {
        return ext?.currentToolName.isEmpty == false ? ext!.currentToolName : "等待授权"
    }
    if let ext, !ext.currentToolName.isEmpty { return ext.currentToolName }
    return state.phaseLabel.isEmpty ? statusLabel(state.status) : state.phaseLabel
}

func statusLabel(_ status: String) -> String {
    switch status {
    case "running": return "运行中"
    case "waiting_permission": return "待授权"
    case "error": return "出错"
    default: return "空闲"
    }
}

func statusColor(_ status: String) -> Color {
    switch status {
    case "running": return Color(red: 0.20, green: 0.74, blue: 0.47)
    case "waiting_permission": return Color(red: 0.96, green: 0.63, blue: 0.20)
    case "error": return Color(red: 0.98, green: 0.32, blue: 0.32)
    default: return Color(red: 0.58, green: 0.62, blue: 0.68)
    }
}

func providerLabel(_ provider: String) -> String {
    switch provider.lowercased() {
    case "codex": return "Codex"
    case "claude": return "Claude"
    default: return "Agent"
    }
}

func providerInitial(_ provider: String) -> String {
    switch provider.lowercased() {
    case "codex": return "C"
    case "claude": return "A"
    default: return "L"
    }
}

func providerColor(_ provider: String) -> Color {
    switch provider.lowercased() {
    case "codex": return Color(red: 0.36, green: 0.76, blue: 0.98)
    case "claude": return Color(red: 0.96, green: 0.68, blue: 0.40)
    default: return Color(red: 0.58, green: 0.70, blue: 1.0)
    }
}

func trimmed(_ value: String, max: Int) -> String {
    let clean = value
        .replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\t", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.count <= max { return clean }
    let index = clean.index(clean.startIndex, offsetBy: max - 1)
    return String(clean[..<index]) + "…"
}

func agentURL(state: LinkShellAttributes.ContentState, ext: ExtendedActivityData?) -> URL {
    if let raw = ext?.deepLink, let url = URL(string: raw) {
        return url
    }
    return URL(string: "linkshell://agent/\(state.conversationId)")!
}
