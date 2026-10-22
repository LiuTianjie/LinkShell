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

/// The one card look used everywhere: rounded, slightly raised from the black background.
struct WatchCardBackground: ViewModifier {
  var tint: Color? = nil
  var radius: CGFloat = 14

  func body(content: Content) -> some View {
    content
      .background((tint?.opacity(0.16) ?? Color(white: 0.12)), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(tint?.opacity(0.40) ?? Color.white.opacity(0.07), lineWidth: 0.5)
      )
  }
}

extension View {
  func watchCard(tint: Color? = nil, radius: CGFloat = 14) -> some View {
    modifier(WatchCardBackground(tint: tint, radius: radius))
  }
}

struct WatchStatusBadge: View {
  let session: WatchSession

  var body: some View {
    let color = WatchPhaseStyle.color(for: session.phase)
    HStack(spacing: 3) {
      if !session.needsAttention, let plan = session.planProgress, plan.total > 0 {
        ZStack {
          Circle().stroke(color.opacity(0.24), lineWidth: 1.5)
          Circle()
            .trim(from: 0, to: plan.fraction)
            .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .rotationEffect(.degrees(-90))
        }
        .frame(width: 9, height: 9)
        Text("\(plan.completed)/\(plan.total)").monospacedDigit()
      } else {
        Circle().fill(color).frame(width: 5, height: 5)
        Text(WatchPhaseStyle.label(for: session.phase))
      }
    }
    .font(.footnote.weight(.semibold))
    .foregroundStyle(color)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(Capsule().fill(color.opacity(0.15)))
    .accessibilityElement(children: .combine)
  }
}

struct WatchCommandSnippet: View {
  let command: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text("$").foregroundStyle(.secondary)
      Text(command)
        .foregroundStyle(Color(white: 0.90))
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .font(.system(.footnote, design: .monospaced))
    .padding(.horizontal, 7)
    .padding(.vertical, 4)
    .background(Color.black.opacity(0.42), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    .privacySensitive()
  }
}

