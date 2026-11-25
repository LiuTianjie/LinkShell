import AppKit

/// Persistent semi-transparent floating top-center capsule shown while `DesktopFullScreenBar` is
/// collapsed, so full-screen exit and menu controls are always easy to spot without blocking work.
/// Hovering (or clicking) reveals the full opaque floating menu bar.
public final class DesktopFullScreenHandle: NSVisualEffectView {
  public static let topOffset: CGFloat = 10
  public static let restingAlpha: CGFloat = 0.36
  public static let height: CGFloat = 26

  public var onTrigger: (() -> Void)?
  private var tracking: NSTrackingArea?
  private let label = NSTextField(labelWithString: "退出全屏")

  public override init(frame frameRect: NSRect) {
    super.init(frame: frameRect.isEmpty ? NSRect(x: 0, y: 0, width: 108, height: Self.height) : frameRect)
    material = .hudWindow
    blendingMode = .withinWindow
    state = .active
    appearance = NSAppearance(named: .darkAqua)
    wantsLayer = true
    layer?.cornerRadius = Self.height / 2
    layer?.masksToBounds = true
    layer?.backgroundColor = NSColor(calibratedRed: 0.08, green: 0.09, blue: 0.12, alpha: 0.82).cgColor
    layer?.borderWidth = 0.5
    layer?.borderColor = NSColor(white: 1.0, alpha: 0.24).cgColor

    let exitIcon = NSImageView()
    exitIcon.image = NSImage(systemSymbolName: "arrow.down.right.and.arrow.up.left", accessibilityDescription: nil)
    exitIcon.contentTintColor = NSColor(white: 1.0, alpha: 0.94)
    exitIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10.5, weight: .medium)

    label.font = .systemFont(ofSize: 11.5, weight: .medium)
    label.textColor = NSColor(white: 1.0, alpha: 0.94)
    label.setAccessibilityElement(false)

