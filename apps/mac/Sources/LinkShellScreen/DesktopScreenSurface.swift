import AppKit
import CoreVideo
import ImageIO
import Metal
import QuartzCore

public enum DesktopScreenGeometry {
  public static func fittedRect(picture: CGSize, in bounds: CGRect) -> CGRect {
    guard picture.width.isFinite, picture.height.isFinite, bounds.origin.x.isFinite, bounds.origin.y.isFinite, bounds.width.isFinite, bounds.height.isFinite,
          picture.width > 0, picture.height > 0, bounds.width > 0, bounds.height > 0 else { return .zero }
    let scale = min(bounds.width / picture.width, bounds.height / picture.height)
    let size = CGSize(width: picture.width * scale, height: picture.height * scale)
    return CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
  }

  public static let fullScreenTopSnapLimit: CGFloat = 96

  public static func normalizedPoint(_ point: CGPoint, picture: CGSize, bounds: CGRect, clamp: Bool = false) -> CGPoint? {
    let rect = fittedRect(picture: picture, in: bounds)
    guard rect.width > 0, rect.height > 0, point.x.isFinite, point.y.isFinite else { return nil }
    let x = (point.x - rect.minX) / rect.width, y = (point.y - rect.minY) / rect.height
    guard clamp || (0...1).contains(x) && (0...1).contains(y) else { return nil }
    return CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y)))
  }

  /// Maps a stage point to remote display coordinates. In full screen (`topEdgeSnap`), when aspect
  /// letterboxing leaves a narrow black band above the picture (`<= 96pt`), slamming the pointer to
  /// the physical top bezel snaps `y` to `0` so Fitts's-law clicks reach the remote Mac's menu bar.
  public static func stagePoint(_ point: CGPoint, picture: CGSize, bounds: CGRect, clamp: Bool = false, topEdgeSnap: Bool = false) -> CGPoint? {
    if let exact = normalizedPoint(point, picture: picture, bounds: bounds, clamp: clamp) {
      return exact
    }
    guard topEdgeSnap else { return nil }
    let rect = fittedRect(picture: picture, in: bounds)
    let topBand = rect.minY - bounds.minY
    guard rect.width > 0, rect.height > 0, topBand > 0, topBand <= fullScreenTopSnapLimit,
          point.x.isFinite, point.y.isFinite,
          point.y >= bounds.minY, point.y <= rect.minY,
          (rect.minX...rect.maxX).contains(point.x) else { return nil }
    return CGPoint(x: min(1, max(0, (point.x - rect.minX) / rect.width)), y: 0)
  }
}

public enum DesktopScreenInput {
  private static let fixedKeys: [UInt16: String] = [
    36: "return", 76: "return", 48: "tab", 49: "space", 51: "backspace", 53: "escape",
    123: "left", 124: "right", 125: "down", 126: "up", 117: "delete", 115: "home", 119: "end", 116: "pageup", 121: "pagedown",
    122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8", 101: "f9", 109: "f10", 103: "f11", 111: "f12",
  ]
  public static func key(code: UInt16, characters: String?) -> String? {
    if let fixed = fixedKeys[code] { return fixed }
    guard let characters, characters.count == 1, let scalar = characters.unicodeScalars.first,
          !CharacterSet.controlCharacters.contains(scalar) else { return nil }
    let key = characters.lowercased()
    return key.utf16.count <= 16 ? key : nil
  }
  public static func isNamedKey(_ code: UInt16) -> Bool { fixedKeys[code] != nil && code != 49 }
  public static func modifiers(_ flags: NSEvent.ModifierFlags) -> [String] {
    [(NSEvent.ModifierFlags.command, "cmd"), (.shift, "shift"), (.option, "alt"), (.control, "ctrl")].compactMap { flags.contains($0.0) ? $0.1 : nil }
  }
  public static func textCommands(_ text: String) -> [[String: Any]] {
    var result: [[String: Any]] = [], chunk = "", count = 0
    func flush() { if !chunk.isEmpty { result.append(["t": "text", "s": chunk]); chunk = ""; count = 0 } }
    for scalar in text.replacingOccurrences(of: "\r\n", with: "\n").unicodeScalars {
      if scalar == "\n" || scalar == "\r" || scalar == "\t" {
        flush(); result.append(["t": "key", "k": scalar == "\t" ? "tab" : "return"])
      } else {
        let length = scalar.utf16.count
        if count + length > 4000 { flush() }
        chunk.unicodeScalars.append(scalar); count += length
      }
    }
    flush()
    return result
  }
}

/// Thread-safe, non-AppKit frame receiver exposed by `DesktopScreenSurface` so background Mach/IPC
/// threads can deliver IOSurfaces without ever retaining an `NSView` off the main thread.
public protocol DesktopScreenFrameSink: AnyObject {
  func receive(_ picture: DesktopScreenFrame)
  func receiveImmediate(_ picture: DesktopScreenFrame)
}

/// The video never enters WebKit. VideoToolbox's pixel buffer is retained until Metal has
/// consumed it; incoming frames replace a single mailbox slot instead of building a FIFO.
public final class DesktopScreenSurface: NSView, NSTextInputClient {
  public var onInput: (([String: Any], Bool) -> Void)?
  public var onFirstFrame: (() -> Void)?
  public var onFailure: ((String) -> Void)?
  public var onExitFullScreen: (() -> Void)?
  public var onFocusChanged: ((Bool) -> Void)?
  public var hasControlFocus: Bool {
    !stopped && active && controlEnabled && window?.isKeyWindow == true && window?.firstResponder === self
  }
  public var controlEnabled = false {
    didSet {
      if !controlEnabled {
        releaseInput()
        if !fullScreen, window?.firstResponder === self { window?.makeFirstResponder(nil) }
      }
      updateCursorVisibility()
      notifyFocusChanged()
    }
  }
  /// The remote computer's helper accepts held keys and the middle button (`keys` capability).
  public var physicalKeys = false
  /// Enables Fitts's-law top-bezel snapping when a full-screen picture has a narrow top letterbox.
  public var fullScreen = false {
    didSet {
      if !fullScreen, !controlEnabled, window?.firstResponder === self {
        window?.makeFirstResponder(nil)
      }
    }
  }
  /// Fusion window mode: fills the surface bounds edge-to-edge without black letterbox bars during live resize.
  public var fillsBounds = false {
    didSet {
      renderer.setFillsBounds(fillsBounds)
      positionOverlays()
    }
  }
  /// Fusion window mode: decides whether a left-drag starting at `mouseDown` should invoke native `window.performDrag`.
  public var onLocalMouseDown: ((NSEvent) -> Bool)?
  public var shouldDragWindow: ((NSEvent) -> Bool)?
  public var onWindowDragStarted: (() -> Void)?
  public var onWindowDragEnded: (() -> Void)?
  /// Fusion only (nil elsewhere): a key chord this Mac keeps (hide, minimize, cycle windows).
  /// Returning true means it was handled here and is not sent to the remote computer.
  public var localKeyEquivalent: ((NSEvent) -> Bool)?
  /// Fusion only: any button pressed in the picture (a menu may follow).
  public var onPointerDown: (() -> Void)?
  /// Fusion popups only: hover reaches the remote while this window is not key (menus highlight
  /// the item under the pointer before any click).
  public var tracksPointerWhenInactive = false {
    didSet { updateTrackingAreas() }
  }
  /// Keys and modifier keys this remote-desktop view has pressed on the remote computer, so each is released.
  private var pressedKeys: Set<UInt16> = []
  private var pressedModifiers: Set<UInt16> = []
  public var receivedFrameCount: UInt64 { renderer.receivedFrameCount }
  /// Non-AppKit frame sink safe to retain and invoke from background Mach/decoder threads.
  public var frameSink: DesktopScreenFrameSink { renderer }
  private let metalView = DesktopScreenMetalView(frame: .zero)
  private var renderer: DesktopScreenMetalRenderer!
  private var pictureSize = CGSize.zero
  private var heldButtons: Set<String> = []
  private var downEvent: NSEvent?
  private var downPoint = CGPoint.zero
  private var pendingWindowDrag = false
  private var dragTakenOver = false
  private var dragMonitor: Any?
  private var dragReleaseTimer: Timer?
  private var presentationFrozen = false
  private var tracking: NSTrackingArea?
  private var windowObserver: NSObjectProtocol?
  private var windowBecomeKeyObserver: NSObjectProtocol?
  private var screenObserver: NSObjectProtocol?
  private var active = true
  private var stopped = false
  private var lastReportedFocus = false
  private var marked = NSAttributedString(string: "")
  private var markedSelection = NSRange(location: 0, length: 0)
  private let compositionLabel = DesktopScreenTextLabel(labelWithString: "")
  private let cursorView = DesktopScreenCursorView(frame: .zero)
  private var cursorPosition = CGPoint(x: 0.5, y: 0.5)
  private var cursorHotspot = CGPoint.zero
  private var cursorSize = CGSize(width: 18, height: 24)
  private var cursorShapes: [String: (NSImage, CGSize, CGPoint)] = [:]
  private var pointerInside = false
  private var localCursor = NSCursor.arrow
  private var lastScrollMovePoint = CGPoint(x: -1, y: -1)

