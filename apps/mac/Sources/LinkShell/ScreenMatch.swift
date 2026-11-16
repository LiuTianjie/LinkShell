import AppKit
import CoreGraphics
import LinkShellFusionShim

/// The remote screen at the viewer's resolution, as a remote desktop session takes its client's:
/// a virtual display the shape and size of the viewer's screen, which the watched display mirrors
/// while the viewer watches. The desktop is laid out for it, so the picture fills the viewer's
/// screen with no bars; whoever sits at the Mac sees the same desktop, with the bars there.
///
/// A Mac with no screen attached has only the system's stand-in display, which goes the moment any
/// other display exists: there the matched display is not mirrored, it simply is the desktop
/// (`alone`), and the stand-in comes back, under a new number, when the viewer leaves.
///
/// One at a time, and it belongs to the viewer that asked. The display configuration is made for
/// this app only (`.forAppOnly`): should the app end without undoing it, the system does.
final class ScreenMatch {
  struct Size: Equatable {
    /// The desktop's size, in points.
    let width: Int
    let height: Int
    /// Pixels to a point: 2 for a viewer whose own screen is dense, so text stays sharp there.
    let scale: Int
  }

  /// What the viewer said of its screen (`rtc.open`'s `match`): its points and its pixels to a point.
  struct Wanted: Equatable {
    let width: Double
    let height: Double
    let scale: Double

    init?(_ value: Any?) {
      guard let value = value as? [String: Any],
            let width = (value["w"] as? NSNumber)?.doubleValue, let height = (value["h"] as? NSNumber)?.doubleValue,
            width.isFinite, height.isFinite else { return nil }
      let scale = (value["scale"] as? NSNumber)?.doubleValue ?? 1
      self.width = width; self.height = height; self.scale = scale.isFinite ? scale : 1
    }

    init(width: Double, height: Double, scale: Double) {
      self.width = width; self.height = height; self.scale = scale
    }
  }

  /// Product numbers of these displays (Fusion's are 0x4600…): `Display.all` leaves them out, so a
  /// `screen` number goes on meaning the display the viewer chose.
  static let product: UInt32 = 0x4700

  /// The display to make for a viewer's screen; nil when it would gain nothing (the watched
  /// display already has that size) or the screen is no desktop's shape (a phone held upright).
  static func size(for wanted: Wanted, watching current: CGSize) -> Size? {
    guard wanted.width >= 800, wanted.height >= 500, wanted.width >= wanted.height else { return nil }
    // No larger than a desktop is useful at; the shape is kept.
    let shrink = min(1, 3840 / wanted.width, 2400 / wanted.height)
    let width = Int((wanted.width * shrink / 2).rounded()) * 2
    let height = Int((wanted.height * shrink / 2).rounded()) * 2
    if abs(Double(width) - current.width) <= 2, abs(Double(height) - current.height) <= 2 { return nil }
    // Twice the pixels only where the viewer shows them and the encoder's widest picture is near.
    let scale = wanted.scale >= 1.25 && width <= 2560 ? 2 : 1
    return Size(width: width, height: height, scale: scale)
  }

  static func isMatch(_ id: CGDirectDisplayID) -> Bool {
    CGDisplayVendorNumber(id) == FusionProtocol.virtualDisplayVendor && CGDisplayModelNumber(id) & 0xFF00 == product
  }

  /// A Fusion remote has arranged this Mac's displays for another computer: they are left alone.
  static func fusionActive() -> Bool {
    online().contains { CGDisplayVendorNumber($0) == FusionProtocol.virtualDisplayVendor && !isMatch($0) }
  }

