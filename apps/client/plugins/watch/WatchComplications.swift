import Foundation
import SwiftUI
#if canImport(WidgetKit)
import WidgetKit

extension WatchSnapshot {
  public static let previewSample = WatchSnapshot(
    version: 1,
    generatedAt: Date().timeIntervalSince1970 * 1000,
    computerKey: "local:mac",
    computerName: "MacBook Pro",
    online: true,
    statusLabel: "1 项等待确认 · 2 运行中",
    waitingCount: 1,
    runningCount: 2,
    failedCount: 0,
    completedCount: 3,
    availableAgents: ["claude", "codex", "antigravity", "gemini", "cursor"],
    workspaces: [WatchWorkspace(path: "~/claude-remote", name: "claude-remote")],
    computers: [WatchComputer(key: "local:mac", name: "MacBook Pro", online: true, selected: true, platform: "darwin")],
    sessions: [
      WatchSession(
        id: "sample-1",
        title: "Apple Watch 腕上交互与组件",
        subtitle: "正在运行全量验证测试",
        project: "claude-remote",
        cwd: "~/claude-remote",
        branch: "main",
        agent: "antigravity",
        model: "Gemini 4",
        mode: "工作区沙盒",
        subagents: WatchSubagentCount(total: 2, running: 1),
        configOptions: nil,
        phase: "running",
        updatedAt: Date().timeIntervalSince1970 * 1000,
        pinned: true,
        promptTitle: nil,
        commandPreview: "pnpm --filter @linkshell/client test",
        detailPreview: "已完成小组件扩展与聊天气泡改造",
        goal: "打磨 Apple Watch 原生体验",
        planProgress: WatchPlanProgress(completed: 3, total: 4, currentStep: "验证表盘与智能叠放"),
        actions: nil,
        hasMoreActions: false,
        items: nil,
        canCancel: true,
        canSend: true,
        handoff: "none",
        deepLink: "linkshell://activity"
      )
    ],
    terminals: []
  )
}

public struct WatchComplicationEntry: TimelineEntry {
  public let date: Date
  public let snapshot: WatchSnapshot

  public init(date: Date = Date(), snapshot: WatchSnapshot) {
    self.date = date
    self.snapshot = snapshot
  }
}

public struct WatchComplicationProvider: TimelineProvider {
  public init() {}

  public static func loadSnapshot() -> WatchSnapshot {
    let group = (Bundle.main.object(forInfoDictionaryKey: "LinkShellWatchAppGroup") as? String) ?? "group.com.bd.linkshell"
    if let shared = UserDefaults(suiteName: group),
       let json = shared.string(forKey: "LinkShellWatch.cachedSnapshot.v1"),
       let data = json.data(using: .utf8),
       let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data),
       !decoded.computerKey.isEmpty || !decoded.sessions.isEmpty {
      return decoded
    }
    if let fileURL = FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: group)?
      .appendingPathComponent("linkshell-watch-snapshot.json"),
       let json = try? String(contentsOf: fileURL, encoding: .utf8),
       let data = json.data(using: .utf8),
       let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data) {
      return decoded
    }
    if let json = UserDefaults.standard.string(forKey: "LinkShellWatch.cachedSnapshot.v1"),
       let data = json.data(using: .utf8),
       let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data),
       !decoded.computerKey.isEmpty || !decoded.sessions.isEmpty {
      return decoded
    }
    #if targetEnvironment(simulator)
    if let json = try? String(contentsOfFile: "/tmp/linkshell-watch-snapshot.json", encoding: .utf8),
       let data = json.data(using: .utf8),
       let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data) {
      return decoded
    }
    #endif
    return .previewSample
  }

  public func placeholder(in context: Context) -> WatchComplicationEntry {
    WatchComplicationEntry(snapshot: .previewSample)
  }

  public func getSnapshot(in context: Context, completion: @escaping (WatchComplicationEntry) -> Void) {
    completion(WatchComplicationEntry(snapshot: Self.loadSnapshot()))
  }

  public func getTimeline(in context: Context, completion: @escaping (Timeline<WatchComplicationEntry>) -> Void) {
    let entry = WatchComplicationEntry(snapshot: Self.loadSnapshot())
    let refresh = Calendar.current.date(byAdding: .minute, value: 5, to: Date()) ?? Date().addingTimeInterval(300)
    completion(Timeline(entries: [entry], policy: .after(refresh)))
  }
}