  public override var isFlipped: Bool { true }
  public override var isOpaque: Bool { false }
  public override var acceptsFirstResponder: Bool { (controlEnabled || fullScreen) && active && !stopped }
  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  public override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
    metalView.autoresizingMask = [.width, .height]
    metalView.frame = bounds
    addSubview(metalView)
    renderer = DesktopScreenMetalRenderer(layer: metalView.metalLayer,
      picture: { [weak self] size in self?.pictureSize = size; self?.positionOverlays() },
      firstFrame: { [weak self] in self?.onFirstFrame?() },
      failure: { [weak self] message in self?.onFailure?(message) })
    metalView.onDrawableSize = { [weak self] size, scale in
      self?.renderer.setDrawableTarget(size: size, scale: scale)
    }
    cursorView.image = NSCursor.arrow.image
    cursorView.imageScaling = .scaleAxesIndependently
    cursorSize = NSCursor.arrow.image.size
    cursorHotspot = NSCursor.arrow.hotSpot
    addSubview(cursorView)
    compositionLabel.isHidden = true
    compositionLabel.isSelectable = false
    compositionLabel.drawsBackground = true
    compositionLabel.backgroundColor = .textBackgroundColor
    compositionLabel.textColor = .textColor
    compositionLabel.font = .systemFont(ofSize: 16)
    compositionLabel.wantsLayer = true
    compositionLabel.layer?.cornerRadius = 4
    compositionLabel.layer?.masksToBounds = true
    addSubview(compositionLabel)
    setAccessibilityLabel("远程桌面画面")
    setAccessibilityHelp("点击画面后可使用鼠标和键盘控制远程电脑")
  }
  public required init?(coder: NSCoder) { nil }
  deinit {
    if let dragMonitor { NSEvent.removeMonitor(dragMonitor) }
    dragReleaseTimer?.invalidate()
    if let windowObserver { NotificationCenter.default.removeObserver(windowObserver) }
    if let windowBecomeKeyObserver { NotificationCenter.default.removeObserver(windowBecomeKeyObserver) }
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
  }

  public override func layout() { super.layout(); positionOverlays() }
  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if let windowObserver { NotificationCenter.default.removeObserver(windowObserver); self.windowObserver = nil }
    if let windowBecomeKeyObserver { NotificationCenter.default.removeObserver(windowBecomeKeyObserver); self.windowBecomeKeyObserver = nil }
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver); self.screenObserver = nil }
    if let window {
      window.acceptsMouseMovedEvents = true
      // Dragged between a 60 Hz display and a 120 Hz one, the picture follows the new display's rate.
      screenObserver = NotificationCenter.default.addObserver(forName: NSWindow.didChangeScreenNotification, object: window, queue: .main) { [weak self] _ in
        self?.updateRunning()
      }
      windowObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in
        self?.releaseInput()
        self?.updateCursorVisibility()
        self?.notifyFocusChanged()
      }
      windowBecomeKeyObserver = NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self] _ in
        self?.updateCursorVisibility()
        self?.notifyFocusChanged()
      }
    } else { releaseInput() }
    updateRunning()
    notifyFocusChanged()
  }
  public override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let activity: NSTrackingArea.Options = tracksPointerWhenInactive ? .activeAlways : .activeInKeyWindow
    let tracking = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, activity, .inVisibleRect], owner: self)
    addTrackingArea(tracking); self.tracking = tracking
  }
  private func surfaceRect() -> CGRect {
    if fillsBounds {
      return bounds.width > 0 && bounds.height > 0 && pictureSize.width > 0 && pictureSize.height > 0 ? bounds : .zero
    }
    return DesktopScreenGeometry.fittedRect(picture: pictureSize, in: bounds)
  }
  private func surfacePoint(_ point: CGPoint, clamp: Bool = false) -> CGPoint? {
    if fillsBounds {
      guard bounds.width > 0, bounds.height > 0, pictureSize.width > 0, pictureSize.height > 0,
            point.x.isFinite, point.y.isFinite else { return nil }
      let x = (point.x - bounds.minX) / bounds.width, y = (point.y - bounds.minY) / bounds.height
      guard clamp || ((0...1).contains(x) && (0...1).contains(y)) else { return nil }
      return CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y)))
    }
    return DesktopScreenGeometry.stagePoint(point, picture: pictureSize, bounds: bounds, clamp: clamp, topEdgeSnap: fullScreen)
  }
  public override func resetCursorRects() {
    let rect = surfaceRect()
    if !rect.isEmpty { addCursorRect(rect, cursor: controlEnabled ? localCursor : .arrow) }
  }
  public override func cursorUpdate(with event: NSEvent) {
    let inPicture = surfacePoint(convert(event.locationInWindow, from: nil)) != nil
    (canControl && inPicture ? localCursor : .arrow).set()
  }
  public override func mouseEntered(with event: NSEvent) { pointerInside = true; updateCursorVisibility() }
  public override func mouseExited(with event: NSEvent) { pointerInside = false; updateCursorVisibility() }
  public override func becomeFirstResponder() -> Bool {
    let accepted = super.becomeFirstResponder()
    notifyFocusChanged()
    return accepted
  }
  public override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    releaseInput()
    notifyFocusChanged()
    return resigned
  }

  public func setActive(_ value: Bool) {
    guard active != value else { return }
    active = value
    renderer.setActive(value && !stopped)
    updateRunning()
    if !value { releaseInput(); pictureSize = .zero }
    updateCursorVisibility()
    notifyFocusChanged()
  }
  public func stop() {
    cancelWindowDragReleaseTracking()
    pendingWindowDrag = false
    downEvent = nil
    downPoint = .zero
    dragTakenOver = false
    releaseInput()
    stopped = true; active = false
    metalView.onDrawableSize = nil
    renderer.stop()
    cursorShapes.removeAll(); cursorView.isHidden = true
    notifyFocusChanged()
    onInput = nil
    onFirstFrame = nil
    onFailure = nil
    onExitFullScreen = nil
    onFocusChanged = nil
  }
  private func notifyFocusChanged() {
    let focused = hasControlFocus
    guard focused != lastReportedFocus else { return }
    lastReportedFocus = focused
    onFocusChanged?(focused)
  }
  public func resetPresentation() {
    releaseInput(); pictureSize = .zero
    renderer.resetPresentation()
    updateCursorVisibility()
  }
  public func receive(_ picture: DesktopScreenFrame) { renderer.receive(picture) }
  /// Low-latency steady-state path: may be called from any thread (e.g. Mach frame receiver) to
  /// enqueue into the single-slot mailbox and immediately submit a Metal draw when the GPU is free.
  public func receiveImmediate(_ picture: DesktopScreenFrame) { renderer.receiveImmediate(picture) }

  /// Freezes Metal drawable presentation and `CAMetalLayer.drawableSize` while the user holds the
  /// mouse button during a local window drag or resize, then flushes the final frame atomically on release.
  public func setPresentationFrozen(_ frozen: Bool, flushPicture: DesktopScreenFrame? = nil) {
    if frozen {
      guard !presentationFrozen else { return }
      presentationFrozen = true
      metalView.drawableSizeFrozen = true
      renderer.setFrozen(true)
    } else {
      let wasFrozen = presentationFrozen
      presentationFrozen = false
      metalView.drawableSizeFrozen = false
      if let flushPicture { renderer.receive(flushPicture) }
      renderer.setFrozen(false)
      let resizedDrawable = metalView.syncDrawableSizeNow()
      if (wasFrozen || flushPicture != nil) && !resizedDrawable {
        renderer.drawNow()
      }
      if wasFrozen { updateRunning() }
    }
  }

  /// Cursor messages are tiny metadata, independent of the decoded video frames.
  public func updateCursor(_ message: [String: Any]) {
    guard !stopped else { return }
    if message["t"] as? String == "cursor", let x = message["x"] as? Double, let y = message["y"] as? Double,
       x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) {
      cursorPosition = CGPoint(x: x, y: y)
      // Position updates arrive many times a second: move the image only, on the main thread.
      return placeCursor()
    } else if message["t"] as? String == "shape", let id = message["id"] as? String {
      if let png = message["png"] as? String, png.utf8.count <= 1_400_000,
         let w = message["w"] as? Double, let h = message["h"] as? Double,
         let x = message["hotX"] as? Double, let y = message["hotY"] as? Double,
         w.isFinite, h.isFinite, x.isFinite, y.isFinite, w > 0, h > 0, w <= 512, h <= 512,
         let data = Data(base64Encoded: png), let image = Self.cursorImage(data) {
        if cursorShapes.count >= 64 { cursorShapes.removeAll() }
        cursorShapes[id] = (image, CGSize(width: w, height: h), CGPoint(x: min(w, max(0, x)), y: min(h, max(0, y))))
      }
      let (image, size, hotspot) = cursorShapes[id] ?? (NSCursor.arrow.image, NSCursor.arrow.image.size, NSCursor.arrow.hotSpot)
      image.size = size
      cursorView.image = image; cursorSize = size; cursorHotspot = hotspot
      localCursor = NSCursor(image: image, hotSpot: hotspot)
      if canControl, pointerInside { localCursor.set() }
      updateCursorVisibility()
      window?.invalidateCursorRects(for: self)
      if !cursorView.isHidden || !compositionLabel.isHidden {
        placeCursor()
      }
      return
    }
    positionOverlays()
  }
  private static func cursorImage(_ data: Data) -> NSImage? {
    // Declared cursor dimensions do not bound PNG decompression. Check the actual header
    // before asking AppKit to allocate or draw a peer-supplied image.
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          CGImageSourceGetType(source) as String? == "public.png",
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
          let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
          let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
          width > 0, height > 0, width <= 2048, height <= 2048, width * height <= 1_048_576,
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    return NSImage(cgImage: image, size: .zero)
  }
  /// The display link draws only while the picture is on screen, synced to the screen the window is on.
  private func updateRunning() {
    guard !presentationFrozen else { return }
    let screen = window?.screen
    let number = screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
    let refreshRate = max(30, min(240, screen?.maximumFramesPerSecond ?? 60))
    renderer.setRunning(window != nil && active && !stopped, display: number.map { CGDirectDisplayID($0.uint32Value) }, refreshRate: refreshRate)
  }
  private func cursorPoint() -> CGPoint {
    let rect = surfaceRect()
    return CGPoint(x: rect.minX + cursorPosition.x * rect.width, y: rect.minY + cursorPosition.y * rect.height)
  }
  private func placeCursor() {
    guard !cursorView.isHidden || !compositionLabel.isHidden else { return }
    let point = cursorPoint()
    if !cursorView.isHidden {
      cursorView.frame = CGRect(origin: CGPoint(x: point.x - cursorHotspot.x, y: point.y - cursorHotspot.y), size: cursorSize)
    }
    if !compositionLabel.isHidden { positionOverlays() }
  }
  private func positionOverlays() {
    let point = cursorPoint()
    cursorView.frame = CGRect(origin: CGPoint(x: point.x - cursorHotspot.x, y: point.y - cursorHotspot.y), size: cursorSize)
    compositionLabel.sizeToFit()
    let width = min(max(24, compositionLabel.frame.width + 10), max(24, bounds.width - 16))
    compositionLabel.frame = CGRect(x: max(8, min(point.x, bounds.maxX - width - 8)), y: max(8, min(point.y + cursorSize.height + 6, bounds.maxY - 32)), width: width, height: 26)
    updateCursorVisibility()
    inputContext?.invalidateCharacterCoordinates()
    window?.invalidateCursorRects(for: self)
  }
  private func updateCursorVisibility() { cursorView.isHidden = fillsBounds || !active || stopped || pictureSize == .zero || (canControl && pointerInside) }
  private var canControl: Bool { controlEnabled && active && !stopped && (window?.isKeyWindow == true || fillsBounds) }
  private func activateWindowIfNeeded() {
    guard fillsBounds, controlEnabled, active, !stopped, let window else { return }
    if !NSApp.isActive { NSApp.activate(ignoringOtherApps: true) }
    if !window.isKeyWindow { window.makeKeyAndOrderFront(nil) }
    if window.firstResponder !== self { window.makeFirstResponder(self) }
  }
  private func move(_ event: NSEvent, clamp: Bool = false, replaceable: Bool = true) -> Bool {
    guard canControl, let point = surfacePoint(convert(event.locationInWindow, from: nil), clamp: clamp) else { return false }
    cursorPosition = point
    onInput?(["t": "move", "x": Double(point.x), "y": Double(point.y)], replaceable && heldButtons.isEmpty)
    return true
  }
  public override func mouseMoved(with event: NSEvent) {
    let local = convert(event.locationInWindow, from: nil)
    let inPicture = surfacePoint(local) != nil
    let shouldClamp = bounds.contains(local) || pointerInside
    pointerInside = inPicture
    updateCursorVisibility()
    guard window?.isKeyWindow == true || tracksPointerWhenInactive else { return }
    _ = move(event, clamp: shouldClamp)
  }
  public override func mouseDragged(with event: NSEvent) {
    if pendingWindowDrag, let savedDown = downEvent {
      let local = convert(event.locationInWindow, from: nil)
      if hypot(local.x - downPoint.x, local.y - downPoint.y) >= 2.0 {
        pendingWindowDrag = false
        dragTakenOver = true
        downEvent = nil
        // `NSWindow.performDrag(with:)` hands window movement to WindowServer (`SkyLight`) and
        // returns immediately while the mouse button is STILL held down! Track real mouse-button
        // release so `onWindowDragEnded` never fires until the user actually lets go.
        beginWindowDragReleaseTracking()
        onWindowDragStarted?()
        window?.performDrag(with: savedDown)
      }
      return
    }
    guard heldButtons.contains("left") else { return }
    _ = move(event, clamp: true)
  }

  private func beginWindowDragReleaseTracking() {
    cancelWindowDragReleaseTracking()
    dragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] ev in
      self?.finishWindowDragIfActive()
      return ev
    }
    let timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
      guard let self else { return }
      if NSEvent.pressedMouseButtons & 1 == 0 {
        self.finishWindowDragIfActive()
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    dragReleaseTimer = timer
  }

  private func finishWindowDragIfActive() {
    let wasDragging = dragTakenOver || dragReleaseTimer != nil || dragMonitor != nil
    cancelWindowDragReleaseTracking()
    dragTakenOver = false
    if wasDragging {
      onWindowDragEnded?()
    }
  }

  private func cancelWindowDragReleaseTracking() {
    if let dragMonitor {
      NSEvent.removeMonitor(dragMonitor)
      self.dragMonitor = nil
    }
    dragReleaseTimer?.invalidate()
    dragReleaseTimer = nil
  }
  public override func rightMouseDragged(with event: NSEvent) { if heldButtons.contains("right") { _ = move(event, clamp: true) } }
  private func button(_ name: String, down: Bool, event: NSEvent) {
    if down {
      activateWindowIfNeeded()
      // Placement must share the reliable lane with the click. Separate data channels have
      // no cross-channel ordering, even when this callback sends the move first.
      guard move(event, replaceable: false) else { return }
      window?.makeFirstResponder(self)
      heldButtons.insert(name)
    } else {
      guard heldButtons.remove(name) != nil else { return }
      _ = move(event, clamp: true, replaceable: false)
    }
    onInput?(["t": down ? "down" : "up", "b": name, "n": min(3, max(1, event.clickCount)), "m": DesktopScreenInput.modifiers(event.modifierFlags)], false)
  }
  public override func mouseDown(with event: NSEvent) {
    onPointerDown?()
    activateWindowIfNeeded()
    if onLocalMouseDown?(event) == true {
      pendingWindowDrag = false
      downEvent = nil
      dragTakenOver = false
      return
    }
    downEvent = event
    downPoint = convert(event.locationInWindow, from: nil)
    dragTakenOver = false
    if event.clickCount == 1, shouldDragWindow?(event) == true {
      pendingWindowDrag = true
      return
    }
    pendingWindowDrag = false
    if fullScreen, !controlEnabled, active, !stopped {
      window?.makeFirstResponder(self)
      return
    }
    button("left", down: true, event: event)
  }
  public override func mouseUp(with event: NSEvent) {
    if pendingWindowDrag, let savedDown = downEvent {
      pendingWindowDrag = false
      downEvent = nil
      downPoint = .zero
      dragTakenOver = false
      button("left", down: true, event: savedDown)
      button("left", down: false, event: event)
      return
    }
    let wasTakenOver = dragTakenOver
    pendingWindowDrag = false
    downEvent = nil
    downPoint = .zero
    if wasTakenOver {
      finishWindowDragIfActive()
      return
    }
    button("left", down: false, event: event)
  }
  public override func rightMouseDown(with event: NSEvent) { onPointerDown?(); activateWindowIfNeeded(); button("right", down: true, event: event) }
  public override func rightMouseUp(with event: NSEvent) { button("right", down: false, event: event) }
  // The middle button only for a helper that knows it: an older one reads any other name as the left.
  public override func otherMouseDown(with event: NSEvent) { if physicalKeys, event.buttonNumber == 2 { activateWindowIfNeeded(); button("middle", down: true, event: event) } }
  public override func otherMouseUp(with event: NSEvent) { if event.buttonNumber == 2 { button("middle", down: false, event: event) } }
  public override func otherMouseDragged(with event: NSEvent) { if heldButtons.contains("middle") { _ = move(event, clamp: true) } }
  public override func scrollWheel(with event: NSEvent) {
    guard canControl, let point = surfacePoint(convert(event.locationInWindow, from: nil), clamp: true) else { return }
    let continuous = event.hasPreciseScrollingDeltas
    let cg = event.cgEvent
    let phase: Int = cg.map { Int($0.getIntegerValueField(.scrollWheelEventScrollPhase)) } ?? {
      if event.phase.contains(.began) { return 1 }
      if event.phase.contains(.changed) { return 2 }
      if event.phase.contains(.ended) { return 4 }
      if event.phase.contains(.cancelled) { return 8 }
      if event.phase.contains(.mayBegin) { return 128 }
      return 0
    }()
    let momentum: Int = cg.map { Int($0.getIntegerValueField(.scrollWheelEventMomentumPhase)) } ?? {
      if event.momentumPhase.contains(.began) { return 1 }
      if event.momentumPhase.contains(.changed) { return 2 }
      if event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) { return 3 }
      return 0
    }()
    let isMidStream = continuous && ((event.phase == .changed && event.momentumPhase.isEmpty) || (event.phase.isEmpty && event.momentumPhase == .changed))
    if hypot(point.x - lastScrollMovePoint.x, point.y - lastScrollMovePoint.y) > 0.0004 || !isMidStream {
      lastScrollMovePoint = point
      cursorPosition = point
      onInput?(["t": "move", "x": Double(point.x), "y": Double(point.y)], isMidStream && heldButtons.isEmpty)
    }
    let scale = continuous ? 1.0 : 12.0
    let dx = Double(event.scrollingDeltaX) * scale
    let dy = Double(event.scrollingDeltaY) * scale
    if abs(dx) < 0.0001 && abs(dy) < 0.0001 && phase == 0 && momentum == 0 { return }
    onInput?([
      "t": "scroll",
      "dx": dx,
      "dy": dy,
      "c": continuous,
      "p": phase,
      "mp": momentum,
      "m": DesktopScreenInput.modifiers(event.modifierFlags),
    ], isMidStream)
  }
  public func releaseHeldInputs() {
    releaseInput()
  }
  private func releaseInput() {
    pendingWindowDrag = false
    downEvent = nil
    downPoint = .zero
    if dragTakenOver || dragReleaseTimer != nil || dragMonitor != nil {
      finishWindowDragIfActive()
    }
    for button in heldButtons.sorted() { onInput?(["t": "up", "b": button, "n": 1, "m": [String]()], false) }
    heldButtons.removeAll()
    for key in pressedKeys.union(pressedModifiers).sorted() {
      if let code = PhysicalKeys.codes[key] { onInput?(["t": "keyup", "c": code], false) }
    }
    pressedKeys.removeAll(); pressedModifiers.removeAll()
    inputContext?.discardMarkedText(); unmarkText()
  }
  private static func isFullScreenShortcut(_ event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    return flags.contains([.command, .control])
      && !flags.contains(.option)
      && (event.keyCode == 3 || event.charactersIgnoringModifiers?.lowercased() == "f")
  }
  private func sendKey(_ event: NSEvent) -> Bool {
    if physicalKeys { return sendHeldKey(event, releaseNow: false) }
    guard canControl, let key = DesktopScreenInput.key(code: event.keyCode, characters: event.charactersIgnoringModifiers) else { return false }
    onInput?(["t": "key", "k": key, "m": DesktopScreenInput.modifiers(event.modifierFlags)], false)
    return true
  }
  public override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if let localKeyEquivalent, window?.firstResponder === self, localKeyEquivalent(event) { return true }
    // ⌃⌘F stays with this Mac so full screen can always be left even while remote keys are captured.
    if Self.isFullScreenShortcut(event) {
      releaseInput()
      if let onExitFullScreen, fullScreen || window == nil || window?.styleMask.contains(.fullScreen) == true {
        onExitFullScreen()
        return true
      }
      return super.performKeyEquivalent(with: event)
    }
    if fullScreen, !controlEnabled, event.keyCode == 53, let onExitFullScreen {
      onExitFullScreen()
      return true
    }
    if window?.firstResponder === self, canControl, !hasMarkedText(), event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
      return physicalKeys ? sendHeldKey(event, releaseNow: true) : sendKey(event)
    }
    return super.performKeyEquivalent(with: event)
  }
  public override func keyDown(with event: NSEvent) {
    if Self.isFullScreenShortcut(event) {
      releaseInput()
      if let onExitFullScreen, fullScreen || window == nil || window?.styleMask.contains(.fullScreen) == true {
        onExitFullScreen()
      }
      return
    }
    if fullScreen, !controlEnabled, event.keyCode == 53 {
      onExitFullScreen?()
      return
    }
    guard canControl else { return }
    if !hasMarkedText(), DesktopScreenInput.isNamedKey(event.keyCode) || event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) || (physicalKeys && event.keyCode == 49) {
      if sendKey(event) { return }
    }
    interpretKeyEvents([event])
  }
  public override func cancelOperation(_ sender: Any?) {
    if fullScreen, !controlEnabled {
      onExitFullScreen?()
      return
    }
    super.cancelOperation(sender)
  }
  /// A key held down on the remote computer by its position (W3C code), until its keyUp here.
  /// `releaseNow`: AppKit may send no keyUp for a ⌘ or ⌃ shortcut, so that key goes down and up at
  /// once; the modifier itself stays held as a modifier key (`flagsChanged`).
  private func sendHeldKey(_ event: NSEvent, releaseNow: Bool) -> Bool {
    guard canControl, let code = PhysicalKeys.codes[event.keyCode], PhysicalKeys.modifier(event.keyCode) == nil else { return false }
    onInput?(["t": "keydown", "c": code, "r": event.isARepeat], false)
    if releaseNow { onInput?(["t": "keyup", "c": code], false) } else { pressedKeys.insert(event.keyCode) }
    return true
  }
  public override func flagsChanged(with event: NSEvent) {
    guard physicalKeys, canControl, let code = PhysicalKeys.codes[event.keyCode], let flag = PhysicalKeys.modifier(event.keyCode) else {
      return super.flagsChanged(with: event)
    }
    // Which side changed is told by the key; whether it went down, by whether this view had it down.
    let stillSet = CGEventFlags(rawValue: UInt64(event.modifierFlags.rawValue)).contains(flag)
    let down = stillSet && !pressedModifiers.contains(event.keyCode)
    if down { pressedModifiers.insert(event.keyCode) } else if pressedModifiers.remove(event.keyCode) == nil { return }
    onInput?(["t": down ? "keydown" : "keyup", "c": code], false)
  }
  public override func keyUp(with event: NSEvent) {
    guard pressedKeys.remove(event.keyCode) != nil, let code = PhysicalKeys.codes[event.keyCode] else { return }
    onInput?(["t": "keyup", "c": code], false)
  }
  public func insertText(_ string: Any, replacementRange: NSRange) {
    guard canControl else { return }
    let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    unmarkText()
    for command in DesktopScreenInput.textCommands(text) { onInput?(command, false) }
  }
  public func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
    guard canControl else { return }
    marked = (string as? NSAttributedString) ?? NSAttributedString(string: (string as? String) ?? "")
    markedSelection = NSIntersectionRange(selectedRange, NSRange(location: 0, length: marked.length))
    compositionLabel.attributedStringValue = marked
    compositionLabel.isHidden = marked.length == 0
    positionOverlays()
  }
  public func unmarkText() { marked = NSAttributedString(string: ""); markedSelection = NSRange(location: 0, length: 0); compositionLabel.isHidden = true }
  public func selectedRange() -> NSRange { markedSelection }
  public func markedRange() -> NSRange { marked.length == 0 ? NSRange(location: NSNotFound, length: 0) : NSRange(location: 0, length: marked.length) }
  public func hasMarkedText() -> Bool { marked.length > 0 }
  public func validAttributesForMarkedText() -> [NSAttributedString.Key] { [.underlineStyle, .markedClauseSegment, .languageIdentifier] }
  public func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
    guard range.location != NSNotFound, marked.length > 0 else { return nil }
    let overlap = NSIntersectionRange(range, NSRange(location: 0, length: marked.length))
    actualRange?.pointee = overlap
    return marked.attributedSubstring(from: overlap)
  }
  public func characterIndex(for point: NSPoint) -> Int { markedSelection.location }
  public func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
    actualRange?.pointee = markedRange()
    guard let window else { return .zero }
    return window.convertToScreen(convert(compositionLabel.frame, to: nil))
  }
  public override func doCommand(by selector: Selector) {
    guard canControl else { return }
    let names: [String: String] = ["insertNewline:": "return", "insertTab:": "tab", "insertBacktab:": "tab", "deleteBackward:": "backspace", "deleteForward:": "delete", "cancelOperation:": "escape", "moveLeft:": "left", "moveRight:": "right", "moveUp:": "up", "moveDown:": "down", "moveToBeginningOfDocument:": "home", "moveToEndOfDocument:": "end", "pageUp:": "pageup", "pageDown:": "pagedown"]
    guard let key = names[NSStringFromSelector(selector)] else { return }
    onInput?(["t": "key", "k": key, "m": NSStringFromSelector(selector) == "insertBacktab:" ? ["shift"] : []], false)
  }
}

