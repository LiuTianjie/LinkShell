import AppKit
import Darwin
import QuartzCore

@MainActor
enum DragPermissionKind: Equatable {
  case accessibility
  case screenRecording
  case inputMonitoring

  var privacyPane: String {
    switch self {
    case .accessibility: return "Privacy_Accessibility"
    case .screenRecording: return "Privacy_ScreenCapture"
    case .inputMonitoring: return "Privacy_ListenEvent"
    }
  }

  var settingsURL: URL {
    URL(string: "x-apple.systempreferences:com.apple.preference.security?\(privacyPane)")!
  }

  func displayName(chinese: Bool) -> String {
    switch self {
    case .accessibility:
      return chinese ? "辅助功能" : "Accessibility"
    case .screenRecording:
      if #available(macOS 15, *) {
        return chinese ? "录屏与系统录音" : "Screen & System Audio Recording"
      }
      return chinese ? "屏幕录制" : "Screen Recording"
    case .inputMonitoring:
      return chinese ? "输入监控" : "Input Monitoring"
    }
  }
}

/// Standalone `--guide-permission <recording|control>` helper process launched directly by the
/// desktop UI: skips any intermediate window, opens System Settings directly to the target pane,
/// anchors the floating drag card to System Settings, and exits cleanly once granted or closed.
final class PermissionGuideRunner: NSObject, NSApplicationDelegate {
  private static let switchNotification = Notification.Name("com.bd.linkshell.host.guide.switch")
  private static let lockPath = NSTemporaryDirectory() + "com.bd.linkshell.host.guide.lock"

  private let initialPermission: Permission

  static func run(_ raw: String) -> Never {
    let permission: Permission = (raw == "control" || raw == "accessibility") ? .control : .recording
    if getppid() != 1, !Launch.has("--reopened") {
      let open = Process()
      open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      open.arguments = ["-n", "-a", Bundle.main.bundlePath, "--args", "--guide-permission", permission.rawValue, "--reopened"]
      if (try? open.run()) != nil {
        open.waitUntilExit()
      }
      exit(0)
    }

    guard holdsLock() else {
      DistributedNotificationCenter.default().postNotificationName(
        switchNotification,
        object: permission.rawValue,
        userInfo: nil,
        deliverImmediately: true
      )
      exit(0)
    }

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let runner = PermissionGuideRunner(initialPermission: permission)
    app.delegate = runner
    withExtendedLifetime(runner) { app.run() }
    exit(0)
  }

  private static func holdsLock() -> Bool {
    let fd = Darwin.open(lockPath, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    return fd < 0 || flock(fd, LOCK_EX | LOCK_NB) == 0
  }

  private init(initialPermission: Permission) {
    self.initialPermission = initialPermission
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    DistributedNotificationCenter.default().addObserver(
      self,
      selector: #selector(handleSwitchNotification(_:)),
      name: Self.switchNotification,
      object: nil,
      suspensionBehavior: .deliverImmediately
    )
    Task { @MainActor in
      self.guide(self.initialPermission)
    }
  }

  @objc private func handleSwitchNotification(_ notification: Notification) {
    let raw = (notification.object as? String) ?? ""
    let permission: Permission = (raw == "control" || raw == "accessibility") ? .control : .recording
    Task { @MainActor in
      self.guide(permission)
    }
  }

  @MainActor
  private func guide(_ permission: Permission) {
    let kind: DragPermissionKind = permission == .recording ? .screenRecording : .accessibility
    PermissionDragGuide.shared.openAndGuide(
      kind: kind,
      appName: "LinkShell",
      checkGranted: {
        switch permission {
        case .control:
          return Permissions.trusted()
        case .recording:
          return await Task.detached(priority: .userInitiated) { Permissions.recording() }.value
        }
      },
      onGranted: {},
      onDismiss: {
        NSApp.terminate(nil)
      }
    )
  }
}

/// Floating, non-activating drag-and-drop helper anchored to the bottom-right corner of
/// macOS System Settings. Dragging the app tile directly onto the Privacy list adds and
/// enables the app without hunting through /Applications.
@MainActor
final class PermissionDragGuide: NSObject {
  static let shared = PermissionDragGuide()

