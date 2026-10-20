import AppKit
import CoreVideo
import ImageIO
import MetalKit
import WebRTC

enum DesktopScreenGeometry {
  static func fittedRect(picture: CGSize, in bounds: CGRect) -> CGRect {
    guard picture.width.isFinite, picture.height.isFinite, bounds.origin.x.isFinite, bounds.origin.y.isFinite, bounds.width.isFinite, bounds.height.isFinite,
          picture.width > 0, picture.height > 0, bounds.width > 0, bounds.height > 0 else { return .zero }
    let scale = min(bounds.width / picture.width, bounds.height / picture.height)
    let size = CGSize(width: picture.width * scale, height: picture.height * scale)
    return CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
  }

  static func normalizedPoint(_ point: CGPoint, picture: CGSize, bounds: CGRect, clamp: Bool = false) -> CGPoint? {
    let rect = fittedRect(picture: picture, in: bounds)
    guard rect.width > 0, rect.height > 0, point.x.isFinite, point.y.isFinite else { return nil }
    let x = (point.x - rect.minX) / rect.width, y = (point.y - rect.minY) / rect.height
    guard clamp || (0...1).contains(x) && (0...1).contains(y) else { return nil }
    return CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y)))
  }
}

enum DesktopScreenInput {
  private static let fixedKeys: [UInt16: String] = [
    36: "return", 76: "return", 48: "tab", 49: "space", 51: "backspace", 53: "escape",
    123: "left", 124: "right", 125: "down", 126: "up", 117: "delete", 115: "home", 119: "end", 116: "pageup", 121: "pagedown",
    122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8", 101: "f9", 109: "f10", 103: "f11", 111: "f12",
  ]
  static func key(code: UInt16, characters: String?) -> String? {
    if let fixed = fixedKeys[code] { return fixed }
    guard let characters, characters.count == 1, let scalar = characters.unicodeScalars.first,
          !CharacterSet.controlCharacters.contains(scalar) else { return nil }
    let key = characters.lowercased()
    return key.utf16.count <= 16 ? key : nil
  }
  static func isNamedKey(_ code: UInt16) -> Bool { fixedKeys[code] != nil && code != 49 }
  static func modifiers(_ flags: NSEvent.ModifierFlags) -> [String] {
    [(NSEvent.ModifierFlags.command, "cmd"), (.shift, "shift"), (.option, "alt"), (.control, "ctrl")].compactMap { flags.contains($0.0) ? $0.1 : nil }
  }
  static func textCommands(_ text: String) -> [[String: Any]] {
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

/// The video never enters WebKit. VideoToolbox's pixel buffer is retained until Metal has
/// consumed it; incoming frames replace a single mailbox slot instead of building a FIFO.
final class DesktopScreenSurface: NSView, RTCVideoRenderer, NSTextInputClient {
  var onInput: (([String: Any], Bool) -> Void)?
  var onFirstFrame: (() -> Void)?
  var onFailure: ((String) -> Void)?
  var controlEnabled = false {
    didSet {
      if !controlEnabled {
        releaseInput()
        if window?.firstResponder === self { window?.makeFirstResponder(nil) }
      }
      updateCursorVisibility()
    }
  }
  var receivedFrameCount: UInt64 { renderer.receivedFrameCount }
  private let metalView = DesktopScreenMetalView(frame: .zero, device: MTLCreateSystemDefaultDevice())
  private var renderer: DesktopScreenMetalRenderer!
  private var pictureSize = CGSize.zero
  private var heldButtons: Set<String> = []
  private var tracking: NSTrackingArea?
  private var windowObserver: NSObjectProtocol?
  private var active = true
  private var stopped = false
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

  override var isFlipped: Bool { true }
  override var isOpaque: Bool { false }
  override var acceptsFirstResponder: Bool { controlEnabled && active && !stopped }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
    metalView.autoresizingMask = [.width, .height]
    metalView.frame = bounds
    addSubview(metalView)
    renderer = DesktopScreenMetalRenderer(view: metalView,
      picture: { [weak self] size in self?.pictureSize = size; self?.positionOverlays() },
      firstFrame: { [weak self] in self?.onFirstFrame?() },
      failure: { [weak self] message in self?.onFailure?(message) })
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
  required init?(coder: NSCoder) { nil }
  deinit { if let windowObserver { NotificationCenter.default.removeObserver(windowObserver) } }

  override func layout() { super.layout(); positionOverlays() }
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if let windowObserver { NotificationCenter.default.removeObserver(windowObserver); self.windowObserver = nil }
    if let window {
      window.acceptsMouseMovedEvents = true
      metalView.preferredFramesPerSecond = min(120, window.screen?.maximumFramesPerSecond ?? 60)
      windowObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in self?.releaseInput(); self?.updateCursorVisibility() }
    } else { releaseInput() }
    metalView.isPaused = window == nil || !active || stopped
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let tracking = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .activeInKeyWindow, .inVisibleRect], owner: self)
    addTrackingArea(tracking); self.tracking = tracking
  }
  override func resetCursorRects() {
    let rect = DesktopScreenGeometry.fittedRect(picture: pictureSize, in: bounds)
    if !rect.isEmpty { addCursorRect(rect, cursor: controlEnabled ? localCursor : .arrow) }
  }
  override func cursorUpdate(with event: NSEvent) {
    let inPicture = DesktopScreenGeometry.normalizedPoint(convert(event.locationInWindow, from: nil), picture: pictureSize, bounds: bounds) != nil
    (canControl && inPicture ? localCursor : .arrow).set()
  }
  override func mouseEntered(with event: NSEvent) { pointerInside = true; updateCursorVisibility() }
  override func mouseExited(with event: NSEvent) { pointerInside = false; updateCursorVisibility() }
  override func resignFirstResponder() -> Bool { releaseInput(); return super.resignFirstResponder() }

  func setActive(_ value: Bool) {
    guard active != value else { return }
    active = value
    renderer.setActive(value && !stopped)
    metalView.isPaused = !value || stopped || window == nil
    if !value { releaseInput(); pictureSize = .zero }
    updateCursorVisibility()
  }
  func stop() {
    releaseInput()
    stopped = true; active = false
    renderer.stop(); metalView.isPaused = true
    cursorShapes.removeAll(); cursorView.isHidden = true
  }
  func resetPresentation() {
    releaseInput(); pictureSize = .zero
    renderer.resetPresentation()
    updateCursorVisibility()
  }
  func setSize(_ size: CGSize) { /* Dimensions travel with their decoded frame. */ }
  func renderFrame(_ frame: RTCVideoFrame?) { if let frame { renderer.receive(frame) } }

  /// Cursor messages are tiny metadata, independent of the decoded video frames.
  func updateCursor(_ message: [String: Any]) {
    guard !stopped else { return }
    if message["t"] as? String == "cursor", let x = message["x"] as? Double, let y = message["y"] as? Double,
       x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) {
      cursorPosition = CGPoint(x: x, y: y)
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
      window?.invalidateCursorRects(for: self)
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
  private func positionOverlays() {
    let rect = DesktopScreenGeometry.fittedRect(picture: pictureSize, in: bounds)
    let point = CGPoint(x: rect.minX + cursorPosition.x * rect.width, y: rect.minY + cursorPosition.y * rect.height)
    cursorView.frame = CGRect(origin: CGPoint(x: point.x - cursorHotspot.x, y: point.y - cursorHotspot.y), size: cursorSize)
    compositionLabel.sizeToFit()
    let width = min(max(24, compositionLabel.frame.width + 10), max(24, bounds.width - 16))
    compositionLabel.frame = CGRect(x: max(8, min(point.x, bounds.maxX - width - 8)), y: max(8, min(point.y + cursorSize.height + 6, bounds.maxY - 32)), width: width, height: 26)
    updateCursorVisibility()
    inputContext?.invalidateCharacterCoordinates()
    window?.invalidateCursorRects(for: self)
  }
  private func updateCursorVisibility() { cursorView.isHidden = !active || stopped || pictureSize == .zero || (canControl && pointerInside) }
  private var canControl: Bool { controlEnabled && active && !stopped && window?.isKeyWindow == true }
  private func move(_ event: NSEvent, clamp: Bool = false, replaceable: Bool = true) -> Bool {
    guard canControl, let point = DesktopScreenGeometry.normalizedPoint(convert(event.locationInWindow, from: nil), picture: pictureSize, bounds: bounds, clamp: clamp) else { return false }
    cursorPosition = point
    onInput?(["t": "move", "x": Double(point.x), "y": Double(point.y)], replaceable && heldButtons.isEmpty)
    return true
  }
  override func mouseMoved(with event: NSEvent) {
    pointerInside = DesktopScreenGeometry.normalizedPoint(convert(event.locationInWindow, from: nil), picture: pictureSize, bounds: bounds) != nil
    updateCursorVisibility()
    _ = move(event)
  }
  override func mouseDragged(with event: NSEvent) { if heldButtons.contains("left") { _ = move(event, clamp: true) } }
  override func rightMouseDragged(with event: NSEvent) { if heldButtons.contains("right") { _ = move(event, clamp: true) } }
  private func button(_ name: String, down: Bool, event: NSEvent) {
    if down {
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
  override func mouseDown(with event: NSEvent) { button("left", down: true, event: event) }
  override func mouseUp(with event: NSEvent) { button("left", down: false, event: event) }
  override func rightMouseDown(with event: NSEvent) { button("right", down: true, event: event) }
  override func rightMouseUp(with event: NSEvent) { button("right", down: false, event: event) }
  override func scrollWheel(with event: NSEvent) {
    guard move(event, replaceable: false) else { return }
    let scale = event.hasPreciseScrollingDeltas ? 1.0 : 12.0
    onInput?(["t": "scroll", "dx": Double(event.scrollingDeltaX) * scale, "dy": Double(event.scrollingDeltaY) * scale, "m": DesktopScreenInput.modifiers(event.modifierFlags)], false)
  }
  private func releaseInput() {
    for button in heldButtons.sorted() { onInput?(["t": "up", "b": button, "n": 1, "m": [String]()], false) }
    heldButtons.removeAll()
    inputContext?.discardMarkedText(); unmarkText()
  }
  private func sendKey(_ event: NSEvent) -> Bool {
    guard canControl, let key = DesktopScreenInput.key(code: event.keyCode, characters: event.charactersIgnoringModifiers) else { return false }
    onInput?(["t": "key", "k": key, "m": DesktopScreenInput.modifiers(event.modifierFlags)], false)
    return true
  }
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if window?.firstResponder === self, canControl, !hasMarkedText(), event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) { return sendKey(event) }
    return super.performKeyEquivalent(with: event)
  }
  override func keyDown(with event: NSEvent) {
    guard canControl else { return }
    if !hasMarkedText(), DesktopScreenInput.isNamedKey(event.keyCode) || event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
      if sendKey(event) { return }
    }
    interpretKeyEvents([event])
  }
  override func keyUp(with event: NSEvent) { /* Key messages are atomic press/release pairs. */ }
  func insertText(_ string: Any, replacementRange: NSRange) {
    guard canControl else { return }
    let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    unmarkText()
    for command in DesktopScreenInput.textCommands(text) { onInput?(command, false) }
  }
  func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
    guard canControl else { return }
    marked = (string as? NSAttributedString) ?? NSAttributedString(string: (string as? String) ?? "")
    markedSelection = NSIntersectionRange(selectedRange, NSRange(location: 0, length: marked.length))
    compositionLabel.attributedStringValue = marked
    compositionLabel.isHidden = marked.length == 0
    positionOverlays()
  }
  func unmarkText() { marked = NSAttributedString(string: ""); markedSelection = NSRange(location: 0, length: 0); compositionLabel.isHidden = true }
  func selectedRange() -> NSRange { markedSelection }
  func markedRange() -> NSRange { marked.length == 0 ? NSRange(location: NSNotFound, length: 0) : NSRange(location: 0, length: marked.length) }
  func hasMarkedText() -> Bool { marked.length > 0 }
  func validAttributesForMarkedText() -> [NSAttributedString.Key] { [.underlineStyle, .markedClauseSegment, .languageIdentifier] }
  func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
    guard range.location != NSNotFound, marked.length > 0 else { return nil }
    let overlap = NSIntersectionRange(range, NSRange(location: 0, length: marked.length))
    actualRange?.pointee = overlap
    return marked.attributedSubstring(from: overlap)
  }
  func characterIndex(for point: NSPoint) -> Int { markedSelection.location }
  func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
    actualRange?.pointee = markedRange()
    guard let window else { return .zero }
    return window.convertToScreen(convert(compositionLabel.frame, to: nil))
  }
  override func doCommand(by selector: Selector) {
    guard canControl else { return }
    let names: [String: String] = ["insertNewline:": "return", "insertTab:": "tab", "insertBacktab:": "tab", "deleteBackward:": "backspace", "deleteForward:": "delete", "cancelOperation:": "escape", "moveLeft:": "left", "moveRight:": "right", "moveUp:": "up", "moveDown:": "down", "moveToBeginningOfDocument:": "home", "moveToEndOfDocument:": "end", "pageUp:": "pageup", "pageDown:": "pagedown"]
    guard let key = names[NSStringFromSelector(selector)] else { return }
    onInput?(["t": "key", "k": key, "m": NSStringFromSelector(selector) == "insertBacktab:" ? ["shift"] : []], false)
  }
}

