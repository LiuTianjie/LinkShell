import SwiftUI
import UIKit

struct WatchPressableButtonStyle: ButtonStyle {
  var scale: CGFloat = 0.96

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? scale : 1.0)
      .opacity(configuration.isPressed ? 0.84 : 1.0)
      .animation(.spring(response: 0.20, dampingFraction: 0.75), value: configuration.isPressed)
  }
}

struct WatchStatusBadge: View {
  let session: WatchSession

  var body: some View {
    let color = WatchPhaseStyle.color(for: session.phase)
    if !session.needsAttention, let plan = session.planProgress, plan.total > 0 {
      HStack(spacing: 3) {
        ZStack {
          Circle()
            .stroke(color.opacity(0.24), lineWidth: 1.5)
          Circle()
            .trim(from: 0, to: plan.fraction)
            .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .rotationEffect(.degrees(-90))
        }
        .frame(width: 8, height: 8)

        Text("\(plan.completed)/\(plan.total)")
          .font(.system(size: 9.5, weight: .semibold))
          .monospacedDigit()
          .foregroundColor(color)
      }
      .padding(.horizontal, 5.5)
      .padding(.vertical, 2)
      .background(Capsule().fill(color.opacity(0.15)))
    } else {
      HStack(spacing: 3) {
        Circle()
          .fill(color)
          .frame(width: 4.5, height: 4.5)
        Text(WatchPhaseStyle.label(for: session.phase))
          .font(.system(size: 9.5, weight: .semibold))
      }
      .foregroundColor(color)
      .padding(.horizontal, 5.5)
      .padding(.vertical, 2)
      .background(Capsule().fill(color.opacity(0.15)))
    }
  }
}

struct WatchCommandSnippet: View {
  let command: String

  var body: some View {
    HStack(spacing: 4) {
      Text("$")
        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
        .foregroundColor(.secondary)
      Text(command)
        .font(.system(.caption2, design: .monospaced))
        .foregroundColor(Color(white: 0.90))
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 6.5)
    .padding(.vertical, 3.5)
    .background(
      RoundedRectangle(cornerRadius: 6.5, style: .continuous)
        .fill(Color.black.opacity(0.42))
        .overlay(
          RoundedRectangle(cornerRadius: 6.5, style: .continuous)
            .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
        )
    )
  }
}

// A single card opens the full request so no approval options are hidden on the overview.
struct WatchSessionRowCard: View {
  let session: WatchSession
  @ObservedObject var store: WatchSessionStore
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 7) {
          WatchAgentBadge(agent: WatchAgent(id: session.agent), size: 22)
          Text(session.project.isEmpty ? WatchAgent(id: session.agent).name : session.project)
            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
        }
        Text(session.title).font(.headline).foregroundStyle(.white)
          .lineLimit(2).multilineTextAlignment(.leading)
        Text(session.needsAttention ? (session.promptTitle ?? session.subtitle) : (session.detailPreview ?? session.subtitle))
          .font(.caption).foregroundStyle(session.needsAttention ? Color.orange : Color.secondary)
          .lineLimit(2).multilineTextAlignment(.leading)
        HStack {
          Label(WatchPhaseStyle.label(for: session.phase), systemImage: session.needsAttention ? "hand.raised.fill" : session.isRunning ? "waveform" : "circle.fill")
            .font(.caption2).foregroundStyle(WatchPhaseStyle.color(for: session.phase))
          Spacer(minLength: 2)
          if let plan = session.planProgress, plan.total > 0 {
            Text("\(plan.completed)/\(plan.total)").font(.caption2).monospacedDigit().foregroundStyle(.secondary)
          }
        }
        if let plan = session.planProgress, plan.total > 0, !session.needsAttention {
          ProgressView(value: plan.fraction).tint(.indigo)
            .accessibilityLabel("计划进度").accessibilityValue("\(plan.percent)%")
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(white: 0.10), in: RoundedRectangle(cornerRadius: 18))
      .overlay(RoundedRectangle(cornerRadius: 18)
        .strokeBorder(session.needsAttention ? Color.orange.opacity(0.5) : Color.white.opacity(0.08), lineWidth: 1))
    }
    .buttonStyle(WatchPressableButtonStyle())
    .accessibilityHint(session.needsAttention ? "查看完整请求与处理选项" : "查看会话消息")
  }
}

struct WatchTerminalRowCard: View {
  let terminal: WatchTerminal
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Image(systemName: "terminal").foregroundStyle(.indigo)
          Text(terminal.title).font(.headline).lineLimit(1)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
        }
        Text(terminal.outputPreview?.split(whereSeparator: \.isNewline).last.map(String.init) ?? terminal.subtitle)
          .font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2)
          .multilineTextAlignment(.leading)
        Text(terminal.exitCode.map { "已退出 · \($0)" } ?? "运行中")
          .font(.caption2).foregroundStyle(terminal.exitCode == nil ? Color.green : Color.secondary)
      }
      .padding(12).frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(white: 0.10), in: RoundedRectangle(cornerRadius: 18))
    }
    .buttonStyle(WatchPressableButtonStyle())
  }
}

struct WatchCommandFeedback: ViewModifier {
  @ObservedObject var store: WatchSessionStore

  func body(content: Content) -> some View {
    content.safeAreaInset(edge: .bottom, spacing: 0) {
      if store.pendingCommandId != nil || store.bannerNotice != nil {
        HStack(spacing: 6) {
          if store.pendingCommandId != nil {
            ProgressView().controlSize(.mini)
            Text("正在确认…")
          } else if let notice = store.bannerNotice {
            Image(systemName: notice.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
              .foregroundStyle(notice.ok ? Color.green : Color.orange)
            Text(notice.text)
          }
        }
        .font(.caption).fixedSize(horizontal: false, vertical: true)
        .padding(10).frame(maxWidth: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
      }
    }
  }
}

struct WatchWorkspaceHomeView: View {
  @ObservedObject var store: WatchSessionStore
  let onOpenSession: (String) -> Void
  let onOpenTerminal: (String) -> Void
  let onOpenComputers: () -> Void
  let onOpenQuickAdd: () -> Void
  @ScaledMetric(relativeTo: .caption) private var computerNameSize: CGFloat = 12
  @ScaledMetric(relativeTo: .caption2) private var connectionStatusSize: CGFloat = 10
  @ScaledMetric(relativeTo: .caption2) private var computerIconSize: CGFloat = 12

  private var attention: [WatchSession] { store.snapshot.sessions.filter(\.needsAttention) }
  private var otherSessions: [WatchSession] { store.snapshot.sessions.filter { !$0.needsAttention } }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 10) {
        Button(action: onOpenComputers) {
          HStack(spacing: 5) {
            Image(systemName: "desktopcomputer")
              .font(.system(size: computerIconSize, weight: .medium))
              .foregroundStyle(.indigo)
              .accessibilityHidden(true)
            Text(store.snapshot.computerName)
              .font(.system(size: computerNameSize, weight: .medium))
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer(minLength: 2)
            Text(store.transportReachable ? (store.snapshot.online ? "已连接" : "电脑离线") : "未连接")
              .font(.system(size: connectionStatusSize))
              .foregroundStyle(.secondary)
              .fixedSize()
            Image(systemName: "chevron.down")
              .font(.system(size: 8, weight: .semibold))
              .foregroundStyle(.secondary)
              .accessibilityHidden(true)
          }
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityHint("切换电脑")

        if !store.transportReachable, store.snapshot.generatedAt > 0 {
          VStack(alignment: .leading, spacing: 4) {
            Label("显示上次同步", systemImage: "clock.arrow.circlepath").font(.caption)
            Text(Date(timeIntervalSince1970: store.snapshot.generatedAt / 1000), style: .relative)
              .font(.caption2).foregroundStyle(.secondary)
            Text(store.independent ? "打开连接设置，检查网络或重新连接电脑。" : "打开 iPhone 上的 LinkShell 后可继续操作。")
              .font(.caption2).foregroundStyle(.secondary)
          }.foregroundStyle(.orange)
        }

        Text("会话 · \(store.snapshot.sessions.count)")
          .font(.caption).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
          .overlay(alignment: .trailing) {
            Button(action: onOpenQuickAdd) {
              Image(systemName: "plus")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.indigo)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("新建会话或终端")
          }

        if !attention.isEmpty {
          Text("待处理 · \(attention.count)").font(.caption).foregroundStyle(.orange)
          ForEach(attention) { session in
            WatchSessionRowCard(session: session, store: store) { onOpenSession(session.id) }
          }
        }
        if !otherSessions.isEmpty {
          ForEach(otherSessions) { session in
            WatchSessionRowCard(session: session, store: store) { onOpenSession(session.id) }
          }
        }
        if !store.snapshot.terminals.isEmpty {
          Text("终端 · \(store.snapshot.terminals.count)").font(.caption).foregroundStyle(.secondary)
          ForEach(store.snapshot.terminals) { terminal in
            WatchTerminalRowCard(terminal: terminal) { onOpenTerminal(terminal.id) }
          }
        }
        if store.snapshot.sessions.isEmpty && store.snapshot.terminals.isEmpty {
          VStack(spacing: 10) {
            Image(systemName: store.snapshot.online ? "sparkles" : "iphone.radiowaves.left.and.right")
              .font(.largeTitle).foregroundStyle(.indigo)
            Text(store.snapshot.online ? "准备就绪" : (store.independent ? "连接你的电脑" : "从 iPhone 开始")).font(.headline)
            Text(store.snapshot.online ? "新建会话，把下一步交给 Agent。" : (store.independent ? store.direct.status : "在配对的 iPhone 上打开 LinkShell 并连接电脑。"))
              .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if store.snapshot.online {
              Button("新建会话", action: onOpenQuickAdd).tint(.indigo)
            }
          }.frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        NavigationLink { WatchConnectionView(store: store) } label: { Label("连接设置", systemImage: "network") }
        Button { store.requestRefresh() } label: {
          Label("同步状态", systemImage: "arrow.clockwise").font(.caption).frame(minHeight: 44)
        }.disabled(store.pendingCommandId != nil)
      }
      .padding(.horizontal, 8).padding(.bottom, 12)
    }
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .modifier(WatchCommandFeedback(store: store))
  }
}

struct WatchDiffLineView: View {
  let rawText: String
  let expanded: Bool