  private static let panelWidth: CGFloat = 324
  private static let allowedFrontmostBundleIDs: Set<String> = [
    "com.apple.systempreferences",
    "com.apple.SecurityAgent",
    "com.apple.LocalAuthentication.UIAgent",
    "com.apple.UserNotificationCenter",
    "com.apple.accessibility.universalAccessAuthWarn",
    "com.apple.coreservices.uiagent",
    "com.apple.TCC",
  ]

  private var panel: NonActivatingDragPanel?
  private var cardView: PermissionDragCardView?
  private var trackingTimer: Timer?
  private var pollTask: Task<Void, Never>?
  private var dismissTask: Task<Void, Never>?

  private var currentKind: DragPermissionKind?
  private var currentAppName: String?
  private var currentBundleURL: URL?
  private var checkGranted: (@MainActor () async -> Bool)?
  private var onGranted: (@MainActor () -> Void)?
  private var onDismiss: (@MainActor () -> Void)?

  private var isDragging = false
  private var isGrantedShown = false
  private var seenSettingsWindow = false
  private var waitTicks = 0
  private var ticksWithoutSettings = 0
  private var lastSettingsFrame: CGRect?
  private var userMovedPanel = false
  private var panelShown = false
  private var moveObserver: NSObjectProtocol?

  private override init() {
    super.init()
  }

  func openAndGuide(
    kind: DragPermissionKind,
    appName: String? = nil,
    bundleURL: URL? = nil,
    checkGranted: @escaping @MainActor () async -> Bool,
    onGranted: @escaping @MainActor () -> Void = {},
    onDismiss: (@MainActor () -> Void)? = nil
  ) {
    NSWorkspace.shared.open(kind.settingsURL)
    show(
      kind: kind,
      appName: appName,
      bundleURL: bundleURL,
      checkGranted: checkGranted,
      onGranted: onGranted,
      onDismiss: onDismiss
    )
  }

  func show(
    kind: DragPermissionKind,
    appName: String? = nil,
    bundleURL: URL? = nil,
    checkGranted: @escaping @MainActor () async -> Bool,
    onGranted: @escaping @MainActor () -> Void = {},
    onDismiss: (@MainActor () -> Void)? = nil
  ) {
    dismissTask?.cancel()
    dismissTask = nil
    pollTask?.cancel()
    pollTask = nil

    let resolvedURL = bundleURL ?? Self.resolvedAppBundleURL()
    let resolvedName = appName ?? Self.resolvedAppName(bundleURL: resolvedURL)
    let chinese = Self.prefersChinese()

    currentKind = kind
    currentAppName = resolvedName
    currentBundleURL = resolvedURL
    self.checkGranted = checkGranted
    self.onGranted = onGranted
    self.onDismiss = onDismiss
    isGrantedShown = false
    isDragging = false
    seenSettingsWindow = false
    waitTicks = 0
    ticksWithoutSettings = 0
    lastSettingsFrame = nil
    userMovedPanel = false

    let panel = ensurePanel(appName: resolvedName, bundleURL: resolvedURL)
    cardView?.configure(
      kind: kind,
      appName: resolvedName,
      bundleURL: resolvedURL,
      chinese: chinese,
      granted: false
    )
    resizePanelToFit(panel)

    if let settingsFrame = Self.systemSettingsWindowFrame() {
      seenSettingsWindow = true
      lastSettingsFrame = settingsFrame
      let origin = Self.anchoredOrigin(panelSize: panel.frame.size, settingsFrame: settingsFrame)
      panel.setFrameOrigin(origin)
      presentPanel(panel)
    } else {
      panelShown = panel.isVisible
    }

    startTracking()
    startPolling()
  }