/// Layer-backed so the renderer can draw into its CAMetalLayer from the display link's thread.
private final class DesktopScreenMetalView: NSView {
  let metalLayer = CAMetalLayer()
  var drawableSizeFrozen = false
  var onDrawableSize: ((CGSize, CGFloat) -> Void)?
  private var lastReportedSize = CGSize.zero
  private var lastReportedScale: CGFloat = 0
  override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
  required init?(coder: NSCoder) { nil }
  override func makeBackingLayer() -> CALayer { metalLayer }
  override var isOpaque: Bool { false }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func layout() { super.layout(); _ = updateDrawableSize() }
  override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); _ = updateDrawableSize() }
  override func viewDidChangeBackingProperties() { super.viewDidChangeBackingProperties(); _ = updateDrawableSize() }
  @discardableResult
  func syncDrawableSizeNow() -> Bool { updateDrawableSize() }
  @discardableResult
  private func updateDrawableSize() -> Bool {
    guard !drawableSizeFrozen else { return false }
    let rawScale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
    let scale = rawScale.isFinite && rawScale > 0 ? min(4, max(1, rawScale)) : 2
    let rawW = bounds.width.isFinite ? (bounds.width * scale).rounded() : 1
    let rawH = bounds.height.isFinite ? (bounds.height * scale).rounded() : 1
    let size = CGSize(width: min(16384, max(1, rawW)), height: min(16384, max(1, rawH)))
    guard lastReportedSize != size || lastReportedScale != scale else { return false }
    lastReportedSize = size
    lastReportedScale = scale
    onDrawableSize?(size, scale)
    return true
  }
}
private final class DesktopScreenCursorView: NSImageView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
private final class DesktopScreenTextLabel: NSTextField {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Draws on the display link's own thread, as the phone does: a busy main thread (the page,
/// cursor and status updates) can no longer hold back the next frame. Incoming frames replace a
/// single mailbox slot; the pixel buffer is retained until the GPU has finished with it.
private final class DesktopScreenMetalRenderer: DesktopScreenFrameSink {
  private typealias Picture = DesktopScreenFrame
  private let layer: CAMetalLayer
  private var onPicture: ((CGSize) -> Void)?
  private var onFirstFrame: (() -> Void)?
  private var onFailure: ((String) -> Void)?
  /// Guards everything below it up to `failureReported`: the decoder, the main thread, the
  /// display link and the GPU's completion handlers all touch it.
  private let lock = NSLock()
  /// Serializes `CVMetalTextureCache` creation and flush between `draw()` and `stop()`.
  private let cacheLock = NSLock()
  private var pending: Picture?
  private var current: Picture?
  private var accepting = true
  private var stopped = false
  private var running = false
  private var received: UInt64 = 0
  private var generation: UInt64 = 0
  private var changes: UInt64 = 0
  private var drawn: UInt64 = 0
  private var clearRequested = false
  private var reportedSize = CGSize.zero
  private var reportedFirst = false
  private var failureReported = false
  private var fillsBounds = false
  private var frozen = false
  private var targetDrawableSize = CGSize(width: 1, height: 1)
  private var targetContentsScale: CGFloat = 2
  private var framesSinceCacheFlush = 0
  private let timingLock = NSLock()
  private var gpuSeconds = 0.0005
  // Single in-flight GPU submission (matching iOS ScreenMetalView) prevents +1 frame swapchain
  // queueing in WindowServer so every 120 Hz VSync presents the newest decoded mailbox frame.
  private let inFlight = DispatchSemaphore(value: 1)
  private var link: CVDisplayLink?
  private var legacyLinkStopped = false
  private var metalLinkStorage: AnyObject?
  private var metalDriverStorage: AnyObject?
  private var renderThreadStorage: AnyObject?
  private var metalLinkStopped = false
  private var queue: MTLCommandQueue?
  private var pipeline: MTLRenderPipelineState?
  private var cache: CVMetalTextureCache?
  var receivedFrameCount: UInt64 { lock.lock(); defer { lock.unlock() }; return received }

