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
        title: "整理发布说明",
        subtitle: "正在运行测试",
        project: "claude-remote",
        cwd: "~/claude-remote",
        branch: "main",
        agent: "claude",
        model: nil,
        mode: nil,
        subagents: WatchSubagentCount(total: 2, running: 1),
        configOptions: nil,
        phase: "running",
        updatedAt: Date().timeIntervalSince1970 * 1000,
        pinned: true,
        promptTitle: nil,
        commandPreview: "pnpm test",
        detailPreview: "已更新 3 个文件",
        goal: nil,
        planProgress: WatchPlanProgress(completed: 3, total: 4, currentStep: "运行测试"),
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
    let file = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
      .appendingPathComponent("linkshell-watch-snapshot.json")
    if let stored = WatchSnapshot.stored(in: UserDefaults(suiteName: group), file: file) { return stored }
    #if targetEnvironment(simulator)
    if let json = try? String(contentsOfFile: "/tmp/linkshell-watch-snapshot.json", encoding: .utf8),
       let data = json.data(using: .utf8),
       let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data), !decoded.isUnsynced {
      return decoded
    }
    #endif
    return .empty
  }

  // The placeholder is drawn redacted by the system, so sample text never reads as real state.
  public func placeholder(in context: Context) -> WatchComplicationEntry {
    WatchComplicationEntry(snapshot: .previewSample)
  }

  public func getSnapshot(in context: Context, completion: @escaping (WatchComplicationEntry) -> Void) {
    // The face gallery may show the sample; a face the user wears shows only what was synced.
    let stored = Self.loadSnapshot()
    completion(WatchComplicationEntry(snapshot: context.isPreview && stored.isUnsynced ? .previewSample : stored))
  }

  public func getTimeline(in context: Context, completion: @escaping (Timeline<WatchComplicationEntry>) -> Void) {
    let snapshot = Self.loadSnapshot()
    var entries = [WatchComplicationEntry(snapshot: snapshot)]
    // A second entry dims the counts once they are old, without waiting for the next sync.
    if !snapshot.isUnsynced {
      let stale = Date(timeIntervalSince1970: snapshot.generatedAt / 1000 + 601)
      if stale > Date() { entries.append(WatchComplicationEntry(date: stale, snapshot: snapshot)) }
    }
    let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date().addingTimeInterval(900)
    completion(Timeline(entries: entries, policy: .after(refresh)))
  }
}

/// What a face shows, worked out once for every family.
struct WatchFaceSummary {
  let phase: String
  let count: Int
  let label: String
  let unsynced: Bool
  let stale: Bool

  init(_ snapshot: WatchSnapshot, at date: Date) {
    unsynced = snapshot.isUnsynced
    stale = snapshot.isStale(at: date)
    if snapshot.waitingCount > 0 {
      phase = "waiting_for_approval"; count = snapshot.waitingCount; label = "\(snapshot.waitingCount) 待确认"
    } else if snapshot.failedCount > 0 {
      phase = "failed"; count = snapshot.failedCount; label = "\(snapshot.failedCount) 出错"
    } else if snapshot.runningCount > 0 {
      phase = "running"; count = snapshot.runningCount; label = "\(snapshot.runningCount) 运行中"
    } else {
      phase = "completed"; count = 0; label = snapshot.online ? "空闲" : "离线"
    }
  }

  /// The tint for the state; none once it may no longer be true.
  var color: Color { stale ? .secondary : WatchPhaseStyle.color(for: phase) }
}

public struct WatchComplicationCircularView: View {
  public let snapshot: WatchSnapshot
  public let date: Date

  public init(snapshot: WatchSnapshot, date: Date = Date()) {
    self.snapshot = snapshot
    self.date = date
  }

