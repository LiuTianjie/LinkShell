import ExpoModulesCore
import UIKit

/// SwiftTerm's native terminal (UIKit rendering, full UITextInput so every
/// input method works in place) wired to a remote shell: output arrives
/// through `write`, keys leave through `onInput`.
final class LinkTerminalView: ExpoView, TerminalViewDelegate {
  let onInput = EventDispatcher()
  let onResize = EventDispatcher()

  private let terminal: TerminalView
  private var fontSize: CGFloat = 13
  private var theme: [String: String] = [:]
  private var lastSize = ""

  required init(appContext: AppContext? = nil) {
    terminal = TerminalView(frame: .zero, font: LinkTerminalView.terminalFont(size: 13))
    super.init(appContext: appContext)
    terminal.terminalDelegate = self
    // The app draws its own key row above the keyboard.
    terminal.inputAccessoryView = nil
    terminal.optionAsMetaKey = true
    terminal.allowMouseReporting = false
    TerminalView.symbolFallbackFont = { size in UIFont(name: "LinkShellSymbols", size: size) }
    addSubview(terminal)
    applyFont()
  }

  /// SF Mono for text; the bundled Nerd Font symbols for prompt icons
  /// (starship, powerlevel10k: branch, language, OS glyphs), which would
  /// otherwise draw as empty boxes. CoreText won't cascade from the system
  /// monospaced font, so SwiftTerm hands those characters the symbols font itself.
  static func terminalFont(size: CGFloat, weight: UIFont.Weight = .regular, italic: Bool = false) -> UIFont {
    let base = UIFont.monospacedSystemFont(ofSize: size, weight: weight)
    guard italic, let slanted = base.fontDescriptor.withSymbolicTraits(.traitItalic) else { return base }
    return UIFont(descriptor: slanted, size: size)
  }

  private func applyFont() {
    terminal.setFonts(
      normal: LinkTerminalView.terminalFont(size: fontSize),
      bold: LinkTerminalView.terminalFont(size: fontSize, weight: .bold),
      italic: LinkTerminalView.terminalFont(size: fontSize, italic: true),
      boldItalic: LinkTerminalView.terminalFont(size: fontSize, weight: .bold, italic: true)
    )
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // Same breathing room as the Android view; the container shares the theme's background.
    terminal.frame = bounds.insetBy(dx: 8, dy: 0)
  }

  // MARK: JS API

  func write(_ data: String) {
    terminal.feed(text: data)
  }

  func reset() {
    terminal.getTerminal().resetToInitialState()
    applyTheme()
  }

  func focus() {
    _ = terminal.becomeFirstResponder()
  }

  func blur() {
    _ = terminal.resignFirstResponder()
  }

  func setFontSize(_ size: Double) {
    fontSize = CGFloat(size)
    applyFont()
  }

  func setTheme(_ value: [String: String]) {
    theme = value
    applyTheme()
  }

  private static let ansiNames = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  ]

  private func applyTheme() {
    if let background = UIColor(css: theme["background"]) {
      backgroundColor = background
      terminal.nativeBackgroundColor = background
      terminal.backgroundColor = background
    }
    if let foreground = UIColor(css: theme["foreground"]) {
      terminal.nativeForegroundColor = foreground
    }
    if let cursor = UIColor(css: theme["cursor"]) {
      terminal.caretColor = cursor
    }
    let ansi = Self.ansiNames.compactMap { UIColor(css: theme[$0])?.terminalColor }
    if ansi.count == 16 { terminal.installColors(ansi) }
    if let selection = UIColor(css: theme["selectionBackground"]) {
      terminal.selectedTextBackgroundColor = selection
    }
  }

  // MARK: TerminalViewDelegate

  func send(source: TerminalView, data: ArraySlice<UInt8>) {
    onInput(["data": String(decoding: data, as: UTF8.self)])
  }

  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    let size = "\(newCols)x\(newRows)"
    guard size != lastSize, newCols > 0, newRows > 0 else { return }
    lastSize = size
    onResize(["cols": newCols, "rows": newRows])
  }

  func setTerminalTitle(source: TerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func scrolled(source: TerminalView, position: Double) {}
  func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
    if let url = URL(string: link) { UIApplication.shared.open(url) }
  }
  func bell(source: TerminalView) {}
  func clipboardCopy(source: TerminalView, content: Data) {
    if let text = String(data: content, encoding: .utf8) { UIPasteboard.general.string = text }
  }
  func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

private extension UIColor {
  /// "#rrggbb" or "rgba(r,g,b,a)".
  convenience init?(css: String?) {
    guard let css = css?.trimmingCharacters(in: .whitespaces) else { return nil }
    if css.hasPrefix("#"), css.count == 7, let value = Int(css.dropFirst(), radix: 16) {
      self.init(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
      return
    }
    if css.hasPrefix("rgb") {
      let parts = css.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
      guard parts.count >= 3 else { return nil }
      self.init(red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: parts.count > 3 ? parts[3] : 1)
      return
    }
    return nil
  }

  var terminalColor: Color {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    getRed(&r, green: &g, blue: &b, alpha: &a)
    return Color(red: UInt16(r * 65535), green: UInt16(g * 65535), blue: UInt16(b * 65535))
  }
}