  func dismiss(animated: Bool = true) {
    trackingTimer?.invalidate()
    trackingTimer = nil
    pollTask?.cancel()
    pollTask = nil
    dismissTask?.cancel()
    dismissTask = nil
    if let moveObserver {
      NotificationCenter.default.removeObserver(moveObserver)
      self.moveObserver = nil
    }

    let dismissCallback = onDismiss
    currentKind = nil
    checkGranted = nil
    onGranted = nil
    onDismiss = nil
    panelShown = false
    isDragging = false

    guard let panel else {
      dismissCallback?()
      return
    }
    cardView?.stopArrowAnimation()
    if animated && panel.isVisible {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.16
        panel.animator().alphaValue = 0
      }, completionHandler: { [weak panel] in
        Task { @MainActor in
          panel?.orderOut(nil)
          panel?.alphaValue = 1
          dismissCallback?()
        }
      })
    } else {
      panel.orderOut(nil)
      panel.alphaValue = 1
      dismissCallback?()
    }
  }

  private func ensurePanel(appName: String, bundleURL: URL) -> NonActivatingDragPanel {
    if let existing = panel {
      return existing
    }
    let panel = NonActivatingDragPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: 126),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .floating
    panel.isFloatingPanel = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

    let card = PermissionDragCardView(
      appName: appName,
      bundleURL: bundleURL,
      onClose: { [weak self] in
        self?.dismiss(animated: true)
      },
      onDragStateChanged: { [weak self] dragging in
        self?.isDragging = dragging
      },
      onDragEnded: { [weak self] in
        self?.schedulePostDragChecks()
      }
    )
    panel.contentView = card
    self.panel = panel
    self.cardView = card

    moveObserver = NotificationCenter.default.addObserver(
      forName: NSWindow.didMoveNotification,
      object: panel,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor [weak self] in
        guard let self, self.panelShown else { return }
        if let settingsFrame = self.lastSettingsFrame, let panel = self.panel {
          let expected = Self.anchoredOrigin(panelSize: panel.frame.size, settingsFrame: settingsFrame)
          let dx = abs(panel.frame.origin.x - expected.x)
          let dy = abs(panel.frame.origin.y - expected.y)
          if dx > 6 || dy > 6 {
            self.userMovedPanel = true
          }
        }
      }
    }
    return panel
  }

  private func resizePanelToFit(_ panel: NonActivatingDragPanel) {
    guard let content = panel.contentView else { return }
    content.layoutSubtreeIfNeeded()
    let fitting = content.fittingSize
    let size = NSSize(width: Self.panelWidth, height: max(112, ceil(fitting.height)))
    if panel.frame.size != size {
      panel.setContentSize(size)
    }
  }

  private func presentPanel(_ panel: NonActivatingDragPanel) {
    guard !panelShown || !panel.isVisible else {
      panel.orderFrontRegardless()
      return
    }
    panelShown = true
    panel.alphaValue = 0
    panel.orderFrontRegardless()
    cardView?.startArrowAnimation()
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.2
      ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
      panel.animator().alphaValue = 1
    }
  }

  private func startTracking() {
    trackingTimer?.invalidate()
    waitTicks = 0
    let timer = Timer(timeInterval: 0.22, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in
        guard let self, let panel = self.panel else { return }
        self.waitTicks += 1

        if let settingsFrame = Self.systemSettingsWindowFrame() {
          self.seenSettingsWindow = true
          self.ticksWithoutSettings = 0
          let moved = self.lastSettingsFrame.map {
            abs($0.origin.x - settingsFrame.origin.x) > 1 ||
            abs($0.origin.y - settingsFrame.origin.y) > 1 ||
            abs($0.width - settingsFrame.width) > 1 ||
            abs($0.height - settingsFrame.height) > 1
          } ?? true
          self.lastSettingsFrame = settingsFrame

          if !self.panelShown {
            let origin = Self.anchoredOrigin(panelSize: panel.frame.size, settingsFrame: settingsFrame)
            panel.setFrameOrigin(origin)
            self.presentPanel(panel)
          } else if !self.isDragging && (moved || !self.userMovedPanel) {
            if moved { self.userMovedPanel = false }
            let target = Self.anchoredOrigin(panelSize: panel.frame.size, settingsFrame: settingsFrame)
            if abs(panel.frame.origin.x - target.x) > 1 || abs(panel.frame.origin.y - target.y) > 1 {
              NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.14
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrameOrigin(target)
              }
            }
          }

          if self.isDragging || self.shouldStayVisibleForFrontmostApp() {
            if !panel.isVisible {
              panel.orderFrontRegardless()
              self.cardView?.startArrowAnimation()
            }
          } else if panel.isVisible {
            panel.orderOut(nil)
          }
        } else {
          if !self.seenSettingsWindow {
            if self.waitTicks >= 3 && !self.panelShown {
              let origin = Self.fallbackOrigin(panelSize: panel.frame.size)
              panel.setFrameOrigin(origin)
              self.presentPanel(panel)
            }
            if self.waitTicks >= 60 {
              self.dismiss(animated: true)
            }
          } else if !self.isDragging {
            self.ticksWithoutSettings += 1
            let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
            if self.ticksWithoutSettings >= 4 && front != "com.apple.systempreferences" {
              self.dismiss(animated: true)
            }
          }
        }
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    trackingTimer = timer
  }

  private func shouldStayVisibleForFrontmostApp() -> Bool {
    guard let frontID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else {
      return true
    }
    if Self.allowedFrontmostBundleIDs.contains(frontID) {
      return true
    }
    if let ownID = Bundle.main.bundleIdentifier, frontID == ownID {
      return true
    }
    return false
  }

  private func startPolling() {
    pollTask?.cancel()
    pollTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        guard let self, !self.isGrantedShown else { return }
        await self.evaluatePermission()
        try? await Task.sleep(for: .milliseconds(500))
      }
    }
  }

  private func schedulePostDragChecks() {
    Task { @MainActor [weak self] in
      for delay in [250, 750, 1500] {
        try? await Task.sleep(for: .milliseconds(delay))
        guard let self, !self.isGrantedShown, self.currentKind != nil else { return }
        await self.evaluatePermission()
      }
    }
  }

  private func evaluatePermission() async {
    guard !isGrantedShown, let checkGranted, let kind = currentKind else { return }
    let granted = await checkGranted()
    guard granted, !isGrantedShown, currentKind == kind else { return }
    handleGranted(kind: kind)
  }

  private func handleGranted(kind: DragPermissionKind) {
    isGrantedShown = true
    pollTask?.cancel()
    pollTask = nil

    let resolvedURL = currentBundleURL ?? Self.resolvedAppBundleURL()
    let resolvedName = currentAppName ?? Self.resolvedAppName(bundleURL: resolvedURL)
    cardView?.configure(
      kind: kind,
      appName: resolvedName,
      bundleURL: resolvedURL,
      chinese: Self.prefersChinese(),
      granted: true
    )
    if let panel {
      resizePanelToFit(panel)
      panel.orderFrontRegardless()
    }
    onGranted?()

    dismissTask?.cancel()
    dismissTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(900))
      guard !Task.isCancelled else { return }
      self?.dismiss(animated: true)
    }
  }

  // MARK: - Window geometry & bundle helpers

  private static func systemSettingsWindowFrame() -> CGRect? {
    let pids = Set(
      NSRunningApplication
        .runningApplications(withBundleIdentifier: "com.apple.systempreferences")
        .map { Int($0.processIdentifier) }
    )
    guard !pids.isEmpty,
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let primaryTop = NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.maxY ?? NSScreen.screens.first?.frame.maxY
    else { return nil }

    let candidates = windows.compactMap { info -> CGRect? in
      guard info[kCGWindowLayer as String] as? Int == 0,
            let owner = info[kCGWindowOwnerPID as String] as? Int, pids.contains(owner),
            let bounds = info[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds),
            rect.width >= 360, rect.height >= 260
      else { return nil }
      return rect
    }
    guard let quartz = candidates.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
      return nil
    }
    return CGRect(
      x: quartz.minX,
      y: primaryTop - quartz.maxY,
      width: quartz.width,
      height: quartz.height
    )
  }

  private static func anchoredOrigin(panelSize: NSSize, settingsFrame: CGRect) -> NSPoint {
    let screen = NSScreen.screens.first {
      $0.frame.contains(CGPoint(x: settingsFrame.midX, y: settingsFrame.midY))
    } ?? NSScreen.main ?? NSScreen.screens.first
    let visible = (screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)).insetBy(dx: 12, dy: 12)

    let rawX = settingsFrame.maxX - panelSize.width - 16
    let rawY = settingsFrame.minY + 34
    let clampedX = min(max(rawX, visible.minX), max(visible.minX, visible.maxX - panelSize.width))
    let clampedY = min(max(rawY, visible.minY), max(visible.minY, visible.maxY - panelSize.height))
    return NSPoint(x: round(clampedX), y: round(clampedY))
  }

  private static func fallbackOrigin(panelSize: NSSize) -> NSPoint {
    let screen = NSScreen.main ?? NSScreen.screens.first
    let visible = (screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)).insetBy(dx: 24, dy: 24)
    let x = visible.midX + 60
    let y = visible.midY - 190
    let clampedX = min(max(x, visible.minX), max(visible.minX, visible.maxX - panelSize.width))
    let clampedY = min(max(y, visible.minY), max(visible.minY, visible.maxY - panelSize.height))
    return NSPoint(x: round(clampedX), y: round(clampedY))
  }

  private static func resolvedAppBundleURL() -> URL {
    let url = Bundle.main.bundleURL
    if url.pathExtension.lowercased() == "app" {
      return url
    }
    var probe = url
    while probe.path != "/" {
      if probe.pathExtension.lowercased() == "app" {
        return probe
      }
      probe.deleteLastPathComponent()
    }
    return url
  }

  private static func resolvedAppName(bundleURL: URL) -> String {
    if let display = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String, !display.isEmpty {
      return display
    }
    if let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String, !name.isEmpty {
      return name
    }
    return (bundleURL.lastPathComponent as NSString).deletingPathExtension
  }

  private static func prefersChinese() -> Bool {
    Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") ?? false
  }
}

