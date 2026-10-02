import AppKit
import CryptoKit

/// The pointer's picture (arrow, I-beam, hand, …), for a viewer that draws the pointer itself.
struct PointerShape {
  /// The same picture has the same id, in every session.
  let id: String
  let png: Data
  /// In points, as it is on the Mac's display; the hot spot from the picture's top left.
  let width: Double
  let height: Double
  let hotX: Double
  let hotY: Double
  /// Pixels of the PNG to a point.
  let scale: Double

  /// A phone's display has two or three pixels to a point: twice is sharp there, and small.
  private static let renderScale = 2.0

  /// Pictures already made, by id: one is encoded once, however often the pointer wears it.
  private static var made: [String: PointerShape] = [:]

  /// What the pointer looks like now, whichever program set it; the arrow when the system
  /// won't say.
  static func current() -> PointerShape? {
    let cursor = (SystemCursor() as CurrentCursor).current() ?? NSCursor.arrow
    let image = cursor.image
    let size = image.size
    guard size.width >= 1, size.height >= 1, size.width <= 512, size.height <= 512 else { return nil }
    let pixelsWide = Int((size.width * renderScale).rounded())
    let pixelsHigh = Int((size.height * renderScale).rounded())
    guard let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: pixelsWide, pixelsHigh: pixelsHigh, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return nil }
    // Its size in points, said before the context is made: that is what makes a point two pixels in it.
    bitmap.size = size
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    // The image holds the picture at several sizes; drawing it takes the one that fits.
    image.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let pixels = bitmap.bitmapData else { return nil }

    var hash = SHA256()
    hash.update(bufferPointer: UnsafeRawBufferPointer(start: pixels, count: bitmap.bytesPerRow * pixelsHigh))
    for value in [size.width, size.height, cursor.hotSpot.x, cursor.hotSpot.y] {
      withUnsafeBytes(of: Double(value)) { hash.update(bufferPointer: $0) }
    }
    let id = hash.finalize().prefix(8).map { String(format: "%02x", $0) }.joined()
    if let known = made[id] { return known }
    guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
    let shape = PointerShape(id: id, png: png, width: size.width, height: size.height, hotX: cursor.hotSpot.x, hotY: cursor.hotSpot.y, scale: renderScale)
    made[id] = shape
    return shape
  }
}

/// `NSCursor.currentSystem` is the only public way to see the pointer another program set. It
/// has been marked deprecated since macOS 14 ("no longer supported") and still answers on
/// macOS 26; asked through a protocol, so that the one deprecated call doesn't warn at every build.
private protocol CurrentCursor {
  func current() -> NSCursor?
}

private struct SystemCursor: CurrentCursor {
  @available(*, deprecated)
  func current() -> NSCursor? {
    NSCursor.currentSystem
  }
}
