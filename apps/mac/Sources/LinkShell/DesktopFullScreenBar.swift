import AppKit

/// A small dark capsule at the top of the full screen picture: 退出全屏, and the shortcut that does the same.
final class DesktopFullScreenBar: NSVisualEffectView {
  /// How close to the top edge the pointer has to come to bring it back.
  static let revealDepth: CGFloat = 72
  var onExit: (() -> Void)?
  private let button = NSButton(title: "退出全屏", target: nil, action: nil)
  private let hint = NSTextField(labelWithString: "⌃⌘F")

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    material = .hudWindow
    blendingMode = .withinWindow
    state = .active
    appearance = NSAppearance(named: .darkAqua)
    wantsLayer = true
    layer?.cornerRadius = 12
    layer?.masksToBounds = true
    button.target = self
    button.action = #selector(exit)
    button.bezelStyle = .rounded
    button.controlSize = .regular
    button.image = NSImage(systemSymbolName: "arrow.down.right.and.arrow.up.left", accessibilityDescription: nil)
    button.imagePosition = .imageLeading
    button.setAccessibilityLabel("退出全屏")
    hint.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
    hint.textColor = .secondaryLabelColor
    hint.setAccessibilityElement(false)
    let stack = NSStackView(views: [button, hint])
    stack.orientation = .horizontal
    stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 6, left: 8, bottom: 6, right: 8)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    alphaValue = 0
    isHidden = true
  }
  required init?(coder: NSCoder) { nil }

  /// Fades in or out; hidden, it takes no clicks meant for the picture below.
  func reveal(_ shown: Bool) {
    if shown { isHidden = false }
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.18
      animator().alphaValue = shown ? 1 : 0
    }, completionHandler: { [weak self] in
      MainActor.assumeIsolated {
        if let self, !shown, self.alphaValue == 0 { self.isHidden = true }
      }
    })
  }

  @objc private func exit() { onExit?() }
}
