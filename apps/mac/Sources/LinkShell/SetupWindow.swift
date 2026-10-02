import AppKit

/// The setup window's face (`--setup`; what it does is `Setup`): the app's icon, a title and a
/// sentence, a row for each permission, and a button to leave it for later. Its colours, fonts
/// and symbols are the system's, so it follows light and dark, the accent colour and the
/// look of whichever macOS it runs on.
final class SetupWindow {
  static let width: CGFloat = 600

  /// The button of a permission's row was pressed.
  var onOpen: (Permission) -> Void = { _ in }

  let window: NSWindow
  private let text: SetupText
  private let icon = AppIcon()
  private let done = NSImageView()
  private let title = Label(size: 20, weight: .semibold)
  private let sentence = Label(size: 13, wraps: true)
  private var rows: [Permission: SetupRow] = [:]
  private let leave: NSButton

  init(text: SetupText) {
    self.text = text
    // No title bar of its own: the content runs to the top, under the close button.
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: SetupWindow.width, height: 400), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: true)
    window.title = "LinkShell"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    // Comes to the Space the user is looking at whenever it comes forward (System Settings may
    // open in another one and take the user there), and shows over an app that fills the screen.
    // Not `.canJoinAllSpaces`: with it the app is never made active, and the window never key
    // (macOS 26).
    window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true

    leave = NSButton(title: text.later, target: window, action: #selector(NSWindow.performClose(_:)))
    leave.controlSize = .large

    done.image = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil)
    done.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 50, weight: .regular)
    done.contentTintColor = .systemGreen
    title.alignment = .center
    sentence.alignment = .center
    sentence.textColor = .secondaryLabelColor

    let card = Card()
    let list = NSStackView()
    list.orientation = .vertical
    list.alignment = .leading
    list.spacing = 0
    for permission in Permission.allCases {
      let row = SetupRow(permission: permission, text: text) { [weak self] in self?.onOpen(permission) }
      rows[permission] = row
      if !list.arrangedSubviews.isEmpty {
        let line = NSBox()
        line.boxType = .separator
        list.addArrangedSubview(line)
        // From where the rows' words begin, as a list's lines are.
        line.leadingAnchor.constraint(equalTo: list.leadingAnchor, constant: SetupRow.wordsFrom).isActive = true
        line.trailingAnchor.constraint(equalTo: list.trailingAnchor).isActive = true
      }
      list.addArrangedSubview(row)
      row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
    }
    card.fill(with: list)

    let footer = NSStackView(views: [NSView(), leave])
    let column = NSStackView(views: [icon, done, title, sentence, card, footer])
    column.orientation = .vertical
    column.alignment = .centerX
    column.spacing = 0
    column.edgeInsets = NSEdgeInsets(top: 40, left: 28, bottom: 20, right: 28)
    column.setCustomSpacing(14, after: icon)
    column.setCustomSpacing(14, after: done)
    column.setCustomSpacing(6, after: title)
    column.setCustomSpacing(22, after: sentence)
    column.setCustomSpacing(18, after: card)
    column.translatesAutoresizingMaskIntoConstraints = false
    let inside = SetupWindow.width - column.edgeInsets.left - column.edgeInsets.right

    let content = NSView()
    content.addSubview(column)
    NSLayoutConstraint.activate([
      content.widthAnchor.constraint(equalToConstant: SetupWindow.width),
      column.topAnchor.constraint(equalTo: content.topAnchor),
      column.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      column.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      column.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      icon.widthAnchor.constraint(equalToConstant: 64),
      icon.heightAnchor.constraint(equalToConstant: 64),
      done.widthAnchor.constraint(equalToConstant: 64),
      done.heightAnchor.constraint(equalToConstant: 64),
      title.widthAnchor.constraint(lessThanOrEqualToConstant: inside),
      sentence.widthAnchor.constraint(lessThanOrEqualToConstant: inside),
      card.widthAnchor.constraint(equalToConstant: inside),
      footer.widthAnchor.constraint(equalToConstant: inside),
    ])
    window.contentView = content
  }

  /// The rows as they now are. `pressed`: the permissions whose button has been pressed, which
  /// then say what to do in System Settings.
  func show(_ granted: Granted, pressed: Set<Permission>) {
    let finished = granted.all
    icon.isHidden = finished
    done.isHidden = !finished
    title.stringValue = finished ? text.doneTitle : text.title
    sentence.stringValue = finished ? text.doneSentence : text.sentence
    for (permission, row) in rows {
      row.show(granted: granted[permission], first: granted.next == permission, pressed: pressed.contains(permission))
    }
    leave.title = finished ? text.done : text.later
    // Return for the button to press next, Escape to leave it for later.
    leave.keyEquivalent = finished ? "\r" : "\u{1b}"
    fit()
  }

  /// As tall as what it now says, its top where it was.
  private func fit() {
    guard let content = window.contentView else { return }
    // Words that wrap know their height once they have their width.
    content.layoutSubtreeIfNeeded()
    let size = content.fittingSize
    guard size.height != window.frame.height else { return }
    let frame = NSRect(x: window.frame.minX, y: window.frame.maxY - size.height, width: size.width, height: size.height)
    window.setFrame(frame, display: true, animate: window.isVisible)
  }

  /// In front of everything, and the one that is typed into. The app has no place in the Dock,
  /// so nothing else brings its window forward.
  func comeForward() {
    window.orderFrontRegardless()
    window.makeKey()
    // The request that waits for the app in front to give way (`activate()`, macOS 14) is not
    // granted to an app like this one: seen on macOS 26.
    NSApp.activate(ignoringOtherApps: true)
  }

  /// Out of the way of `other` (System Settings' window), on that window's screen.
  func move(beside other: CGRect?) {
    let screen = other.flatMap { frame in NSScreen.screens.first { $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) } } ?? window.screen ?? NSScreen.main
    guard let screen else { return }
    let origin = Beside.origin(size: window.frame.size, other: other, visible: screen.visibleFrame)
    window.setFrame(NSRect(origin: origin, size: window.frame.size), display: true, animate: true)
    // Where the two have to overlap, this one is on top: System Settings has just come forward.
    window.orderFrontRegardless()
  }

  /// The content as it is drawn, twice the size (as a Retina display has it), as a PNG: the
  /// window can be looked at without being put on the screen.
  func picture(appearance: NSAppearance?) -> Data? {
    guard let content = window.contentView else { return nil }
    window.appearance = appearance
    content.layoutSubtreeIfNeeded()
    let size = content.bounds.size
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width) * 2, pixelsHigh: Int(size.height) * 2, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap)
    else { return nil }
    context.cgContext.scaleBy(x: 2, y: 2)
    // The window's own background is not the content view's to draw.
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    window.effectiveAppearance.performAsCurrentDrawingAppearance {
      NSColor.windowBackgroundColor.setFill()
      NSRect(origin: .zero, size: size).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    content.displayIgnoringOpacity(content.bounds, in: context)
    return bitmap.representation(using: .png, properties: [:])
  }
}