  private var lines: [String] {
    let all = rawText
      .split(whereSeparator: \.isNewline)
      .map { String($0) }
    return expanded ? Array(all.prefix(16)) : Array(all.prefix(4))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 1.5) {
      ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
        let isAdd = line.hasPrefix("+")
        let isDel = line.hasPrefix("-")
        Text(line)
          .font(.system(size: 9, weight: .regular, design: .monospaced))
          .foregroundColor(
            isAdd
              ? Color(red: 0.42, green: 0.95, blue: 0.54)
              : isDel
                ? Color(red: 1.0, green: 0.52, blue: 0.52)
                : Color(white: 0.72)
          )
          .lineLimit(expanded ? 2 : 1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 4)
          .padding(.vertical, 1)
          .background(
            RoundedRectangle(cornerRadius: 3.5, style: .continuous)
              .fill(
                isAdd
                  ? Color.green.opacity(0.14)
                  : isDel
                    ? Color.red.opacity(0.14)
                    : Color.clear
              )
          )
      }
    }
    .padding(4.5)
    .background(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(Color.black.opacity(0.46))
    )
  }
}

struct WatchTimelineItemCard: View {
  let item: WatchTimelineItem
  let agent: WatchAgent
  let onPreviewImage: (UIImage, String) -> Void
  @State private var isExpanded: Bool = false

  private var decodedImage: UIImage? {
    guard let b64 = item.imageBase64, !b64.isEmpty,
          let data = Data(base64Encoded: b64) else {
      return nil
    }
    return UIImage(data: data)
  }

