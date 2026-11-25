import AppKit
import CoreGraphics

/// One of this Mac's displays.
///
/// A `screen` number, wherever one is said (`open`, `rtc.open`, `stream.open`, `displays`, a
/// number on the command line), is a place in the system's list of active displays: 0 is the main
/// display (the one with the menu bar), whichever way the displays are arranged. Everything that
/// turns a number into a display does it here, so the picture and the pointer can't mean
/// different ones.
struct Display {
  let id: CGDirectDisplayID
  /// Where it is among the displays, in points, from the top left of the main one: the
  /// coordinates mouse events are posted in.
  let bounds: CGRect
  /// What it really has.
  let pixelWidth: Int
  let pixelHeight: Int

  init(id: CGDirectDisplayID) {
    self.id = id
    bounds = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    let pixels = Self.effectivePixelSize(
      bounds: bounds,
      modePixelWidth: mode?.pixelWidth,
      modePixelHeight: mode?.pixelHeight,
      rotation: CGDisplayRotation(id)
    )
    pixelWidth = pixels.width
    pixelHeight = pixels.height
  }

  init(id: CGDirectDisplayID, bounds: CGRect, pixelWidth: Int, pixelHeight: Int) {
    self.id = id
    self.bounds = bounds
    self.pixelWidth = max(pixelWidth, 1)
    self.pixelHeight = max(pixelHeight, 1)
  }

  /// Resolves effective pixel dimensions matching the active desktop orientation.
  /// `CGDisplayCopyDisplayMode` reports native unrotated panel dimensions on 90°/270° rotated
  /// displays, while `CGDisplayBounds` and ScreenCaptureKit operate in rotated coordinates.
  static func effectivePixelSize(
    bounds: CGRect,
    modePixelWidth: Int?,
    modePixelHeight: Int?,
    rotation: Double
  ) -> (width: Int, height: Int) {
    let fallbackWidth = max(1, Int(bounds.width.rounded()))
    let fallbackHeight = max(1, Int(bounds.height.rounded()))
    guard let rawWidth = modePixelWidth, let rawHeight = modePixelHeight, rawWidth > 0, rawHeight > 0 else {
      return (fallbackWidth, fallbackHeight)
    }
    guard rawWidth != rawHeight, bounds.width > 0, bounds.height > 0 else {
      return (rawWidth, rawHeight)
    }
    let normalizedRotation = ((Int(rotation.rounded()) % 360) + 360) % 360
    let isQuarterTurn = normalizedRotation == 90 || normalizedRotation == 270
    let boundsIsPortrait = bounds.height > bounds.width
    let modeIsPortrait = rawHeight > rawWidth
    guard boundsIsPortrait != modeIsPortrait else {
      return (rawWidth, rawHeight)
    }
    if isQuarterTurn {
      return (rawHeight, rawWidth)
    }
    let directSkew = abs((Double(rawWidth) / Double(bounds.width)) - (Double(rawHeight) / Double(bounds.height)))
    let swappedSkew = abs((Double(rawHeight) / Double(bounds.width)) - (Double(rawWidth) / Double(bounds.height)))
    return swappedSkew < directSkew ? (rawHeight, rawWidth) : (rawWidth, rawHeight)
  }

  static var main: Display { Display(id: CGMainDisplayID()) }

  /// In `screen` order.
  static var all: [Display] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    // A display made to match a viewer's resolution (`ScreenMatch`) stands in for the one that
    // mirrors it: the list, and every `screen` number, stays what it was before the viewer came.
    var seen = Set<CGDirectDisplayID>()
    return ids.prefix(Int(count)).compactMap { id -> CGDirectDisplayID? in
      ScreenMatch.isMatch(id) ? ScreenMatch.watched(by: id) : id
    }.filter { seen.insert($0).inserted }.map(Display.init(id:))
  }

  static func at(_ screen: Int) -> Display? {
    let displays = all
    return screen >= 0 && screen < displays.count ? displays[screen] : nil
  }

  var screen: NSScreen? {
    NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }
  }

  /// Pixels to a point.
  var scale: Double {
    bounds.width > 0 ? Double(pixelWidth) / Double(bounds.width) : 1
  }

  /// The picture sent for it: no wider than asked, never larger than the display, the same
  /// shape, and even both ways (4:2:0).
  func pictureSize(maxWidth: Int) -> (width: Int, height: Int) {
    guard pixelWidth > 0, pixelHeight > 0 else { return (2, 2) }
    let width = max(min(maxWidth, pixelWidth), 2) & ~1
    let height = Int((Double(width) * Double(pixelHeight) / Double(pixelWidth) / 2).rounded()) * 2
    return (width, max(height, 2))
  }

  /// The answer to `displays`: `w` and `h` in pixels, `name` as System Settings shows it.
  static func list() -> [[String: Any]] {
    let main = CGMainDisplayID()
    return all.enumerated().map { screen, display in
      [
        "screen": screen,
        "id": Int(display.id),
        "name": display.screen?.localizedName ?? "",
        "w": display.pixelWidth,
        "h": display.pixelHeight,
        "scale": display.scale,
        "main": display.id == main,
      ]
    }
  }
}
