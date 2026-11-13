import AppKit
import SwiftUI

/// One neutral system for LinkShell.app's own pages, matching the workspace page
/// (apps/web/src/theme.ts, styles/desktop.css) and docs/design/visual-system.md.
///
/// The window is a grey ground; panels sit on it one lightness step away with a hairline;
/// inside a panel a well holds rows and settings. No gradients, glows or resting shadows.
/// Colour says what can be done (indigo) and state (indigo running, amber waiting on the user,
/// red failed, green online or a success). The one filled control on a page is the indigo fill.
///
/// The hues are copies of apps/client/src/theme/brand-colors.json (Swift can't read it at build
/// time); apps/web/test/brand-colors.test.ts fails when they drift.
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

  /// The window ground (#f3f3f3 / #1d1d1d); the titlebar shares it so a resize never shows a seam.
  static let windowBackground = gray(0.953, 0.114)
  static let background = Color(nsColor: windowBackground)
  /// A panel: the sidebar, the page, a sheet (#ffffff / #181818).
  static let panel = Color(nsColor: gray(1.0, 0.094))
  static let sidebar = panel
  /// Content set into a panel: a group of rows, a chart, a log (#f3f3f3 / #141414).
  static let card = Color(nsColor: gray(0.953, 0.078))
  /// The resting fill of a quiet control.
  static let raised = Color(nsColor: gray(0.938, 0.145))
  /// The current page in a list, the chosen segment.
  static let selection = Color(nsColor: gray(0.895, 0.175))
  /// Panel and well edges, and row rules.
  static let line = Color(nsColor: gray(0.885, 0.165))
  /// The outline of something that can be clicked: one step stronger than a hairline.
  static let controlStroke = Color(nsColor: gray(0.80, 0.24))

  // AppKit views (the setup window) draw with the same values.
  static let panelColor = gray(1.0, 0.094)
  static let raisedColor = gray(0.938, 0.145)
  static let selectionColor = gray(0.895, 0.175)
  static let lineColor = gray(0.885, 0.165)
  static let controlStrokeColor = gray(0.80, 0.24)
  static let primaryText = gray(0.10, 0.875)
  static let secondaryText = gray(0.30, 0.71)
  static let tertiaryText = gray(0.38, 0.59)

  /// Text, icons and the chart's bars for what can be done or is running (`accent`, `running`).
  static let accentColor = hue(rgb(0x4c5fd5), rgb(0x8d9bff))
  /// The fill of the one primary control and of a switch that is on; white goes on it, which the
  /// paler dark `accent` would not carry.
  static let accentFillColor = hue(rgb(0x4c5fd5), rgb(0x5263e8))
  static let accentHoverColor = hue(rgb(0x4254c7), rgb(0x4d5fe0))
  static let onAccentColor = NSColor.white
  /// Connection health (online, the host service up) and a success (granted, paired); a session
  /// that runs is `running`, not this.
  static let okColor = hue(rgb(0x187a4a), rgb(0x4cc38a))
  static let waitingColor = hue(rgb(0xad5200), rgb(0xffad5c))
  static let dangerColor = hue(rgb(0xc8322f), rgb(0xff7b72))

  static let primary = Color(nsColor: gray(0.07, 0.95))
  /// About 8:1 on its panel in both appearances.
  static let secondary = Color(nsColor: gray(0.30, 0.71))
  /// Meta text and units; at least 4.5:1 on every surface.
  static let tertiary = Color(nsColor: gray(0.38, 0.59))

  static let accent = Color(nsColor: accentColor)
  static let running = accent
  static let accentFill = Color(nsColor: accentFillColor)
  static let accentHover = Color(nsColor: accentHoverColor)
  static let onAccent = Color(nsColor: onAccentColor)
  static let ok = Color(nsColor: okColor)
  static let waiting = Color(nsColor: waitingColor)
  static let danger = Color(nsColor: dangerColor)
  // The light grounds under a state's own words. Drawn over a panel, never the window ground:
  // there the amber and indigo words fall under 4.5:1.
  static let accentSoft = Color(nsColor: hue(rgb(0x4c5fd5, 0.10), rgb(0x8d9bff, 0.16)))
  static let waitingSoft = Color(nsColor: hue(rgb(0xad5200, 0.10), rgb(0xffad5c, 0.14)))
  static let dangerSoft = Color(nsColor: hue(rgb(0xc8322f, 0.09), rgb(0xff7b72, 0.14)))

  /// Dialogs, sheets and the panels on the window ground.
  static let panelRadius: CGFloat = 12
  /// Cards, wells, popovers, banners.
  static let wellRadius: CGFloat = 8
  /// Buttons, fields, menu items, list rows, segments.
  static let controlRadius: CGFloat = 6
  /// Key hints and badges.
  static let smallRadius: CGFloat = 4
  static let controlHeight: CGFloat = 32
  static let compactControlHeight: CGFloat = 28
  static let gutter: CGFloat = 10
  static let topBarHeight: CGFloat = 46
  static let statusBarHeight: CGFloat = 30
  static let sidebarWidth: CGFloat = 264

  static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .monospaced) }
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