public struct WatchComplicationCircularView: View {
  public let snapshot: WatchSnapshot

  public init(snapshot: WatchSnapshot) {
    self.snapshot = snapshot
  }

  public var body: some View {
    let urgent = snapshot.waitingCount > 0
    let failed = snapshot.failedCount > 0
    let activeCount = urgent
      ? snapshot.waitingCount
      : failed
        ? snapshot.failedCount
        : snapshot.runningCount > 0
          ? snapshot.runningCount
          : snapshot.sessions.count
    let phase = urgent ? "waiting_for_approval" : failed ? "failed" : snapshot.runningCount > 0 ? "running" : "completed"

    ZStack {
      AccessoryWidgetBackground()
      VStack(spacing: 1) {
        Image(systemName: WatchPhaseStyle.symbol(for: phase))
          .font(.system(size: 11, weight: .bold))
          .foregroundColor(WatchPhaseStyle.color(for: phase))
        Text("\(activeCount)")
          .font(.system(size: 13, weight: .bold, design: .rounded))
          .monospacedDigit()
      }
    }
  }
}

public struct WatchComplicationRectangularView: View {
  public let snapshot: WatchSnapshot

  public init(snapshot: WatchSnapshot) {
    self.snapshot = snapshot
  }

  public var body: some View {
    if let top = snapshot.sessions.first {
      let agent = WatchAgent(id: top.agent)
      VStack(alignment: .leading, spacing: 2.5) {
        HStack(spacing: 4.5) {
          WatchAgentBadge(agent: agent, size: 15)
          Text("\(agent.name) · \(top.project)")
            .font(.system(size: 11, weight: .semibold, design: .rounded))
            .foregroundColor(.white)
            .lineLimit(1)
          Spacer(minLength: 2)
          HStack(spacing: 2.5) {
            Circle()
              .fill(WatchPhaseStyle.color(for: top.phase))
              .frame(width: 4.5, height: 4.5)
            Text(WatchPhaseStyle.label(for: top.phase))
              .font(.system(size: 9.5, weight: .semibold))
              .foregroundColor(WatchPhaseStyle.color(for: top.phase))
          }
        }
        Text(top.title)
          .font(.system(size: 12, weight: .bold, design: .rounded))
          .foregroundColor(.white)
          .lineLimit(1)
        Text(top.promptTitle ?? top.detailPreview ?? top.subtitle)
          .font(.system(size: 10.5))
          .foregroundColor(.secondary)
          .lineLimit(1)
      }
    } else {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
          Image(systemName: "terminal.fill")
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.green)
          Text("LinkShell · \(snapshot.computerName)")
            .font(.system(size: 11, weight: .semibold, design: .rounded))
            .lineLimit(1)
        }
        Text(snapshot.statusLabel)
          .font(.system(size: 11))
          .foregroundColor(.secondary)
          .lineLimit(2)
      }
    }
  }
}

public struct WatchComplicationInlineView: View {
  public let snapshot: WatchSnapshot

  public init(snapshot: WatchSnapshot) {
    self.snapshot = snapshot
  }

  public var body: some View {
    if snapshot.waitingCount > 0 {
      Text("⚡ LinkShell · \(snapshot.waitingCount) 待确认")
    } else if snapshot.runningCount > 0 {
      Text("● LinkShell · \(snapshot.runningCount) 运行中")
    } else {
      Text("LinkShell · \(snapshot.computerName)")
    }
  }
}

public struct WatchComplicationCornerView: View {
  public let snapshot: WatchSnapshot

  public init(snapshot: WatchSnapshot) {
    self.snapshot = snapshot
  }

  public var body: some View {
    let urgent = snapshot.waitingCount > 0
    let failed = snapshot.failedCount > 0
    let activeCount = urgent
      ? snapshot.waitingCount
      : failed
        ? snapshot.failedCount
        : snapshot.runningCount > 0
          ? snapshot.runningCount
          : snapshot.sessions.count
    let phase = urgent ? "waiting_for_approval" : failed ? "failed" : snapshot.runningCount > 0 ? "running" : "completed"

    ZStack {
      AccessoryWidgetBackground()
      VStack(spacing: 0) {
        Image(systemName: WatchPhaseStyle.symbol(for: phase))
          .font(.system(size: 11, weight: .bold))
          .foregroundColor(WatchPhaseStyle.color(for: phase))
        Text("\(activeCount)")
          .font(.system(size: 11, weight: .bold, design: .rounded))
          .monospacedDigit()
      }
    }
    .widgetLabel {
      Text(snapshot.statusLabel)
    }
  }
}