    let chevron = NSImageView()
    chevron.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)
    chevron.contentTintColor = NSColor(white: 1.0, alpha: 0.72)
    chevron.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 9.5, weight: .semibold)

    let stack = NSStackView(views: [exitIcon, label, chevron])
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = 5
    stack.edgeInsets = NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 9)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
      heightAnchor.constraint(equalToConstant: Self.height),
    ])

    alphaValue = Self.restingAlpha
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel("显示退出全屏菜单")
  }
  public required init?(coder: NSCoder) { nil }

  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  public override func hitTest(_ point: NSPoint) -> NSView? {
    guard !isHidden, alphaValue > 0.01 else { return nil }
    let local = superview != nil ? convert(point, from: superview) : point
    return bounds.contains(local) ? self : nil
  }

  public func layoutCentered(in bounds: CGRect) {
    let fitted = fittingSize
    let width = max(104, ceil(fitted.width))
    frame = CGRect(
      x: ((bounds.width - width) / 2).rounded(),
      y: Self.topOffset,
      width: width,
      height: Self.height
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

/// Floating frosted-dark full-screen menu capsule revealed on hover over `DesktopFullScreenHandle`:
/// exposes quick remote controls (when wired), a native dropdown menu, and `[退出全屏  ⌃⌘F]`.
public final class DesktopFullScreenBar: NSVisualEffectView {
  /// Top-center trigger zone wide enough to find effortlessly while leaving left app menus and right status bar items clear.
  public static let triggerHalfWidth: CGFloat = 180
  public static let triggerDepth: CGFloat = 22
  public static let hoverInset: CGFloat = 10

  public var onExit: (() -> Void)?
  public var onAction: ((String) -> Void)? {
    didSet { syncActionButtonsVisibility() }
  }
  public var onRevealChanged: ((Bool) -> Void)?
  public private(set) var isRevealed = false
  public private(set) var isMenuOpen = false

  private let controlButton = NSButton(title: "仅观看", target: nil, action: nil)
  private let audioButton = NSButton(title: "静音", target: nil, action: nil)
  private let menuButton = NSButton(title: "菜单", target: nil, action: nil)
  private let divider = NSBox()
  private let button = NSButton(title: "退出全屏", target: nil, action: nil)
  private let hint = NSTextField(labelWithString: "⌃⌘F")

  public override init(frame frameRect: NSRect) {
    super.init(frame: frameRect.isEmpty ? NSRect(x: 0, y: 0, width: 160, height: 36) : frameRect)
    material = .hudWindow
    blendingMode = .withinWindow
    state = .active
    appearance = NSAppearance(named: .darkAqua)
    wantsLayer = true
    layer?.cornerRadius = 12
    layer?.masksToBounds = true
    layer?.borderWidth = 0.5
    layer?.borderColor = NSColor(white: 1.0, alpha: 0.16).cgColor

    for (btn, symbol, action, accessibility) in [
      (controlButton, "eye", #selector(toggleControl), "切换远程控制"),
      (audioButton, "speaker.slash", #selector(toggleAudio), "切换远程声音"),
      (menuButton, "ellipsis.circle", #selector(openMoreMenu), "更多远程菜单"),
    ] as [(NSButton, String, Selector, String)] {
      btn.target = self
      btn.action = action
      btn.bezelStyle = .rounded
      btn.controlSize = .regular
      btn.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
      btn.imagePosition = .imageLeading
      btn.setAccessibilityLabel(accessibility)
    }

    divider.boxType = .separator
    divider.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      divider.widthAnchor.constraint(equalToConstant: 1),
      divider.heightAnchor.constraint(equalToConstant: 16),
    ])

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

    let stack = NSStackView(views: [controlButton, audioButton, menuButton, divider, button, hint])
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = 8
    stack.edgeInsets = NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 10)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    syncActionButtonsVisibility()
    alphaValue = 0
    isHidden = true
  }
  public required init?(coder: NSCoder) { nil }

  public func updateState(control: Bool, audioMuted: Bool) {
    controlButton.title = control ? "控制中" : "仅观看"
    controlButton.image = NSImage(
      systemSymbolName: control ? "cursorarrow.click" : "eye",
      accessibilityDescription: nil
    )
    controlButton.contentTintColor = control ? NSColor(calibratedRed: 0.55, green: 0.61, blue: 1.0, alpha: 1.0) : nil

    audioButton.title = audioMuted ? "静音" : "声音"
    audioButton.image = NSImage(
      systemSymbolName: audioMuted ? "speaker.slash" : "speaker.wave.2",
      accessibilityDescription: nil
    )
    audioButton.contentTintColor = audioMuted ? nil : NSColor(calibratedRed: 0.55, green: 0.61, blue: 1.0, alpha: 1.0)
    needsLayout = true
  }

  private func syncActionButtonsVisibility() {
    let hasActions = onAction != nil
    controlButton.isHidden = !hasActions
    audioButton.isHidden = !hasActions
    menuButton.isHidden = !hasActions
    divider.isHidden = !hasActions
    needsLayout = true
  }

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

  @objc private func toggleControl() { onAction?("toggleControl") }
  @objc private func toggleAudio() { onAction?("toggleAudio") }
  @objc private func reconnectAction() { onAction?("reconnect") }
  @objc private func disconnectAction() { onAction?("disconnect") }
  @objc private func exit() { onExit?() }

  @objc private func openMoreMenu() {
    let menu = NSMenu(title: "远程屏幕菜单")
    menu.appearance = NSAppearance(named: .darkAqua)
    let reconnectItem = NSMenuItem(title: "重新连接", action: #selector(reconnectAction), keyEquivalent: "")
    reconnectItem.target = self
    let disconnectItem = NSMenuItem(title: "断开连接", action: #selector(disconnectAction), keyEquivalent: "")
    disconnectItem.target = self
    let exitItem = NSMenuItem(title: "退出全屏 (⌃⌘F)", action: #selector(exit), keyEquivalent: "")
    exitItem.target = self
    menu.addItem(reconnectItem)
    menu.addItem(disconnectItem)
    menu.addItem(.separator())
    menu.addItem(exitItem)
    isMenuOpen = true
    defer { isMenuOpen = false }
    menu.popUp(positioning: nil, at: NSPoint(x: 0, y: menuButton.bounds.height + 4), in: menuButton)
  }
}

/// Manages `DesktopFullScreenBar` and its persistent semi-transparent top-center floating pill
/// inside a flipped full-screen container, revealing the full menu on entry (2.4s) and whenever
/// the floating pill or top-center zone is hovered or clicked.
@MainActor public final class DesktopFullScreenOverlay {
  public let bar = DesktopFullScreenBar(frame: .zero)
  public let handle = DesktopFullScreenHandle(frame: .zero)
  private weak var container: NSView?
  private var monitor: Any?
  private var hideWork: DispatchWorkItem?

  public init(onExit: @escaping () -> Void, onAction: ((String) -> Void)? = nil) {
    bar.onExit = onExit
    bar.onAction = onAction
    bar.onRevealChanged = { [weak self] revealed in
      MainActor.assumeIsolated { self?.syncHandleVisibility(barRevealed: revealed) }
    }
    handle.onTrigger = { [weak self] in
      MainActor.assumeIsolated { self?.reveal(after: 2.4) }
    }
  }

  deinit {
    hideWork?.cancel()
    if let monitor {
      if Thread.isMainThread {
        NSEvent.removeMonitor(monitor)
      } else {
        DispatchQueue.main.async {
          NSEvent.removeMonitor(monitor)
        }
      }
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
      reveal(after: 2.4)
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

  public func updateState(control: Bool, audioMuted: Bool) {
    bar.updateState(control: control, audioMuted: audioMuted)
    layout()
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
    let overHandle = !handle.isHidden && handle.frame.insetBy(dx: -6, dy: -6).contains(point)
    if overHandle || DesktopFullScreenBar.shouldReveal(point: point, in: container.bounds, barFrame: bar.frame, barShown: bar.isRevealed) {
      reveal(after: 2.0)
    } else if bar.isRevealed && !bar.isMenuOpen {
      scheduleHide(after: 0.35)
    }
  }

  private func reveal(after delay: TimeInterval) {
    layout()
    bar.reveal(true)
    scheduleHide(after: delay)
  }

  private func scheduleHide(after delay: TimeInterval) {
    hideWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self, let container = self.container else { return }
        if self.bar.isMenuOpen {
          self.scheduleHide(after: 0.5)
          return
        }
        if let window = container.window {
          let point = container.convert(window.mouseLocationOutsideOfEventStream, from: nil)
          let overHandle = !self.handle.isHidden && self.handle.frame.insetBy(dx: -6, dy: -6).contains(point)
          if overHandle || DesktopFullScreenBar.shouldReveal(point: point, in: container.bounds, barFrame: self.bar.frame, barShown: true) {
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
