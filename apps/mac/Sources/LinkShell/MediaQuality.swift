import CoreVideo
import Foundation

/// Optional, sampled luma comparison for laboratory runs. Copies a small grid, never retains
/// capture surfaces. This detects corruption/large quality changes, not text legibility or
/// chroma fidelity; runs with CPU sampling are reported separately from latency-only runs.
struct MediaQuality {
  let width: Int
  let height: Int
  private let pixels: [UInt8]

  init?(_ buffer: CVPixelBuffer) {
    let format = CVPixelBufferGetPixelFormatType(buffer)
    guard format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
          CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
    width = CVPixelBufferGetWidth(buffer); height = CVPixelBufferGetHeight(buffer)
    let columns = min(256, width), rows = min(160, height)
    guard columns > 0, rows > 0 else { return nil }
    let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    let bytes = base.assumingMemoryBound(to: UInt8.self)
    let limited = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    var samples: [UInt8] = []; samples.reserveCapacity(columns * rows)
    for row in 0..<rows {
      let y = (row * 2 + 1) * height / (rows * 2)
      for column in 0..<columns {
        let x = (column * 2 + 1) * width / (columns * 2)
        let value = Double(bytes[y * stride + x])
        samples.append(UInt8((limited ? min(255, max(0, (value - 16) * 255 / 219)) : value).rounded()))
      }
    }
    pixels = samples
  }

  struct Difference {
    let psnr: Double
    let largeErrors: Double
  }

  func compare(_ other: MediaQuality) -> Difference? {
    guard width == other.width, height == other.height, pixels.count == other.pixels.count else { return nil }
    var squared = 0.0, errors = 0
    for index in pixels.indices {
      let difference = Double(pixels[index]) - Double(other.pixels[index])
      squared += difference * difference
      if abs(difference) > 32 { errors += 1 }
    }
    let mse = squared / Double(pixels.count)
    return Difference(psnr: mse > 0 ? 10 * log10(255 * 255 / mse) : 99,
      largeErrors: Double(errors) / Double(pixels.count) * 100)
  }

  static func report(_ samples: [Difference]) -> [String: Any] {
    guard !samples.isEmpty else { return ["n": 0] }
    return ["n": samples.count, "meanLumaPSNRdB": samples.map(\.psnr).reduce(0, +) / Double(samples.count),
      "minimumLumaPSNRdB": samples.map(\.psnr).min()!,
      "largeLumaErrorPercent": samples.map(\.largeErrors).reduce(0, +) / Double(samples.count)]
  }
}