// A single card opens the full request so no approval options are hidden on the overview.
struct WatchSessionRowCard: View {
  let session: WatchSession
  @ObservedObject var store: WatchSessionStore
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          WatchAgentBadge(agent: WatchAgent(id: session.agent), size: 22)
          Text(session.project.isEmpty ? WatchAgent(id: session.agent).name : session.project)
            .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
        }
        Text(session.title).font(.headline).foregroundStyle(.white)
          .lineLimit(2).multilineTextAlignment(.leading)
          .privacySensitive()
        Text(session.needsAttention ? (session.promptTitle ?? session.subtitle) : (session.detailPreview ?? session.subtitle))
          .font(.footnote).foregroundStyle(session.needsAttention ? WatchPalette.waiting : Color.secondary)
          .lineLimit(2).multilineTextAlignment(.leading)
          .privacySensitive()
        HStack {
          Label(WatchPhaseStyle.label(for: session.phase), systemImage: WatchPhaseStyle.symbol(for: session.phase))
            .font(.footnote).foregroundStyle(WatchPhaseStyle.color(for: session.phase))
          Spacer(minLength: 2)
          if let plan = session.planProgress, plan.total > 0 {
            Text("\(plan.completed)/\(plan.total)").font(.footnote).monospacedDigit().foregroundStyle(.secondary)
          }
        }
        if let plan = session.planProgress, plan.total > 0, !session.needsAttention {
          ProgressView(value: plan.fraction).tint(WatchPalette.accent)
            .accessibilityLabel("计划进度").accessibilityValue("\(plan.percent)%")
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .watchCard(tint: session.needsAttention ? WatchPalette.waiting : nil, radius: 18)
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
          Image(systemName: "terminal").foregroundStyle(WatchPalette.ok)
          Text(terminal.title).font(.headline).lineLimit(1)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
        }
        Text(terminal.outputPreview?.split(whereSeparator: \.isNewline).last.map(String.init) ?? terminal.subtitle)
          .font(.system(.footnote, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2)
          .multilineTextAlignment(.leading)
          .privacySensitive()
        Text(terminal.exitCode.map { "已退出 · \($0)" } ?? "运行中")
          .font(.footnote).foregroundStyle(terminal.exitCode == nil ? WatchPalette.ok : Color.secondary)
      }
      .padding(12).frame(maxWidth: .infinity, alignment: .leading)
      .watchCard(radius: 18)
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
              .foregroundStyle(notice.ok ? WatchPalette.ok : WatchPalette.waiting)
            Text(notice.text)
          }
        }
        .font(.footnote).fixedSize(horizontal: false, vertical: true)
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

  private var attention: [WatchSession] { store.snapshot.sessions.filter(\.needsAttention) }
  private var otherSessions: [WatchSession] { store.snapshot.sessions.filter { !$0.needsAttention } }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 10) {
        Button(action: onOpenComputers) {
          HStack(spacing: 5) {
            Image(systemName: "desktopcomputer")
              .foregroundStyle(WatchPalette.accent)
              .accessibilityHidden(true)
            Text(store.snapshot.computerName)
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer(minLength: 2)
            Text(store.transportReachable ? (store.snapshot.online ? "已连接" : "电脑离线") : "未连接")
              .foregroundStyle(.secondary)
              .fixedSize()
            Image(systemName: "chevron.down")
              .imageScale(.small)
              .foregroundStyle(.secondary)
              .accessibilityHidden(true)
          }
          .font(.footnote.weight(.medium))
          .frame(maxWidth: .infinity, minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityHint("切换电脑")

        if !store.transportReachable, store.snapshot.generatedAt > 0 {
          VStack(alignment: .leading, spacing: 4) {
            Label("显示上次同步", systemImage: "clock.arrow.circlepath").font(.footnote)
            Text(Date(timeIntervalSince1970: store.snapshot.generatedAt / 1000), style: .relative)
              .font(.footnote).foregroundStyle(.secondary)
            Text(store.independent ? "打开连接设置，检查网络或重新连接电脑。" : "打开 iPhone 上的 LinkShell 后可继续操作。")
              .font(.footnote).foregroundStyle(.secondary)
          }.foregroundStyle(WatchPalette.waiting)
        }

        HStack {
          Text("会话 · \(store.snapshot.sessions.count)")
            .font(.footnote).foregroundStyle(.secondary)
          Spacer(minLength: 0)
          Button(action: onOpenQuickAdd) {
            Image(systemName: "plus")
              .font(.body.weight(.semibold))
              .foregroundStyle(WatchPalette.accent)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("新建会话或终端")
        }

        if !attention.isEmpty {
          Text("待处理 · \(attention.count)").font(.footnote).foregroundStyle(WatchPalette.waiting)
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
          Text("终端 · \(store.snapshot.terminals.count)").font(.footnote).foregroundStyle(.secondary)
          ForEach(store.snapshot.terminals) { terminal in
            WatchTerminalRowCard(terminal: terminal) { onOpenTerminal(terminal.id) }
          }
        }
        if store.snapshot.sessions.isEmpty && store.snapshot.terminals.isEmpty {
          VStack(spacing: 10) {
            Image(systemName: store.snapshot.online ? "sparkles" : "iphone.radiowaves.left.and.right")
              .font(.largeTitle).foregroundStyle(WatchPalette.accent)
            Text(store.snapshot.online ? "准备就绪" : (store.independent ? "连接你的电脑" : "从 iPhone 开始")).font(.headline)
            Text(store.snapshot.online ? "新建会话，把下一步交给 Agent。" : (store.independent ? store.direct.status : "在配对的 iPhone 上打开 LinkShell 并连接电脑。"))
              .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if store.snapshot.online {
              Button("新建会话", action: onOpenQuickAdd).tint(WatchPalette.accentFill)
            }
          }.frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        NavigationLink { WatchConnectionView(store: store) } label: { Label("连接设置", systemImage: "network") }
        Button { store.requestRefresh() } label: {
          Label("同步状态", systemImage: "arrow.clockwise").font(.footnote).frame(maxWidth: .infinity, minHeight: 44)
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
    let all = rawText.split(whereSeparator: \.isNewline).map { String($0) }
    return expanded ? Array(all.prefix(16)) : Array(all.prefix(4))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 1.5) {
      ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
        let isAdd = line.hasPrefix("+")
        let isDel = line.hasPrefix("-")
        Text(line)
          .font(.system(.footnote, design: .monospaced))
          .foregroundStyle(isAdd ? WatchPalette.diffAdd : isDel ? WatchPalette.diffDel : Color(white: 0.72))
          .lineLimit(expanded ? 2 : 1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 4)
          .padding(.vertical, 1)
          .background(
            RoundedRectangle(cornerRadius: 3.5, style: .continuous)
              .fill(isAdd ? WatchPalette.ok.opacity(0.14) : isDel ? WatchPalette.danger.opacity(0.14) : Color.clear)
          )
      }
    }
    .padding(4.5)
    .background(Color.black.opacity(0.46), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    .privacySensitive()
  }
}

/// Decoded pictures, kept between redraws: the snapshot refreshes every few seconds and decoding
/// base64 on each pass costs a watch real time.
@MainActor
enum WatchImageCache {
  private static let cache = NSCache<NSString, UIImage>()

  static func image(id: String, base64: String?) -> UIImage? {
    guard let base64, !base64.isEmpty else { return nil }
    let key = "\(id):\(base64.count)" as NSString
    if let hit = cache.object(forKey: key) { return hit }
    guard let data = Data(base64Encoded: base64), let image = UIImage(data: data) else { return nil }
    cache.setObject(image, forKey: key)
    return image
  }
}

/// A message split into prose and fenced code, kept between redraws: a conversation holds hundreds
/// of rows and the snapshot refreshes several times a second.
@MainActor
enum WatchTextCache {
  enum Block { case prose(AttributedString), code(String) }
  private final class Entry { let blocks: [Block]; init(_ blocks: [Block]) { self.blocks = blocks } }
  private static let cache = NSCache<NSString, Entry>()

  static func blocks(id: String, text: String, markdown: Bool) -> [Block] {
    let key = "\(id):\(markdown):\(text.count):\(text.hashValue)" as NSString
    if let hit = cache.object(forKey: key) { return hit.blocks }
    var blocks: [Block] = [], prose: [String] = [], code: [String]? = nil
    func flushProse() {
      let joined = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
      prose = []
      guard !joined.isEmpty else { return }
      let parsed = markdown ? try? AttributedString(markdown: joined, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) : nil
      blocks.append(.prose(parsed ?? AttributedString(joined)))
    }
    for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
      if markdown && line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
        if let open = code { blocks.append(.code(open.joined(separator: "\n"))); code = nil } else { flushProse(); code = [] }
      } else if code != nil {
        code!.append(line)
      } else if markdown, let heading = line.range(of: #"^\s{0,3}#{1,6}\s+"#, options: .regularExpression) {
        prose.append("**\(line[heading.upperBound...])**")
      } else if markdown, let bullet = line.range(of: #"^\s{0,3}[-*+]\s+"#, options: .regularExpression) {
        prose.append("• " + line[bullet.upperBound...])
      } else {
        prose.append(line)
      }
    }
    // A reply cut off (or still streaming) inside a code block shows what it has as code.
    if let open = code { blocks.append(.code(open.joined(separator: "\n"))) }
    flushProse()
    cache.setObject(Entry(blocks), forKey: key)
    return blocks
  }
}

/// A message's text: prose with inline Markdown, code blocks in monospace. A long one shows its
/// opening until expanded; the projection already bounds what one row carries.
struct WatchMessageText: View {
  let id: String
  let text: String
  let markdown: Bool
  @State private var expanded = false

  private static let collapsedCharacters = 600, collapsedLines = 14

  private var collapsed: String? {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    guard text.count > Self.collapsedCharacters || lines.count > Self.collapsedLines else { return nil }
    return String(lines.prefix(Self.collapsedLines).joined(separator: "\n").prefix(Self.collapsedCharacters)) + "…"
  }

  var body: some View {
    let short = collapsed
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(WatchTextCache.blocks(id: id, text: expanded ? text : short ?? text, markdown: markdown).enumerated()), id: \.offset) { _, block in
        switch block {
        case .prose(let value):
          Text(value)
            .font(.body)
            .foregroundStyle(.white)
            .fixedSize(horizontal: false, vertical: true)
        case .code(let value):
          Text(value)
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(Color(white: 0.86))
            .fixedSize(horizontal: false, vertical: true)
            .padding(5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
      }
      if short != nil {
        Button {
          WatchHaptics.click()
          withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
        } label: {
          Label(expanded ? "收起" : "展开全文", systemImage: expanded ? "chevron.up" : "chevron.down")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(WatchPalette.accent)
            .frame(minHeight: 28)
        }
        .buttonStyle(.plain)
      }
    }
  }
}

/// The header line of a timeline card: an icon and a short title in one colour.
private struct WatchItemHeader: View {
  let icon: String
  let title: String
  let color: Color
  var trailing: AnyView? = nil

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: icon).imageScale(.small)
      Text(title).lineLimit(1)
      Spacer(minLength: 2)
      if let trailing { trailing }
    }
    .font(.footnote.weight(.semibold))
    .foregroundStyle(color)
  }
}

