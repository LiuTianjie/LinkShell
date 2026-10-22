import AppKit
import SwiftUI

/// One neutral system for LinkShell.app's own pages, matching the workspace page
/// (apps/web/src/theme.ts, styles/desktop.css) and StupidMirror.
///
/// The window is a grey ground; panels sit on it one lightness step away with a hairline;
/// inside a panel a well holds rows and settings. No gradients, glows or resting shadows.
/// Colour is state: mint while something runs, amber when it waits on the user, red when it
/// failed. The one filled control on a page is inverted ink (white on dark, black on light).
enum DesktopStyle {
  private static func gray(_ light: CGFloat, _ dark: CGFloat) -> NSColor {
    NSColor(name: nil) { appearance in
      let value = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
      return NSColor(srgbRed: value, green: value, blue: value, alpha: 1)
    }
  }
  private static func hue(_ light: NSColor, _ dark: NSColor) -> NSColor {
    NSColor(name: nil) { appearance in appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light }
  }
  private static func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
  }

  /// The window ground (#ececec / #1b1b1b); the titlebar shares it so a resize never shows a seam.
  static let windowBackground = gray(0.925, 0.105)
  static let background = Color(nsColor: windowBackground)
  /// A panel: the sidebar, the page, a sheet (#fff / #111).
  static let panel = Color(nsColor: gray(1.0, 0.067))
  static let sidebar = panel
  /// Content set into a panel: a group of rows, a chart, a log (#f5f5f5 / #0b0b0b).
  static let card = Color(nsColor: gray(0.962, 0.043))
  /// The resting fill of a quiet control.
  static let raised = Color(nsColor: gray(0.938, 0.135))
  /// The current page in a list, the chosen segment.
  static let selection = Color(nsColor: gray(0.895, 0.17))
  /// Panel and well edges, and row rules.
  static let line = Color(nsColor: gray(0.885, 0.15))
  /// The outline of something that can be clicked: one step stronger than a hairline.
  static let controlStroke = Color(nsColor: gray(0.80, 0.24))

  // AppKit views (the setup window) draw with the same values.
  static let panelColor = gray(1.0, 0.067)
  static let raisedColor = gray(0.938, 0.135)
  static let selectionColor = gray(0.895, 0.17)
  static let lineColor = gray(0.885, 0.15)
  static let controlStrokeColor = gray(0.80, 0.24)
  static let primaryText = gray(0.07, 0.95)
  static let secondaryText = gray(0.30, 0.71)
  static let tertiaryText = gray(0.38, 0.59)
  static let inkColor = gray(0.10, 0.95)
  static let inkPressedColor = gray(0.26, 0.80)
  static let onInkColor = gray(1.0, 0.06)
  static let mintColor = hue(rgb(0x077a66), rgb(0x3ddbb9))

  static let primary = Color(nsColor: gray(0.07, 0.95))
  /// About 8:1 on its panel in both appearances.
  static let secondary = Color(nsColor: gray(0.30, 0.71))
  /// Meta text and units; at least 4.5:1 on every surface.
  static let tertiary = Color(nsColor: gray(0.38, 0.59))
  /// The inverted fill of the one primary control, and the ink on it.
  static let ink = Color(nsColor: gray(0.10, 0.95))
  static let inkPressed = Color(nsColor: gray(0.26, 0.80))
  static let onInk = Color(nsColor: gray(1.0, 0.06))

  /// The one data hue (LinkShell's mint): running work, online, the chart's bars.
  static let mint = Color(nsColor: hue(rgb(0x077a66), rgb(0x3ddbb9)))
  static let accent = mint
  static let waiting = Color(nsColor: hue(rgb(0x965c05), rgb(0xf2a33d)))
  static let danger = Color(nsColor: hue(rgb(0xb3292b), rgb(0xe6576f)))
  /// Kept for call sites that predate the ink primary.
  static let onAccent = onInk

  static let panelRadius: CGFloat = 16
  static let wellRadius: CGFloat = 12
  static let gutter: CGFloat = 10
  static let topBarHeight: CGFloat = 46
  static let statusBarHeight: CGFloat = 30
  static let sidebarWidth: CGFloat = 264

  static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .monospaced) }
  /// A state hue on a tint of itself.
  static func tint(_ color: Color) -> Color { color.opacity(0.15) }
}