  var body: some View {
    switch item.kind {
    case "user":
      // Native watchOS iMessage-style right-aligned blue chat bubble
      HStack(spacing: 0) {
        Spacer(minLength: 20)
        VStack(alignment: .trailing, spacing: 3.5) {
          if let uiImg = decodedImage {
            Button {
              WatchHaptics.click()
              onPreviewImage(uiImg, item.title ?? "图片预览")
            } label: {
              Image(uiImage: uiImg)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(maxWidth: 118, maxHeight: 74)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
                )
            }
            .buttonStyle(WatchPressableButtonStyle())
          }

          VStack(alignment: .leading, spacing: 2) {
            Text(item.text)
              .font(.system(size: 11.5, weight: .regular))
              .foregroundColor(.white)
              .fixedSize(horizontal: false, vertical: true)

            if item.status == "running" {
              Text("已发送")
                .font(.system(size: 8.5, weight: .medium))
                .foregroundColor(Color.white.opacity(0.72))
            }
          }
          .padding(.horizontal, 9.5)
          .padding(.vertical, 6.5)
          .background(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
              .fill(
                LinearGradient(
                  colors: [
                    Color(red: 0.08, green: 0.49, blue: 0.98),
                    Color(red: 0.33, green: 0.38, blue: 0.92),
                  ],
                  startPoint: .topLeading,
                  endPoint: .bottomTrailing
                )
              )
          )
        }
      }

    case "image":
      HStack(spacing: 0) {
        if (item.title ?? "").hasPrefix("你") {
          Spacer(minLength: 22)
        }
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 4) {
            Image(systemName: "photo.fill")
              .font(.system(size: 9.5, weight: .semibold))
              .foregroundColor(.cyan)
            Text(item.title ?? "图片")
              .font(.system(size: 10, weight: .semibold))
              .foregroundColor(.cyan)
            Spacer()
            Text("点按缩放")
              .font(.system(size: 8.5))
              .foregroundColor(.secondary)
          }
          if let uiImg = decodedImage {
            Button {
              WatchHaptics.click()
              onPreviewImage(uiImg, item.title ?? "图片")
            } label: {
              Image(uiImage: uiImg)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(maxWidth: .infinity, maxHeight: 84)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            .buttonStyle(WatchPressableButtonStyle())
          }
          Text(item.text)
            .font(.system(size: 10.5))
            .foregroundColor(.white)
        }
        .padding(8)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color(white: 0.14))
        )
        if !(item.title ?? "").hasPrefix("你") {
          Spacer(minLength: 14)
        }
      }

    case "diff":
      Button {
        WatchHaptics.click()
        withAnimation(.spring(response: 0.25, dampingFraction: 0.82)) {
          isExpanded.toggle()
        }
      } label: {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 4.5) {
            Image(systemName: "doc.badge.gearshape.fill")
              .font(.system(size: 9.5, weight: .semibold))
              .foregroundColor(.cyan)
            Text(item.text)
              .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
              .foregroundColor(.white)
              .lineLimit(1)
            Spacer(minLength: 2)
            if let add = item.diffAdded, add > 0 {
              Text("+\(add)")
                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                .foregroundColor(Color(red: 0.35, green: 0.92, blue: 0.48))
            }
            if let del = item.diffRemoved, del > 0 {
              Text("-\(del)")
                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                .foregroundColor(Color(red: 1.0, green: 0.46, blue: 0.46))
            }
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
              .font(.system(size: 8, weight: .bold))
              .foregroundColor(.secondary)
          }

          if let detail = item.detail, !detail.isEmpty {
            WatchDiffLineView(rawText: detail, expanded: isExpanded)
          }
        }
        .padding(.horizontal, 8.5)
        .padding(.vertical, 6.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(Color(white: 0.12))
            .overlay(
              RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Color.cyan.opacity(0.24), lineWidth: 0.5)
            )
        )
      }
      .buttonStyle(WatchPressableButtonStyle())

    case "subagent":
      Button {
        WatchHaptics.click()
        withAnimation(.spring(response: 0.25, dampingFraction: 0.82)) {
          isExpanded.toggle()
        }
      } label: {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 4.5) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
              .font(.system(size: 9.5, weight: .semibold))
              .foregroundColor(.indigo)
            Text(item.title ?? "子代理")
              .font(.system(size: 10, weight: .semibold))
              .foregroundColor(.indigo)
              .lineLimit(1)
            Spacer(minLength: 2)
            HStack(spacing: 2.5) {
              Circle()
                .fill(item.status == "running" ? Color.green : Color.secondary)
                .frame(width: 4.5, height: 4.5)
              Text(item.status == "running" ? "运行中" : "已完成")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(item.status == "running" ? .green : .secondary)
            }
          }

          Text(item.text)
            .font(.system(size: 10.5, weight: .medium))
            .foregroundColor(.white)
            .lineLimit(isExpanded ? 6 : 2)
            .multilineTextAlignment(.leading)

          if let detail = item.detail, !detail.isEmpty {
            Text(detail)
              .font(.system(size: 9.5, design: .monospaced))
              .foregroundColor(Color(white: 0.72))
              .lineLimit(isExpanded ? 10 : 2)
              .padding(5)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(
                RoundedRectangle(cornerRadius: 6.5, style: .continuous)
                  .fill(Color.black.opacity(0.40))
              )
          }
        }
        .padding(.horizontal, 8.5)
        .padding(.vertical, 6.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(Color.indigo.opacity(0.14))
            .overlay(
              RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Color.indigo.opacity(0.32), lineWidth: 0.5)
            )
        )
      }
      .buttonStyle(WatchPressableButtonStyle())

    case "tool":
      Button {
        WatchHaptics.click()
        withAnimation(.spring(response: 0.25, dampingFraction: 0.82)) {
          isExpanded.toggle()
        }
      } label: {
        VStack(alignment: .leading, spacing: 3.5) {
          HStack(spacing: 4.5) {
            Image(systemName: "terminal")
              .font(.system(size: 9, weight: .semibold))
              .foregroundColor(.secondary)
            Text(item.title ?? "工具调用")
              .font(.system(size: 9.5, weight: .semibold))
              .foregroundColor(.secondary)
              .lineLimit(1)
            Spacer()
            if item.detail != nil {
              Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 7.5, weight: .bold))
                .foregroundColor(.secondary)
            }
            Image(
              systemName: item.status == "failed"
                ? "xmark.circle.fill"
                : item.status == "running" || item.status == "waiting"
                  ? "bolt.horizontal.circle.fill"
                  : "checkmark.circle.fill"
            )
            .font(.system(size: 9.5))
            .foregroundColor(
              item.status == "failed"
                ? .red
                : item.status == "waiting"
                  ? .orange
                  : .green
            )
          }

          Text(item.text)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundColor(Color(white: 0.92))
            .lineLimit(isExpanded ? 6 : 2)
            .multilineTextAlignment(.leading)

          if let detail = item.detail, !detail.isEmpty, (isExpanded || item.status == "failed") {
            Text(detail)
              .font(.system(size: 9, design: .monospaced))
              .foregroundColor(Color(white: 0.68))
              .lineLimit(isExpanded ? 12 : 4)
              .padding(5)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(
                RoundedRectangle(cornerRadius: 6.5, style: .continuous)
                  .fill(Color.black.opacity(0.45))
              )
          }
        }
        .padding(.horizontal, 8.5)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color(white: 0.11))
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.white.opacity(0.07), lineWidth: 0.5)
            )
        )
      }
      .buttonStyle(WatchPressableButtonStyle())

    case "thought":
      Button {
        WatchHaptics.click()
        withAnimation(.spring(response: 0.25, dampingFraction: 0.82)) {
          isExpanded.toggle()
        }
      } label: {
        VStack(alignment: .leading, spacing: 2.5) {
          HStack(spacing: 4) {
            Image(systemName: "sparkles")
              .font(.system(size: 9, weight: .semibold))
              .foregroundColor(.secondary)
            Text(item.title ?? "思考")
              .font(.system(size: 9.5, weight: .medium))
              .foregroundColor(.secondary)
            Spacer()
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
              .font(.system(size: 7.5, weight: .bold))
              .foregroundColor(.secondary)
          }
          Text(item.text)
            .font(.system(size: 10.5))
            .foregroundColor(Color(white: 0.72))
            .lineLimit(isExpanded ? 10 : 2)
            .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, 8.5)
        .padding(.vertical, 5.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 9.5, style: .continuous)
            .fill(Color(white: 0.09))
        )
      }
      .buttonStyle(WatchPressableButtonStyle())

    case "plan":
      VStack(alignment: .leading, spacing: 3.5) {
        HStack(spacing: 4) {
          Image(systemName: "checklist")
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundColor(.green)
          Text(item.title ?? "执行计划")
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.green)
        }
        Text(item.text)
          .font(.system(size: 10.5))
          .foregroundColor(Color(white: 0.88))
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, 8.5)
      .padding(.vertical, 6.5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(Color(white: 0.12))
          .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
              .strokeBorder(Color.green.opacity(0.25), lineWidth: 0.5)
          )
      )

    case "question":
      VStack(alignment: .leading, spacing: 3.5) {
        HStack(spacing: 4) {
          Image(systemName: "questionmark.bubble.fill")
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundColor(.orange)
          Text(item.title ?? "问题")
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.orange)
        }
        Text(item.text)
          .font(.system(size: 11, weight: .medium))
          .foregroundColor(.white)
          .fixedSize(horizontal: false, vertical: true)
        if let detail = item.detail, !detail.isEmpty {
          Text(detail)
            .font(.system(size: 10))
            .foregroundColor(Color(white: 0.78))
        }
      }
      .padding(.horizontal, 8.5)
      .padding(.vertical, 6.5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(Color.orange.opacity(0.14))
          .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
              .strokeBorder(Color.orange.opacity(0.35), lineWidth: 0.5)
          )
      )

    case "error":
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 4) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundColor(.red)
          Text(item.title ?? "错误")
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.red)
        }
        Text(item.text)
          .font(.system(size: 10.5))
          .foregroundColor(.white)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, 8.5)
      .padding(.vertical, 6.5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(Color.red.opacity(0.16))
          .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
              .strokeBorder(Color.red.opacity(0.35), lineWidth: 0.5)
          )
      )

    default:
      // Native watchOS iMessage-style left-aligned Agent bubble
      HStack(alignment: .top, spacing: 5) {
        WatchAgentBadge(agent: agent, size: 17)
          .padding(.top, 2)

        VStack(alignment: .leading, spacing: 3) {
          if let uiImg = decodedImage {
            Button {
              WatchHaptics.click()
              onPreviewImage(uiImg, agent.name)
            } label: {
              Image(uiImage: uiImg)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(maxWidth: 120, maxHeight: 76)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            .buttonStyle(WatchPressableButtonStyle())
          }

          Text(item.text)
            .font(.system(size: 11.5))
            .foregroundColor(.white)
            .fixedSize(horizontal: false, vertical: true)

          if item.status == "running" {
            HStack(spacing: 3) {
              Circle()
                .fill(Color.green)
                .frame(width: 4, height: 4)
              Text("正在输出…")
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(.green)
            }
          }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6.5)
        .background(
          RoundedRectangle(cornerRadius: 13, style: .continuous)
            .fill(Color(white: 0.14))
            .overlay(
              RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
            )
        )

        Spacer(minLength: 10)
      }
    }
  }
}

struct WatchImagePreviewSheet: View {
  let image: UIImage
  let title: String
  @Environment(\.dismiss) private var dismiss
  @State private var crownScale: Double = 1.0

  var body: some View {
    NavigationStack {
      ZStack(alignment: .bottomTrailing) {
        Color.black.ignoresSafeArea()

        ScrollView([.horizontal, .vertical], showsIndicators: false) {
          Image(uiImage: image)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: 176 * CGFloat(crownScale))
            .padding(6)
        }
        .focusable(true)
        .digitalCrownRotation(
          $crownScale,
          from: 1.0,
          through: 3.5,
          by: 0.15,
          sensitivity: .medium,
          isContinuous: false,
          isHapticFeedbackEnabled: true
        )

        Text("\(String(format: "%.1fx", crownScale))")
          .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
          .foregroundColor(.secondary)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(Color.black.opacity(0.65)))
          .padding(.trailing, 8)
          .padding(.bottom, 4)
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button {
            WatchHaptics.click()
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 11, weight: .bold))
          }
        }
      }
    }
  }
}

struct WatchSessionConfigSheet: View {
  let session: WatchSession
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss

  private var configOptions: [WatchConfigOption] {
    if let opts = session.configOptions, !opts.isEmpty {
      return opts
    }
    return [
      WatchConfigOption(
        id: "mode",
        name: "沙盒与权限模式",
        category: "mode",
        current: session.mode ?? "default",
        currentLabel: session.mode ?? "标准确认",
        values: [
          WatchConfigOptionValue(value: "workspace-write", name: "工作区沙盒", description: "允许修改当前工作区文件"),
          WatchConfigOptionValue(value: "read-only", name: "只读沙盒", description: "仅分析代码，写操作需确认"),
          WatchConfigOptionValue(value: "acceptEdits", name: "自动批准修改", description: "自动允许文件编辑"),
        ]
      )
    ]
  }

  var body: some View {
    List {
      ForEach(configOptions) { opt in
        Section(opt.name) {
          ForEach(opt.values) { val in
            let isSelected = opt.current == val.value || opt.currentLabel == val.name
            Button {
              store.setSessionConfig(
                sessionId: session.id,
                optionId: opt.id,
                value: val.value,
                label: val.name
              )
              dismiss()
            } label: {
              HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                  Text(val.name)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(.white)
                  if let desc = val.description, !desc.isEmpty {
                    Text(desc)
                      .font(.system(size: 9.5))
                      .foregroundColor(.secondary)
                      .lineLimit(1)
                  }
                }
                Spacer()
                if isSelected {
                  Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.indigo)
                }
              }
            }
          }
        }
      }

      Section("快捷督导与控制") {
        ForEach(WatchQuickPrompt.defaults) { preset in
          Button {
            store.sendPrompt(sessionId: session.id, text: preset.prompt, now: false)
            dismiss()
          } label: {
            Label(preset.label, systemImage: preset.icon)
              .font(.system(size: 11.5, weight: .medium))
          }
        }

        if session.handoff == "can_release" {
          Button {
            store.releaseSession(sessionId: session.id)
            dismiss()
          } label: {
            Label("交还电脑终端", systemImage: "macbook.and.iphone")
              .font(.system(size: 11.5, weight: .medium))
          }
        }

        if session.canCancel {
          Button(role: .destructive) {
            store.cancelSession(sessionId: session.id)
            dismiss()
          } label: {
            Label("停止当前轮次", systemImage: "stop.circle.fill")
              .font(.system(size: 11.5, weight: .semibold))
          }
        }
      }
    }
    .navigationTitle("会话设置")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct WatchScrollTopOffsetKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

struct WatchSessionDetailView: View {
  let sessionId: String
  @ObservedObject var store: WatchSessionStore
  @State private var showingConfigSheet = false
  @State private var previewImageItem: (image: UIImage, title: String)? = nil
  @State private var isComposerExpanded = CommandLine.arguments.contains("--composer-expanded")
  @State private var didInitialScroll = false
  @State private var autoLoadReady = false
  @State private var lastAutoLoadCount = -1
  @State private var anchorItemIdBeforeLoad: String? = nil

  private var session: WatchSession? {
    store.snapshot.sessions.first(where: { $0.id == sessionId })
  }