// MARK: - Non-activating floating panel

@MainActor
private final class NonActivatingDragPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

// MARK: - Card container view

@MainActor
private final class PermissionDragCardView: NSView {
  private let effectView = NSVisualEffectView()
  private let tintLayer = CALayer()
  private let borderLayer = CALayer()
  private let iconHolder = NSView()
  private let statusIcon = NSImageView()
  private let titleLabel = NSTextField(wrappingLabelWithString: "")
  private let closeButton: DragGuideCloseButton
  private let appTile: DraggableAppTileView

  init(
    appName: String,
    bundleURL: URL,
    onClose: @escaping @MainActor () -> Void,
    onDragStateChanged: @escaping @MainActor (Bool) -> Void,
    onDragEnded: @escaping @MainActor () -> Void
  ) {
    self.closeButton = DragGuideCloseButton(onClick: onClose)
    self.appTile = DraggableAppTileView(
      appName: appName,
      bundleURL: bundleURL,
      onDragStateChanged: onDragStateChanged,
      onDragEnded: onDragEnded
    )
    super.init(frame: .zero)
    wantsLayer = true

    effectView.material = .popover
    effectView.blendingMode = .behindWindow
    effectView.state = .active
    effectView.wantsLayer = true
    effectView.layer?.cornerRadius = 18
    effectView.layer?.masksToBounds = true
    effectView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(effectView)

    tintLayer.cornerRadius = 18
    effectView.layer?.addSublayer(tintLayer)

    borderLayer.cornerRadius = 18
    borderLayer.borderWidth = 0.75
    effectView.layer?.addSublayer(borderLayer)

    iconHolder.wantsLayer = true
    iconHolder.translatesAutoresizingMaskIntoConstraints = false

    statusIcon.translatesAutoresizingMaskIntoConstraints = false
    statusIcon.imageScaling = .scaleProportionallyUpOrDown
    iconHolder.addSubview(statusIcon)

    titleLabel.font = .systemFont(ofSize: 13.5, weight: .medium)
    titleLabel.textColor = .labelColor
    titleLabel.lineBreakMode = .byWordWrapping
    titleLabel.maximumNumberOfLines = 3
    titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    closeButton.translatesAutoresizingMaskIntoConstraints = false
    appTile.translatesAutoresizingMaskIntoConstraints = false

    effectView.addSubview(iconHolder)
    effectView.addSubview(titleLabel)
    effectView.addSubview(closeButton)
    effectView.addSubview(appTile)

    NSLayoutConstraint.activate([
      effectView.topAnchor.constraint(equalTo: topAnchor),
      effectView.bottomAnchor.constraint(equalTo: bottomAnchor),
      effectView.leadingAnchor.constraint(equalTo: leadingAnchor),
      effectView.trailingAnchor.constraint(equalTo: trailingAnchor),

      iconHolder.leadingAnchor.constraint(equalTo: effectView.leadingAnchor, constant: 15),
      iconHolder.topAnchor.constraint(equalTo: effectView.topAnchor, constant: 15),
      iconHolder.widthAnchor.constraint(equalToConstant: 20),
      iconHolder.heightAnchor.constraint(equalToConstant: 20),

      statusIcon.centerXAnchor.constraint(equalTo: iconHolder.centerXAnchor),
      statusIcon.centerYAnchor.constraint(equalTo: iconHolder.centerYAnchor),
      statusIcon.widthAnchor.constraint(equalToConstant: 16),
      statusIcon.heightAnchor.constraint(equalToConstant: 16),

      closeButton.trailingAnchor.constraint(equalTo: effectView.trailingAnchor, constant: -11),
      closeButton.topAnchor.constraint(equalTo: effectView.topAnchor, constant: 11),
      closeButton.widthAnchor.constraint(equalToConstant: 22),
      closeButton.heightAnchor.constraint(equalToConstant: 22),

      titleLabel.leadingAnchor.constraint(equalTo: iconHolder.trailingAnchor, constant: 8),
      titleLabel.topAnchor.constraint(equalTo: effectView.topAnchor, constant: 14),
      titleLabel.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -8),

      appTile.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 13),
      appTile.leadingAnchor.constraint(equalTo: effectView.leadingAnchor, constant: 14),
      appTile.trailingAnchor.constraint(equalTo: effectView.trailingAnchor, constant: -14),
      appTile.heightAnchor.constraint(equalToConstant: 44),
      appTile.bottomAnchor.constraint(equalTo: effectView.bottomAnchor, constant: -14),
    ])

    updateAppearanceColors()
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    tintLayer.frame = effectView.bounds
    borderLayer.frame = effectView.bounds
    CATransaction.commit()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    updateAppearanceColors()
  }

  private func updateAppearanceColors() {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      tintLayer.backgroundColor = isDark
        ? NSColor.windowBackgroundColor.withAlphaComponent(0.32).cgColor
        : NSColor.white.withAlphaComponent(0.76).cgColor
      borderLayer.borderColor = isDark
        ? NSColor.white.withAlphaComponent(0.14).cgColor
        : NSColor.black.withAlphaComponent(0.08).cgColor
    }
  }

  func configure(
    kind: DragPermissionKind,
    appName: String,
    bundleURL: URL,
    chinese: Bool,
    granted: Bool
  ) {
    appTile.update(appName: appName, bundleURL: bundleURL)
    let permName = kind.displayName(chinese: chinese)

    if granted {
      stopArrowAnimation()
      let config = NSImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
      statusIcon.image = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil)?
        .withSymbolConfiguration(config)
      statusIcon.contentTintColor = .systemGreen
      titleLabel.stringValue = chinese
        ? "已允许“\(appName)”使用“\(permName)”设置"
        : "“\(appName)” is now allowed in “\(permName)”"
    } else {
      let config = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
      statusIcon.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil)?
        .withSymbolConfiguration(config)
      statusIcon.contentTintColor = .controlAccentColor
      titleLabel.stringValue = chinese
        ? "拖放应用，以允许“\(appName)”使用“\(permName)”设置"
        : "Drag and drop the app to allow “\(appName)” in “\(permName)” settings"
      startArrowAnimation()
    }
  }

  func startArrowAnimation() {
    guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
    statusIcon.wantsLayer = true
    guard statusIcon.layer?.animation(forKey: "dragGuideBounce") == nil else { return }
    let anim = CABasicAnimation(keyPath: "transform.translation.y")
    anim.fromValue = -1.5
    anim.toValue = 2.5
    anim.duration = 0.95
    anim.autoreverses = true
    anim.repeatCount = .infinity
    anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    statusIcon.layer?.add(anim, forKey: "dragGuideBounce")
  }

  func stopArrowAnimation() {
    statusIcon.layer?.removeAnimation(forKey: "dragGuideBounce")
  }
}