extension View {
  /// A top-level panel on the window ground.
  func panelSurface(radius: CGFloat = DesktopStyle.panelRadius) -> some View {
    background(DesktopStyle.panel, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(DesktopStyle.line, lineWidth: 1) }
  }
  /// Content set into a panel.
  func desktopCard(radius: CGFloat = DesktopStyle.wellRadius, padding: CGFloat = 16) -> some View {
    self.padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(DesktopStyle.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(DesktopStyle.line, lineWidth: 1) }
  }
  /// Rows (each drawing its own rule under it) in one well; the last rule is clipped so the
  /// well's edge is the only line at the bottom.
  func rowsCard() -> some View {
    VStack(alignment: .leading, spacing: 0) { self }
      .padding(.horizontal, 14).padding(.bottom, -1).clipped()
      .desktopCard(padding: 0)
  }
}

/// Pills: `.primary` is inverted ink and appears once per page; `.secondary` is a hairline pill;
/// `.quiet` is text until hovered.
struct DesktopPillStyle: ButtonStyle {
  enum Kind { case primary, secondary, quiet }
  var kind: Kind = .secondary
  var compact = false
  init(_ kind: Kind = .secondary, compact: Bool = false) { self.kind = kind; self.compact = compact }
  func makeBody(configuration: Configuration) -> some View { DesktopPillBody(configuration: configuration, kind: kind, compact: compact) }
}

private struct DesktopPillBody: View {
  let configuration: ButtonStyleConfiguration
  let kind: DesktopPillStyle.Kind
  let compact: Bool
  @Environment(\.isEnabled) private var isEnabled
  @State private var hovered = false
  var body: some View {
    configuration.label
      .font(.system(size: compact ? 12 : 13, weight: .medium))
      .lineLimit(1)
      .padding(.horizontal, compact ? 11 : 14)
      .frame(height: compact ? 26 : 30)
      .foregroundStyle(foreground)
      .background { Capsule().fill(fill) }
      .overlay { if kind == .secondary { Capsule().strokeBorder(DesktopStyle.controlStroke, lineWidth: 1) } }
      .contentShape(Capsule())
      .opacity(isEnabled ? 1 : 0.55)
      .onHover { hovered = $0 }
      .animation(.easeOut(duration: 0.12), value: hovered)
  }
  private var foreground: Color {
    switch kind {
    case .primary: DesktopStyle.onInk
    case .secondary: DesktopStyle.primary
    case .quiet: hovered ? DesktopStyle.primary : DesktopStyle.secondary
    }
  }
  private var fill: Color {
    switch kind {
    case .primary: configuration.isPressed ? DesktopStyle.inkPressed : DesktopStyle.ink
    case .secondary, .quiet: configuration.isPressed ? DesktopStyle.selection : hovered && isEnabled ? DesktopStyle.raised : .clear
    }
  }
}

/// A round icon-only control.
struct DesktopIconButtonStyle: ButtonStyle {
  var size: CGFloat = 28
  func makeBody(configuration: Configuration) -> some View { DesktopIconBody(configuration: configuration, size: size) }
}

private struct DesktopIconBody: View {
  let configuration: ButtonStyleConfiguration
  let size: CGFloat
  @State private var hovered = false
  var body: some View {
    configuration.label
      .font(.system(size: 13, weight: .medium))
      .labelStyle(.iconOnly)
      .foregroundStyle(hovered ? DesktopStyle.primary : DesktopStyle.secondary)
      .frame(width: size, height: size)
      .background(Circle().fill(configuration.isPressed ? DesktopStyle.selection : hovered ? DesktopStyle.raised : .clear))
      .contentShape(Circle())
      .onHover { hovered = $0 }
  }
}

/// A group label above a well: 12 pt, sentence case, grey.
struct DesktopGroupLabel: View {
  let title: String
  var trailing: String?
  var body: some View {
    HStack {
      Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(DesktopStyle.secondary)
      Spacer()
      if let trailing { Text(trailing).font(.system(size: 12)).foregroundStyle(DesktopStyle.tertiary) }
    }.padding(.horizontal, 4).padding(.bottom, 6)
  }
}

/// A dot and a word on a tint of the state's hue: the top bar's facts about this Mac.
struct DesktopStatusPill: View {
  let text: String
  var tone: Color = DesktopStyle.tertiary
  var tinted = false
  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(tone).frame(width: 6, height: 6)
      Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(tinted ? tone : DesktopStyle.secondary).lineLimit(1)
    }
    .padding(.horizontal, 10).frame(height: 26)
    .background(Capsule().fill(tinted ? DesktopStyle.tint(tone) : DesktopStyle.raised))
    .fixedSize()
  }
}