  private func scrollToBottomOnOpen(proxy: ScrollViewProxy, items: [WatchTimelineItem]) {
    guard !didInitialScroll, !items.isEmpty else { return }
    didInitialScroll = true
    DispatchQueue.main.async {
      proxy.scrollTo("session-bottom-anchor", anchor: .bottom)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
        autoLoadReady = true
      }
    }
  }

  var body: some View {
    Group {
      if let session {
        let agent = WatchAgent(id: session.agent)
        let timelineItems = session.items ?? []
        let isLoadingEarlier = store.loadingEarlierSessionId == session.id

        ZStack(alignment: .bottom) {
          ScrollViewReader { scrollProxy in
            ScrollView {
              VStack(alignment: .leading, spacing: 5.5) {
                GeometryReader { geo in
                  Color.clear.preference(
                    key: WatchScrollTopOffsetKey.self,
                    value: geo.frame(in: .named("watchSessionScroll")).minY
                  )
                }
                .frame(height: 0)

                // Compact Agent + Project + Status + Settings Bar (Tap to configure Sandbox Mode, Model, or Quick Actions)
                Button {
                  WatchHaptics.click()
                  showingConfigSheet = true
                } label: {
                  HStack(spacing: 4.5) {
                    WatchAgentBadge(agent: agent, size: 17)
                    Text(session.project.isEmpty ? agent.name : session.project)
                      .font(.system(size: 10.5, weight: .semibold))
                      .foregroundColor(.white)
                      .lineLimit(1)

                    Spacer(minLength: 2)

                    WatchStatusBadge(session: session)

                    Image(systemName: "slider.horizontal.3")
                      .font(.system(size: 9.5, weight: .semibold))
                      .foregroundColor(.secondary)
                  }
                  .padding(.horizontal, 7)
                  .padding(.vertical, 4.5)
                  .background(
                    RoundedRectangle(cornerRadius: 9.5, style: .continuous)
                      .fill(Color(white: 0.12))
                      .overlay(
                        RoundedRectangle(cornerRadius: 9.5, style: .continuous)
                          .strokeBorder(Color.white.opacity(0.07), lineWidth: 0.5)
                      )
                  )
                }
                .buttonStyle(WatchPressableButtonStyle())

                // Silent automatic loading spinner only while fetching earlier messages
                if isLoadingEarlier {
                  HStack {
                    Spacer()
                    ProgressView()
                      .controlSize(.mini)
                      .scaleEffect(0.72)
                    Spacer()
                  }
                  .frame(height: 12)
                }

                // iMessage-style Conversation & Rich Timeline
                if !timelineItems.isEmpty {
                  ForEach(timelineItems) { item in
                    WatchTimelineItemCard(item: item, agent: agent) { img, title in
                      previewImageItem = (img, title)
                    }
                    .id(item.id)
                  }
                } else {
                  WatchTimelineItemCard(
                    item: WatchTimelineItem(
                      id: "fallback-user",
                      kind: "user",
                      title: "你",
                      text: session.title,
                      detail: nil,
                      status: "completed"
                    ),
                    agent: agent,
                    onPreviewImage: { _, _ in }
                  )
                  WatchTimelineItemCard(
                    item: WatchTimelineItem(
                      id: "fallback-agent",
                      kind: "assistant",
                      title: agent.name,
                      text: session.detailPreview ?? session.subtitle,
                      detail: session.commandPreview,
                      status: session.isRunning ? "running" : "completed"
                    ),
                    agent: agent,
                    onPreviewImage: { _, _ in }
                  )
                }

                // Pending Approval / Decision Card (if waiting for approval)
                if let actions = session.actions, !actions.isEmpty {
                  VStack(alignment: .leading, spacing: 5) {
                    Text(session.promptTitle ?? "需要你的确认")
                      .font(.system(size: 11, weight: .semibold))
                      .foregroundColor(.orange)

                    if let cmd = session.commandPreview, !cmd.isEmpty {
                      WatchCommandSnippet(command: cmd)
                    }

                    ForEach(actions) { action in
                      let isDestructive = action.role == "reject" || action.role == "stop"
                      Button {
                        store.performAction(action)
                      } label: {
                        HStack {
                          Text(action.label)
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                          Spacer()
                          Image(systemName: isDestructive ? "xmark.circle.fill" : "checkmark.circle.fill")
                            .font(.system(size: 11))
                        }
                        .foregroundColor(isDestructive ? Color(red: 1.0, green: 0.48, blue: 0.48) : .white)
                        .padding(.horizontal, 9)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(
                          RoundedRectangle(cornerRadius: 8.5, style: .continuous)
                            .fill(isDestructive ? Color.red.opacity(0.20) : Color.indigo)
                        )
                      }
                      .buttonStyle(WatchPressableButtonStyle())
                      .disabled(store.pendingCommandId != nil)
                    }
                  }
                  .padding(8.5)
                  .background(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                      .fill(Color(white: 0.14))
                      .overlay(
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                          .strokeBorder(Color.orange.opacity(0.45), lineWidth: 0.8)
                      )
                  )
                }

                if session.hasMoreActions == true {
                  Label("更多选项请在手机或电脑处理", systemImage: "iphone")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.vertical, 8)
                }

                Color.clear
                  .frame(height: isComposerExpanded ? 38 : 26)
                  .id("session-bottom-anchor")
              }
              .padding(.horizontal, 6)
              .padding(.top, 2)
              .onAppear {
                store.openSession(sessionId: session.id)
                scrollToBottomOnOpen(proxy: scrollProxy, items: timelineItems)
              }
              .onChange(of: timelineItems.count) { _, _ in
                if !didInitialScroll {
                  scrollToBottomOnOpen(proxy: scrollProxy, items: timelineItems)
                } else if let anchorId = anchorItemIdBeforeLoad {
                  anchorItemIdBeforeLoad = nil
                  DispatchQueue.main.async {
                    scrollProxy.scrollTo(anchorId, anchor: .top)
                  }
                }
              }
            }
            .coordinateSpace(name: "watchSessionScroll")
            .onPreferenceChange(WatchScrollTopOffsetKey.self) { minY in
              guard autoLoadReady else { return }
              if minY >= -24,
                 session.hasEarlier == true,
                 store.loadingEarlierSessionId != session.id,
                 timelineItems.count != lastAutoLoadCount {
                lastAutoLoadCount = timelineItems.count
                anchorItemIdBeforeLoad = timelineItems.first?.id
                store.loadEarlierMessages(sessionId: session.id)
              }
            }
          }

          // Collapsible bottom composer: collapsed into a tiny chin pill by default; expands only when tapped
          if session.handoff == "can_takeover" || session.canSend {
            if isComposerExpanded {
              VStack(spacing: 0) {
                Rectangle()
                  .fill(Color.white.opacity(0.07))
                  .frame(height: 0.5)

                HStack(spacing: 5) {
                  Button {
                    WatchHaptics.click()
                    withAnimation(.spring(response: 0.24, dampingFraction: 0.85)) {
                      isComposerExpanded = false
                    }
                  } label: {
                    Image(systemName: "chevron.down")
                      .font(.system(size: 10, weight: .bold))
                      .foregroundColor(.secondary)
                      .frame(width: 24, height: 25)
                      .background(Circle().fill(Color(white: 0.14)))
                  }
                  .buttonStyle(WatchPressableButtonStyle(scale: 0.92))

                  if session.handoff == "can_takeover" {
                    Button {
                      store.takeoverSession(sessionId: session.id)
                      withAnimation(.spring(response: 0.24, dampingFraction: 0.85)) {
                        isComposerExpanded = false
                      }
                    } label: {
                      HStack(spacing: 4.5) {
                        Image(systemName: "applewatch.radiowaves.left.and.right")
                          .font(.system(size: 10, weight: .semibold))
                          .foregroundColor(.orange)
                        Text("接管至腕表督导")
                          .font(.system(size: 10.5, weight: .medium))
                          .foregroundColor(.white)
                          .lineLimit(1)
                        Spacer(minLength: 2)
                        Image(systemName: "arrow.right.circle.fill")
                          .font(.system(size: 13.5, weight: .semibold))
                          .foregroundColor(.orange)
                      }
                      .padding(.leading, 8)
                      .padding(.trailing, 5)
                      .frame(maxWidth: .infinity, minHeight: 44)
                      .background(Capsule().fill(Color(white: 0.14)))
                    }
                    .buttonStyle(WatchPressableButtonStyle(scale: 0.97))
                  } else if session.canSend {
                    #if os(watchOS)
                    TextFieldLink(prompt: Text("发送给 \(agent.name)…")) {
                      HStack(spacing: 4.5) {
                        Image(systemName: "waveform.and.mic")
                          .font(.system(size: 10, weight: .semibold))
                          .foregroundColor(Color(red: 0.45, green: 0.52, blue: 0.98))
                        Text("发消息或语音…")
                          .font(.system(size: 10.5, weight: .regular))
                          .foregroundColor(Color(white: 0.72))
                          .lineLimit(1)
                        Spacer(minLength: 2)
                        Image(systemName: "arrow.up.circle.fill")
                          .font(.system(size: 14, weight: .semibold))
                          .foregroundColor(Color(red: 0.35, green: 0.48, blue: 0.98))
                      }
                      .padding(.leading, 8)
                      .padding(.trailing, 5)
                      .frame(maxWidth: .infinity, minHeight: 44)
                      .background(Capsule().fill(Color(white: 0.14)))
                    } onSubmit: { text in
                      store.sendPrompt(sessionId: session.id, text: text, now: false)
                      isComposerExpanded = false
                    }
                    .buttonStyle(WatchPressableButtonStyle(scale: 0.97))
                    #endif
                  }
                }
                .padding(.horizontal, 12)
                .padding(.top, 4)
                .padding(.bottom, 5)
              }
              .background(Color.black.opacity(0.95))
              .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
              Button {
                WatchHaptics.click()
                withAnimation(.spring(response: 0.25, dampingFraction: 0.84)) {
                  isComposerExpanded = true
                }
              } label: {
                HStack(spacing: 3.5) {
                  Image(
                    systemName: session.handoff == "can_takeover"
                      ? "applewatch.radiowaves.left.and.right"
                      : "chevron.up"
                  )
                  .font(.system(size: 8, weight: .bold))
                  .foregroundColor(
                    session.handoff == "can_takeover"
                      ? .orange
                      : Color(red: 0.48, green: 0.55, blue: 0.98)
                  )
                  Text(session.handoff == "can_takeover" ? "接管" : "发消息")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundColor(Color(white: 0.82))
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 3)
                .background(
                  Capsule()
                    .fill(Color(white: 0.13).opacity(0.92))
                    .overlay(
                      Capsule()
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
                    )
                )
              }
              .buttonStyle(WatchPressableButtonStyle(scale: 0.94))
              .frame(minHeight: 40)
              .contentShape(Rectangle())
              .padding(.bottom, 2)
            }
          }
        }
        .ignoresSafeArea(edges: .bottom)
      } else {
        Text("该会话已结束")
          .font(.system(size: 12))
          .foregroundColor(.secondary)
          .padding(.top, 28)
      }
    }
    .modifier(WatchCommandFeedback(store: store))
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $showingConfigSheet) {
      if let session {
        NavigationStack {
          WatchSessionConfigSheet(session: session, store: store)
        }
      }
    }
    .sheet(
      isPresented: Binding(
        get: { previewImageItem != nil },
        set: { if !$0 { previewImageItem = nil } }
      )
    ) {
      if let preview = previewImageItem {
        WatchImagePreviewSheet(image: preview.image, title: preview.title)
      }
    }
  }
}

struct WatchTerminalDetailView: View {
  let terminalId: String
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss
  @State private var isInputExpanded = false

  private var terminal: WatchTerminal? {
    store.snapshot.terminals.first(where: { $0.id == terminalId })
  }

  private let quickCommands: [(label: String, cmd: String)] = [
    ("git status", "git status"),
    ("pnpm test", "pnpm test"),
    ("git diff", "git diff --stat"),
    ("ls -la", "ls -la"),
  ]

  var body: some View {
    Group {
      if let terminal {
        ZStack(alignment: .bottom) {
          ScrollView {
            VStack(alignment: .leading, spacing: 6) {
              // Terminal Output Log (Digital Crown Scrollable)
              VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                  WatchAgentBadge(agent: WatchAgent(id: "terminal"), size: 16)
                  Text(terminal.cwd ?? terminal.project)
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                  Spacer()
                  Button {
                    store.openTerminal(terminalId: terminal.id)
                    store.requestRefresh()
                  } label: {
                    Image(systemName: "arrow.clockwise")
                      .font(.system(size: 9.5, weight: .semibold))
                      .foregroundColor(.secondary)
                  }
                  .buttonStyle(WatchPressableButtonStyle())
                }

                Text(
                  (terminal.outputPreview?.isEmpty == false)
                    ? terminal.outputPreview!
                    : "$ \(terminal.command ?? terminal.title)\n(等待终端输出…)"
                )
                .font(.system(size: 9.5, weight: .regular, design: .monospaced))
                .foregroundColor(Color(red: 0.84, green: 0.94, blue: 0.86))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
              }
              .padding(8)
              .background(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                  .fill(Color(white: 0.08))
                  .overlay(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                      .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
                  )
              )

              // Quick Shell Presets
              LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 5), GridItem(.flexible(), spacing: 5)],
                spacing: 5
              ) {
                ForEach(quickCommands, id: \.cmd) { item in
                  Button {
                    store.sendTerminalInput(terminalId: terminal.id, data: item.cmd + "\n")
                  } label: {
                    Text(item.label)
                      .font(.system(size: 10, weight: .medium, design: .monospaced))
                      .foregroundColor(.white)
                      .lineLimit(1)
                      .frame(maxWidth: .infinity, minHeight: 44)
                      .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                          .fill(Color(white: 0.14))
                      )
                  }
                  .buttonStyle(WatchPressableButtonStyle())
                }
              }

