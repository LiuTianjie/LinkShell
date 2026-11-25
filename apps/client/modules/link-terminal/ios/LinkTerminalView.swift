import ExpoModulesCore
import GhosttyTerminal
import UIKit
import UniformTypeIdentifiers

final class LinkTerminalView: ExpoView {
  let onFontSize = EventDispatcher()
  let onInput = EventDispatcher()
  let onResize = EventDispatcher()
  let onFile = EventDispatcher()
  let onError = EventDispatcher()
  let onModifiers = EventDispatcher()
  private let terminal = TerminalView(frame: .zero)
  private let controller = TerminalController()
  private var session: InMemoryTerminalSession!
  private let replayLock = NSLock()
  private let replayQueue = DispatchQueue(label: "com.bd.linkshell.terminal.replay", qos: .userInitiated)
  private var restoring = false
  private var applyingReplayGrid = false
  private var pendingResize: (UInt32, UInt32)?
  private var importedURLs: [URL] = []
  private var fontSize: Float = 9
  private var theme: [String: String] = [:]
  private var liveSize: (UInt32, UInt32)?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    Self.pruneStaleImports()
    if ProcessInfo.processInfo.environment["LINKSHELL_TERMINAL_DEBUG"] == "1" { TerminalDebugLog.enable([.metrics, .actions]) }
    session = InMemoryTerminalSession(write: { [weak self] data in
      guard let self else { return }
      self.replayLock.lock()
      let muted = self.restoring
      self.replayLock.unlock()
      if !muted { self.onInput(["data": String(decoding: data, as: UTF8.self)]) }
    }, resize: { [weak self] size in
      guard let self else { return }
      let nextSize = (UInt32(size.columns), UInt32(size.rows))
      self.replayLock.lock()
      let isSynthetic = self.applyingReplayGrid
      let muted = self.restoring
      if !isSynthetic && muted {
        // Record real viewport resizes requested during replay so endReplay applies them immediately.
        self.pendingResize = nextSize
      }
      self.replayLock.unlock()
      guard !isSynthetic, !muted else { return }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.replayLock.lock()
        let stillRestoring = self.restoring
        if stillRestoring { self.pendingResize = nextSize }
        self.replayLock.unlock()
        guard !stillRestoring else { return }
        self.liveSize = nextSize
        self.onResize(["cols": size.columns, "rows": size.rows])
      }
    }, suppressesPixelOnlyResizes: true)
    terminal.delegate = self
    terminal.usesSystemScrollback = true
    terminal.controller = controller
    terminal.configuration = TerminalSurfaceOptions(backend: .inMemory(session), fontSize: fontSize)
    terminal.inputAccessoryItems = []
    terminal.isAccessibilityElement = true
    terminal.accessibilityLabel = "终端"
    terminal.accessibilityTraits = [.allowsDirectInteraction]
    terminal.onImportProviders = { [weak self] providers in self?.importFiles(providers) }
    terminal.setStickyModifierChangeHandler { [weak self] in
      guard let self else { return }
      self.onModifiers(["ctrl": self.terminal.stickyActivation(for: .ctrl) != .inactive])
    }
    addSubview(terminal)
    applyTheme()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    terminal.frame = bounds.insetBy(dx: 8, dy: 0)
  }

  func write(_ data: String) { session.receive(data) }
  func reset() { session.receive("\u{1b}c") }
  func focus() { _ = terminal.acquireProgrammaticFocus() }
  func blur() { _ = terminal.resignFirstResponder() }
  func paste(_ text: String) { _ = terminal.paste(text: text) }
  func pasteClipboard() { terminal.paste(nil) }
  func toggleCtrl() { terminal.toggleStickyModifier(.ctrl) }

  func key(_ name: String, _ shift: Bool, _ ctrl: Bool, _ alt: Bool) {
    var mods: TerminalInputModifiers = []
    if shift { mods.insert(.shift) }
    if ctrl { mods.insert(.ctrl) }
    if alt { mods.insert(.alt) }
    let keys: [String: TerminalKey] = ["enter": .enter, "escape": .escape, "tab": .tab,
      "up": .arrowUp, "down": .arrowDown, "left": .arrowLeft, "right": .arrowRight,
      "backspace": .backspace, "home": .home, "end": .end, "pageUp": .pageUp, "pageDown": .pageDown]
    if let key = keys[name] { _ = terminal.sendKey(key, modifiers: mods) }
    else if name.count == 1, let character = name.first, let press = TerminalKeyPress(typing: character, modifiers: mods) {
      _ = terminal.sendKey(press)
    }
  }

  func setFontSize(_ size: Double) {
    fontSize = Float(min(32, max(6, size)))
    if terminal.surface == nil {
      terminal.configuration = TerminalSurfaceOptions(backend: .inMemory(session), fontSize: fontSize)
    } else { _ = terminal.performBindingAction("set_font_size:\(fontSize)") }
  }

  func setTheme(_ values: [String: String]) {
    guard theme != values else { return }
    theme = values
    applyTheme()
  }

  private func applyTheme() {
    let values = theme
    var config = TerminalConfiguration().fontSize(fontSize)
      .custom("smooth-scroll", "true")
      .custom("mouse-scroll-multiplier", "precision:1,discrete:3")
    if let value = values["background"] { config = config.background(value); backgroundColor = UIColor(hex: value) }
    if let value = values["foreground"] { config = config.foreground(value) }
    if let value = values["cursor"] { config = config.cursorColor(value) }
    if let value = values["selectionBackground"], value.hasPrefix("#") { config = config.selectionBackground(value) }
    let names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"]
    for (index, name) in names.enumerated() { if let value = values[name] { config = config.palette(index, color: value) } }
    _ = controller.setTheme(TerminalTheme(light: config, dark: config))
  }

  deinit {
    replayLock.lock()
    let urls = importedURLs
    importedURLs.removeAll()
    replayLock.unlock()
    if !urls.isEmpty {
      DispatchQueue.global(qos: .utility).async {
        let fm = FileManager.default
        for url in urls { try? fm.removeItem(at: url) }
      }
    }
  }

  func beginReplay(_ reset: Bool) {
    controller.suppressesExternalEffects = true
    replayLock.lock()
    restoring = true
    replayLock.unlock()
    if reset { session.receive("\u{1b}c\u{1b}[3J") }
  }

  func replay(_ data: String, _ cols: Int, _ rows: Int, promise: Promise) {
    let session = self.session!
    replayQueue.async { [weak self] in
      // Drain prior writes off the main thread so UI responsiveness and Ghostty's main-thread tick never stall.
      session.waitForPendingOutput()
      DispatchQueue.main.async {
        guard let self else { promise.resolve(nil); return }
        self.replayLock.lock(); self.applyingReplayGrid = true; self.replayLock.unlock()
        session.applyGridSize(columns: UInt32(cols), rows: UInt32(rows))
        self.replayLock.lock(); self.applyingReplayGrid = false; self.replayLock.unlock()
        session.receive(data)
        self.replayQueue.async {
          session.waitForPendingOutput()
          DispatchQueue.main.async { promise.resolve(nil) }
        }
      }
    }
  }

  func endReplay(promise: Promise) {
    let session = self.session!
    replayQueue.async { [weak self] in
      session.waitForPendingOutput()
      DispatchQueue.main.async {
        guard let self else { promise.resolve(nil); return }
        self.replayLock.lock()
        let target = self.pendingResize ?? self.liveSize
        self.applyingReplayGrid = true
        self.replayLock.unlock()
        if let (cols, rows) = target {
          session.applyGridSize(columns: cols, rows: rows)
        }
        self.replayLock.lock(); self.applyingReplayGrid = false; self.replayLock.unlock()
        self.replayQueue.async { [weak self] in
          session.waitForPendingOutput()
          DispatchQueue.main.async {
            guard let self else { promise.resolve(nil); return }
            self.controller.suppressesExternalEffects = false
            self.replayLock.lock()
            self.restoring = false
            let deferred = self.pendingResize
            self.pendingResize = nil
            self.replayLock.unlock()
            if let (cols, rows) = deferred {
              self.liveSize = (cols, rows)
              self.onResize(["cols": Int(cols), "rows": Int(rows)])
            }
            promise.resolve(nil)
          }
        }
      }
    }
  }

  private static func pruneStaleImports() {
    DispatchQueue.global(qos: .utility).async {
      let fm = FileManager.default
      let dir = fm.temporaryDirectory.appendingPathComponent("linkshell-imports", isDirectory: true)
      guard let entries = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]) else { return }
      let cutoff = Date().addingTimeInterval(-600)
      for entry in entries {
        let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        if modified < cutoff { try? fm.removeItem(at: entry) }
      }
    }
  }

  private func importFiles(_ providers: [NSItemProvider]) {
    for provider in providers {
      guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true })
        ?? provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) else { continue }
      provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] source, error in
        guard let self else { return }
        guard let source else {
          self.onError(["message": "无法读取粘贴或拖入的文件"])
          return
        }
        var createdTarget: URL?
        do {
          let dir = FileManager.default.temporaryDirectory.appendingPathComponent("linkshell-imports", isDirectory: true)
          try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
          let name = provider.suggestedName ?? source.lastPathComponent
          let target = dir.appendingPathComponent(UUID().uuidString + "-" + source.lastPathComponent)
          let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
          guard size <= 30 * 1024 * 1024 else { self.onError(["message": "文件超过 30 MB"]); return }
          try FileManager.default.copyItem(at: source, to: target)
          createdTarget = target
          self.replayLock.lock()
          self.importedURLs.append(target)
          self.replayLock.unlock()
          self.onFile(["uri": target.absoluteString, "name": name, "size": size])
        } catch {
          if let createdTarget { try? FileManager.default.removeItem(at: createdTarget) }
          self.onError(["message": "无法暂存文件，请重试"])
        }
      }
    }
  }
}

private extension UIColor {
  convenience init?(hex: String) {
    guard let value = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) else { return nil }
    self.init(red: CGFloat(value >> 16 & 255) / 255, green: CGFloat(value >> 8 & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
  }
}

extension LinkTerminalView: TerminalSurfaceFontSizeDelegate {
  func terminalDidChangeFontSize(_ size: Float) {
    let clamped = min(32, max(6, size))
    if clamped != size { setFontSize(Double(clamped)); return }
    fontSize = clamped
    onFontSize(["size": clamped])
  }
}
