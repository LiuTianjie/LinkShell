import CoreVideo
import Foundation
import IOSurface

/// Retains the decoder's surface until both the mailbox and the GPU are done with it.
/// For cross-process frames, releasing this object acknowledges that the decoder may reuse it.
public final class DesktopScreenFrame {
  public let buffer: CVPixelBuffer
  public let width: Int
  public let height: Int
  public let rotation: Int
  public let cropX: Int
  public let cropY: Int
  public let cropWidth: Int
  public let cropHeight: Int
  private let release: () -> Void

  public init(buffer: CVPixelBuffer, width: Int, height: Int, rotation: Int, crop: CGRect, release: @escaping () -> Void = {}) {
    self.buffer = buffer; self.width = width; self.height = height; self.rotation = rotation
    cropX = Int(crop.minX); cropY = Int(crop.minY); cropWidth = Int(crop.width); cropHeight = Int(crop.height)
    self.release = release
  }
  deinit { release() }

  public var metadata: Data {
    // These are decoder dimensions, never pixels or an encoded frame.
    try! JSONSerialization.data(withJSONObject: ["width": width, "height": height, "rotation": rotation,
      "x": cropX, "y": cropY, "w": cropWidth, "h": cropHeight,
      "matrix": (CVBufferCopyAttachment(buffer, kCVImageBufferYCbCrMatrixKey, nil) as? String) ?? ""])
  }

  public static func importSurface(_ surface: IOSurface, metadata: Data, release: @escaping () -> Void) -> DesktopScreenFrame? {
    guard metadata.count < 1024, let values = try? JSONSerialization.jsonObject(with: metadata) as? [String: Any],
          let width = DesktopScreenBridge.integer(values["width"]), let height = DesktopScreenBridge.integer(values["height"]),
          let rotation = DesktopScreenBridge.integer(values["rotation"]), [0, 90, 180, 270].contains(rotation),
          let x = DesktopScreenBridge.integer(values["x"]), let y = DesktopScreenBridge.integer(values["y"]),
          let w = DesktopScreenBridge.integer(values["w"]), let h = DesktopScreenBridge.integer(values["h"]),
          (1...8192).contains(width), (1...8192).contains(height), x >= 0, y >= 0, w > 0, h > 0,
          surface.width <= 8192, surface.height <= 8192, x + w <= surface.width, y + h <= surface.height,
          [kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange].contains(surface.pixelFormat)
    else { return nil }
    var imported: Unmanaged<CVPixelBuffer>?
    let result = CVPixelBufferCreateWithIOSurface(nil, surface, [kCVPixelBufferMetalCompatibilityKey: true] as CFDictionary, &imported)
    guard result == kCVReturnSuccess, let buffer = imported?.takeRetainedValue() else { return nil }
    if let matrix = values["matrix"] as? String,
       [kCVImageBufferYCbCrMatrix_ITU_R_601_4 as String, kCVImageBufferYCbCrMatrix_ITU_R_709_2 as String, kCVImageBufferYCbCrMatrix_ITU_R_2020 as String].contains(matrix) {
      CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, matrix as CFString, .shouldPropagate)
    }
    return DesktopScreenFrame(buffer: buffer, width: width, height: height, rotation: rotation,
      crop: CGRect(x: x, y: y, width: w, height: h), release: release)
  }
}