              // Interrupt (Ctrl+C) & Close Terminal
              HStack(spacing: 6) {
                Button {
                  store.sendTerminalInput(terminalId: terminal.id, data: "\u{0003}")
                } label: {
                  Text("Ctrl+C 中断")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(.orange)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(
                      RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.orange.opacity(0.16))
                    )
                }
                .buttonStyle(WatchPressableButtonStyle())

                Button {
                  store.closeTerminal(terminalId: terminal.id)
                  dismiss()
                } label: {
                  Text("关闭终端")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(Color(red: 1.0, green: 0.45, blue: 0.45))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(
                      RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.red.opacity(0.16))
                    )
                }
                .buttonStyle(WatchPressableButtonStyle())
              }

              Color.clear.frame(height: isInputExpanded ? 34 : 20)
            }
            .padding(.horizontal, 6)
            .padding(.top, 2)
            .onAppear {
              store.openTerminal(terminalId: terminal.id)
            }
          }

          #if os(watchOS)
          if isInputExpanded {
            VStack(spacing: 0) {
              Rectangle()
                .fill(Color.white.opacity(0.07))
                .frame(height: 0.5)

              HStack(spacing: 5) {
                Button {
                  WatchHaptics.click()
                  withAnimation(.spring(response: 0.24, dampingFraction: 0.85)) {
                    isInputExpanded = false
                  }
                } label: {
                  Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.secondary)
                    .frame(width: 24, height: 25)
                    .background(Circle().fill(Color(white: 0.14)))
                }
                .buttonStyle(WatchPressableButtonStyle(scale: 0.92))

                TextFieldLink(prompt: Text("输入 Shell 命令…")) {
                  HStack(spacing: 4.5) {
                    Text("$")
                      .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                      .foregroundColor(.green)
                    Text("输入 Shell 命令…")
                      .font(.system(size: 10.5, weight: .regular))
                      .foregroundColor(Color(white: 0.72))
                      .lineLimit(1)
                    Spacer(minLength: 2)
                    Image(systemName: "arrow.up.circle.fill")
                      .font(.system(size: 14, weight: .semibold))
                      .foregroundColor(.green)
                  }
                  .padding(.leading, 8)
                  .padding(.trailing, 5)
                  .frame(maxWidth: .infinity, minHeight: 44)
                  .background(Capsule().fill(Color(white: 0.14)))
                } onSubmit: { text in
                  let cmd = text.trimmingCharacters(in: .whitespacesAndNewlines)
                  if !cmd.isEmpty {
                    store.sendTerminalInput(terminalId: terminal.id, data: cmd + "\n")
                  }
                  isInputExpanded = false
                }
                .buttonStyle(WatchPressableButtonStyle(scale: 0.97))
              }
              .padding(.horizontal, 12)
              .padding(.top, 4)
              .padding(.bottom, 5)
            }
            .background(Color.black.opacity(0.95))
            .transition(.move(edge: .bottom).combined(with: .opacity))
          } else {
            Button {
              WatchHaptics.click()
              withAnimation(.spring(response: 0.25, dampingFraction: 0.84)) {
                isInputExpanded = true
              }
            } label: {
              HStack(spacing: 3.5) {
                Text("$")
                  .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                  .foregroundColor(.green)
                Text("命令")
                  .font(.system(size: 9.5, weight: .medium))
                  .foregroundColor(Color(white: 0.82))
              }
              .padding(.horizontal, 9)
              .padding(.vertical, 3)
              .background(
                Capsule()
                  .fill(Color(white: 0.13).opacity(0.92))
                  .overlay(
                    Capsule()
                      .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
                  )
              )
            }
            .buttonStyle(WatchPressableButtonStyle(scale: 0.94))
            .padding(.bottom, 2)
          }
          #endif
        }
        .ignoresSafeArea(edges: .bottom)
      } else {
        Text("该终端已关闭")
          .font(.system(size: 12))
          .foregroundColor(.secondary)
          .padding(.top, 28)
      }
    }
    .modifier(WatchCommandFeedback(store: store))
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct WatchQuickAddSheet: View {
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss
  let onNewSession: () -> Void
  let onNewTerminal: () -> Void
  let onOpenComputers: () -> Void
  let onOpenComplications: () -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: 6) {
        Button {
          WatchHaptics.click()
          dismiss()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            onNewSession()
          }
        } label: {
          HStack(spacing: 8) {
            ZStack {
              Circle()
                .fill(Color.indigo.opacity(0.28))
                .frame(width: 26, height: 26)
              Image(systemName: "plus.bubble.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.indigo)
            }
            VStack(alignment: .leading, spacing: 1) {
              Text("新建 Agent 会话")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.white)
              Text("选择 Claude / Codex / Gemini 发起任务")
                .font(.system(size: 9.5))
                .foregroundColor(.secondary)
                .lineLimit(1)
            }
            Spacer()
          }
          .padding(.horizontal, 9)
          .padding(.vertical, 7)
          .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
              .fill(Color(white: 0.14))
          )
        }
        .buttonStyle(WatchPressableButtonStyle())

        Button {
          WatchHaptics.click()
          dismiss()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            onNewTerminal()
          }
        } label: {
          HStack(spacing: 8) {
            ZStack {
              Circle()
                .fill(Color.green.opacity(0.22))
                .frame(width: 26, height: 26)
              Image(systemName: "terminal.fill")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(.green)
            }
            VStack(alignment: .leading, spacing: 1) {
              Text("新建交互终端")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.white)
              Text("启动远端 Shell 并查看实时输出")
                .font(.system(size: 9.5))
                .foregroundColor(.secondary)
                .lineLimit(1)
            }
            Spacer()
          }
          .padding(.horizontal, 9)
          .padding(.vertical, 7)
          .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
              .fill(Color(white: 0.14))
          )
        }
        .buttonStyle(WatchPressableButtonStyle())

        Button {
          WatchHaptics.click()
          dismiss()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            onOpenComplications()
          }
        } label: {
          HStack(spacing: 8) {
            ZStack {
              Circle()
                .fill(Color.orange.opacity(0.22))
                .frame(width: 26, height: 26)
              Image(systemName: "applewatch.watchface")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.orange)
            }
            VStack(alignment: .leading, spacing: 1) {
              Text("表盘组件与智能叠放")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.white)
              Text("预览圆形、矩形、边角表盘与叠放卡片")
                .font(.system(size: 9.5))
                .foregroundColor(.secondary)
                .lineLimit(1)
            }
            Spacer()
          }
          .padding(.horizontal, 9)
          .padding(.vertical, 7)
          .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
              .fill(Color(white: 0.14))
          )
        }
        .buttonStyle(WatchPressableButtonStyle())

        Button {
          WatchHaptics.click()
          dismiss()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            onOpenComputers()
          }
        } label: {
          HStack(spacing: 8) {
            ZStack {
              Circle()
                .fill(Color.cyan.opacity(0.22))
                .frame(width: 26, height: 26)
              Image(systemName: "macbook")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(.cyan)
            }
            VStack(alignment: .leading, spacing: 1) {
              Text("切换电脑 · \(store.snapshot.computerName)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(1)
              Text("刷新或切换已配对的在线电脑")
                .font(.system(size: 9.5))
                .foregroundColor(.secondary)
                .lineLimit(1)
            }
            Spacer()
          }
          .padding(.horizontal, 9)
          .padding(.vertical, 7)
          .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
              .fill(Color(white: 0.14))
          )
        }
        .buttonStyle(WatchPressableButtonStyle())
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 10)
    }
    .navigationTitle("快捷操作")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct WatchComplicationsPreviewSheet: View {
  @ObservedObject var store: WatchSessionStore

  var body: some View {
    let snap = store.snapshot.sessions.isEmpty ? WatchSnapshot.previewSample : store.snapshot
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text("智能叠放 (Smart Stack)")
          .font(.system(size: 10, weight: .semibold))
          .foregroundColor(.secondary)

        VStack(alignment: .leading, spacing: 3) {
          let top = snap.sessions.first
          let agent = WatchAgent(id: top?.agent ?? "antigravity")
          HStack(spacing: 5) {
            WatchAgentBadge(agent: agent, size: 16)
            Text(top != nil ? "\(agent.name) · \(top!.project)" : "LinkShell · \(snap.computerName)")
              .font(.system(size: 11, weight: .semibold))
              .foregroundColor(.white)
              .lineLimit(1)
            Spacer()
            Text(snap.waitingCount > 0 ? "\(snap.waitingCount) 待确认" : "\(snap.runningCount) 运行中")
              .font(.system(size: 9.5, weight: .bold))
              .foregroundColor(snap.waitingCount > 0 ? .orange : .green)
          }
          Text(top?.title ?? snap.statusLabel)
            .font(.system(size: 12, weight: .bold))
            .foregroundColor(.white)
            .lineLimit(1)
          Text(top?.promptTitle ?? top?.detailPreview ?? top?.subtitle ?? "实时同步电脑 Agent 状态")
            .font(.system(size: 10.5))
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
        .padding(9)
        .background(
          RoundedRectangle(cornerRadius: 13, style: .continuous)
            .fill(Color(white: 0.14))
            .overlay(
              RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(Color.indigo.opacity(0.35), lineWidth: 0.6)
            )
        )

        Text("表盘复杂功能 (4 种尺寸)")
          .font(.system(size: 10, weight: .semibold))
          .foregroundColor(.secondary)

        HStack(spacing: 10) {
          VStack(spacing: 4) {
            ZStack {
              Circle()
                .fill(Color(white: 0.16))
                .frame(width: 42, height: 42)
              VStack(spacing: 1) {
                Image(systemName: "waveform")
                  .font(.system(size: 11, weight: .bold))
                  .foregroundColor(.green)
                Text("\(max(1, snap.runningCount + snap.waitingCount))")
                  .font(.system(size: 12, weight: .bold, design: .rounded))
              }
            }
            Text("圆形 Circular")
              .font(.system(size: 9))
              .foregroundColor(.secondary)
          }
          .frame(maxWidth: .infinity)

          VStack(spacing: 4) {
            ZStack {
              Circle()
                .fill(Color(white: 0.16))
                .frame(width: 42, height: 42)
              VStack(spacing: 0) {
                Image(systemName: "bolt.horizontal.fill")
                  .font(.system(size: 11, weight: .bold))
                  .foregroundColor(.orange)
                Text("\(snap.sessions.count)")
                  .font(.system(size: 11, weight: .bold, design: .rounded))
              }
            }
            Text("边角 Corner")
              .font(.system(size: 9))
              .foregroundColor(.secondary)
          }
          .frame(maxWidth: .infinity)
        }
        .padding(7)
        .background(
          RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(Color(white: 0.11))
        )

        VStack(alignment: .leading, spacing: 2) {
          Text("顶部内联 (Inline)")
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(.secondary)
          Text(
            snap.waitingCount > 0
              ? "⚡ LinkShell · \(snap.waitingCount) 待确认"
              : "● LinkShell · \(max(1, snap.runningCount)) 运行中"
          )
          .font(.system(size: 11, weight: .semibold, design: .rounded))
          .foregroundColor(.white)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color(white: 0.12))
        )
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 12)
    }
    .navigationTitle("表盘与智能叠放")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct WatchNewSessionSheet: View {
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss
  @State private var selectedAgent: String = "claude"
  @State private var selectedCwd: String = ""

  private var agentIds: [String] {
    let list = store.snapshot.availableAgents ?? ["claude", "codex", "gemini", "cursor", "opencode"]
    return list.isEmpty ? ["claude", "codex", "gemini", "cursor"] : list
  }

  private var workspaces: [WatchWorkspace] {
    if let ws = store.snapshot.workspaces, !ws.isEmpty {
      return ws
    }
    if let firstCwd = store.snapshot.sessions.first?.cwd, !firstCwd.isEmpty {
      return [WatchWorkspace(path: firstCwd, name: store.snapshot.sessions.first?.project ?? "当前项目")]
    }
    return [WatchWorkspace(path: "~", name: "默认工作区")]
  }

  private var activeCwd: String {
    if !selectedCwd.isEmpty { return selectedCwd }
    return workspaces.first?.path ?? "~"
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 7) {
        Text("选择 Agent")
          .font(.system(size: 10, weight: .semibold))
          .foregroundColor(.secondary)

        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(agentIds, id: \.self) { id in
              let agent = WatchAgent(id: id)
              let isSelected = selectedAgent == id
              Button {
                WatchHaptics.click()
                selectedAgent = id
              } label: {
                HStack(spacing: 5) {
                  WatchAgentBadge(agent: agent, size: 19)
                  Text(agent.name)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5.5)
                .background(
                  RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(isSelected ? Color.indigo.opacity(0.45) : Color(white: 0.14))
                    .overlay(
                      RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(isSelected ? Color.indigo : Color.white.opacity(0.08), lineWidth: 1)
                    )
                )
              }
              .buttonStyle(WatchPressableButtonStyle())
            }
          }
        }

        Text("工作目录")
          .font(.system(size: 10, weight: .semibold))
          .foregroundColor(.secondary)

        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(workspaces.prefix(5)) { ws in
              let isSelected = activeCwd == ws.path
              Button {
                WatchHaptics.click()
                selectedCwd = ws.path
              } label: {
                HStack(spacing: 4) {
                  Image(systemName: "folder.fill")
                    .font(.system(size: 9.5))
                    .foregroundColor(isSelected ? .indigo : .secondary)
                  Text(ws.name)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5.5)
                .background(
                  RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(isSelected ? Color.indigo.opacity(0.28) : Color(white: 0.13))
                    .overlay(
                      RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(isSelected ? Color.indigo : Color.white.opacity(0.08), lineWidth: 0.8)
                    )
                )
              }
              .buttonStyle(WatchPressableButtonStyle())
            }
          }
        }

        #if os(watchOS)
        TextFieldLink(prompt: Text("输入新会话任务…")) {
          HStack(spacing: 5) {
            Image(systemName: "waveform.and.mic")
              .font(.system(size: 11, weight: .semibold))
            Text("语音或手写发起会话")
              .font(.system(size: 11.5, weight: .semibold))
          }
          .foregroundColor(.white)
          .frame(maxWidth: .infinity, minHeight: 31)
          .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .fill(Color.indigo)
          )
        } onSubmit: { text in
          store.createSession(agent: selectedAgent, cwd: activeCwd, prompt: text)
          dismiss()
        }
        .buttonStyle(WatchPressableButtonStyle())
        #endif

        Button {
          store.createSession(
            agent: selectedAgent,
            cwd: activeCwd,
            prompt: "请检查当前仓库的 git status 和最近改动，并简明汇报。"
          )
          dismiss()
        } label: {
          Text("快速启动：检查项目状态")
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(.white)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
              RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color(white: 0.15))
            )
        }
        .buttonStyle(WatchPressableButtonStyle())
      }
      .padding(.horizontal, 6)
      .padding(.top, 2)
      .padding(.bottom, 10)
    }
    .modifier(WatchCommandFeedback(store: store))
    .navigationTitle("新建会话")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear {
      if let first = agentIds.first {
        selectedAgent = first
      }
      if let firstWs = workspaces.first {
        selectedCwd = firstWs.path
      }
    }
  }
}

