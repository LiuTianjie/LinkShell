import AppKit
import CoreFoundation
import Foundation
import QuartzCore

public struct DesktopScreenHole: Equatable {
  public let rect: CGRect
  public let radius: CGFloat

  public init(rect: CGRect, radius: CGFloat = 10) {
    self.rect = rect
    self.radius = max(0, min(radius, 512))
  }
}

public enum DesktopScreenBridge {
  public static func identifier(_ value: Any?) -> String? {
    guard let value = value as? String, value.utf8.count == 36, UUID(uuidString: value) != nil else { return nil }
    return value
  }
  public static func validMessage(_ value: [String: Any]) -> Bool {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return false }
    return data.count <= 262_144
  }
  public static func rect(_ value: Any?) -> CGRect? {
    guard let value = value as? [String: Any], let x = number(value["x"]), let y = number(value["y"]),
          let width = number(value["width"]), let height = number(value["height"]),
          abs(x) <= 16_384, abs(y) <= 16_384, (0...16_384).contains(width), (0...16_384).contains(height) else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
  }
  public static func holes(_ value: Any?) -> [DesktopScreenHole]? {
    guard let list = value as? [Any] else { return nil }
    return list.prefix(64).compactMap { item in
      guard let dict = item as? [String: Any], let rect = rect(dict), rect.width > 0, rect.height > 0 else { return nil }
      let radius = number(dict["radius"]).map { CGFloat($0) } ?? 10
      return DesktopScreenHole(rect: rect, radius: radius)
    }
  }
  public static func integer(_ value: Any?) -> Int? {
    guard let number = number(value), number.rounded() == number, abs(number) <= 9_007_199_254_740_991 else { return nil }
    return Int(number)
  }
  public static func boolean(_ value: Any?) -> Bool? {
    guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return value.boolValue
  }
  private static func number(_ value: Any?) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
    return value.doubleValue
  }
}

/// Clips `DesktopScreenSurface` inside Electron's content view while punching rounded transparent
/// cutouts (`CAShapeLayer` even-odd mask) and passing pointer events through to Chromium whenever
/// HTML Top-Layer popovers or dialogs are open.
public final class DesktopScreenClipView: NSView {
  public override var isFlipped: Bool { true }

  public var overlayOpen = false
  public private(set) var holesInBounds: [DesktopScreenHole] = []

  public override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true
  }

  public required init?(coder: NSCoder) { nil }

  public func applyCutouts(_ holes: [DesktopScreenHole], in host: NSView) {
    guard bounds.width > 0, bounds.height > 0, !holes.isEmpty else {
      holesInBounds = []
      layer?.mask = nil
      return
    }
    var mapped: [DesktopScreenHole] = []
    mapped.reserveCapacity(holes.count)
    for hole in holes {
      let inHost = CGRect(
        x: hole.rect.minX,
        y: host.isFlipped ? hole.rect.minY : host.bounds.height - hole.rect.maxY,
        width: hole.rect.width,
        height: hole.rect.height
      )
      let local = convert(inHost, from: host).intersection(bounds)
      guard !local.isNull, !local.isEmpty, local.width > 0.5, local.height > 0.5 else { continue }
      let radius = min(hole.radius, min(local.width, local.height) / 2)
      mapped.append(DesktopScreenHole(rect: local, radius: radius))
    }
    holesInBounds = mapped
    guard !mapped.isEmpty else {
      layer?.mask = nil
      return
    }
    let path = CGMutablePath()
    path.addRect(bounds)
    for hole in mapped {
      if hole.radius > 0 {
        path.addRoundedRect(in: hole.rect, cornerWidth: hole.radius, cornerHeight: hole.radius)
      } else {
        path.addRect(hole.rect)
      }
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let mask = (layer?.mask as? CAShapeLayer) ?? CAShapeLayer()
    mask.frame = bounds
    mask.fillRule = .evenOdd
    mask.fillColor = NSColor.white.cgColor
    mask.path = path
    if layer?.mask !== mask {
      layer?.mask = mask
    }
    CATransaction.commit()
  }

  public override func hitTest(_ point: NSPoint) -> NSView? {
    guard !isHidden, alphaValue > 0.01 else { return nil }
    let local = superview != nil ? convert(point, from: superview) : point
    guard bounds.contains(local) else { return nil }
    // Native fullscreen chrome (exit bar / top handle) stays clickable above the stage.
    for subview in subviews.reversed() where !(subview is DesktopScreenSurface) && !subview.isHidden && subview.alphaValue > 0.01 {
      if let hit = subview.hitTest(local) {
        return hit
      }
    }
    if overlayOpen || holesInBounds.contains(where: { $0.rect.contains(local) }) {
      return nil
    }
    return super.hitTest(point)
  }
}
