import AppKit
import CoreVideo
import QuartzCore

/// The clock strip's code: 20 cells across 5%–45% of the display's width and 10%–14% of its
/// height — white, black, the 16 bits (the highest first) of a Gray-coded count of milliseconds
/// since 1970, black, white. Whoever shows the picture reads the count back off a frame and takes
/// it from its own clock: that is how long the frame took. The viewer page reads it too
/// (packages/host/src/screen-viewer.ts, `?measure=1`), so the code is not this app's alone to change.
enum StripCode {
  static let cells = 20
  static let left = 0.05
  static let right = 0.45
  static let top = 0.10
  static let bottom = 0.14

  static func gray(_ value: UInt16) -> UInt16 { value ^ (value >> 1) }

  static func binary(_ gray: UInt16) -> UInt16 {
    var value = gray
    var shift = gray >> 1
    while shift != 0 {
      value ^= shift
      shift >>= 1
    }
    return value
  }

  /// The count for a moment on the host clock.
  static func count(host: Double) -> UInt16 {
    UInt16(truncatingIfNeeded: Int(HostClock.epochMilliseconds(host: host).rounded(.down)))
  }

  /// `a − b` on the 16-bit circle, in milliseconds, between −32768 and 32767.
  static func difference(_ a: UInt16, _ b: UInt16) -> Int {
    Int(Int16(truncatingIfNeeded: Int(a) - Int(b)))
  }

  /// Reads the count back from a picture of the display: its brightness plane, a row at a time.
  static func read(luma: UnsafePointer<UInt8>, stride: Int, width: Int, height: Int) -> UInt16? {
    let row = luma + min(Int((top + bottom) / 2 * Double(height)), height - 1) * stride
    let cell = (right - left) / Double(cells)
    func level(_ index: Int) -> Int {
      Int(row[min(Int((left + (Double(index) + 0.5) * cell) * Double(width)), width - 1)])
    }
    let white = (level(0) + level(cells - 1)) / 2
    let black = (level(1) + level(cells - 2)) / 2
    guard white - black >= 80 else { return nil }
    let middle = (white + black) / 2
    var code: UInt16 = 0
    for bit in 0..<16 { code = code << 1 | (level(2 + bit) > middle ? 1 : 0) }
    return binary(code)
  }

  /// From an NV12 (or any planar, brightness first) pixel buffer.
  static func read(_ buffer: CVPixelBuffer) -> UInt16? {
    guard CVPixelBufferIsPlanar(buffer) else { return nil }
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
    return read(
      luma: base.assumingMemoryBound(to: UInt8.self),
      stride: CVPixelBufferGetBytesPerRowOfPlane(buffer, 0),
      width: CVPixelBufferGetWidthOfPlane(buffer, 0),
      height: CVPixelBufferGetHeightOfPlane(buffer, 0)
    )
  }
}

/// The strip itself: a window over everything on one display, redrawn at every refresh with the
/// time that refresh will be on the glass.
final class ClockStrip: NSObject {
  /// "target": each refresh shows the time the display link says it will be shown at.
  /// "drawn": only the time of drawing is known (before macOS 14).
  static var timing: String {
    if #available(macOS 14.0, *) { return "target" }
    return "drawn"
  }

  private let window: NSWindow
  private var bits: [CALayer] = []
  private var link: AnyObject?
  private var timer: Timer?
  private var shown: UInt16?

  init(screen: NSScreen) {
    let scale = screen.backingScaleFactor
    let frame = screen.frame
    // On whole pixels, so that no edge is a blend of black and white.
    func snap(_ value: CGFloat) -> CGFloat { (value * scale).rounded() / scale }
    let rect = NSRect(
      x: frame.minX + snap(frame.width * StripCode.left),
      y: frame.maxY - snap(frame.height * StripCode.bottom),
      width: snap(frame.width * (StripCode.right - StripCode.left)),
      height: snap(frame.height * (StripCode.bottom - StripCode.top))
    )
    window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
    super.init()
    window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
    window.isOpaque = true
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.backgroundColor = .black
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    window.isReleasedWhenClosed = false

    let view = NSView(frame: NSRect(origin: .zero, size: rect.size))
    view.wantsLayer = true
    view.layer?.backgroundColor = CGColor.black
    let pixels = rect.width * scale
    for index in 0..<StripCode.cells {
      let from = (CGFloat(index) * pixels / CGFloat(StripCode.cells)).rounded() / scale
      let to = (CGFloat(index + 1) * pixels / CGFloat(StripCode.cells)).rounded() / scale
      let cell = CALayer()
      cell.frame = CGRect(x: from, y: 0, width: to - from, height: rect.height)
      cell.backgroundColor = index == 0 || index == StripCode.cells - 1 ? CGColor.white : CGColor.black
      cell.actions = ["backgroundColor": NSNull()]
      view.layer?.addSublayer(cell)
      if index >= 2, index < StripCode.cells - 2 { bits.append(cell) }
    }
    window.contentView = view
  }

  func show() {
    window.orderFrontRegardless()
    if #available(macOS 14.0, *), let screen = window.screen {
      let link = screen.displayLink(target: self, selector: #selector(refresh(_:)))
      link.add(to: .main, forMode: .common)
      self.link = link
    } else {
      let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in self?.draw(host: HostClock.seconds()) }
      RunLoop.main.add(timer, forMode: .common)
      self.timer = timer
    }
  }

  func hide() {
    if #available(macOS 14.0, *) { (link as? CADisplayLink)?.invalidate() }
    link = nil
    timer?.invalidate()
    timer = nil
    window.orderOut(nil)
  }

  @available(macOS 14.0, *)
  @objc private func refresh(_ link: CADisplayLink) {
    draw(host: link.targetTimestamp)
  }

  private func draw(host: Double) {
    let count = StripCode.count(host: host)
    guard count != shown else { return }
    shown = count
    let code = StripCode.gray(count)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (index, cell) in bits.enumerated() {
      cell.backgroundColor = code & (0x8000 >> UInt16(index)) != 0 ? CGColor.white : CGColor.black
    }
    CATransaction.commit()
  }
}

/// How far the strip is from the truth, for `rtc.stats`: the count read from each captured
/// picture against the time ScreenCaptureKit says that picture was on the display. A median of
/// −7 means the strip shows a time 7 ms before the glass did, so latencies read from it are 7 ms
/// too long.
final class StripCheck {
  private var differences: [Int] = []
  private var unread = 0
  private let lock = NSLock()

  func add(_ buffer: CVPixelBuffer, displayed: Double) {
    let read = StripCode.read(buffer)
    lock.lock()
    defer { lock.unlock() }
    guard let read else {
      unread += 1
      return
    }
    differences.append(StripCode.difference(read, StripCode.count(host: displayed)))
  }

  /// What was seen since the last time, in milliseconds (strip − display time).
  func take() -> [String: Any] {
    lock.lock()
    defer {
      differences = []
      unread = 0
      lock.unlock()
    }
    let sorted = differences.sorted()
    guard !sorted.isEmpty else { return ["n": 0, "unreadable": unread] }
    return ["n": sorted.count, "unreadable": unread, "min": sorted[0], "median": sorted[sorted.count / 2], "max": sorted[sorted.count - 1]]
  }
}
