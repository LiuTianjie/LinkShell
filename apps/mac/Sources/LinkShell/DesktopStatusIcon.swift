import AppKit

/// A menu-bar mark, not a miniature app tile. Template rendering follows the system's contrast.
enum DesktopStatusIcon {
  static func make() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
      NSColor.black.setStroke()
      let path = NSBezierPath()
      path.lineWidth = 2.1
      path.lineCapStyle = .round
      path.lineJoinStyle = .round
      path.move(to: NSPoint(x: 3.5, y: 13))
      path.line(to: NSPoint(x: 7.5, y: 9))
      path.line(to: NSPoint(x: 3.5, y: 5))
      path.move(to: NSPoint(x: 10, y: 5))
      path.line(to: NSPoint(x: 15, y: 5))
      path.stroke()
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "LinkShell"
    return image
  }
}