private final class DesktopScreenMetalView: MTKView {
  override var isOpaque: Bool { false }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
private final class DesktopScreenCursorView: NSImageView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
private final class DesktopScreenTextLabel: NSTextField {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private final class DesktopScreenMetalRenderer: NSObject, MTKViewDelegate {
  private struct Picture { let frame: RTCVideoFrame; let buffer: RTCCVPixelBuffer }
  private let view: MTKView
  private let onPicture: (CGSize) -> Void
  private let onFirstFrame: () -> Void
  private let onFailure: (String) -> Void
  private let lock = NSLock()
  private var pending: Picture?
  private var accepting = true
  private var stopped = false
  private var received: UInt64 = 0
  private var current: Picture?
  private var lastSize = CGSize.zero
  private var dirty = false
  private var clearRequested = false
  private var firstFrame = true
  private var failureReported = false
  private var generation: UInt64 = 0
  private let inFlight = DispatchSemaphore(value: 1)
  private var queue: MTLCommandQueue?
  private var pipeline: MTLRenderPipelineState?
  private var cache: CVMetalTextureCache?
  var receivedFrameCount: UInt64 { lock.lock(); defer { lock.unlock() }; return received }

  init(view: MTKView, picture: @escaping (CGSize) -> Void, firstFrame: @escaping () -> Void, failure: @escaping (String) -> Void) {
    self.view = view; onPicture = picture; onFirstFrame = firstFrame; onFailure = failure
    super.init()
    view.colorPixelFormat = .bgra8Unorm
    view.framebufferOnly = true
    view.clearColor = MTLClearColorMake(0, 0, 0, 1)
    view.autoResizeDrawable = true
    view.enableSetNeedsDisplay = false
    view.isPaused = true
    view.delegate = self
    if let layer = view.layer as? CAMetalLayer { layer.maximumDrawableCount = 2; layer.presentsWithTransaction = false; layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB); layer.isOpaque = false; layer.backgroundColor = NSColor.clear.cgColor }
    guard let device = view.device, let queue = device.makeCommandQueue() else { fail("这台 Mac 无法使用 Metal 显示远程桌面"); return }
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
  }
  func receive(_ frame: RTCVideoFrame) {
    guard let buffer = frame.buffer as? RTCCVPixelBuffer else { return fail("远程桌面未收到原生硬件解码画面") }
    lock.lock()
    if accepting && !stopped { pending = Picture(frame: frame, buffer: buffer); received &+= 1 }
    lock.unlock()
  }
  func setActive(_ value: Bool) {
    lock.lock(); accepting = value && !stopped; if !accepting { pending = nil }; lock.unlock()
    generation &+= 1
    if !value { current = nil; dirty = false; firstFrame = true; lastSize = .zero; clearRequested = true }
  }
  func resetPresentation() {
    lock.lock(); pending = nil; lock.unlock()
    generation &+= 1; current = nil; dirty = false; firstFrame = true; lastSize = .zero; clearRequested = true
  }
  func stop() {
    lock.lock(); stopped = true; accepting = false; pending = nil; lock.unlock()
    generation &+= 1; current = nil; dirty = false
    if let cache { CVMetalTextureCacheFlush(cache, 0) }
  }
  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { dirty = true }
  func draw(in view: MTKView) {
    guard !stopped, accepting, inFlight.wait(timeout: .now()) == .success else { return }
    var committed = false
    defer { if !committed { inFlight.signal() } }
    lock.lock(); let next = pending; pending = nil; lock.unlock()
    if let next { current = next; dirty = true }
    if clearRequested, current == nil, let command = queue?.makeCommandBuffer(), let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable {
      pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
      guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
      encoder.endEncoding()
      command.addCompletedHandler { [inFlight] _ in inFlight.signal() }
      command.present(drawable); command.commit(); committed = true; clearRequested = false
      return
    }
    guard dirty, let picture = current, let cache, let queue, let pipeline, let command = queue.makeCommandBuffer(),
          let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable else { return }
    let buffer = picture.buffer.pixelBuffer
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
    pass.colorAttachments[0].loadAction = .clear
    let format = CVPixelBufferGetPixelFormatType(buffer)
    guard format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange else { return fail("原生屏幕收到不支持的硬件像素格式") }
    var heldTextures: [CVMetalTexture] = []
    func texture(_ plane: Int, _ format: MTLPixelFormat) -> MTLTexture? {
      var cv: CVMetalTexture?
      guard CVMetalTextureCacheCreateTextureFromImage(nil, cache, buffer, nil, format, CVPixelBufferGetWidthOfPlane(buffer, plane), CVPixelBufferGetHeightOfPlane(buffer, plane), plane, &cv) == kCVReturnSuccess,
            let cv, let texture = CVMetalTextureGetTexture(cv) else { return nil }
      heldTextures.append(cv); return texture
    }
    guard let y = texture(0, .r8Unorm), let uv = texture(1, .rg8Unorm), let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return fail("原生屏幕纹理创建失败") }
    let rotation = Int(picture.frame.rotation.rawValue)
    let turned = rotation == 90 || rotation == 270
    let size = CGSize(width: Int(turned ? picture.frame.height : picture.frame.width), height: Int(turned ? picture.frame.width : picture.frame.height))
    let rect = DesktopScreenGeometry.fittedRect(picture: size, in: CGRect(origin: .zero, size: view.drawableSize))
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
    var crop = SIMD4<Float>(Float(picture.buffer.cropX) / Float(CVPixelBufferGetWidth(buffer)), Float(picture.buffer.cropY) / Float(CVPixelBufferGetHeight(buffer)), Float(picture.buffer.cropWidth) / Float(CVPixelBufferGetWidth(buffer)), Float(picture.buffer.cropHeight) / Float(CVPixelBufferGetHeight(buffer)))
    var turn = Int32(rotation / 90)
    encoder.setVertexBytes(&crop, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
    encoder.setVertexBytes(&turn, length: MemoryLayout<Int32>.size, index: 1)
    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    encoder.endEncoding()
    let ticket = generation
    command.addCompletedHandler { [weak self, heldTextures, inFlight] buffer in
      _ = heldTextures; _ = picture
      inFlight.signal()
      DispatchQueue.main.async { [weak self] in
        guard let self, self.generation == ticket, self.accepting, !self.stopped else { return }
        if buffer.status == .error { self.fail("远程桌面渲染失败，请重新连接"); return }
        if self.lastSize != size { self.lastSize = size; self.onPicture(size) }
        if self.firstFrame { self.firstFrame = false; self.onFirstFrame() }
      }
    }
    command.present(drawable); command.commit(); committed = true; dirty = false; clearRequested = false
  }
  private func fail(_ message: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped, !self.failureReported else { return }
      self.failureReported = true; self.onFailure(message)
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
