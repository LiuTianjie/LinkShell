import SwiftUI
import WebKit

struct DesktopRootView: View {
  @ObservedObject var model: DesktopModel
  @ObservedObject var workspace: DesktopWorkspace

  private var managing: Bool { workspace.managing || (model.preview && !Launch.has("--workspace-preview")) }

  var body: some View {
    VStack(spacing: 0) {
      // A remote screen or a preview shown across the window takes the top bar's room too.
      if managing || !workspace.contentFocused {
        DesktopTopBar(model: model, workspace: workspace, managing: managing)
          .frame(height: DesktopStyle.topBarHeight)
      }
      ZStack(alignment: .topLeading) {
        if !model.preview || Launch.has("--workspace-preview") {
          DesktopWorkspaceWebView(workspace: workspace)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(workspace.managing || workspace.problem != nil ? 0 : 1)
            .allowsHitTesting(!workspace.managing && workspace.problem == nil)
            .accessibilityHidden(workspace.managing || workspace.problem != nil)
          if !workspace.managing, workspace.loading || workspace.problem != nil {
            placeholder
          }
        }
        if managing { DesktopView(model: model) }
      }
    }
    // The title bar is transparent: the top bar shares its row with the traffic lights.
    .ignoresSafeArea(.container, edges: .top)
    .background(DesktopStyle.background)
    .foregroundStyle(DesktopStyle.primary)
    .preferredColorScheme(model.colorScheme)
    .scrollIndicators(.hidden)
  }

  /// The page's own frame, drawn ahead of it so nothing jumps when the page takes over.
  private var placeholder: some View {
    VStack(spacing: 0) {
      HStack(spacing: DesktopStyle.gutter) {
        Color.clear.frame(width: DesktopStyle.sidebarWidth).frame(maxHeight: .infinity).panelSurface()
        VStack(spacing: 14) {
          if let problem = workspace.problem {
            Image(systemName: "rectangle.connected.to.line.below").font(.system(size: 28, weight: .light)).foregroundStyle(DesktopStyle.tertiary)
            Text("工作台暂时无法连接").font(.system(size: 17, weight: .semibold))
            Text(problem).font(.system(size: 13)).foregroundStyle(DesktopStyle.secondary).multilineTextAlignment(.center).textSelection(.enabled).frame(maxWidth: 440)
            HStack(spacing: 10) {
              Button("本机管理") { workspace.setManaging(true) }.buttonStyle(DesktopPillStyle(.secondary))
              Button("重新连接") { workspace.retry() }.buttonStyle(DesktopPillStyle(.primary))
            }.padding(.top, 4)
          } else {
            ProgressView().controlSize(.small)
            Text("正在打开工作台").font(.system(size: 14, weight: .medium))
            Text("连接电脑，继续对话与远程桌面").font(.system(size: 12)).foregroundStyle(DesktopStyle.tertiary)
          }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).panelSurface()
      }.padding(.horizontal, DesktopStyle.gutter)
      Color.clear.frame(height: DesktopStyle.statusBarHeight)
    }.background(DesktopStyle.background)
  }
}

/// The window's top strip: where you are (工作台 or 本机管理), the way into everything (⌘K),
/// and this Mac's own state. It is also the handle the window is dragged by.
private struct DesktopTopBar: View {
  @ObservedObject var model: DesktopModel
  @ObservedObject var workspace: DesktopWorkspace
  var managing: Bool
  var body: some View {
    ZStack {
      WindowDragArea()
      HStack(spacing: 14) {
        // The traffic lights sit here.
        Color.clear.frame(width: 64, height: 1)
        HStack(spacing: 8) {
          Image(nsImage: NSImage(named: NSImage.applicationIconName) ?? NSImage())
            .resizable().scaledToFit().frame(width: 20, height: 20)
          Text("LinkShell").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(DesktopStyle.secondary).fixedSize()
        }.allowsHitTesting(false)
        modes
        Spacer(minLength: 12)
        if !managing {
          Button { workspace.send(command: "palette") } label: {
            HStack(spacing: 8) {
              Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .medium))
              Text("搜索会话、项目和命令").font(.system(size: 12.5)).lineLimit(1)
              Spacer(minLength: 8)
              Text("⌘K").font(.system(size: 11, weight: .medium)).padding(.horizontal, 5).frame(height: 18)
                .background(RoundedRectangle(cornerRadius: 5).fill(DesktopStyle.raised))
            }
            .foregroundStyle(DesktopStyle.tertiary)
            .padding(.leading, 12).padding(.trailing, 6).frame(width: 320, height: 30)
            .background(Capsule().fill(DesktopStyle.panel))
            .overlay { Capsule().strokeBorder(DesktopStyle.line, lineWidth: 1) }
            .contentShape(Capsule())
          }.buttonStyle(.plain).help("搜索与命令 · ⌘K").accessibilityLabel("搜索与命令")
          Spacer(minLength: 12)
        }
        facts
      }.padding(.trailing, 14)
    }
  }

  private var modes: some View {
    HStack(spacing: 2) {
      mode("工作台", shortcut: "⌘1", selected: !managing) { workspace.setManaging(false) }
      mode("本机管理", shortcut: "⌘2", selected: managing) { workspace.setManaging(true) }
    }
    .padding(2).background(Capsule().fill(DesktopStyle.raised))
    .accessibilityElement(children: .contain).accessibilityLabel("切换 LinkShell 入口")
  }

  private func mode(_ title: String, shortcut: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title).font(.system(size: 12.5, weight: .medium))
        .foregroundStyle(selected ? DesktopStyle.primary : DesktopStyle.secondary)
        .padding(.horizontal, 12).frame(height: 26)
        .background(Capsule().fill(selected ? DesktopStyle.selection : .clear))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .help("\(title) · \(shortcut)")
    .accessibilityLabel(title).accessibilityValue(selected ? "当前入口" : "切换入口")
  }

  /// Facts about this Mac only; the workspace's own computer and connection sit in its status line.
  private var facts: some View {
    HStack(spacing: 6) {
      if model.pending > 0 {
        Button { workspace.setManaging(false) } label: {
          DesktopStatusPill(text: "\(model.pending) 个请求等待确认", tone: DesktopStyle.waiting, tinted: true)
        }.buttonStyle(.plain).help("回到工作台处理")
      }
      if model.newVersion {
        Button { workspace.setManaging(true); model.selected = "更新" } label: {
          DesktopStatusPill(text: "有新版本", tone: DesktopStyle.mint, tinted: true)
        }.buttonStyle(.plain)
      }
      Button { workspace.setManaging(true); model.selected = "总览" } label: {
        DesktopStatusPill(
          text: model.healthy ? "本机服务运行中 · 网关\(model.gatewayLabel)" : "本机服务\(model.serviceLabel)",
          tone: model.healthy ? (model.snapshot?.gateway?.status == "online" ? DesktopStyle.mint : DesktopStyle.tertiary) : DesktopStyle.waiting
        )
      }.buttonStyle(.plain).help("这台 Mac 的服务与网关")
    }
  }
}

private struct DesktopWorkspaceWebView: NSViewRepresentable {
  let workspace: DesktopWorkspace
  func makeNSView(context: Context) -> NSView { workspace.view }
  func updateNSView(_ view: NSView, context: Context) {}
}