/// Buttons: `.primary` is the indigo fill and appears once per page; `.secondary` has a hairline;
/// `.quiet` is text until hovered. Not capsules: the desktop's buttons are rounded rectangles.
struct DesktopButtonStyle: ButtonStyle {
  enum Kind { case primary, secondary, quiet }
  var kind: Kind = .secondary
  var compact = false
  init(_ kind: Kind = .secondary, compact: Bool = false) { self.kind = kind; self.compact = compact }
  func makeBody(configuration: Configuration) -> some View { DesktopButtonBody(configuration: configuration, kind: kind, compact: compact) }
}

private struct DesktopButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let kind: DesktopButtonStyle.Kind
  let compact: Bool
  @Environment(\.isEnabled) private var isEnabled
  @State private var hovered = false
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: DesktopStyle.controlRadius, style: .continuous)
    configuration.label
      .font(.system(size: compact ? 12 : 13, weight: .medium))
      .lineLimit(1)
      .padding(.horizontal, 12)
      .frame(height: compact ? DesktopStyle.compactControlHeight : DesktopStyle.controlHeight)
      .foregroundStyle(foreground)
      .background { shape.fill(fill) }
      .overlay { if kind == .secondary { shape.strokeBorder(DesktopStyle.controlStroke, lineWidth: 1) } }
      .contentShape(shape)
      .opacity(isEnabled ? 1 : 0.55)
      .onHover { hovered = $0 }
      .animation(.easeOut(duration: 0.12), value: hovered)
  }
  private var foreground: Color {
    switch kind {
    case .primary: DesktopStyle.onAccent
    case .secondary: DesktopStyle.primary
    case .quiet: hovered ? DesktopStyle.primary : DesktopStyle.secondary
    }
  }
  private var fill: Color {
    switch kind {
    // The spec has one darker step for the fill; pressing shows it as hovering does.
    case .primary: configuration.isPressed || hovered && isEnabled ? DesktopStyle.accentHover : DesktopStyle.accentFill
    case .secondary, .quiet: configuration.isPressed ? DesktopStyle.selection : hovered && isEnabled ? DesktopStyle.raised : .clear
    }
  }
}

/// An icon-only control.
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
      .background(RoundedRectangle(cornerRadius: DesktopStyle.controlRadius, style: .continuous).fill(configuration.isPressed ? DesktopStyle.selection : hovered ? DesktopStyle.raised : .clear))
      .contentShape(RoundedRectangle(cornerRadius: DesktopStyle.controlRadius, style: .continuous))
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