// MARK: - Close button

@MainActor
private final class DragGuideCloseButton: NSView {
  private let onClick: @MainActor () -> Void
  private let iconView = NSImageView()
  private var hovered = false { didSet { needsDisplay = true } }
  private var trackingArea: NSTrackingArea?

  init(onClick: @escaping @MainActor () -> Void) {
    self.onClick = onClick
    super.init(frame: .zero)
    let config = NSImage.SymbolConfiguration(pointSize: 10.5, weight: .semibold)
    iconView.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")?
      .withSymbolConfiguration(config)
    iconView.contentTintColor = .secondaryLabelColor
    iconView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(iconView)
    NSLayoutConstraint.activate([
      iconView.centerXAnchor.constraint(equalTo: centerXAnchor),
      iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var mouseDownCanMoveWindow: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let trackingArea { removeTrackingArea(trackingArea) }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  override func mouseEntered(with event: NSEvent) { hovered = true }
  override func mouseExited(with event: NSEvent) { hovered = false }

  override func mouseUp(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    if bounds.contains(point) {
      onClick()
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    guard hovered else { return }
    effectiveAppearance.performAsCurrentDrawingAppearance {
      NSColor.labelColor.withAlphaComponent(0.08).setFill()
      NSBezierPath(ovalIn: bounds).fill()
    }
  }
}

// MARK: - Draggable app tile

@MainActor
private final class DraggableAppTileView: NSView, NSDraggingSource {
  private var appName: String
  private var bundleURL: URL
  private let onDragStateChanged: @MainActor (Bool) -> Void
  private let onDragEnded: @MainActor () -> Void

  private let iconView = NSImageView()
  private let nameLabel = NSTextField(labelWithString: "")
  private let gripView = NSImageView()
  private var trackingArea: NSTrackingArea?
  private var isHovered = false { didSet { needsDisplay = true } }
  private var isPressed = false { didSet { needsDisplay = true } }
  private var mouseDownPoint: NSPoint?
  private var startedDrag = false

  init(
    appName: String,
    bundleURL: URL,
    onDragStateChanged: @escaping @MainActor (Bool) -> Void,
    onDragEnded: @escaping @MainActor () -> Void
  ) {
    self.appName = appName
    self.bundleURL = bundleURL
    self.onDragStateChanged = onDragStateChanged
    self.onDragEnded = onDragEnded
    super.init(frame: .zero)

    iconView.imageScaling = .scaleProportionallyUpOrDown
    iconView.translatesAutoresizingMaskIntoConstraints = false

    nameLabel.font = .systemFont(ofSize: 14, weight: .medium)
    nameLabel.textColor = .labelColor
    nameLabel.lineBreakMode = .byTruncatingTail
    nameLabel.translatesAutoresizingMaskIntoConstraints = false

    let gripConfig = NSImage.SymbolConfiguration(pointSize: 11, weight: .medium)
    gripView.image = NSImage(systemSymbolName: "line.3.horizontal", accessibilityDescription: nil)?
      .withSymbolConfiguration(gripConfig)
    gripView.contentTintColor = .tertiaryLabelColor
    gripView.translatesAutoresizingMaskIntoConstraints = false

    addSubview(iconView)
    addSubview(nameLabel)
    addSubview(gripView)

    NSLayoutConstraint.activate([
      iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
      iconView.widthAnchor.constraint(equalToConstant: 24),
      iconView.heightAnchor.constraint(equalToConstant: 24),

      nameLabel.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 10),
      nameLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
      nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: gripView.leadingAnchor, constant: -8),

      gripView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      gripView.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])

    update(appName: appName, bundleURL: bundleURL)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func update(appName: String, bundleURL: URL) {
    self.appName = appName
    self.bundleURL = bundleURL
    nameLabel.stringValue = appName
    let fileIcon = NSWorkspace.shared.icon(forFile: bundleURL.path)
    iconView.image = fileIcon.size.width > 0 ? fileIcon : NSApp.applicationIconImage
  }

  override var mouseDownCanMoveWindow: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let trackingArea { removeTrackingArea(trackingArea) }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.mouseEnteredAndExited, .cursorUpdate, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  override func mouseEntered(with event: NSEvent) {
    isHovered = true
    NSCursor.openHand.set()
  }

  override func mouseExited(with event: NSEvent) {
    isHovered = false
    if !isPressed { NSCursor.arrow.set() }
  }

  override func cursorUpdate(with event: NSEvent) {
    if isPressed {
      NSCursor.closedHand.set()
    } else if isHovered {
      NSCursor.openHand.set()
    }
  }

  override func mouseDown(with event: NSEvent) {
    mouseDownPoint = convert(event.locationInWindow, from: nil)
    startedDrag = false
    isPressed = true
    NSCursor.closedHand.set()
  }

  override func mouseUp(with event: NSEvent) {
    mouseDownPoint = nil
    startedDrag = false
    isPressed = false
    if isHovered { NSCursor.openHand.set() } else { NSCursor.arrow.set() }
  }

  override func mouseDragged(with event: NSEvent) {
    guard !startedDrag, let start = mouseDownPoint else { return }
    let current = convert(event.locationInWindow, from: nil)
    let distance = hypot(current.x - start.x, current.y - start.y)
    guard distance >= 3 else { return }

    startedDrag = true
    let item = NSDraggingItem(pasteboardWriter: bundleURL as NSURL)
    let preview = renderDragPreview()
    item.setDraggingFrame(bounds, contents: preview)

    let session = beginDraggingSession(with: [item], event: event, source: self)
    session.animatesToStartingPositionsOnCancelOrFail = true
    session.draggingFormation = .none
  }

  override func draw(_ dirtyRect: NSRect) {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      let fillAlpha: CGFloat
      if isPressed {
        fillAlpha = isDark ? 0.16 : 0.10
      } else if isHovered {
        fillAlpha = isDark ? 0.12 : 0.075
      } else {
        fillAlpha = isDark ? 0.08 : 0.048
      }
      let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
      let path = NSBezierPath(roundedRect: rect, xRadius: 11, yRadius: 11)
      NSColor.labelColor.withAlphaComponent(fillAlpha).setFill()
      path.fill()
      let strokeColor = isDark
        ? NSColor.white.withAlphaComponent(isHovered ? 0.18 : 0.11)
        : NSColor.black.withAlphaComponent(isHovered ? 0.13 : 0.08)
      strokeColor.setStroke()
      path.lineWidth = 0.75
      path.stroke()
    }
  }

  private func renderDragPreview() -> NSImage {
    let size = bounds.size
    let appearance = effectiveAppearance
    let icon = iconView.image
    let title = appName as NSString
    return NSImage(size: size, flipped: false) { _ in
      appearance.performAsCurrentDrawingAppearance {
        let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let rect = NSRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: 11, yRadius: 11)
        (isDark ? NSColor(white: 0.18, alpha: 0.94) : NSColor(white: 0.97, alpha: 0.96)).setFill()
        path.fill()
        (isDark ? NSColor.white.withAlphaComponent(0.20) : NSColor.black.withAlphaComponent(0.12)).setStroke()
        path.lineWidth = 0.75
        path.stroke()

        if let icon {
          let iconRect = NSRect(x: 12, y: (size.height - 24) / 2, width: 24, height: 24)
          icon.draw(in: iconRect)
        }
        let attrs: [NSAttributedString.Key: Any] = [
          .font: NSFont.systemFont(ofSize: 14, weight: .medium),
          .foregroundColor: NSColor.labelColor,
        ]
        let textSize = title.size(withAttributes: attrs)
        let textRect = NSRect(
          x: 46,
          y: (size.height - textSize.height) / 2,
          width: max(0, size.width - 60),
          height: textSize.height
        )
        title.draw(in: textRect, withAttributes: attrs)
      }
      return true
    }
  }

  // MARK: - NSDraggingSource

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    [.copy, .link, .generic]
  }

  func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) {
    onDragStateChanged(true)
  }

  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
    mouseDownPoint = nil
    startedDrag = false
    isPressed = false
    onDragStateChanged(false)
    onDragEnded()
  }
}