struct WatchNewTerminalSheet: View {
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss
  @State private var selectedCwd: String = ""

  private var workspaces: [WatchWorkspace] {
    if let ws = store.snapshot.workspaces, !ws.isEmpty {
      return ws
    }
    if let firstCwd = store.snapshot.sessions.first?.cwd, !firstCwd.isEmpty {
      return [WatchWorkspace(path: firstCwd, name: store.snapshot.sessions.first?.project ?? "当前项目")]
    }
    return [WatchWorkspace(path: "~", name: "默认工作区")]
  }

  private var activeCwd: String {
    if !selectedCwd.isEmpty { return selectedCwd }
    return workspaces.first?.path ?? "~"
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 7) {
        Text("工作目录")
          .font(.system(size: 10.5, weight: .semibold))
          .foregroundColor(.secondary)

        ForEach(workspaces.prefix(3)) { ws in
          let isSelected = activeCwd == ws.path
          Button {
            WatchHaptics.click()
            selectedCwd = ws.path
          } label: {
            HStack(spacing: 6) {
              Image(systemName: "folder.fill")
                .font(.system(size: 10.5))
                .foregroundColor(isSelected ? .green : .secondary)
              Text(ws.name)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundColor(.white)
                .lineLimit(1)
              Spacer()
              if isSelected {
                Image(systemName: "checkmark")
                  .font(.system(size: 10, weight: .bold))
                  .foregroundColor(.green)
              }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(
              RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(isSelected ? Color.green.opacity(0.18) : Color(white: 0.13))
            )
          }
          .buttonStyle(WatchPressableButtonStyle())
        }

        Button {
          store.createTerminal(cwd: activeCwd, command: nil)
          dismiss()
        } label: {
          HStack(spacing: 5) {
            Image(systemName: "terminal.fill")
              .font(.system(size: 11, weight: .semibold))
            Text("新建交互终端 (Shell)")
              .font(.system(size: 11.5, weight: .semibold))
          }
          .foregroundColor(.black)
          .frame(maxWidth: .infinity, minHeight: 31)
          .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .fill(Color.green)
          )
        }
        .buttonStyle(WatchPressableButtonStyle())

        Button {
          store.createTerminal(cwd: activeCwd, command: "git status")
          dismiss()
        } label: {
          Text("新建并运行 git status")
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundColor(.white)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(white: 0.15))
            )
        }
        .buttonStyle(WatchPressableButtonStyle())

        #if os(watchOS)
        TextFieldLink(prompt: Text("输入终端启动命令…")) {
          Text("输入命令并新建终端…")
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(.white)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(white: 0.15))
            )
        } onSubmit: { text in
          store.createTerminal(cwd: activeCwd, command: text)
          dismiss()
        }
        .buttonStyle(WatchPressableButtonStyle())
        #endif
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 12)
    }
    .modifier(WatchCommandFeedback(store: store))
    .navigationTitle("新建终端")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct WatchComputerSwitcherSheet: View {
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List {
      NavigationLink { WatchConnectionView(store: store) } label: { Label("连接设置", systemImage: "network") }
      Section("可用电脑") {
        if store.snapshot.computers.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text("尚未收到电脑列表")
              .font(.system(size: 11.5, weight: .semibold))
              .foregroundColor(.white)
            Text(store.independent ? "在连接设置中登录账号，或输入电脑上的六位配对码。" : "请在已配对的 iPhone 上打开 LinkShell，电脑与会话将自动同步。")
              .font(.system(size: 10.5))
              .foregroundColor(.secondary)
          }
          .padding(.vertical, 4)
        } else {
          ForEach(store.snapshot.computers) { computer in
            Button {
              store.selectComputer(computerKey: computer.key)
              dismiss()
            } label: {
              HStack(spacing: 8) {
                Image(systemName: "macbook")
                  .font(.system(size: 12, weight: .medium))
                  .foregroundColor(computer.online ? .green : .secondary)
                VStack(alignment: .leading, spacing: 1) {
                  Text(computer.name)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)
                  Text(computer.online ? "在线" : "离线")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                }
                Spacer(minLength: 2)
                if computer.selected {
                  Image(systemName: "checkmark")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(.indigo)
                }
              }
            }
          }
        }
      }

      Section {
        Button {
          store.requestRefresh()
          dismiss()
        } label: {
          Label("立即同步状态", systemImage: "arrow.clockwise")
            .font(.system(size: 12, weight: .medium))
        }
      }
    }
    .modifier(WatchCommandFeedback(store: store))
    .navigationTitle("选择电脑")
    .navigationBarTitleDisplayMode(.inline)
  }
}

