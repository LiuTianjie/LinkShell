import AppKit

/// What someone sitting at the remote Mac sees while it lends its apps: a menu bar item that says
/// so, and the one way to stop it from here (docs/v2/fusion.md §4.3). Without it the extra
/// displays and the missing Dock have no explanation.
final class FusionStatusItem: NSObject {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let stateLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let localName: String
  private let onEnd: () -> Void

  init(localName: String, onEnd: @escaping () -> Void) {
    self.localName = localName
    self.onEnd = onEnd
    super.init()
    if let button = item.button {
      button.image = NSImage(systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: "LinkShell 融合模式")
      button.image?.isTemplate = true
      button.toolTip = "LinkShell 融合模式"
    }
    let menu = NSMenu()
    stateLine.isEnabled = false
    menu.addItem(stateLine)
    menu.addItem(.separator())
    let end = NSMenuItem(title: "结束融合", action: #selector(endFusion), keyEquivalent: "")
    end.target = self
    menu.addItem(end)
    item.menu = menu
    update(state: nil)
  }

  /// nil: the normal line, "融合中：<local computer>".
  func update(state: String?) {
    stateLine.title = state ?? "融合中：\(localName.isEmpty ? "另一台电脑" : localName) 正在使用这台 Mac 的应用"
  }

  func remove() {
    NSStatusBar.system.removeStatusItem(item)
  }

  @objc private func endFusion() { onEnd() }
}