  init(layer: CAMetalLayer, picture: @escaping (CGSize) -> Void, firstFrame: @escaping () -> Void, failure: @escaping (String) -> Void) {
    self.layer = layer; onPicture = picture; onFirstFrame = firstFrame; onFailure = failure
    layer.device = MTLCreateSystemDefaultDevice()
    layer.pixelFormat = .bgra8Unorm
    layer.framebufferOnly = true
    // Double-buffered swapchain eliminates 1 frame of Metal presentation queueing latency.
    layer.maximumDrawableCount = 2
    layer.presentsWithTransaction = false
    layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    layer.isOpaque = false
    layer.backgroundColor = NSColor.clear.cgColor
    guard let device = layer.device, let queue = device.makeCommandQueue() else { fail("这台 Mac 无法使用 Metal 显示远程桌面"); return }
    self.queue = queue
    guard CVMetalTextureCacheCreate(nil, nil, device, nil, &cache) == kCVReturnSuccess else { fail("原生屏幕纹理缓存初始化失败"); return }
    do {
      let library = try device.makeLibrary(source: Self.shader, options: nil)
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: "desktopScreenVertex")
      descriptor.fragmentFunction = library.makeFunction(name: "desktopScreenYUV")
      descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
      pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
    } catch { fail("原生屏幕渲染初始化失败") }
    if #available(macOS 14.0, *) {
      // Exact parity with iOS ScreenMetalView: CAMetalDisplayLink on a dedicated user-interactive
      // thread unlocks true 120 Hz ProMotion VSync at 1-frame latency instead of 60 Hz CVDisplayLink.
      let thread = DesktopRenderThread()
      let driver = DesktopMetalDisplayLinkDriver(renderer: self)
      let metalLink = CAMetalDisplayLink(metalLayer: layer)
      metalLink.delegate = driver
      metalLink.preferredFrameLatency = 1
      metalLink.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
      metalLink.isPaused = true
      renderThreadStorage = thread
      metalDriverStorage = driver
      metalLinkStorage = metalLink
      thread.perform { metalLink.add(to: .current, forMode: .common) }
    } else {
      var made: CVDisplayLink?
      guard CVDisplayLinkCreateWithActiveCGDisplays(&made) == kCVReturnSuccess, let made else { fail("无法与显示器刷新同步，请重新连接"); return }
      CVDisplayLinkSetOutputHandler(made) { [weak self] _, _, _, _, _ in self?.draw(); return kCVReturnSuccess }
      link = made
    }
  }
  deinit {
    teardownDisplayLinks()
  }

  private func teardownDisplayLinks() {
    lock.lock()
    let legacyLink = legacyLinkStopped ? nil : link
    legacyLinkStopped = true
    link = nil
    lock.unlock()
    if let legacyLink { CVDisplayLinkStop(legacyLink) }
    if #available(macOS 14.0, *) {
      lock.lock()
      let alreadyStopped = metalLinkStopped
      metalLinkStopped = true
      let metalLink = metalLinkStorage as? CAMetalDisplayLink
      let thread = renderThreadStorage as? DesktopRenderThread
      metalLinkStorage = nil
      metalDriverStorage = nil
      renderThreadStorage = nil
      lock.unlock()
      guard !alreadyStopped else { return }
      if let metalLink, let thread {
        thread.performSync {
          metalLink.isPaused = true
          metalLink.invalidate()
        }
        thread.shutdown()
      }
    }
  }

  private var usesMetalDisplayLink: Bool {
    if #available(macOS 14.0, *) {
      return metalLinkStorage != nil
    }
    return false
  }

  /// Wakes `CAMetalDisplayLink` on its dedicated render thread without ever calling `layer.nextDrawable()`
  /// directly (which throws `NSInternalInconsistencyException` once `CAMetalDisplayLink` owns the layer).
  private func wakeMetalLinkIfNeeded() {
    guard #available(macOS 14.0, *) else { return }
    lock.lock()
    let shouldWake = !stopped && !frozen && !metalLinkStopped && (running || (clearRequested && current == nil))
    let metalLink = shouldWake ? (metalLinkStorage as? CAMetalDisplayLink) : nil
    let thread = shouldWake ? (renderThreadStorage as? DesktopRenderThread) : nil
    lock.unlock()
    if let metalLink, let thread {
      thread.perform { metalLink.isPaused = false }
    }
  }

  func receive(_ picture: DesktopScreenFrame) {
    var dropped: Picture?
    lock.lock()
    if accepting && !stopped {
      dropped = pending
      pending = picture
      received &+= 1
    }
    lock.unlock()
    _ = dropped
    wakeMetalLinkIfNeeded()
  }
  func receiveImmediate(_ picture: DesktopScreenFrame) {
    var dropped: Picture?
    lock.lock()
    let ready = accepting && !stopped && running && !frozen
    if accepting && !stopped {
      dropped = pending
      pending = picture
      received &+= 1
    }
    lock.unlock()
    _ = dropped
    if usesMetalDisplayLink {
      if ready { wakeMetalLinkIfNeeded() }
    } else if ready {
      draw()
    }
  }
  /// Draws only while the surface is on screen; `display` and `refreshRate` follow the window's screen.
  func setRunning(_ value: Bool, display: CGDirectDisplayID?, refreshRate: Int = 60) {
    lock.lock()
    let was = running
    running = value && !stopped
    let now = running
    let needsClear = !stopped && !frozen && clearRequested && current == nil
    if now && !was { changes &+= 1 }
    lock.unlock()
    if #available(macOS 14.0, *),
       let metalLink = metalLinkStorage as? CAMetalDisplayLink,
       let thread = renderThreadStorage as? DesktopRenderThread {
      let maxHz = Float(max(30, min(240, refreshRate)))
      let minHz = min(60, maxHz)
      let range = CAFrameRateRange(minimum: minHz, maximum: maxHz, preferred: maxHz)
      let keepUnpaused = now || needsClear
      thread.perform {
        metalLink.preferredFrameRateRange = range
        metalLink.isPaused = !keepUnpaused
      }
      return
    }
    guard let link else { return }
    if let display { CVDisplayLinkSetCurrentCGDisplay(link, display) }
    if now && !was { CVDisplayLinkStart(link) } else if !now && was { CVDisplayLinkStop(link) }
  }
  func setDrawableTarget(size: CGSize, scale: CGFloat) {
    lock.lock()
    targetDrawableSize = size
    targetContentsScale = scale
    changes &+= 1
    lock.unlock()
    if usesMetalDisplayLink {
      wakeMetalLinkIfNeeded()
    } else {
      if layer.contentsScale != scale { layer.contentsScale = scale }
      if layer.drawableSize != size { layer.drawableSize = size }
      drawNow()
    }
  }
  func setFillsBounds(_ value: Bool) { lock.lock(); fillsBounds = value; changes &+= 1; lock.unlock(); wakeMetalLinkIfNeeded() }
  func setFrozen(_ value: Bool) {
    lock.lock()
    let was = frozen
    frozen = value
    if !value && was { changes &+= 1 }
    lock.unlock()
    if !value && was { wakeMetalLinkIfNeeded() }
  }
  func drawNow() {
    if usesMetalDisplayLink {
      wakeMetalLinkIfNeeded()
      return
    }
    draw(waitTimeout: .now() + .milliseconds(8))
  }
  func setActive(_ value: Bool) {
    var droppedPending: Picture?
    var droppedCurrent: Picture?
    lock.lock()
    accepting = value && !stopped
    if !accepting { droppedPending = pending; pending = nil }
    generation &+= 1
    if !value {
      droppedCurrent = current
      current = nil
      clearRequested = true
      changes &+= 1
      reportedSize = .zero
      reportedFirst = false
    }
    let hasDrawableTarget = targetDrawableSize.width >= 1 && targetDrawableSize.height >= 1
    lock.unlock()
    _ = droppedPending
    _ = droppedCurrent
    if !value {
      layer.isOpaque = false
      if hasDrawableTarget { drawNow() }
    }
  }
  func resetPresentation() {
    var droppedPending: Picture?
    var droppedCurrent: Picture?
    lock.lock()
    droppedPending = pending; pending = nil
    droppedCurrent = current; current = nil
    generation &+= 1; clearRequested = true; changes &+= 1
    reportedSize = .zero; reportedFirst = false
    let hasDrawableTarget = targetDrawableSize.width >= 1 && targetDrawableSize.height >= 1
    lock.unlock()
    _ = droppedPending
    _ = droppedCurrent
    layer.isOpaque = false
    if hasDrawableTarget { drawNow() }
  }
  func stop() {
    var droppedPending: Picture?
    var droppedCurrent: Picture?
    lock.lock()
    stopped = true
    accepting = false
    droppedPending = pending; pending = nil
    droppedCurrent = current; current = nil
    generation &+= 1
    onPicture = nil
    onFirstFrame = nil
    onFailure = nil
    lock.unlock()
    _ = droppedPending
    _ = droppedCurrent
    setRunning(false, display: nil)
    teardownDisplayLinks()
    cacheLock.lock()
    if let cache { CVMetalTextureCacheFlush(cache, 0) }
    cacheLock.unlock()
  }

  fileprivate func draw(
    drawable providedDrawable: CAMetalDrawable? = nil,
    waitTimeout: DispatchTime = .now(),
    deadline: Double? = nil,
    expectedPresentation: Double? = nil
  ) {
    if usesMetalDisplayLink, providedDrawable == nil {
      wakeMetalLinkIfNeeded()
      return
    }
    var superseded: Picture?
    lock.lock()
    if stopped || frozen { lock.unlock(); return }
    // Allow clearing a stale drawable even after the surface becomes inactive or pauses its display link.
    let clearOnly = clearRequested && current == nil && (!accepting || !running)
    guard clearOnly || (accepting && running) else { lock.unlock(); return }
    let desiredSize = targetDrawableSize
    let desiredScale = targetContentsScale
    if accepting, let next = pending {
      superseded = current
      current = next
      pending = nil
      changes &+= 1
    }
    let picture = current, mark = changes, ticket = generation, stretch = fillsBounds
    let clear = clearRequested && picture == nil
    let alreadyPresentedFirst = reportedFirst
    let needed = clear || (accepting && running && picture != nil && mark != drawn)
    lock.unlock()
    // Release any superseded frame outside `lock` so cross-process pipe token release never blocks callers.
    _ = superseded
    guard needed else { return }

    // Synchronize CAMetalLayer size on the render thread before touching the drawable (parity with iOS ScreenMetalView).
    if layer.contentsScale != desiredScale { layer.contentsScale = desiredScale }
    if layer.drawableSize != desiredSize { layer.drawableSize = desiredSize }
    if !clear, let providedDrawable,
       (providedDrawable.texture.width != Int(desiredSize.width) || providedDrawable.texture.height != Int(desiredSize.height)) {
      return
    }

    if !clear, alreadyPresentedFirst, let targetDeadline = expectedPresentation ?? deadline {
      timingLock.lock(); let cost = gpuSeconds; timingLock.unlock()
      let now = CACurrentMediaTime()
      if targetDeadline > 0, targetDeadline <= now || (targetDeadline - now) < max(0.0005, cost * 1.25) {
        return
      }
    }

    guard inFlight.wait(timeout: waitTimeout) == .success else { return }
    var committed = false
    defer { if !committed { inFlight.signal() } }
    let drawable: CAMetalDrawable? = usesMetalDisplayLink ? providedDrawable : (providedDrawable ?? layer.nextDrawable())
    guard let queue, let command = queue.makeCommandBuffer(), let drawable else { return }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = drawable.texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    if clear {
      pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
      guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
      encoder.endEncoding()
      command.addCompletedHandler { [inFlight] _ in inFlight.signal() }
      command.present(drawable); command.commit(); committed = true
      lock.lock()
      drawn = mark
      clearRequested = false
      let pauseAfterClear = !running || stopped
      let metalLink = pauseAfterClear ? metalLinkStorage : nil
      lock.unlock()
      if #available(macOS 14.0, *), let link = metalLink as? CAMetalDisplayLink {
        link.isPaused = true
      }
      return
    }
    guard let picture, let cache, let pipeline else { return }
    let buffer = picture.buffer
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
    let format = CVPixelBufferGetPixelFormatType(buffer)
    guard format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange else { return fail("原生屏幕收到不支持的硬件像素格式") }
    var heldTextures: [CVMetalTexture] = []
    func texture(_ plane: Int, _ format: MTLPixelFormat) -> MTLTexture? {
      var cv: CVMetalTexture?
      let status: CVReturn = cacheLock.withLock {
        CVMetalTextureCacheCreateTextureFromImage(nil, cache, buffer, nil, format, CVPixelBufferGetWidthOfPlane(buffer, plane), CVPixelBufferGetHeightOfPlane(buffer, plane), plane, &cv)
      }
      guard status == kCVReturnSuccess,
            let cv, let texture = CVMetalTextureGetTexture(cv) else { return nil }
      heldTextures.append(cv); return texture
    }
    guard let y = texture(0, .r8Unorm), let uv = texture(1, .rg8Unorm), let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return fail("原生屏幕纹理创建失败") }
    let rotation = Int(picture.rotation)
    let turned = rotation == 90 || rotation == 270
    let size = CGSize(width: Int(turned ? picture.height : picture.width), height: Int(turned ? picture.width : picture.height))
    let drawableRect = CGRect(x: 0, y: 0, width: drawable.texture.width, height: drawable.texture.height)
    let rect = stretch ? drawableRect : DesktopScreenGeometry.fittedRect(picture: size, in: drawableRect)
    encoder.setViewport(MTLViewport(originX: rect.minX, originY: rect.minY, width: rect.width, height: rect.height, znear: 0, zfar: 1))
    encoder.setRenderPipelineState(pipeline)
    encoder.setFragmentTexture(y, index: 0); encoder.setFragmentTexture(uv, index: 1)
    let full = format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    var range = SIMD4<Float>(full ? 1 : 255.0 / 219, full ? 0 : 16.0 / 255, full ? 1 : 255.0 / 224, 0)
    encoder.setFragmentBytes(&range, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
    let matrix = CVBufferCopyAttachment(buffer, kCVImageBufferYCbCrMatrixKey, nil) as? String
    var coefficients: SIMD4<Float>
    if matrix == kCVImageBufferYCbCrMatrix_ITU_R_601_4 as String { coefficients = SIMD4(1.402, -0.344136, -0.714136, 1.772) }
    else if matrix == kCVImageBufferYCbCrMatrix_ITU_R_2020 as String { coefficients = SIMD4(1.4746, -0.164553, -0.571353, 1.8814) }
    else { coefficients = SIMD4(1.5748, -0.187324, -0.468124, 1.8556) }
    encoder.setFragmentBytes(&coefficients, length: MemoryLayout<SIMD4<Float>>.size, index: 1)
    var crop = SIMD4<Float>(Float(picture.cropX) / Float(CVPixelBufferGetWidth(buffer)), Float(picture.cropY) / Float(CVPixelBufferGetHeight(buffer)), Float(picture.cropWidth) / Float(CVPixelBufferGetWidth(buffer)), Float(picture.cropHeight) / Float(CVPixelBufferGetHeight(buffer)))
    var turn = Int32(rotation / 90)
    encoder.setVertexBytes(&crop, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
    encoder.setVertexBytes(&turn, length: MemoryLayout<Int32>.size, index: 1)
    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    encoder.endEncoding()
    command.addCompletedHandler { [weak self, heldTextures, inFlight] buffer in
      _ = heldTextures; _ = picture
      if let self, buffer.gpuEndTime > buffer.gpuStartTime {
        self.timingLock.lock()
        self.gpuSeconds = self.gpuSeconds * 0.8 + (buffer.gpuEndTime - buffer.gpuStartTime) * 0.2
        self.timingLock.unlock()
      }
      inFlight.signal()
      self?.presented(ticket: ticket, size: size, failed: buffer.status == .error)
    }
    command.present(drawable); command.commit(); committed = true
    lock.lock()
    drawn = mark; clearRequested = false
    framesSinceCacheFlush += 1
    let shouldFlush = framesSinceCacheFlush >= 120
    if shouldFlush { framesSinceCacheFlush = 0 }
    lock.unlock()
    if shouldFlush {
      cacheLock.lock()
      CVMetalTextureCacheFlush(cache, 0)
      cacheLock.unlock()
    }
  }
  /// Runs on Metal's completion thread; the main thread hears only about a new size or the first frame.
  private func presented(ticket: UInt64, size: CGSize, failed: Bool) {
    lock.lock()
    guard generation == ticket, accepting, !stopped else { lock.unlock(); return }
    let newSize = reportedSize != size, first = !reportedFirst
    if !failed { reportedSize = size; reportedFirst = true }
    lock.unlock()
    if failed { return fail("远程桌面渲染失败，请重新连接") }
    guard newSize || first else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let live = self.generation == ticket && self.accepting && !self.stopped
      let pictureCb = live ? self.onPicture : nil
      let firstCb = live ? self.onFirstFrame : nil
      self.lock.unlock()
      guard live else { return }
      if newSize { pictureCb?(size) }
      // With a picture every pixel is drawn opaque (black beside it): the window server can then
      // skip blending this layer with the page beneath it on every frame.
      if first { self.layer.isOpaque = true; firstCb?() }
    }
  }
  private func fail(_ message: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let report = !self.stopped && !self.failureReported
      self.failureReported = true
      let failureCb = report ? self.onFailure : nil
      self.lock.unlock()
      if report { failureCb?(message) }
    }
  }
  private static let shader = """
  #include <metal_stdlib>
  using namespace metal;
  struct DesktopVertex { float4 position [[position]]; float2 uv; };
  vertex DesktopVertex desktopScreenVertex(uint i [[vertex_id]], constant float4& crop [[buffer(0)]], constant int& turn [[buffer(1)]]) {
    const float2 p[4] = {float2(-1,1),float2(-1,-1),float2(1,1),float2(1,-1)};
    const float2 coords[4] = {float2(0,0),float2(0,1),float2(1,0),float2(1,1)};
    float2 uv = coords[i];
    if (turn == 1) uv = float2(uv.y, 1-uv.x);
    else if (turn == 2) uv = 1-uv;
    else if (turn == 3) uv = float2(1-uv.y, uv.x);
    return {float4(p[i],0,1),crop.xy + uv*crop.zw};
  }
  fragment float4 desktopScreenYUV(DesktopVertex v [[stage_in]], texture2d<float> y [[texture(0)]], texture2d<float> uv [[texture(1)]], constant float4& r [[buffer(0)]], constant float4& c [[buffer(1)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float l = (y.sample(s,v.uv).r-r.y)*r.x;
    float2 chroma = (uv.sample(s,v.uv).rg-float2(128.0/255.0))*r.z;
    return float4(l+c.x*chroma.y,l+c.y*chroma.x+c.z*chroma.y,l+c.w*chroma.x,1);
  }
  """
}