struct WatchTimelineItemCard: View {
  let item: WatchTimelineItem
  let agent: WatchAgent
  let onPreviewImage: (UIImage, String) -> Void
  @State private var isExpanded: Bool = false

  private var decodedImage: UIImage? { WatchImageCache.image(id: item.id, base64: item.imageBase64) }

  private func toggle() {
    WatchHaptics.click()
    withAnimation(.spring(response: 0.25, dampingFraction: 0.82)) { isExpanded.toggle() }
  }

  private func chevron() -> AnyView {
    AnyView(Image(systemName: isExpanded ? "chevron.up" : "chevron.down").imageScale(.small).foregroundStyle(.secondary))
  }

  private func picture(_ image: UIImage, title: String, maxWidth: CGFloat?, maxHeight: CGFloat) -> some View {
    Button {
      WatchHaptics.click()
      onPreviewImage(image, title)
    } label: {
      Image(uiImage: image)
        .resizable()
        .aspectRatio(contentMode: .fill)
        .frame(maxWidth: maxWidth ?? .infinity, maxHeight: maxHeight)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
    .buttonStyle(WatchPressableButtonStyle())
    .accessibilityLabel("查看图片")
  }

  var body: some View {
    switch item.kind {
    case "user":
      HStack(spacing: 0) {
        Spacer(minLength: 20)
        VStack(alignment: .trailing, spacing: 3.5) {
          if let image = decodedImage { picture(image, title: item.title ?? "图片预览", maxWidth: 118, maxHeight: 74) }
          VStack(alignment: .leading, spacing: 2) {
            WatchMessageText(id: item.id, text: item.text, markdown: false)
            if item.status == "running" {
              Text("已发送").font(.footnote).foregroundStyle(.white.opacity(0.72))
            }
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 7)
          .background(WatchPalette.accentFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .privacySensitive()
        }
      }

    case "image":
      HStack(spacing: 0) {
        if (item.title ?? "").hasPrefix("你") { Spacer(minLength: 22) }
        VStack(alignment: .leading, spacing: 4) {
          WatchItemHeader(icon: "photo.fill", title: item.title ?? "图片", color: .cyan)
          if let image = decodedImage { picture(image, title: item.title ?? "图片", maxWidth: nil, maxHeight: 84) }
          Text(item.text).font(.footnote).foregroundStyle(.white)
        }
        .padding(8)
        .watchCard(radius: 12)
        .privacySensitive()
        if !(item.title ?? "").hasPrefix("你") { Spacer(minLength: 14) }
      }

    case "diff":
      Button(action: toggle) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 4) {
            Image(systemName: "doc.badge.gearshape.fill").imageScale(.small).foregroundStyle(.cyan)
            Text(item.text)
              .font(.system(.footnote, design: .monospaced).weight(.semibold))
              .foregroundStyle(.white)
              .lineLimit(1)
            Spacer(minLength: 2)
            if let add = item.diffAdded, add > 0 {
              Text("+\(add)").foregroundStyle(WatchPalette.diffAdd)
            }
            if let del = item.diffRemoved, del > 0 {
              Text("-\(del)").foregroundStyle(WatchPalette.diffDel)
            }
            chevron()
          }
          .font(.system(.footnote, design: .monospaced).weight(.bold))
          if let detail = item.detail, !detail.isEmpty {
            WatchDiffLineView(rawText: detail, expanded: isExpanded)
          }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .watchCard(radius: 12)
      }
      .buttonStyle(WatchPressableButtonStyle())
      .accessibilityHint(isExpanded ? "收起改动" : "展开改动")

    case "subagent":
      Button(action: toggle) {
        VStack(alignment: .leading, spacing: 4) {
          WatchItemHeader(
            icon: "point.3.connected.trianglepath.dotted", title: item.title ?? "子代理", color: WatchPalette.accent,
            trailing: AnyView(
              Text(item.status == "running" ? "运行中" : "已完成")
                .foregroundStyle(item.status == "running" ? WatchPalette.accent : .secondary)
            )
          )
          Text(item.text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.white)
            .lineLimit(isExpanded ? 6 : 2)
            .multilineTextAlignment(.leading)
          if let detail = item.detail, !detail.isEmpty {
            Text(detail)
              .font(.system(.footnote, design: .monospaced))
              .foregroundStyle(Color(white: 0.72))
              .lineLimit(isExpanded ? 10 : 2)
              .padding(5)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(Color.black.opacity(0.40), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
          }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .watchCard(tint: WatchPalette.accent, radius: 12)
        .privacySensitive()
      }
      .buttonStyle(WatchPressableButtonStyle())

    case "tool":
      Button(action: toggle) {
        VStack(alignment: .leading, spacing: 3.5) {
          WatchItemHeader(
            icon: "terminal", title: item.title ?? "工具调用", color: .secondary,
            trailing: AnyView(HStack(spacing: 4) {
              if item.detail != nil { chevron() }
              Image(systemName: item.status == "failed" ? "xmark.circle.fill"
                : item.status == "running" || item.status == "waiting" ? "bolt.horizontal.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(item.status == "failed" ? WatchPalette.danger
                  : item.status == "waiting" ? WatchPalette.waiting
                  : item.status == "running" ? WatchPalette.accent : WatchPalette.ok)
                .accessibilityLabel(item.status == "failed" ? "失败" : item.status == "running" ? "运行中" : item.status == "waiting" ? "等待中" : "完成")
            })
          )
          Text(item.text)
            .font(.system(.footnote, design: .monospaced).weight(.medium))
            .foregroundStyle(Color(white: 0.92))
            .lineLimit(isExpanded ? 12 : 2)
            .multilineTextAlignment(.leading)
          if let detail = item.detail, !detail.isEmpty, isExpanded || item.status == "failed" {
            // The output's latest lines: the projection keeps a bounded tail.
            Text(detail)
              .font(.system(.footnote, design: .monospaced))
              .foregroundStyle(Color(white: 0.68))
              .lineLimit(isExpanded ? 24 : 4)
              .padding(5)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
          }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .watchCard(radius: 12)
        .privacySensitive()
      }
      .buttonStyle(WatchPressableButtonStyle())

    case "thought":
      Button(action: toggle) {
        VStack(alignment: .leading, spacing: 2.5) {
          WatchItemHeader(icon: "sparkles", title: item.title ?? "思考", color: .secondary, trailing: chevron())
          Text(item.text)
            .font(.footnote)
            .foregroundStyle(Color(white: 0.6))
            .lineLimit(isExpanded ? 60 : 2)
            .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(white: 0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .privacySensitive()
      }
      .buttonStyle(WatchPressableButtonStyle())

    case "plan":
      VStack(alignment: .leading, spacing: 3.5) {
        WatchItemHeader(icon: "checklist", title: item.title ?? "执行计划", color: WatchPalette.ok)
        Text(item.text)
          .font(.footnote)
          .foregroundStyle(Color(white: 0.88))
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .watchCard(tint: WatchPalette.ok, radius: 12)
      .privacySensitive()

    case "question":
      let answered = item.status == "completed"
      VStack(alignment: .leading, spacing: 3.5) {
        WatchItemHeader(icon: answered ? "checkmark.bubble.fill" : "questionmark.bubble.fill", title: item.title ?? "问题",
                        color: answered ? WatchPalette.accent : WatchPalette.waiting)
        Text(item.text)
          .font(.body.weight(.medium))
          .foregroundStyle(.white)
          .fixedSize(horizontal: false, vertical: true)
        if let detail = item.detail, !detail.isEmpty {
          Text(detail).font(.footnote).foregroundStyle(Color(white: 0.78))
        }
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .watchCard(tint: answered ? WatchPalette.accent : WatchPalette.waiting, radius: 12)
      .privacySensitive()

    case "permission":
      let denied = item.status == "failed"
      VStack(alignment: .leading, spacing: 2.5) {
        WatchItemHeader(icon: denied ? "xmark.shield.fill" : "checkmark.shield.fill", title: item.title ?? "权限请求",
                        color: denied ? WatchPalette.danger : WatchPalette.ok)
        Text(item.text).font(.footnote).foregroundStyle(Color(white: 0.78))
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(white: 0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .privacySensitive()

    case "notice":
      // Handoffs, stops and agent notices: a quiet line between messages, as on the phone.
      let warn = item.status == "waiting"
      VStack(spacing: 2) {
        if let title = item.title, !title.isEmpty {
          Text(title).font(.footnote.weight(.semibold)).foregroundStyle(warn ? WatchPalette.waiting : .secondary)
        }
        Label(item.text, systemImage: warn ? "exclamationmark.circle" : "info.circle")
          .font(.footnote)
          .foregroundStyle(warn ? WatchPalette.waiting : .secondary)
      }
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 3)

    case "error":
      VStack(alignment: .leading, spacing: 3) {
        WatchItemHeader(icon: "exclamationmark.triangle.fill", title: item.title ?? "错误", color: WatchPalette.danger)
        Text(item.text)
          .font(.footnote)
          .foregroundStyle(.white)
          .fixedSize(horizontal: false, vertical: true)
        if let hint = item.detail, !hint.isEmpty {
          Text(hint).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .watchCard(tint: WatchPalette.danger, radius: 12)

    default:
      HStack(alignment: .top, spacing: 5) {
        WatchAgentBadge(agent: agent, size: 18)
          .padding(.top, 2)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          if let image = decodedImage { picture(image, title: agent.name, maxWidth: 120, maxHeight: 76) }
          WatchMessageText(id: item.id, text: item.text, markdown: true)
          if item.status == "running" {
            HStack(spacing: 3) {
              Circle().fill(WatchPalette.accent).frame(width: 4, height: 4)
              Text("正在输出…")
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(WatchPalette.accent)
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .watchCard(radius: 14)
        .privacySensitive()
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
          $crownScale, from: 1.0, through: 3.5, by: 0.15,
          sensitivity: .medium, isContinuous: false, isHapticFeedbackEnabled: true
        )
        Text(String(format: "%.1fx", crownScale))
          .font(.system(.footnote, design: .monospaced).weight(.semibold))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(Color.black.opacity(0.65)))
          .padding(.trailing, 8)
          .padding(.bottom, 4)
          .accessibilityLabel("缩放 \(String(format: "%.1f", crownScale)) 倍，转动表冠调整")
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
          }
          .accessibilityLabel("关闭")
        }
      }
    }
  }
}

struct WatchSessionConfigSheet: View {
  let session: WatchSession
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss

  // Only what the agent itself reported: a guessed option would be refused by the host or
  // claim a mode the session isn't in.
  private var configOptions: [WatchConfigOption] { session.configOptions ?? [] }

  var body: some View {
    List {
      ForEach(configOptions) { opt in
        Section(opt.name) {
          ForEach(opt.values) { val in
            let isSelected = opt.current == val.value
            Button {
              store.setSessionConfig(sessionId: session.id, optionId: opt.id, value: val.value, label: val.name)
              dismiss()
            } label: {
              HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                  Text(val.name).font(.body.weight(.semibold))
                  if let desc = val.description, !desc.isEmpty {
                    Text(desc).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                  }
                }
                Spacer()
                if isSelected {
                  Image(systemName: "checkmark").foregroundStyle(WatchPalette.accent)
                    .accessibilityLabel("当前选项")
                }
              }
            }
            .disabled(isSelected || store.pendingCommandId != nil)
          }
        }
      }

      if session.canSend {
        Section("快捷指令") {
          ForEach(WatchQuickPrompt.defaults) { preset in
            Button {
              store.sendPrompt(sessionId: session.id, text: preset.prompt, now: false)
              dismiss()
            } label: {
              Label(preset.label, systemImage: preset.icon)
            }
          }
        }
      }

      if session.handoff == "can_release" || session.canCancel {
        Section {
          if session.handoff == "can_release" {
            Button {
              store.releaseSession(sessionId: session.id)
              dismiss()
            } label: {
              Label("交还给电脑", systemImage: "macbook.and.iphone")
            }
          }
          if session.canCancel {
            Button(role: .destructive) {
              store.cancelSession(sessionId: session.id)
              dismiss()
            } label: {
              Label("停止当前轮次", systemImage: "stop.circle.fill")
            }
          }
        }
      }
    }
    .navigationTitle("会话")
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

        ScrollViewReader { scrollProxy in
          ScrollView {
            VStack(alignment: .leading, spacing: 6) {
              GeometryReader { geo in
                Color.clear.preference(
                  key: WatchScrollTopOffsetKey.self,
                  value: geo.frame(in: .named("watchSessionScroll")).minY
                )
              }
              .frame(height: 0)

              Button {
                WatchHaptics.click()
                showingConfigSheet = true
              } label: {
                HStack(spacing: 5) {
                  WatchAgentBadge(agent: agent, size: 20)
                  Text(session.project.isEmpty ? agent.name : session.project)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                  Spacer(minLength: 2)
                  WatchStatusBadge(session: session)
                  Image(systemName: "ellipsis.circle")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                }
                .padding(.horizontal, 8)
                .frame(minHeight: 44)
                .watchCard(radius: 12)
                .contentShape(Rectangle())
              }
              .buttonStyle(WatchPressableButtonStyle())
              .accessibilityLabel("\(agent.name)，\(WatchPhaseStyle.label(for: session.phase))")
              .accessibilityHint("会话设置与快捷指令")

              if isLoadingEarlier {
                ProgressView()
                  .controlSize(.mini)
                  .frame(maxWidth: .infinity)
                  .frame(height: 14)
              }

              if !timelineItems.isEmpty {
                ForEach(timelineItems) { item in
                  WatchTimelineItemCard(item: item, agent: agent) { img, title in
                    previewImageItem = (img, title)
                  }
                  .id(item.id)
                }
              } else {
                WatchTimelineItemCard(
                  item: WatchTimelineItem(id: "fallback-user", kind: "user", title: "你", text: session.title, detail: nil, status: "completed"),
                  agent: agent,
                  onPreviewImage: { _, _ in }
                )
                WatchTimelineItemCard(
                  item: WatchTimelineItem(
                    id: "fallback-agent", kind: "assistant", title: agent.name,
                    text: session.detailPreview ?? session.subtitle, detail: session.commandPreview,
                    status: session.isRunning ? "running" : "completed"
                  ),
                  agent: agent,
                  onPreviewImage: { _, _ in }
                )
              }

              if let actions = session.actions, !actions.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                  Text(session.promptTitle ?? "需要你的确认")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(WatchPalette.waiting)
                    .privacySensitive()
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
                          .font(.body.weight(.semibold))
                          .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        Image(systemName: isDestructive ? "xmark.circle.fill" : "checkmark.circle.fill")
                          .accessibilityHidden(true)
                      }
                      .foregroundStyle(isDestructive ? WatchPalette.danger : .white)
                      .padding(.horizontal, 10)
                      .frame(maxWidth: .infinity, minHeight: 44)
                      .background(
                        isDestructive ? WatchPalette.danger.opacity(0.20) : WatchPalette.accentFill,
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                      )
                    }
                    .buttonStyle(WatchPressableButtonStyle())
                    .disabled(store.pendingCommandId != nil)
                  }
                }
                .padding(9)
                .watchCard(tint: WatchPalette.waiting, radius: 12)
              }

              if session.hasMoreActions == true {
                Label("更多选项请在手机或电脑处理", systemImage: "iphone")
                  .font(.footnote).foregroundStyle(.secondary)
                  .padding(.vertical, 8)
              }

              // Room for the bottom bar's button, so the last message can be scrolled clear of it.
              Color.clear.frame(height: 40).id("session-bottom-anchor")
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
        .toolbar {
          // One tap to reply: the system bottom bar, not a pill that first has to be opened.
          ToolbarItemGroup(placement: .bottomBar) {
            if session.handoff == "can_takeover" {
              Spacer()
              Button {
                store.takeoverSession(sessionId: session.id)
              } label: {
                Label("接管", systemImage: "applewatch.radiowaves.left.and.right")
              }
              .tint(WatchPalette.waiting)
              .disabled(store.pendingCommandId != nil)
              .accessibilityLabel("接管会话")
              .accessibilityHint("把会话从电脑终端接到腕表上处理")
            } else if session.canSend {
              Spacer()
              #if os(watchOS)
              TextFieldLink(prompt: Text("发送给 \(agent.name)")) {
                Label("回复", systemImage: "mic.fill")
              } onSubmit: { text in
                store.sendPrompt(sessionId: session.id, text: text, now: false)
              }
              .tint(WatchPalette.accentFill)
              .accessibilityLabel("回复 \(agent.name)")
              #endif
            }
          }
        }
      } else {
        Text("该会话已结束")
          .font(.footnote)
          .foregroundStyle(.secondary)
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
  @State private var confirmClose = false

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
        ScrollView {
          VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 5) {
                WatchAgentBadge(agent: WatchAgent(id: "terminal"), size: 18)
                  .accessibilityHidden(true)
                Text(terminal.cwd ?? terminal.project)
                  .font(.system(.footnote, design: .monospaced))
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
                Spacer(minLength: 0)
                Button {
                  store.openTerminal(terminalId: terminal.id)
                  store.requestRefresh()
                } label: {
                  Image(systemName: "arrow.clockwise")
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("刷新终端输出")
              }
              Text(
                (terminal.outputPreview?.isEmpty == false)
                  ? terminal.outputPreview!
                  : "$ \(terminal.command ?? terminal.title)\n(等待终端输出…)"
              )
              .font(.system(.footnote, design: .monospaced))
              .foregroundStyle(Color(red: 0.84, green: 0.94, blue: 0.86))
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
              .privacySensitive()
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
            .background(Color(white: 0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 5), GridItem(.flexible(), spacing: 5)], spacing: 5) {
              ForEach(quickCommands, id: \.cmd) { item in
                Button {
                  store.sendTerminalInput(terminalId: terminal.id, data: item.cmd + "\n")
                } label: {
                  Text(item.label)
                    .font(.system(.footnote, design: .monospaced).weight(.medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .watchCard(radius: 10)
                }
                .buttonStyle(WatchPressableButtonStyle())
                .disabled(store.pendingCommandId != nil)
              }
            }

            HStack(spacing: 6) {
              Button {
                store.sendTerminalInput(terminalId: terminal.id, data: "\u{0003}")
              } label: {
                Text("Ctrl+C")
                  .font(.footnote.weight(.semibold))
                  .foregroundStyle(WatchPalette.waiting)
                  .frame(maxWidth: .infinity, minHeight: 44)
                  .background(WatchPalette.waiting.opacity(0.16), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
              }
              .buttonStyle(WatchPressableButtonStyle())
              .accessibilityLabel("中断当前命令")

              Button {
                confirmClose = true
              } label: {
                Text("关闭终端")
                  .font(.footnote.weight(.semibold))
                  .foregroundStyle(WatchPalette.danger)
                  .frame(maxWidth: .infinity, minHeight: 44)
                  .background(WatchPalette.danger.opacity(0.16), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
              }
              .buttonStyle(WatchPressableButtonStyle())
            }
            // Room for the bottom bar's button, so the last row can be scrolled clear of it.
            Color.clear.frame(height: 40)
          }
          .padding(.horizontal, 6)
          .padding(.top, 2)
          .onAppear {
            store.openTerminal(terminalId: terminal.id)
          }
        }
        .toolbar {
          ToolbarItemGroup(placement: .bottomBar) {
            Spacer()
            #if os(watchOS)
            TextFieldLink(prompt: Text("输入命令")) {
              Label("命令", systemImage: "chevron.right.square")
            } onSubmit: { text in
              let cmd = text.trimmingCharacters(in: .whitespacesAndNewlines)
              if !cmd.isEmpty {
                store.sendTerminalInput(terminalId: terminal.id, data: cmd + "\n")
              }
            }
            .tint(WatchPalette.ok)
            .accessibilityLabel("输入终端命令")
            #endif
          }
        }
        .confirmationDialog("关闭这个终端？", isPresented: $confirmClose) {
          Button("关闭终端", role: .destructive) {
            store.closeTerminal(terminalId: terminal.id)
            dismiss()
          }
        }
      } else {
        Text("该终端已关闭")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .padding(.top, 28)
      }
    }
    .modifier(WatchCommandFeedback(store: store))
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// A row in the quick-add list: a tinted icon, a title and one line saying what it does.
private struct WatchQuickAddRow: View {
  let icon: String
  let tint: Color
  let title: String
  let detail: String

  var body: some View {
    HStack(spacing: 9) {
      Image(systemName: icon)
        .foregroundStyle(tint)
        .frame(width: 30, height: 30)
        .background(Circle().fill(tint.opacity(0.22)))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.body.weight(.semibold)).lineLimit(1)
        Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(minHeight: 44)
    .watchCard(radius: 14)
    .accessibilityElement(children: .combine)
  }
}

struct WatchQuickAddSheet: View {
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss
  let onNewSession: () -> Void
  let onNewTerminal: () -> Void
  let onOpenComputers: () -> Void

  private func open(_ next: @escaping () -> Void) {
    WatchHaptics.click()
    dismiss()
    // The next sheet can only appear once this one has gone.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { next() }
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 6) {
        Button { open(onNewSession) } label: {
          WatchQuickAddRow(icon: "plus.bubble.fill", tint: WatchPalette.accent, title: "新建会话", detail: "选一个 Agent，交给它一项任务")
        }
        .buttonStyle(WatchPressableButtonStyle())

        Button { open(onNewTerminal) } label: {
          WatchQuickAddRow(icon: "terminal.fill", tint: WatchPalette.ok, title: "新建终端", detail: "在电脑上开一个 Shell")
        }
        .buttonStyle(WatchPressableButtonStyle())

        Button { open(onOpenComputers) } label: {
          WatchQuickAddRow(icon: "macbook", tint: .cyan, title: "切换电脑", detail: store.snapshot.computerName)
        }
        .buttonStyle(WatchPressableButtonStyle())
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 10)
    }
    .navigationTitle("新建")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// A selectable chip in a horizontal list (agents, folders).
private struct WatchChip<Leading: View>: View {
  let title: String
  let selected: Bool
  @ViewBuilder let leading: () -> Leading

  var body: some View {
    HStack(spacing: 5) {
      leading()
      Text(title).font(.footnote.weight(.semibold)).lineLimit(1)
    }
    .padding(.horizontal, 10)
    .frame(minHeight: 44)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(selected ? WatchPalette.accentFill.opacity(0.55) : Color(white: 0.14))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(selected ? WatchPalette.accent : Color.white.opacity(0.08), lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

struct WatchNewSessionSheet: View {
  @ObservedObject var store: WatchSessionStore
  @Environment(\.dismiss) private var dismiss
  @State private var selectedAgent: String = ""
  @State private var selectedCwd: String = ""

  // Only agents the computer reported as installed: starting one it doesn't have just fails.
  private var agentIds: [String] { store.snapshot.availableAgents ?? [] }

  private var workspaces: [WatchWorkspace] {
    if let ws = store.snapshot.workspaces, !ws.isEmpty {
      return ws
    }
    if let firstCwd = store.snapshot.sessions.first?.cwd, !firstCwd.isEmpty {
      return [WatchWorkspace(path: firstCwd, name: store.snapshot.sessions.first?.project ?? "当前项目")]
    }
    return []
  }

  private var activeCwd: String {
    if !selectedCwd.isEmpty { return selectedCwd }
    return workspaces.first?.path ?? ""
  }

  private var activeAgent: String {
    agentIds.contains(selectedAgent) ? selectedAgent : (agentIds.first ?? "")
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        if agentIds.isEmpty || workspaces.isEmpty {
          VStack(spacing: 6) {
            Image(systemName: "exclamationmark.circle").font(.title3).foregroundStyle(.secondary)
            Text(store.snapshot.online ? "电脑还没报告可用的 Agent 或项目" : "电脑离线，暂时无法新建会话")
              .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
        } else {
          Text("Agent").font(.footnote).foregroundStyle(.secondary)
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
              ForEach(agentIds, id: \.self) { id in
                let agent = WatchAgent(id: id)
                Button {
                  WatchHaptics.click()
                  selectedAgent = id
                } label: {
                  WatchChip(title: agent.name, selected: activeAgent == id) {
                    WatchAgentBadge(agent: agent, size: 20)
                  }
                }
                .buttonStyle(WatchPressableButtonStyle())
              }
            }
          }

          Text("项目").font(.footnote).foregroundStyle(.secondary)
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
              ForEach(workspaces.prefix(5)) { ws in
                Button {
                  WatchHaptics.click()
                  selectedCwd = ws.path
                } label: {
                  WatchChip(title: ws.name, selected: activeCwd == ws.path) {
                    Image(systemName: "folder.fill").imageScale(.small)
                      .foregroundStyle(activeCwd == ws.path ? WatchPalette.accent : .secondary)
                  }
                }
                .buttonStyle(WatchPressableButtonStyle())
              }
            }
          }

          #if os(watchOS)
          TextFieldLink(prompt: Text("要做什么？")) {
            Label("说出任务", systemImage: "mic.fill")
              .font(.body.weight(.semibold))
              .foregroundStyle(.white)
              .frame(maxWidth: .infinity, minHeight: 44)
              .background(WatchPalette.accentFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          } onSubmit: { text in
            store.createSession(agent: activeAgent, cwd: activeCwd, prompt: text)
            dismiss()
          }
          .buttonStyle(WatchPressableButtonStyle())
          .disabled(store.pendingCommandId != nil)
          #endif

          Button {
            store.createSession(agent: activeAgent, cwd: activeCwd, prompt: "请检查当前仓库的 git status 和最近改动，并简明汇报。")
            dismiss()
          } label: {
            Text("检查项目状态")
              .font(.footnote.weight(.medium))
              .frame(maxWidth: .infinity, minHeight: 44)
              .watchCard(radius: 12)
          }
          .buttonStyle(WatchPressableButtonStyle())
          .disabled(store.pendingCommandId != nil)
        }
      }
      .padding(.horizontal, 6)
      .padding(.top, 2)
      .padding(.bottom, 10)
    }
    .modifier(WatchCommandFeedback(store: store))
    .navigationTitle("新建会话")
    .navigationBarTitleDisplayMode(.inline)
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
    return []
  }

  private var activeCwd: String? {
    if !selectedCwd.isEmpty { return selectedCwd }
    return workspaces.first?.path
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 7) {
        if !workspaces.isEmpty {
          Text("项目").font(.footnote).foregroundStyle(.secondary)
          ForEach(workspaces.prefix(3)) { ws in
            let isSelected = activeCwd == ws.path
            Button {
              WatchHaptics.click()
              selectedCwd = ws.path
            } label: {
              HStack(spacing: 6) {
                Image(systemName: "folder.fill").foregroundStyle(isSelected ? WatchPalette.ok : .secondary)
                Text(ws.name).font(.footnote.weight(.medium)).lineLimit(1)
                Spacer(minLength: 0)
                if isSelected { Image(systemName: "checkmark").foregroundStyle(WatchPalette.ok) }
              }
              .padding(.horizontal, 10)
              .frame(minHeight: 44)
              .background(isSelected ? WatchPalette.ok.opacity(0.18) : Color(white: 0.13), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              .accessibilityElement(children: .combine)
              .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
            .buttonStyle(WatchPressableButtonStyle())
          }
        }

        Button {
          store.createTerminal(cwd: activeCwd, command: nil)
          dismiss()
        } label: {
          Label("新建终端", systemImage: "terminal.fill")
            .font(.body.weight(.semibold))
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(WatchPalette.ok, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(WatchPressableButtonStyle())
        .disabled(store.pendingCommandId != nil)

        #if os(watchOS)
        TextFieldLink(prompt: Text("启动时运行的命令")) {
          Text("新建并运行命令…")
            .font(.footnote.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 44)
            .watchCard(radius: 12)
        } onSubmit: { text in
          store.createTerminal(cwd: activeCwd, command: text)
          dismiss()
        }
        .buttonStyle(WatchPressableButtonStyle())
        .disabled(store.pendingCommandId != nil)
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
      Section("电脑") {
        if store.snapshot.computers.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text("尚未收到电脑列表").font(.body.weight(.semibold))
            Text(store.independent ? "在连接设置中登录账号，或输入电脑上的六位配对码。" : "请在已配对的 iPhone 上打开 LinkShell，电脑与会话将自动同步。")
              .font(.footnote)
              .foregroundStyle(.secondary)
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
                  .foregroundStyle(computer.online ? WatchPalette.ok : .secondary)
                  .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                  Text(computer.name).lineLimit(1)
                  Text(computer.online ? "在线" : "离线").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 2)
                if computer.selected {
                  Image(systemName: "checkmark").foregroundStyle(WatchPalette.accent)
                }
              }
              .accessibilityElement(children: .combine)
              .accessibilityAddTraits(computer.selected ? .isSelected : [])
            }
          }
        }
      }

      Section {
        Button {
          store.requestRefresh()
          dismiss()
        } label: {
          Label("立即同步", systemImage: "arrow.clockwise")
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
    self._detailSessionId = State(initialValue: initialDetailSession)
    self._detailTerminalId = State(initialValue: initialDetailTerminal)
  }

  public var body: some View {
    NavigationStack {
      WatchWorkspaceHomeView(
        store: store,
        onOpenSession: { id in detailSessionId = id },
        onOpenTerminal: { id in detailTerminalId = id },
        onOpenComputers: { showingComputers = true },
        onOpenQuickAdd: { showingQuickAdd = true }
      )
      // Inactive (wrist down, Always On, a notification) keeps the connection; only background pauses it.
      .onAppear { store.setForeground(scenePhase != .background) }
      .onChange(of: scenePhase) { _, phase in store.setForeground(phase != .background) }
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
            onOpenComputers: { showingComputers = true }
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
    }
    .tint(WatchPalette.accent)
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
