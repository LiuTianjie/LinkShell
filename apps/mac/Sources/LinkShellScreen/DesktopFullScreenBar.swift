import AppKit

/// A small dark bar at the top of the full screen picture: 退出全屏, and the shortcut that does the same.
public final class DesktopFullScreenBar: NSVisualEffectView {
  /// Narrow top-center trigger zone so left-side app menus and right-side status bar menus stay unobstructed.
  public static let triggerHalfWidth: CGFloat = 48
  public static let triggerDepth: CGFloat = 6
  public static let hoverInset: CGFloat = 8

  public var onExit: (() -> Void)?
  public private(set) var isRevealed = false
  private let button = NSButton(title: "退出全屏", target: nil, action: nil)
  private let hint = NSTextField(labelWithString: "⌃⌘F")

  public override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    material = .hudWindow
    blendingMode = .withinWindow
    state = .active
    appearance = NSAppearance(named: .darkAqua)
    wantsLayer = true
    layer?.cornerRadius = 8
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
  public required init?(coder: NSCoder) { nil }

  public static func shouldReveal(point: CGPoint, in bounds: CGRect, barFrame: CGRect, barShown: Bool) -> Bool {
    guard bounds.width > 0, bounds.height > 0, point.x.isFinite, point.y.isFinite else { return false }
    if barShown, !barFrame.isEmpty, barFrame.insetBy(dx: -hoverInset, dy: -hoverInset).contains(point) {
      return true
    }
    return point.y >= bounds.minY
      && point.y <= bounds.minY + triggerDepth
      && abs(point.x - bounds.midX) <= triggerHalfWidth
  }

  public func layoutCentered(in bounds: CGRect, topOffset: CGFloat = 10) {
    let size = fittingSize
    frame = CGRect(x: ((bounds.width - size.width) / 2).rounded(), y: topOffset, width: size.width, height: size.height)
  }

  /// Fades in or out; hidden, it takes no clicks meant for the picture below.
  public func reveal(_ shown: Bool) {
    isRevealed = shown
    if shown { isHidden = false }
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.16
      animator().alphaValue = shown ? 1 : 0
    }, completionHandler: { [weak self] in
      MainActor.assumeIsolated {
        if let self, !self.isRevealed, self.alphaValue == 0 { self.isHidden = true }
      }
    })
  }

  @objc private func exit() { onExit?() }
}

/// Manages `DesktopFullScreenBar` inside a flipped full-screen container, revealing it only from the
/// narrow top-center edge and hiding it promptly once the pointer moves away.
@MainActor public final class DesktopFullScreenOverlay {
  public let bar = DesktopFullScreenBar(frame: .zero)
  private weak var container: NSView?
  private var monitor: Any?
  private var hideWork: DispatchWorkItem?

  public init(onExit: @escaping () -> Void) {
    bar.onExit = onExit
  }

  public func attach(to container: NSView) {
    let attachedBefore = bar.superview === container && monitor != nil
    self.container = container
    if bar.superview !== container {
      container.addSubview(bar, positioned: .above, relativeTo: nil)
    }
    layout()
    container.window?.acceptsMouseMovedEvents = true
    if monitor == nil {
      monitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
        MainActor.assumeIsolated { self?.pointerMoved(event) }
        return event
      }
    }
    if !attachedBefore {
      reveal(after: 1.6)
    }
  }

  public func detach() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    hideWork?.cancel(); hideWork = nil
    bar.reveal(false)
    bar.removeFromSuperview()
    container = nil
  }

  public func layout() {
    guard let container else { return }
    bar.layoutCentered(in: container.bounds)
  }

  private func pointerMoved(_ event: NSEvent) {
    guard let container, event.window === container.window else { return }
    let point = container.convert(event.locationInWindow, from: nil)
    if DesktopFullScreenBar.shouldReveal(point: point, in: container.bounds, barFrame: bar.frame, barShown: bar.isRevealed) {
      reveal(after: 1.4)
    } else if bar.isRevealed {
      scheduleHide(after: 0.22)
    }
  }

  private func reveal(after delay: TimeInterval) {
    bar.reveal(true)
    scheduleHide(after: delay)
  }

  private func scheduleHide(after delay: TimeInterval) {
    hideWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self, let container = self.container else { return }
        if let window = container.window {
          let point = container.convert(window.mouseLocationOutsideOfEventStream, from: nil)
          if DesktopFullScreenBar.shouldReveal(point: point, in: container.bounds, barFrame: self.bar.frame, barShown: true) {
            self.scheduleHide(after: 0.6)
            return
          }
        }
        self.bar.reveal(false)
      }
    }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }
}
