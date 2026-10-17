import AppKit
import CryptoKit
import Combine
import SwiftUI

/// The status UI has its own lifecycle; screen workers still exit with their host socket.
@MainActor final class Desktop: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private let model = DesktopModel()
  private var window: NSWindow!
  private var statusItem: NSStatusItem!
  private let popover = NSPopover()
  private static let wanted = Notification.Name("com.bd.linkshell.host.desktop.wanted")
  private var statusSubscription: AnyCancellable?
  private var scope = ""
  private var lock: Int32 = -1

  static func run() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let desktop = Desktop()
    app.delegate = desktop
    withExtendedLifetime(desktop) { app.run() }
    exit(0)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    scope = SHA256.hash(data: Data(model.home.utf8)).map { String(format: "%02x", $0) }.joined()
    if !model.preview {
      let path = NSTemporaryDirectory() + "com.bd.linkshell.desktop.\(scope).lock"
      lock = Darwin.open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
      if lock >= 0 && flock(lock, LOCK_EX | LOCK_NB) != 0 {
        DistributedNotificationCenter.default().postNotificationName(Self.wanted, object: scope, userInfo: ["checkUpdates": Launch.has("--check-updates")], deliverImmediately: true)
        NSApp.terminate(nil); return
      }
      DistributedNotificationCenter.default().addObserver(self, selector: #selector(handleRequest(_:)), name: Self.wanted, object: scope, suspensionBehavior: .deliverImmediately)
    }
    let root = NSHostingView(rootView: DesktopView(model: model))
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: model.preview && Launch.has("--dashboard-tall") ? 1000 : 760), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    window.title = "LinkShell"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.backgroundColor = .windowBackgroundColor
    window.contentView = root
    window.minSize = NSSize(width: 880, height: 650)
    window.isReleasedWhenClosed = false
    window.delegate = self
    if !model.preview { window.setFrameAutosaveName("LinkShellDesktop") }
    window.center()
    installMenu()
    model.start()
    if Launch.has("--check-updates") { model.selected = "更新"; model.checkUpdates() }
    if let path = Launch.value(after: "--dashboard-snapshot"), model.preview {
      root.layoutSubtreeIfNeeded()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        guard let bitmap = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { exit(1) }
        root.cacheDisplay(in: root.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
        do { try data.write(to: URL(fileURLWithPath: path)); exit(0) } catch { exit(1) }
      }
      return
    }
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.image = DesktopStatusIcon.make()
    updateStatusIcon()
    statusSubscription = model.objectWillChange.sink { [weak self] _ in
      DispatchQueue.main.async { self?.updateStatusIcon() }
    }
    statusItem.button?.target = self
    statusItem.button?.action = #selector(togglePopover)
    popover.behavior = .transient
    popover.contentViewController = NSHostingController(rootView: DesktopPopover(model: model, open: { [weak self] page in
      self?.model.selected = page; self?.showWindow()
    }))
    showWindow()
  }

  private func installMenu() {
    let main = NSMenu(); let app = NSMenu(); let item = NSMenuItem(); item.submenu = app; main.addItem(item)
    app.addItem(withTitle: "打开 LinkShell", action: #selector(reopen), keyEquivalent: "0").target = self
    app.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    app.addItem(.separator())
    app.addItem(withTitle: "退出 LinkShell 界面", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    let editItem = NSMenuItem(); let edit = NSMenu(title: "编辑"); editItem.submenu = edit; main.addItem(editItem)
    edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    NSApp.mainMenu = main
  }
  private func updateStatusIcon() {
    statusItem.button?.title = ""
    statusItem.button?.toolTip = "LinkShell · \(model.serviceLabel) · \(model.pending) 个请求待确认"
  }
  @objc private func handleRequest(_ notification: Notification) {
    if notification.userInfo?["checkUpdates"] as? Bool == true { model.selected = "更新"; model.checkUpdates() }
    showWindow()
  }
  @objc private func reopen() { showWindow() }
  private func showWindow() {
    popover.performClose(nil)
    NSApp.setActivationPolicy(.regular)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
  @objc private func togglePopover() {
    if popover.isShown { popover.performClose(nil) }
    else if let button = statusItem.button { popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
  }
  func windowWillClose(_ notification: Notification) { NSApp.setActivationPolicy(.accessory) }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
}
