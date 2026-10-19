import SwiftUI
import WebKit

struct DesktopRootView: View {
  @ObservedObject var model: DesktopModel
  @ObservedObject var workspace: DesktopWorkspace

  var body: some View {
    Group {
      if model.preview && !Launch.has("--workspace-preview") { DesktopView(model: model) }
      else {
        ZStack(alignment: .topLeading) {
          DesktopWorkspaceWebView(workspace: workspace)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(workspace.managing || workspace.problem != nil ? 0 : 1)
            .allowsHitTesting(!workspace.managing && workspace.problem == nil)
            .accessibilityHidden(workspace.managing || workspace.problem != nil)
          if !workspace.managing, workspace.loading || workspace.problem != nil {
            VStack(spacing: 18) {
              if let problem = workspace.problem {
                Image(systemName: "rectangle.connected.to.line.below").font(.system(size: 34, weight: .light)).foregroundStyle(DesktopStyle.secondary)
                Text("工作台暂时无法连接").font(.system(size: 20, weight: .semibold))
                Text(problem).font(.system(size: 13)).foregroundStyle(DesktopStyle.secondary).multilineTextAlignment(.center).textSelection(.enabled).frame(maxWidth: 440)
                HStack(spacing: 12) {
                  Button("本机管理") { workspace.setManaging(true) }
                  Button("重新连接") { workspace.retry() }.buttonStyle(.borderedProminent).tint(.indigo)
                }.padding(.top, 6)
              } else {
                ProgressView().controlSize(.regular)
                Text("正在打开工作台").font(.system(size: 16, weight: .medium))
                Text("连接电脑，继续对话与远程桌面").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
              }
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(DesktopStyle.background)
          }
          if workspace.managing { DesktopView(model: model) }
        }
        .overlay(alignment: .topLeading) {
          if workspace.managing || !workspace.contentFocused { DesktopWorkspaceBrand(workspace: workspace) }
        }
      }
    }.background(DesktopStyle.background).foregroundStyle(DesktopStyle.primary).preferredColorScheme(model.colorScheme).scrollIndicators(.hidden)
  }
}

private struct DesktopWorkspaceBrand: View {
  @ObservedObject var workspace: DesktopWorkspace
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 9) {
        Image(nsImage: NSImage(named: NSImage.applicationIconName) ?? NSImage())
          .resizable().scaledToFit().frame(width: 32, height: 32)
        Text("LinkShell").font(.system(size: 18, weight: .semibold)).tracking(-0.35).fixedSize()
      }.frame(height: 34)
      HStack(spacing: 2) {
        mode("工作台", selected: !workspace.managing, shortcut: "⌘1") { workspace.setManaging(false) }
        mode("本机管理", selected: workspace.managing, shortcut: "⌘2") { workspace.setManaging(true) }
      }
      .padding(2).frame(width: 204, height: 32)
      .background(RoundedRectangle(cornerRadius: 7).fill(DesktopStyle.selection.opacity(0.6)))
      .accessibilityElement(children: .contain).accessibilityLabel("切换 LinkShell 入口")
    }
    .padding(.horizontal, 14).padding(.top, 12).frame(width: 232, height: 104, alignment: .topLeading)
    .background(DesktopStyle.sidebar)
    .overlay(alignment: .trailing) { Rectangle().fill(DesktopStyle.line).frame(width: 1) }
  }

  private func mode(_ title: String, selected: Bool, shortcut: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title).font(.system(size: 13, weight: selected ? .semibold : .medium))
        .foregroundStyle(selected ? DesktopStyle.primary : DesktopStyle.secondary)
        .lineLimit(1).fixedSize(horizontal: true, vertical: false)
        .frame(maxWidth: .infinity).frame(height: 28)
        .background(RoundedRectangle(cornerRadius: 5).fill(selected ? DesktopStyle.selection : .clear))
        .contentShape(RoundedRectangle(cornerRadius: 5))
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
