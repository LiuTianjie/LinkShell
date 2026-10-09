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
  private var restoring = false
  private var fontSize: Float = 9
  private var theme: [String: String] = [:]
  private var liveSize: (UInt32, UInt32)?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    if ProcessInfo.processInfo.environment["LINKSHELL_TERMINAL_DEBUG"] == "1" { TerminalDebugLog.enable([.metrics, .actions]) }
    session = InMemoryTerminalSession(write: { [weak self] data in
      guard let self else { return }
      self.replayLock.lock()
      let muted = self.restoring
      self.replayLock.unlock()
      if !muted { self.onInput(["data": String(decoding: data, as: UTF8.self)]) }
    }, resize: { [weak self] size in
      guard let self else { return }
      self.replayLock.lock(); let muted = self.restoring; self.replayLock.unlock()
      guard !muted else { return }
      DispatchQueue.main.async { [weak self] in
        guard let self, !self.restoring else { return }
        self.liveSize = (UInt32(size.columns), UInt32(size.rows))
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

  func beginReplay(_ reset: Bool) {
    controller.suppressesExternalEffects = true
    replayLock.lock(); restoring = true; replayLock.unlock()
    if reset { session.receive("\u{1b}c\u{1b}[3J") }
  }
  func replay(_ data: String, _ cols: Int, _ rows: Int) {
    session.resizeGrid(columns: UInt32(cols), rows: UInt32(rows))
    session.receive(data)
    session.waitForPendingOutput()
  }
  func endReplay() {
    session.waitForPendingOutput()
    if let (cols, rows) = liveSize { session.resizeGrid(columns: cols, rows: rows) }
    session.waitForPendingOutput()
    controller.suppressesExternalEffects = false
    replayLock.lock(); restoring = false; replayLock.unlock()
  }

  private func importFiles(_ providers: [NSItemProvider]) {
    for provider in providers {
      guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true })
        ?? provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) else { continue }
      provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] source, error in
        guard let source else {
          self?.onError(["message": "无法读取粘贴或拖入的文件"])
          return
        }
        do {
          let dir = FileManager.default.temporaryDirectory.appendingPathComponent("linkshell-imports", isDirectory: true)
          try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
          let name = provider.suggestedName ?? source.lastPathComponent
          let target = dir.appendingPathComponent(UUID().uuidString + "-" + source.lastPathComponent)
          let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
          guard size <= 30 * 1024 * 1024 else { self?.onError(["message": "文件超过 30 MB"]); return }
          try FileManager.default.copyItem(at: source, to: target)
          self?.onFile(["uri": target.absoluteString, "name": name, "size": size])
        } catch { self?.onError(["message": "无法暂存文件，请重试"] ) }
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