@available(macOS 14.0, *)
private final class DesktopMetalDisplayLinkDriver: NSObject, CAMetalDisplayLinkDelegate {
  weak var renderer: DesktopScreenMetalRenderer?
  init(renderer: DesktopScreenMetalRenderer) { self.renderer = renderer }
  func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
    renderer?.draw(
      drawable: update.drawable,
      deadline: update.targetTimestamp,
      expectedPresentation: update.targetPresentationTimestamp
    )
  }
}

@available(macOS 14.0, *)
private final class DesktopRenderThread: Thread {
  private let ready = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var loop: RunLoop?
  private var keepAlive: Port?
  private var loopExited = false

  override init() {
    super.init()
    name = "linkshell.desktop.metal"
    qualityOfService = .userInteractive
    start()
    ready.wait()
  }

  override func main() {
    let current = RunLoop.current
    let port = Port()
    current.add(port, forMode: .common)
    lock.lock()
    loop = current
    keepAlive = port
    lock.unlock()
    ready.signal()
    while !isCancelled {
      autoreleasepool {
        _ = current.run(mode: .default, before: Date(timeIntervalSinceNow: 1))
      }
    }
    lock.lock()
    if let keepAlive { current.remove(keepAlive, forMode: .common) }
    keepAlive = nil
    loop = nil
    loopExited = true
    lock.unlock()
  }