public struct WatchSmartStackCardView: View {
  public let snapshot: WatchSnapshot

  public init(snapshot: WatchSnapshot) {
    self.snapshot = snapshot
  }

  public var body: some View {
    let top = snapshot.sessions.first
    let agent = WatchAgent(id: top?.agent ?? "claude")

    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 5) {
        WatchAgentBadge(agent: agent, size: 16)
        Text(top != nil ? "\(agent.name) · \(top!.project)" : "LinkShell · \(snapshot.computerName)")
          .font(.system(size: 11, weight: .semibold))
          .foregroundColor(.white)
          .lineLimit(1)
        Spacer(minLength: 2)
        if snapshot.waitingCount > 0 {
          Text("\(snapshot.waitingCount) 待确认")
            .font(.system(size: 9.5, weight: .bold))
            .foregroundColor(.orange)
        } else if snapshot.runningCount > 0 {
          Text("\(snapshot.runningCount) 运行中")
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundColor(.green)
        } else {
          Text("已就绪")
            .font(.system(size: 9.5, weight: .medium))
            .foregroundColor(.secondary)
        }
      }

      if let top {
        Text(top.title)
          .font(.system(size: 12, weight: .bold))
          .foregroundColor(.white)
          .lineLimit(1)

        if let cmd = top.commandPreview, !cmd.isEmpty {
          Text("$ \(cmd)")
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundColor(top.needsAttention ? .orange : Color(white: 0.78))
            .lineLimit(1)
        } else {
          Text(top.promptTitle ?? top.detailPreview ?? top.subtitle)
            .font(.system(size: 10.5))
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
      } else {
        Text(snapshot.statusLabel)
          .font(.system(size: 11.5, weight: .semibold))
          .foregroundColor(.white)
          .lineLimit(1)
        Text("轻点进入腕上工作台")
          .font(.system(size: 10))
          .foregroundColor(.secondary)
          .lineLimit(1)
      }
    }
    .containerBackground(.fill.tertiary, for: .widget)
  }
}

public struct WatchComplicationEntryView: View {
  public let entry: WatchComplicationEntry
  @Environment(\.widgetFamily) private var family

  public init(entry: WatchComplicationEntry) {
    self.entry = entry
  }

  public var body: some View {
    Group {
      switch family {
      case .accessoryCircular:
        WatchComplicationCircularView(snapshot: entry.snapshot)
      case .accessoryCorner:
        WatchComplicationCornerView(snapshot: entry.snapshot)
      case .accessoryInline:
        WatchComplicationInlineView(snapshot: entry.snapshot)
      default:
        WatchComplicationRectangularView(snapshot: entry.snapshot)
      }
    }
    .containerBackground(.fill.tertiary, for: .widget)
  }
}

public struct LinkShellWatchComplicationWidget: Widget {
  public static let kind = "LinkShellWatchComplication"

  public init() {}

  public var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: WatchComplicationProvider()) { entry in
      WatchComplicationEntryView(entry: entry)
    }
    .configurationDisplayName("LinkShell 腕上状态")
    .description("在表盘实时查看电脑上的 Agent 审批请求与运行进度。")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
  }
}

public struct LinkShellWatchSmartStackWidget: Widget {
  public static let kind = "LinkShellWatchSmartStack"

  public init() {}

  public var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: WatchComplicationProvider()) { entry in
      WatchSmartStackCardView(snapshot: entry.snapshot)
    }
    .configurationDisplayName("LinkShell 智能叠放")
    .description("转动数码表冠在智能叠放中随时查看活跃 Agent 会话、命令与待办审批。")
    .supportedFamilies([.accessoryRectangular])
  }
}

#if WIDGET_EXTENSION || LINKSHELL_WATCH_WIDGET_EXTENSION
@main
public struct LinkShellWatchWidgetBundle: WidgetBundle {
  public init() {}

  public var body: some Widget {
    LinkShellWatchComplicationWidget()
    LinkShellWatchSmartStackWidget()
  }
}
#endif
#endif