/// One permission in the setup window: its symbol, its name and state, what it is for, the
/// button that leads to its switch and, once that has been pressed, what to do there.
final class SetupRow: NSView {
  /// From the row's leading edge to its words: the inset, the symbol's tile, the space after it.
  static let wordsFrom: CGFloat = 16 + 36 + 12

  private let text: SetupText
  private let press: () -> Void
  private let tile: Tile
  private let name = Label(size: 13, weight: .semibold)
  private let mark = NSImageView()
  private let state = Label(size: 12)
  private let purpose = Label(size: 12, wraps: true)
  private let hint = Label(size: 12, weight: .medium, wraps: true)
  private let note = Label(size: 11, wraps: true)
  private let button: NSButton
  /// The space between what the permission is for and what to do about it.
  private var below = NSLayoutConstraint()

  init(permission: Permission, text: SetupText, press: @escaping () -> Void) {
    self.text = text
    self.press = press
    tile = Tile(symbol: permission == .recording ? "rectangle.dashed.badge.record" : "accessibility")
    button = NSButton(title: text.open, target: nil, action: nil)
    super.init(frame: .zero)
    button.controlSize = .large
    button.target = self
    button.action = #selector(pressed)
    name.stringValue = text.name(permission)
    purpose.stringValue = text.purpose(permission)
    hint.stringValue = text.hint
    hint.textColor = .labelColor
    // Only Screen Recording has the system say the app must quit and reopen.
    note.stringValue = permission == .recording ? text.reopen : ""
    note.textColor = .secondaryLabelColor
    mark.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)

