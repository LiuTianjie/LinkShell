import CoreGraphics

/// Where the setup window goes once System Settings is open, so that both can be seen at once.
enum Beside {
  /// Left between the two windows, and between the window and the edge of the screen.
  static let gap: CGFloat = 16

  /// The origin for a window of `size` that keeps clear of `other`, on a screen whose usable
  /// part is `visible` (AppKit's coordinates: y goes up).
  ///
  /// Beside `other`, on the side with more room, its top level with `other`'s. Where neither
  /// side has room for it: against the edge of the screen farther from `other`'s middle, which
  /// covers the least of it. With no `other`: against the right edge, half-way up.
  static func origin(size: CGSize, other: CGRect?, visible: CGRect) -> CGPoint {
    let left = visible.minX + gap
    let right = visible.maxX - gap - size.width
    guard let other else {
      return CGPoint(x: max(right, visible.minX), y: visible.midY - size.height / 2)
    }
    let roomRight = visible.maxX - other.maxX
    let roomLeft = other.minX - visible.minX
    let needed = size.width + gap
    let x: CGFloat
    if max(roomRight, roomLeft) >= needed {
      x = roomRight >= roomLeft ? min(other.maxX + gap, visible.maxX - size.width) : max(other.minX - gap - size.width, visible.minX)
    } else {
      x = other.midX < visible.midX ? right : left
    }
    let y = min(max(other.maxY - size.height, visible.minY), visible.maxY - size.height)
    return CGPoint(x: max(x, visible.minX), y: y)
  }
}