/// Lets the window be dragged by an area SwiftUI would otherwise treat as content.
struct WindowDragArea: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView { DragAreaView() }
  func updateNSView(_ nsView: NSView, context: Context) {}
  private final class DragAreaView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
      if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
    }
  }
}

/// The AppKit pill: the setup window's buttons, drawn like `DesktopPillStyle`.
final class DesktopPillButton: NSButton {
  enum Kind { case primary, secondary }
  var kind: Kind = .secondary { didSet { needsDisplay = true } }
  private var hovered = false { didSet { needsDisplay = true } }

  convenience init(title: String, kind: Kind, target: AnyObject?, action: Selector?) {
    self.init(frame: .zero)
    self.title = title
    self.kind = kind
    self.target = target
    self.action = action
    isBordered = false
    setButtonType(.momentaryChange)
    font = .systemFont(ofSize: 13, weight: .medium)
    focusRingType = .exterior
  }

  override var intrinsicContentSize: NSSize {
    let text = (title as NSString).size(withAttributes: [.font: font ?? .systemFont(ofSize: 13)])
    return NSSize(width: ceil(text.width) + 32, height: 30)
  }
  override var title: String { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { hovered = true }
  override func mouseExited(with event: NSEvent) { hovered = false }

  override func draw(_ dirtyRect: NSRect) {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      let pill = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: (bounds.height - 1) / 2, yRadius: (bounds.height - 1) / 2)
      let pressed = isHighlighted
      switch kind {
      case .primary:
        (pressed ? DesktopStyle.inkPressedColor : DesktopStyle.inkColor).setFill()
        pill.fill()
      case .secondary:
        if pressed { DesktopStyle.selectionColor.setFill(); pill.fill() } else if hovered { DesktopStyle.raisedColor.setFill(); pill.fill() }
        DesktopStyle.controlStrokeColor.setStroke()
        pill.lineWidth = 1
        pill.stroke()
      }
      let attributes: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: 13, weight: .medium), .foregroundColor: kind == .primary ? DesktopStyle.onInkColor : DesktopStyle.primaryText]
      let size = (title as NSString).size(withAttributes: attributes)
      (title as NSString).draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attributes)
    }
  }
  override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill() }
  override var focusRingMaskBounds: NSRect { bounds }
}

/// Pills in a recessed track; the chosen one is a grey step, never a hue.
struct DesktopSegmented<Value: Hashable>: View {
  let options: [(Value, String)]
  @Binding var selection: Value
  @Environment(\.isEnabled) private var isEnabled
  var body: some View {
    HStack(spacing: 2) {
      ForEach(Array(options.enumerated()), id: \.offset) { _, option in
        let chosen = option.0 == selection
        Button { selection = option.0 } label: {
          Text(option.1).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
            .foregroundStyle(chosen ? DesktopStyle.primary : DesktopStyle.secondary)
            .padding(.horizontal, 12).frame(height: 26)
            .background(Capsule().fill(chosen ? DesktopStyle.selection : .clear))
            .contentShape(Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(chosen ? [.isSelected] : [])
      }
    }
    .padding(2).background(Capsule().fill(DesktopStyle.raised)).fixedSize()
    .opacity(isEnabled ? 1 : 0.55)
  }
}

/// The switch used on every settings row: mint when on, like a running state.
struct DesktopSwitchStyle: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    Button { configuration.isOn.toggle() } label: {
      Capsule().fill(configuration.isOn ? DesktopStyle.mint : DesktopStyle.controlStroke)
        .frame(width: 34, height: 20)
        .overlay(alignment: configuration.isOn ? .trailing : .leading) {
          Circle().fill(Color.white).frame(width: 16, height: 16).padding(2)
            .shadow(color: .black.opacity(0.18), radius: 1, y: 0.5)
        }
        .animation(.easeOut(duration: 0.15), value: configuration.isOn)
    }
    .buttonStyle(.plain)
    .accessibilityValue(configuration.isOn ? "开" : "关").accessibilityAddTraits(.isButton)
  }
}

extension View {
  /// A text field set into a well, matching the workspace's inputs.
  func desktopField() -> some View {
    textFieldStyle(.plain).font(.system(size: 13)).padding(.horizontal, 12).frame(height: 32)
      .background(DesktopStyle.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(DesktopStyle.controlStroke, lineWidth: 1) }
  }
}
