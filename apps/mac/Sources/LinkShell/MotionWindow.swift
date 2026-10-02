import AppKit
import QuartzCore

/// Something moving on a display, for measuring (`--motion`): a window of text that scrolls as
/// a terminal's does, and a block that slides across it as a dragged window does. It gives the
/// encoder the work a busy screen gives it, the same in every run, with no input posted. The
/// render server moves it: none of the app's own time goes into it.
final class MotionWindow {
  private let window: NSWindow

  /// The lower middle of the display, clear of the clock strip.
  init(screen: NSScreen) {
    let frame = screen.frame
    let rect = NSRect(x: frame.minX + frame.width * 0.1, y: frame.minY + frame.height * 0.12, width: frame.width * 0.8, height: frame.height * 0.6)
    window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
    window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
    window.isOpaque = true
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.backgroundColor = .white
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    window.isReleasedWhenClosed = false

    let view = NSView(frame: NSRect(origin: .zero, size: rect.size))
    view.wantsLayer = true
    view.layer?.backgroundColor = CGColor.white
    view.layer?.masksToBounds = true

    // The page, twice over, so that where it wraps around can't be seen.
    let lineHeight: CGFloat = 18
    let lines = Int(rect.height / lineHeight) + 1
    let page = CALayer()
    page.frame = CGRect(x: 0, y: 0, width: rect.width, height: CGFloat(lines * 2) * lineHeight)
    for index in 0..<(lines * 2) {
      let line = CATextLayer()
      line.frame = CGRect(x: 12, y: CGFloat(index) * lineHeight, width: rect.width - 24, height: lineHeight)
      line.string = MotionWindow.text(index % lines)
      line.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
      line.fontSize = 13
      line.foregroundColor = CGColor.black
      line.contentsScale = screen.backingScaleFactor
      page.addSublayer(line)
    }
    view.layer?.addSublayer(page)
    let scroll = CABasicAnimation(keyPath: "position.y")
    scroll.fromValue = page.position.y
    scroll.toValue = page.position.y - CGFloat(lines) * lineHeight
    // Twelve lines a second: a build's output going by.
    scroll.duration = Double(lines) / 12
    scroll.repeatCount = .infinity
    page.add(scroll, forKey: "scroll")

    let block = CALayer()
    block.frame = CGRect(x: 0, y: rect.height * 0.3, width: rect.width * 0.25, height: rect.height * 0.3)
    block.backgroundColor = CGColor(red: 0.16, green: 0.38, blue: 0.75, alpha: 1)
    view.layer?.addSublayer(block)
    let slide = CABasicAnimation(keyPath: "position.x")
    slide.fromValue = block.position.x
    slide.toValue = rect.width - block.position.x
    slide.duration = 3
    slide.autoreverses = true
    slide.repeatCount = .infinity
    block.add(slide, forKey: "slide")

    window.contentView = view
  }

  func show() {
    window.orderFrontRegardless()
  }

  func hide() {
    window.orderOut(nil)
  }

  /// A line of the page: the same every run.
  private static func text(_ index: Int) -> String {
    let words = ["let", "frame", "= encoder.next()", "// 屏幕", "guard", "bitrate", "<", "ceiling", "else", "{ return }", "0x1f", "keyframe", "→", "socket.write(record)", "await", "viewer.decode(unit)"]
    var seed = UInt64(index) &* 2_654_435_761 &+ 12345
    var line = String(format: "%04d  ", index)
    while line.count < 150 {
      seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      line += words[Int(seed >> 33) % words.count] + " "
    }
    return line
  }
}