public struct LinkShellWatchRootView: View {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var store: WatchSessionStore
  @State private var showingConnection = ProcessInfo.processInfo.arguments.contains { ["--connection", "--login", "--pair"].contains($0) }
  @State private var showingQuickAdd: Bool
  @State private var showingComputers: Bool
  @State private var showingNewSession: Bool
  @State private var showingNewTerminal: Bool
  @State private var showingComplications: Bool
  @State private var detailSessionId: String?
  @State private var detailTerminalId: String?

  @MainActor
  public init(store: WatchSessionStore? = nil) {
    let resolved = store ?? WatchSessionStore()
    self._store = StateObject(wrappedValue: resolved)

    var initialQuickAdd = false
    var initialComputers = false
    var initialNewSession = false
    var initialNewTerminal = false
    var initialComplications = false
    var initialDetailSession: String? = nil
    var initialDetailTerminal: String? = nil

    for arg in ProcessInfo.processInfo.arguments {
      if arg == "--quick-add" {
        initialQuickAdd = true
      } else if arg == "--computers" {
        initialComputers = true
      } else if arg == "--new-session" {
        initialNewSession = true
      } else if arg == "--new-terminal" {
        initialNewTerminal = true
      } else if arg == "--complications" {
        initialComplications = true
      } else if arg == "--detail" {
        initialDetailSession = resolved.snapshot.sessions.first?.id
      } else if arg.hasPrefix("--session=") {
        initialDetailSession = String(arg.dropFirst("--session=".count))
      } else if arg == "--terminal" {
        initialDetailTerminal = resolved.snapshot.terminals.first?.id
      } else if arg.hasPrefix("--terminal=") {
        initialDetailTerminal = String(arg.dropFirst("--terminal=".count))
      }
    }

    self._showingQuickAdd = State(initialValue: initialQuickAdd)
    self._showingComputers = State(initialValue: initialComputers)
    self._showingNewSession = State(initialValue: initialNewSession)
    self._showingNewTerminal = State(initialValue: initialNewTerminal)
    self._showingComplications = State(initialValue: initialComplications)
    self._detailSessionId = State(initialValue: initialDetailSession)
    self._detailTerminalId = State(initialValue: initialDetailTerminal)
  }

  public var body: some View {
    NavigationStack {
      ZStack(alignment: .top) {
        WatchWorkspaceHomeView(
          store: store,
          onOpenSession: { id in detailSessionId = id },
          onOpenTerminal: { id in detailTerminalId = id },
          onOpenComputers: { showingComputers = true },
          onOpenQuickAdd: { showingQuickAdd = true }
        )


      }
      .onAppear { store.setForeground(scenePhase == .active) }
      .onChange(of: scenePhase) { _, phase in store.setForeground(phase == .active) }
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(item: $detailSessionId) { sessionId in
        WatchSessionDetailView(sessionId: sessionId, store: store)
      }
      .navigationDestination(item: $detailTerminalId) { terminalId in
        WatchTerminalDetailView(terminalId: terminalId, store: store)
      }
      .sheet(isPresented: $showingConnection) {
        NavigationStack {
          if ProcessInfo.processInfo.arguments.contains("--login") { WatchLoginView(client: store.direct) }
          else if ProcessInfo.processInfo.arguments.contains("--pair") { WatchPairView(client: store.direct) }
          else { WatchConnectionView(store: store) }
        }
      }
      .sheet(isPresented: $showingQuickAdd) {
        NavigationStack {
          WatchQuickAddSheet(
            store: store,
            onNewSession: { showingNewSession = true },
            onNewTerminal: { showingNewTerminal = true },
            onOpenComputers: { showingComputers = true },
            onOpenComplications: { showingComplications = true }
          )
        }
      }
      .sheet(isPresented: $showingComputers) {
        NavigationStack {
          WatchComputerSwitcherSheet(store: store)
        }
      }
      .sheet(isPresented: $showingNewSession) {
        NavigationStack {
          WatchNewSessionSheet(store: store)
        }
      }
      .sheet(isPresented: $showingNewTerminal) {
        NavigationStack {
          WatchNewTerminalSheet(store: store)
        }
      }
      .sheet(isPresented: $showingComplications) {
        NavigationStack {
          WatchComplicationsPreviewSheet(store: store)
        }
      }
    }
  }
}

@main
struct LinkShellWatchApp: App {
  var body: some Scene {
    WindowGroup {
      LinkShellWatchRootView()
    }
  }
}