/// A dot and a word, on the state's own light ground when given one: the top bar's facts about
/// this Mac.
struct DesktopStatusPill: View {
  let text: String
  var tone: Color = DesktopStyle.tertiary
  var soft: Color?
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: DesktopStyle.controlRadius, style: .continuous)
    HStack(spacing: 8) {
      Circle().fill(tone).frame(width: 8, height: 8)
      Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(soft == nil ? DesktopStyle.secondary : tone).lineLimit(1)
    }
    .padding(.horizontal, 12).frame(height: DesktopStyle.compactControlHeight)
    .background {
      // The soft ground goes over a panel: on the bare window ground its words lose contrast.
      if let soft { shape.fill(DesktopStyle.panel).overlay(shape.fill(soft)) } else { shape.fill(DesktopStyle.raised) }
    }
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

/// The AppKit button: the setup window's buttons, drawn like `DesktopButtonStyle`.
final class DesktopButton: NSButton {
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
    return NSSize(width: ceil(text.width) + 24, height: DesktopStyle.controlHeight)
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
      let radius = DesktopStyle.controlRadius
      let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
      let pressed = isHighlighted
      switch kind {
      case .primary:
        (pressed || hovered ? DesktopStyle.accentHoverColor : DesktopStyle.accentFillColor).setFill()
        box.fill()
      case .secondary:
        if pressed { DesktopStyle.selectionColor.setFill(); box.fill() } else if hovered { DesktopStyle.raisedColor.setFill(); box.fill() }
        DesktopStyle.controlStrokeColor.setStroke()
        box.lineWidth = 1
        box.stroke()
      }
      let attributes: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: 13, weight: .medium), .foregroundColor: kind == .primary ? DesktopStyle.onAccentColor : DesktopStyle.primaryText]
      let size = (title as NSString).size(withAttributes: attributes)
      (title as NSString).draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attributes)
    }
  }
  override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: DesktopStyle.controlRadius, yRadius: DesktopStyle.controlRadius).fill() }
  override var focusRingMaskBounds: NSRect { bounds }
}

/// Segments in a recessed track; the chosen one is a grey step, never a hue (as the workspace's
/// segmented controls). The track's radius is the segments' plus its 2 pt inset, so the corners
/// stay concentric.
struct DesktopSegmented<Value: Hashable>: View {
  let options: [(Value, String)]
  @Binding var selection: Value
  @Environment(\.isEnabled) private var isEnabled
  var body: some View {
    HStack(spacing: 2) {
      ForEach(Array(options.enumerated()), id: \.offset) { _, option in
        let chosen = option.0 == selection
        Button { selection = option.0 } label: {
          Text(option.1).font(.system(size: 12, weight: .medium)).lineLimit(1)
            .foregroundStyle(chosen ? DesktopStyle.primary : DesktopStyle.secondary)
            .padding(.horizontal, 12).frame(height: DesktopStyle.compactControlHeight - 4)
            .background(RoundedRectangle(cornerRadius: DesktopStyle.controlRadius, style: .continuous).fill(chosen ? DesktopStyle.selection : .clear))
            .contentShape(RoundedRectangle(cornerRadius: DesktopStyle.controlRadius, style: .continuous))
        }.buttonStyle(.plain).accessibilityAddTraits(chosen ? [.isSelected] : [])
      }
    }
    .padding(2).background(RoundedRectangle(cornerRadius: DesktopStyle.wellRadius, style: .continuous).fill(DesktopStyle.raised)).fixedSize()
    .opacity(isEnabled ? 1 : 0.55)
  }
}

/// The switch used on every settings row: the indigo fill when on, with the white knob the
/// fill is made to carry.
struct DesktopSwitchStyle: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    Button { configuration.isOn.toggle() } label: {
      Capsule().fill(configuration.isOn ? DesktopStyle.accentFill : DesktopStyle.controlStroke)
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
      .background(DesktopStyle.card, in: RoundedRectangle(cornerRadius: DesktopStyle.controlRadius, style: .continuous))
      .overlay { RoundedRectangle(cornerRadius: DesktopStyle.controlRadius, style: .continuous).strokeBorder(DesktopStyle.controlStroke, lineWidth: 1) }
  }
}
