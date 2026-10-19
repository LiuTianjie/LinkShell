import AppKit
import CryptoKit
import Combine
import SwiftUI

/// The status UI has its own lifecycle; screen workers still exit with their host socket.
@MainActor final class Desktop: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private let model = DesktopModel()
  private let workspace = DesktopWorkspace()
  private var window: NSWindow!
  private var statusItem: NSStatusItem!
  private let popover = NSPopover()
  private static let wanted = Notification.Name("com.bd.linkshell.host.desktop.wanted")
  private var statusSubscription: AnyCancellable?
  private var appearanceSubscription: AnyCancellable?
  private var scope = ""
  private var lock: Int32 = -1
  private var terminationPending = false

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
    if !model.preview {
      workspace.onAppearance = { [weak model = self.model] value in
        if model?.appearance != value { model?.appearance = value }
      }
      appearanceSubscription = model.$appearance.sink { [weak workspace = self.workspace] value in workspace?.setAppearance(value) }
    }
    let root = NSHostingView(rootView: DesktopRootView(model: model, workspace: workspace))
    let classicPreview = model.preview && !Launch.has("--workspace-preview")
    let windowStyle: NSWindow.StyleMask = classicPreview ? [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView] : [.titled, .closable, .miniaturizable, .resizable]
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: model.preview && Launch.has("--dashboard-tall") ? 1000 : 760), styleMask: windowStyle, backing: .buffered, defer: false)
    window.title = "LinkShell"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.titlebarSeparatorStyle = .none
    window.collectionBehavior.insert(.fullScreenPrimary)
    window.backgroundColor = DesktopStyle.windowBackground
    window.contentView = root
    window.minSize = NSSize(width: 880, height: model.preview ? 650 : 680)
    window.isReleasedWhenClosed = false
    window.delegate = self
    if !model.preview { window.setFrameAutosaveName("LinkShellDesktop") }
    window.center()
    installMenu()
    model.start()
    if model.preview && Launch.has("--workspace-preview-management") { workspace.setManaging(true) }
    if !model.preview { workspace.start() }
    if Launch.has("--check-updates") { workspace.setManaging(true); model.selected = "更新"; model.checkUpdates() }
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
      if page == "工作台" { self?.workspace.setManaging(false) }
      else { self?.workspace.setManaging(true); self?.model.selected = page }
      self?.showWindow()
    }))
    showWindow()
  }

  private func installMenu() {
    let main = NSMenu(); let app = NSMenu(); let item = NSMenuItem(); item.submenu = app; main.addItem(item)
    app.addItem(withTitle: "打开 LinkShell", action: #selector(reopen), keyEquivalent: "0").target = self
    if !model.preview {
      app.addItem(withTitle: "工作台", action: #selector(openWorkspace), keyEquivalent: "1").target = self
      app.addItem(withTitle: "本机管理", action: #selector(openManagement), keyEquivalent: "2").target = self
    }
    app.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    app.addItem(.separator())
    app.addItem(withTitle: "退出 LinkShell 界面", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    let editItem = NSMenuItem(); let edit = NSMenu(title: "编辑"); editItem.submenu = edit; main.addItem(editItem)
    edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    let windowItem = NSMenuItem(); let windows = NSMenu(title: "窗口"); windowItem.submenu = windows; main.addItem(windowItem)
    windows.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windows.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    let fullscreen = windows.addItem(withTitle: "进入全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    fullscreen.keyEquivalentModifierMask = [.command, .control]
    NSApp.windowsMenu = windows
    NSApp.mainMenu = main
  }
  @objc private func openWorkspace() { workspace.setManaging(false); showWindow() }
  @objc private func openManagement() { workspace.setManaging(true); showWindow() }
  private func updateStatusIcon() {
    statusItem.button?.title = ""
    statusItem.button?.toolTip = "LinkShell · \(model.serviceLabel) · \(model.pending) 个请求待确认"
  }
  @objc private func handleRequest(_ notification: Notification) {
    if notification.userInfo?["checkUpdates"] as? Bool == true { workspace.setManaging(true); model.selected = "更新"; model.checkUpdates() }
    showWindow()
  }
  @objc private func reopen() { showWindow() }
  private func showWindow() {
    popover.performClose(nil)
    NSApp.setActivationPolicy(.regular)
    window.makeKeyAndOrderFront(nil)
    if window.isMiniaturized { window.deminiaturize(nil) }
    if !model.preview { workspace.setWindowVisible(true) }
    NSApp.activate(ignoringOtherApps: true)
  }
  @objc private func togglePopover() {
    if popover.isShown { popover.performClose(nil) }
    else if let button = statusItem.button { popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
  }
  func windowWillClose(_ notification: Notification) {
    if !model.preview { workspace.setWindowVisible(false) }
    NSApp.setActivationPolicy(.accessory)
  }
  func windowDidMiniaturize(_ notification: Notification) { if !model.preview { workspace.setWindowVisible(false) } }
  func windowDidDeminiaturize(_ notification: Notification) { if !model.preview { workspace.setWindowVisible(true) } }
  func applicationDidHide(_ notification: Notification) { if !model.preview { workspace.setWindowVisible(false) } }
  func applicationDidUnhide(_ notification: Notification) {
    if !model.preview { workspace.setWindowVisible(window.isVisible && !window.isMiniaturized) }
  }
  func applicationWillTerminate(_ notification: Notification) {
    if !model.preview { workspace.setWindowVisible(false); workspace.stop() }
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard !model.preview else { return .terminateNow }
    guard !terminationPending else { return .terminateLater }
    terminationPending = true
    Task { @MainActor in
      let saved = await workspace.flushStorage()
      var confirmed = saved
      if !saved { confirmed = await workspace.confirmDiscard(continuing: "仍然退出") }
      terminationPending = false
      sender.reply(toApplicationShouldTerminate: confirmed)
    }
    return .terminateLater
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
}