  static func online() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetOnlineDisplayList(count, &ids, &count)
    return Array(ids.prefix(Int(count)))
  }

  /// The display a match display stands in for, while it does: itself, on a Mac whose only
  /// display left when it came.
  static func watched(by id: CGDirectDisplayID) -> CGDirectDisplayID? {
    guard let current, current.displayID == id else { return nil }
    return current.alone ? id : current.physical
  }

  private(set) static var current: ScreenMatch?
  /// Displays on their way out: released a moment after the mirroring is undone.
  private static var retiring: [CGVirtualDisplay] = []
  private static var serial: UInt32 = 0

  let physical: CGDirectDisplayID
  let size: Size
  private var display: CGVirtualDisplay?
  private let log: (String) -> Void
  private var ended = false
  /// The watched display left when this one came (a Mac with no screen): nothing mirrors it.
  private(set) var alone = false

  var displayID: CGDirectDisplayID { display?.displayID ?? 0 }

  private init(physical: CGDirectDisplayID, size: Size, display: CGVirtualDisplay, log: @escaping (String) -> Void) {
    self.physical = physical
    self.size = size
    self.display = display
    self.log = log
  }

  /// Makes the display and has `physical` mirror it; `ready` gets nil when that could not be done
  /// (the picture is then the display as it is). On the main queue, as everything here.
  static func begin(watching physical: CGDirectDisplayID, size: Size, hz: Double, log: @escaping (String) -> Void, ready: @escaping (ScreenMatch?) -> Void) {
    current?.end()
    guard !fusionActive(), !isMatch(physical) else {
      log("the viewer's resolution is not matched: this Mac's displays are arranged for Fusion")
      return ready(nil)
    }
    let descriptor = CGVirtualDisplayDescriptor()
    descriptor.queue = .main
    descriptor.name = "LinkShell Remote"
    descriptor.maxPixelsWide = UInt32(size.width * size.scale)
    descriptor.maxPixelsHigh = UInt32(size.height * size.scale)
    descriptor.sizeInMillimeters = CGSize(width: Double(size.width) / 110 * 25.4, height: Double(size.height) / 110 * 25.4)
    serial += 1
    descriptor.vendorID = FusionProtocol.virtualDisplayVendor
    descriptor.productID = product
    descriptor.serialNum = 200 + serial
    descriptor.terminationHandler = { _, _ in log("the matched display was ended by the system") }
    guard let display = CGVirtualDisplay(descriptor: descriptor) else {
      log("the viewer's resolution is not matched: no virtual display could be made")
      return ready(nil)
    }
    let settings = CGVirtualDisplaySettings()
    settings.hiDPI = size.scale > 1 ? 1 : 0
    settings.modes = [CGVirtualDisplayMode(width: UInt32(size.width), height: UInt32(size.height), refreshRate: min(max(hz, 60), 120))]
    guard display.apply(settings) else {
      log("the viewer's resolution is not matched: the display refused \(size.width)×\(size.height)")
      return ready(nil)
    }
    let match = ScreenMatch(physical: physical, size: size, display: display, log: log)
    current = match
    // Not answered before the display has left the list: until then the watched display, on a Mac
    // with no screen, has not come back, and a capture of the one that was there finds nothing.
    let failed = {
      match.end()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { ready(nil) }
    }
    let settled = {
      // The window server finishes laying the desktop out before the capture looks for it.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { match.ended ? ready(nil) : ready(match) }
    }
    let gone = { !online().contains(physical) }
    // The display comes up a moment after it is made; mirroring one that is not there fails.
    match.wait(until: { online().contains(display.displayID) }, tries: 30) { up in
      guard up, !match.ended else { return failed() }
      // With no screen attached, the display being watched was the system's stand-in, and it goes
      // once there is another: a moment is given for that before mirroring is tried.
      match.wait(until: gone, tries: 3) { left in
        guard !match.ended else { return failed() }
        if left { return match.standAlone(settled) }
        guard match.mirror() else { return gone() ? match.standAlone(settled) : failed() }
        match.wait(until: { CGDisplayMirrorsDisplay(physical) == display.displayID || gone() }, tries: 30) { done in
          guard done, !match.ended else {
            if !match.ended { log("the viewer's resolution is not matched: display \(physical) did not start mirroring") }
            return failed()
          }
          if gone() { return match.standAlone(settled) }
          log("display \(physical) mirrors a \(size.width)×\(size.height) @\(size.scale)x display for the viewer")
          settled()
        }
      }
    }
  }

  private func standAlone(_ settled: () -> Void) {
    alone = true
    log("this Mac has no screen of its own: its desktop is a \(size.width)×\(size.height) @\(size.scale)x display for the viewer")
    settled()
  }

  private func wait(until done: @escaping () -> Bool, tries: Int, then: @escaping (Bool) -> Void) {
    if done() { return then(true) }
    guard tries > 0, !ended else { return then(false) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
      guard let self else { return then(false) }
      self.wait(until: done, tries: tries - 1, then: then)
    }
  }

  private func mirror() -> Bool {
    let origin = CGDisplayBounds(physical).origin
    var config: CGDisplayConfigRef?
    guard CGBeginDisplayConfiguration(&config) == .success else { return false }
    // In the watched display's place, so the other displays stay where they are around it.
    CGConfigureDisplayOrigin(config, displayID, Int32(origin.x.rounded()), Int32(origin.y.rounded()))
    CGConfigureDisplayMirrorOfDisplay(config, physical, displayID)
    let done = CGCompleteDisplayConfiguration(config, .forAppOnly)
    if done != .success { log("the viewer's resolution is not matched: mirroring failed (\(done.rawValue))") }
    return done == .success
  }

  /// The watched display is itself again. Safe to call twice.
  func end() {
    guard !ended else { return }
    ended = true
    if ScreenMatch.current === self { ScreenMatch.current = nil }
    guard let display else { return }
    self.display = nil
    if alone { log("the viewer's display is gone") }
    else if CGDisplayMirrorsDisplay(physical) == display.displayID {
      var config: CGDisplayConfigRef?
      if CGBeginDisplayConfiguration(&config) == .success {
        CGConfigureDisplayMirrorOfDisplay(config, physical, kCGNullDirectDisplay)
        CGCompleteDisplayConfiguration(config, .forAppOnly)
      }
      log("display \(physical) is itself again")
    }
    // Released once the mirroring is undone: gone at once, the watched display would be left
    // mirroring nothing for a moment.
    ScreenMatch.retiring.append(display)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      ScreenMatch.retiring.removeAll { $0 === display }
    }
  }
}