    let heading = NSStackView(views: [name, mark, state])
    heading.spacing = 4
    heading.setCustomSpacing(8, after: name)
    let words = NSStackView(views: [heading, purpose])
    // What to do in System Settings goes under the button too: the row's whole width.
    let guide = NSStackView(views: [hint, note])
    for stack in [words, guide] {
      stack.orientation = .vertical
      stack.alignment = .leading
      stack.spacing = 3
    }
    for view in [tile, words, guide, button] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    below = guide.topAnchor.constraint(equalTo: words.bottomAnchor)
    // The name is never cut short; what it is for wraps to make room for the button.
    name.setContentCompressionResistancePriority(.required, for: .horizontal)
    button.setContentCompressionResistancePriority(.required, for: .horizontal)
    button.setContentHuggingPriority(.required, for: .horizontal)
    NSLayoutConstraint.activate([
      tile.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      tile.topAnchor.constraint(equalTo: topAnchor, constant: 14),
      tile.widthAnchor.constraint(equalToConstant: 36),
      tile.heightAnchor.constraint(equalToConstant: 36),
      words.leadingAnchor.constraint(equalTo: leadingAnchor, constant: SetupRow.wordsFrom),
      words.topAnchor.constraint(equalTo: topAnchor, constant: 14),
      words.trailingAnchor.constraint(lessThanOrEqualTo: button.leadingAnchor, constant: -12),
      below,
      guide.leadingAnchor.constraint(equalTo: words.leadingAnchor),
      guide.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
      guide.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
      bottomAnchor.constraint(greaterThanOrEqualTo: tile.bottomAnchor, constant: 14),
      button.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      button.centerYAnchor.constraint(equalTo: tile.centerYAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("made in code")
  }

  @objc private func pressed() {
    press()
  }

  /// `first`: the first permission still missing — the thing to do now. A missing one that is
  /// not first is drawn fainter; its button works all the same.
  func show(granted: Bool, first: Bool, pressed: Bool) {
    let faint = !granted && !first
    tile.faint = faint
    name.textColor = faint ? .secondaryLabelColor : .labelColor
    purpose.textColor = faint ? .tertiaryLabelColor : .secondaryLabelColor
    mark.image = NSImage(systemSymbolName: granted ? "checkmark.circle.fill" : "circle", accessibilityDescription: nil)
    mark.contentTintColor = granted ? .systemGreen : .tertiaryLabelColor
    state.stringValue = granted ? text.on : text.off
    state.textColor = faint ? .tertiaryLabelColor : .secondaryLabelColor
    button.isHidden = granted
    button.keyEquivalent = first ? "\r" : ""
    hint.isHidden = granted || !pressed
    note.isHidden = hint.isHidden || note.stringValue.isEmpty
    below.constant = hint.isHidden ? 0 : 10
  }
}

/// A line or a paragraph of the window's words.
private final class Label: NSTextField {
  convenience init(size: CGFloat, weight: NSFont.Weight = .regular, wraps: Bool = false) {
    self.init(frame: .zero)
    isEditable = false
    isSelectable = false
    isBordered = false
    drawsBackground = false
    font = .systemFont(ofSize: size, weight: weight)
    if wraps {
      lineBreakMode = .byWordWrapping
      maximumNumberOfLines = 0
      cell?.wraps = true
      // Gives way to the button beside it, and takes as many lines as it then needs.
      setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    } else {
      lineBreakMode = .byClipping
    }
  }
}

/// The rounded square behind a row's symbol, in the user's accent colour.
private final class Tile: NSView {
  private let symbol = NSImageView()

  var faint = false {
    didSet {
      symbol.contentTintColor = faint ? .tertiaryLabelColor : .controlAccentColor
      needsDisplay = true
    }
  }

  init(symbol name: String) {
    super.init(frame: .zero)
    symbol.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)
    symbol.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 17, weight: .medium)
    symbol.translatesAutoresizingMaskIntoConstraints = false
    addSubview(symbol)
    NSLayoutConstraint.activate([
      symbol.centerXAnchor.constraint(equalTo: centerXAnchor),
      symbol.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("made in code")
  }

  override func draw(_ dirtyRect: NSRect) {
    (faint ? NSColor.tertiaryLabelColor : NSColor.controlAccentColor).withAlphaComponent(faint ? 0.1 : 0.14).setFill()
    NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9).fill()
  }
}

/// The rounded box the rows are in: a little lighter than the window, with a hairline around it.
private final class Card: NSView {
  private static let radius: CGFloat = 12

  func fill(with view: NSView) {
    view.translatesAutoresizingMaskIntoConstraints = false
    addSubview(view)
    NSLayoutConstraint.activate([
      view.topAnchor.constraint(equalTo: topAnchor),
      view.bottomAnchor.constraint(equalTo: bottomAnchor),
      view.leadingAnchor.constraint(equalTo: leadingAnchor),
      view.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])
  }

  override func draw(_ dirtyRect: NSRect) {
    let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: Card.radius, yRadius: Card.radius)
    NSColor(white: 1, alpha: dark ? 0.05 : 0.6).setFill()
    box.fill()
    NSColor.separatorColor.setStroke()
    box.stroke()
  }
}

/// The app's icon. It is the phone app's: a full square, which a Mac shows with its corners
/// rounded.
private final class AppIcon: NSView {
  override func draw(_ dirtyRect: NSRect) {
    NSBezierPath(roundedRect: bounds, xRadius: bounds.width * 0.225, yRadius: bounds.height * 0.225).addClip()
    NSApp.applicationIconImage.draw(in: bounds)
  }
}