  public var body: some View {
    let face = WatchFaceSummary(snapshot, at: date)
    ZStack {
      AccessoryWidgetBackground()
      if face.unsynced {
        Image(systemName: "applewatch.slash").font(.title3).widgetAccentable()
      } else {
        VStack(spacing: 0) {
          Image(systemName: WatchPhaseStyle.symbol(for: face.phase))
            .font(.caption2.weight(.bold))
            .foregroundStyle(face.color)
            .widgetAccentable()
          Text(face.count > 0 ? "\(face.count)" : "–")
            .font(.system(.title3, design: .rounded).weight(.bold))
            .monospacedDigit()
            .minimumScaleFactor(0.6)
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(face.unsynced ? "LinkShell 尚未同步" : "LinkShell \(face.label)")
  }
}

public struct WatchComplicationRectangularView: View {
  public let snapshot: WatchSnapshot
  public let date: Date

  public init(snapshot: WatchSnapshot, date: Date = Date()) {
    self.snapshot = snapshot
    self.date = date
  }

  public var body: some View {
    let face = WatchFaceSummary(snapshot, at: date)
    if face.unsynced {
      VStack(alignment: .leading, spacing: 1) {
        Label("LinkShell", systemImage: "terminal.fill")
          .font(.headline).widgetAccentable()
        Text("打开腕表 App 连接电脑")
          .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else if let top = snapshot.sessions.first {
      let agent = WatchAgent(id: top.agent)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 4) {
          WatchAgentBadge(agent: agent, size: 14)
          Text(face.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(face.color)
            .widgetAccentable()
          Spacer(minLength: 2)
          if face.stale {
            Text(Date(timeIntervalSince1970: snapshot.generatedAt / 1000), style: .relative)
              .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
          }
        }
        Text(top.title)
          .font(.headline)
          .lineLimit(1)
          .privacySensitive()
        Text(top.promptTitle ?? top.detailPreview ?? top.subtitle)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .privacySensitive()
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      VStack(alignment: .leading, spacing: 1) {
        Label(snapshot.computerName, systemImage: "desktopcomputer")
          .font(.headline).lineLimit(1).widgetAccentable()
        Text(snapshot.online ? "没有进行中的会话" : "电脑离线")
          .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

public struct WatchComplicationInlineView: View {
  public let snapshot: WatchSnapshot
  public let date: Date

  public init(snapshot: WatchSnapshot, date: Date = Date()) {
    self.snapshot = snapshot
    self.date = date
  }

  public var body: some View {
    let face = WatchFaceSummary(snapshot, at: date)
    if face.unsynced {
      Label("LinkShell 未连接", systemImage: "applewatch.slash")
    } else {
      Label("LinkShell · \(face.label)", systemImage: WatchPhaseStyle.symbol(for: face.phase))
    }
  }
}

public struct WatchComplicationCornerView: View {
  public let snapshot: WatchSnapshot
  public let date: Date

  public init(snapshot: WatchSnapshot, date: Date = Date()) {
    self.snapshot = snapshot
    self.date = date
  }

  public var body: some View {
    let face = WatchFaceSummary(snapshot, at: date)
    ZStack {
      AccessoryWidgetBackground()
      if face.unsynced {
        Image(systemName: "applewatch.slash").font(.title3).widgetAccentable()
      } else {
        Text(face.count > 0 ? "\(face.count)" : "–")
          .font(.system(.title3, design: .rounded).weight(.bold))
          .monospacedDigit()
          .foregroundStyle(face.color)
          .widgetAccentable()
      }
    }
    .widgetLabel {
      Text(face.unsynced ? "LinkShell 未连接" : "LinkShell · \(face.label)")
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(face.unsynced ? "LinkShell 尚未同步" : "LinkShell \(face.label)")
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
        WatchComplicationCircularView(snapshot: entry.snapshot, date: entry.date)
      case .accessoryCorner:
        WatchComplicationCornerView(snapshot: entry.snapshot, date: entry.date)
      case .accessoryInline:
        WatchComplicationInlineView(snapshot: entry.snapshot, date: entry.date)
      default:
        WatchComplicationRectangularView(snapshot: entry.snapshot, date: entry.date)
      }
    }
    .containerBackground(.fill.tertiary, for: .widget)
  }
}

// One widget: the Smart Stack picks up its rectangular family by itself. A second widget with
// the same family only gave the face editor two near-identical entries.
public struct LinkShellWatchComplicationWidget: Widget {
  public static let kind = "LinkShellWatchComplication"

  public init() {}

  public var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: WatchComplicationProvider()) { entry in
      WatchComplicationEntryView(entry: entry)
    }
    .configurationDisplayName("LinkShell")
    .description("查看电脑上待确认的请求和正在运行的会话。")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
  }
}

#if WIDGET_EXTENSION || LINKSHELL_WATCH_WIDGET_EXTENSION
@main
public struct LinkShellWatchWidgetBundle: WidgetBundle {
  public init() {}

  public var body: some Widget {
    LinkShellWatchComplicationWidget()
  }
}
#endif
#endif
