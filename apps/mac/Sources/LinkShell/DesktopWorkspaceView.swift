import SwiftUI
import WebKit

struct DesktopRootView: View {
  @ObservedObject var model: DesktopModel
  @ObservedObject var workspace: DesktopWorkspace

  var body: some View {
    ZStack(alignment: .topLeading) {
      if !model.preview || Launch.has("--workspace-preview") {
        DesktopWorkspaceWebView(workspace: workspace)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .opacity(workspace.managing || workspace.problem != nil ? 0 : 1)
          .allowsHitTesting(!workspace.managing && workspace.problem == nil)
          .accessibilityHidden(workspace.managing || workspace.problem != nil)
        if !workspace.managing, workspace.loading || workspace.problem != nil {
          // The page's own layout, drawn ahead of it: the brand above sits on a full-height sidebar
          // instead of a lone card, and nothing jumps when the page takes over.
          HStack(spacing: 0) {
            Rectangle().fill(DesktopStyle.sidebar).frame(width: 232)
              .overlay(alignment: .trailing) { Rectangle().fill(DesktopStyle.line).frame(width: 1) }
              .ignoresSafeArea(.container, edges: .top)
          VStack(spacing: 18) {
            if let problem = workspace.problem {
              Image(systemName: "rectangle.connected.to.line.below").font(.system(size: 34, weight: .light)).foregroundStyle(DesktopStyle.secondary)
              Text("工作台暂时无法连接").font(.system(size: 20, weight: .semibold))
              Text(problem).font(.system(size: 13)).foregroundStyle(DesktopStyle.secondary).multilineTextAlignment(.center).textSelection(.enabled).frame(maxWidth: 440)
              HStack(spacing: 12) {
                Button("本机管理") { workspace.setManaging(true) }
                Button("重新连接") { workspace.retry() }.buttonStyle(.borderedProminent).tint(DesktopStyle.accent).foregroundStyle(DesktopStyle.onAccent)
              }.padding(.top, 6)
            } else {
              ProgressView().controlSize(.regular)
              Text("正在打开工作台").font(.system(size: 16, weight: .medium))
              Text("连接电脑，继续对话与远程桌面").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
            }
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
          }.frame(maxWidth: .infinity, maxHeight: .infinity).background(DesktopStyle.background)
        }
      }
      if workspace.managing || (model.preview && !Launch.has("--workspace-preview")) {
        DesktopView(model: model)
      }
    }
    .overlay(alignment: .topLeading) {
      if workspace.managing || !workspace.contentFocused || (model.preview && !Launch.has("--workspace-preview")) {
        DesktopWorkspaceBrand(
          workspace: workspace,
          managing: workspace.managing || (model.preview && !Launch.has("--workspace-preview"))
        )
      }
    }
    .background(DesktopStyle.background)
    .foregroundStyle(DesktopStyle.primary)
    .preferredColorScheme(model.colorScheme)
    .scrollIndicators(.hidden)
  }
}

private struct DesktopWorkspaceBrand: View {
  @ObservedObject var workspace: DesktopWorkspace
  var managing: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      HStack(spacing: 9) {
        Image(nsImage: NSImage(named: NSImage.applicationIconName) ?? NSImage())
          .resizable().scaledToFit().frame(width: 30, height: 30)
        Text("LinkShell").font(.system(size: 17, weight: .semibold)).tracking(-0.3).fixedSize()
        Spacer(minLength: 0)
      }.frame(height: 32)
      HStack(spacing: 3) {
        mode("工作台", symbol: "macwindow", selected: !managing, shortcut: "⌘1") { workspace.setManaging(false) }
        mode("本机管理", symbol: "slider.horizontal.3", selected: managing, shortcut: "⌘2") { workspace.setManaging(true) }
      }
      .padding(3).frame(width: 204, height: 34)
      .background(RoundedRectangle(cornerRadius: 8).fill(DesktopStyle.selection))
      .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(DesktopStyle.line, lineWidth: 1) }
      .accessibilityElement(children: .contain).accessibilityLabel("切换 LinkShell 入口")
    }
    .padding(.horizontal, 14).padding(.top, 14).frame(width: 232, height: 104, alignment: .topLeading)
    .background(DesktopStyle.sidebar)
    .overlay(alignment: .trailing) { Rectangle().fill(DesktopStyle.line).frame(width: 1).ignoresSafeArea(.container, edges: .top) }
  }

  private func mode(_ title: String, symbol: String, selected: Bool, shortcut: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: symbol).font(.system(size: 11, weight: selected ? .semibold : .regular))
        Text(title).font(.system(size: 12.5, weight: selected ? .semibold : .medium))
          .lineLimit(1).fixedSize(horizontal: true, vertical: false)
      }
      .foregroundStyle(selected ? DesktopStyle.primary : DesktopStyle.secondary)
      .frame(maxWidth: .infinity).frame(height: 28)
      .background(RoundedRectangle(cornerRadius: 6).fill(selected ? DesktopStyle.card : .clear))
      .overlay {
        if selected {
          RoundedRectangle(cornerRadius: 6).strokeBorder(DesktopStyle.line, lineWidth: 1)
        }
      }
      .contentShape(RoundedRectangle(cornerRadius: 6))
    }
    .buttonStyle(.plain)
    .help("\(title) · \(shortcut)")
    .accessibilityLabel(title).accessibilityValue(selected ? "当前入口" : "切换入口")
  }
}

private struct DesktopWorkspaceWebView: NSViewRepresentable {
  let workspace: DesktopWorkspace
  func makeNSView(context: Context) -> NSView { workspace.view }
  func updateNSView(_ view: NSView, context: Context) {}
}
