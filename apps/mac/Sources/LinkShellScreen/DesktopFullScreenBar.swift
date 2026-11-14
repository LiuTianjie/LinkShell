import AppKit

/// Subtle persistent top-center pill shown while `DesktopFullScreenBar` is collapsed so the user
/// always sees a discoverable target that reveals `[退出全屏  ⌃⌘F]` on hover or click.
public final class DesktopFullScreenHandle: NSView {
  public static let size = CGSize(width: 48, height: 5)
  public static let topOffset: CGFloat = 6
  public static let restingAlpha: CGFloat = 0.48

  public var onTrigger: (() -> Void)?
  private var tracking: NSTrackingArea?

  public override init(frame frameRect: NSRect) {
    super.init(frame: frameRect.isEmpty ? NSRect(origin: .zero, size: Self.size) : frameRect)
    wantsLayer = true
    layer?.cornerRadius = Self.size.height / 2
    layer?.masksToBounds = true
    layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.9).cgColor
    layer?.borderWidth = 0.5
    layer?.borderColor = NSColor(white: 0.0, alpha: 0.35).cgColor
    alphaValue = Self.restingAlpha
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel("显示退出全屏工具栏")
  }
  public required init?(coder: NSCoder) { nil }

  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  public func layoutCentered(in bounds: CGRect) {
    frame = CGRect(
      x: ((bounds.width - Self.size.width) / 2).rounded(),
      y: Self.topOffset,
      width: Self.size.width,
      height: Self.size.height
    )
  }

  public override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let next = NSTrackingArea(
      rect: .zero,
      options: [.mouseEnteredAndExited, .mouseMoved, .cursorUpdate, .activeAlways, .inVisibleRect],
      owner: self
    )
    addTrackingArea(next)
    tracking = next
  }

  public override func cursorUpdate(with event: NSEvent) { NSCursor.pointingHand.set() }
  public override func mouseEntered(with event: NSEvent) { onTrigger?() }
  public override func mouseMoved(with event: NSEvent) { onTrigger?() }
  public override func mouseDown(with event: NSEvent) { onTrigger?() }
}

/// A small dark bar at the top of the full screen picture: 退出全屏, and the shortcut that does the same.
public final class DesktopFullScreenBar: NSVisualEffectView {
  /// Top-center trigger zone wide enough to find effortlessly while leaving left app menus and right status bar items clear.
  public static let triggerHalfWidth: CGFloat = 180
  public static let triggerDepth: CGFloat = 22
  public static let hoverInset: CGFloat = 8

  public var onExit: (() -> Void)?
  public var onRevealChanged: ((Bool) -> Void)?
  public private(set) var isRevealed = false
  private let button = NSButton(title: "退出全屏", target: nil, action: nil)
  private let hint = NSTextField(labelWithString: "⌃⌘F")

  public override init(frame frameRect: NSRect) {
    super.init(frame: frameRect.isEmpty ? NSRect(x: 0, y: 0, width: 160, height: 36) : frameRect)
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
    let changed = isRevealed != shown
    isRevealed = shown
    if shown { isHidden = false }
    if changed { onRevealChanged?(shown) }
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

/// Manages `DesktopFullScreenBar` and its persistent top-center handle pill inside a flipped
/// full-screen container, revealing `[退出全屏  ⌃⌘F]` on entry (3.0s) and whenever the top-center
/// zone or handle is hovered or clicked.
@MainActor public final class DesktopFullScreenOverlay {
  public let bar = DesktopFullScreenBar(frame: .zero)
  public let handle = DesktopFullScreenHandle(frame: .zero)
  private weak var container: NSView?
  private var monitor: Any?
  private var hideWork: DispatchWorkItem?

  public init(onExit: @escaping () -> Void) {
    bar.onExit = onExit
    bar.onRevealChanged = { [weak self] revealed in
      MainActor.assumeIsolated { self?.syncHandleVisibility(barRevealed: revealed) }
    }
    handle.onTrigger = { [weak self] in
      MainActor.assumeIsolated { self?.reveal(after: 2.4) }
    }
  }

  public func attach(to container: NSView) {
    let attachedBefore = bar.superview === container && monitor != nil
    self.container = container
    if handle.superview !== container {
      container.addSubview(handle, positioned: .above, relativeTo: nil)
    }
    if bar.superview !== container {
      container.addSubview(bar, positioned: .above, relativeTo: handle)
    }
    layout()
    syncHandleVisibility(barRevealed: bar.isRevealed)
    container.window?.acceptsMouseMovedEvents = true
    if monitor == nil {
      monitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
        MainActor.assumeIsolated { self?.pointerMoved(event) }
        return event
      }
    }
    if !attachedBefore {
      reveal(after: 3.0)
    }
  }

  public func detach() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    hideWork?.cancel(); hideWork = nil
    bar.reveal(false)
    bar.removeFromSuperview()
    handle.removeFromSuperview()
    container = nil
  }

  public func layout() {
    guard let container else { return }
    handle.layoutCentered(in: container.bounds)
    bar.layoutCentered(in: container.bounds)
  }

  public func triggerHandle() {
    reveal(after: 2.4)
  }

  private func syncHandleVisibility(barRevealed: Bool) {
    handle.isHidden = barRevealed
    handle.alphaValue = barRevealed ? 0 : DesktopFullScreenHandle.restingAlpha
  }

  private func pointerMoved(_ event: NSEvent) {
    guard let container, event.window === container.window else { return }
    let point = container.convert(event.locationInWindow, from: nil)
    if DesktopFullScreenBar.shouldReveal(point: point, in: container.bounds, barFrame: bar.frame, barShown: bar.isRevealed) {
      reveal(after: 2.0)
    } else if bar.isRevealed {
      scheduleHide(after: 0.3)
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