  func perform(_ work: @escaping () -> Void) {
    lock.lock()
    let target = loop
    let done = loopExited
    lock.unlock()
    guard !done, let target else { return }
    CFRunLoopPerformBlock(target.getCFRunLoop(), CFRunLoopMode.commonModes.rawValue, work)
    CFRunLoopWakeUp(target.getCFRunLoop())
  }

  func performSync(_ work: @escaping () -> Void) {
    if Thread.current === self { work(); return }
    let done = DispatchSemaphore(value: 0)
    lock.lock()
    let target = loop
    let isDone = loopExited
    lock.unlock()
    guard !isDone, let target else { return }
    CFRunLoopPerformBlock(target.getCFRunLoop(), CFRunLoopMode.commonModes.rawValue) {
      work()
      done.signal()
    }
    CFRunLoopWakeUp(target.getCFRunLoop())
    _ = done.wait(timeout: .now() + .seconds(1))
  }

  func shutdown() {
    cancel()
    lock.lock()
    let target = loop
    let done = loopExited
    lock.unlock()
    if !done, let target {
      let cfLoop = target.getCFRunLoop()
      CFRunLoopPerformBlock(cfLoop, CFRunLoopMode.commonModes.rawValue) {
        CFRunLoopStop(cfLoop)
      }
      CFRunLoopWakeUp(cfLoop)
    }
  }
}
