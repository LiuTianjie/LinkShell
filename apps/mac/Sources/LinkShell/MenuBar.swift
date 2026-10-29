import AppKit

/// `--menubar <socket>`: the menu bar item of LinkShell's window. macOS draws a menu bar item
/// only for a process running the bundle's main executable (this one), and the window runs as
/// `LinkShell Desktop`; so the window has the system open this, which shows the item it is sent,
/// reports a click back, and ends when the window's app has gone (its socket closes).
///
/// Window → here: `{"t":"menu","tooltip":"…","items":[{"id":"open","label":"…"},{"separator":true}]}`.
/// Here → window: `{"t":"click","id":"open"}`; `{"t":"reopen"}` when the app is opened again.
@MainActor final class MenuBar: NSObject, NSApplicationDelegate {
  private let link: Link
  private var item: NSStatusItem!

  private init(link: Link) {
    self.link = link
  }

  static func run(link: Link) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let bar = MenuBar(link: link)
    app.delegate = bar
    withExtendedLifetime(bar) { app.run() }
    exit(0)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    MenuBar.placeFirstTime()
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = MenuBar.icon()
    item.button?.toolTip = "LinkShell"
    link.read(each: { [weak self] message in self?.handle(message) }, end: { exit(0) })
  }

  /// Opened from Finder, the Dock or Spotlight while running, the system may pick this instance.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    link.emit(["t": "reopen"])
    return false
  }

  private func handle(_ message: [String: Any]) {
    guard message["t"] as? String == "menu" else { return }
    if let tooltip = message["tooltip"] as? String { item.button?.toolTip = tooltip }
    item.menu = MenuBar.menu(message["items"] as? [[String: Any]] ?? [], target: self)
  }

  static func menu(_ entries: [[String: Any]], target: AnyObject) -> NSMenu {
    let menu = NSMenu()
    for entry in entries {
      if entry["separator"] as? Bool == true {
        menu.addItem(.separator())
      } else if let id = entry["id"] as? String, let label = entry["label"] as? String {
        let item = NSMenuItem(title: label, action: #selector(MenuBar.clicked(_:)), keyEquivalent: "")
        item.representedObject = id
        item.target = target
        menu.addItem(item)
      }
    }
    return menu
  }

  @objc private func clicked(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    link.emit(["t": "click", "id": id])
  }

  /// Where AppKit keeps this item's place (points from the right): it is the process's first, `Item-0`.
  static let positionKey = "NSStatusItem Preferred Position Item-0"

  /// A new item goes to the far left, the end a full menu bar beside the notch hides. With no
  /// place kept yet, it starts near the right; where it is dragged to is kept under the same key.
  static func placeFirstTime(_ defaults: UserDefaults = .standard) {
    if defaults.object(forKey: positionKey) == nil { defaults.set(300.0, forKey: positionKey) }
  }

  /// The window's own template picture (both resolutions), or the drawn mark if it is missing.
  private static func icon() -> NSImage {
    let assets = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/app/assets")
    let image = NSImage(size: NSSize(width: 18, height: 18))
    for name in ["trayTemplate.png", "trayTemplate@2x.png"] {
      guard let data = try? Data(contentsOf: assets.appendingPathComponent(name)), let rep = NSBitmapImageRep(data: data) else { continue }
      rep.size = image.size
      image.addRepresentation(rep)
    }
    guard !image.representations.isEmpty else { return DesktopStatusIcon.make() }
    image.isTemplate = true
    image.accessibilityDescription = "LinkShell"
    return image
  }
}
