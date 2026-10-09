import Foundation
import WebRTC

/// H.264 keeps the decoded picture in a CVPixelBuffer backed by the system video decoder.
/// The receiver never converts it to I420/UIImage on the CPU to put it on the screen.
final class ScreenDecoderFactory: NSObject, RTCVideoDecoderFactory {
  let metrics: ScreenMetrics
  private let stock = RTCVideoDecoderFactoryH264()
  init(metrics: ScreenMetrics) { self.metrics = metrics }
  func supportedCodecs() -> [RTCVideoCodecInfo] { stock.supportedCodecs() }
  func createDecoder(_ info: RTCVideoCodecInfo) -> RTCVideoDecoder? {
    guard let decoder = stock.createDecoder(info) else { return nil }
    return metrics.enabled ? ScreenDecoder(decoder, metrics: metrics) : decoder
  }
}

private final class ScreenDecoder: NSObject, RTCVideoDecoder {
  let decoder: RTCVideoDecoder
  let metrics: ScreenMetrics
  init(_ decoder: RTCVideoDecoder, metrics: ScreenMetrics) { self.decoder = decoder; self.metrics = metrics }
  func setCallback(_ callback: @escaping RTCVideoDecoderCallback) {
    decoder.setCallback { [metrics] frame in
      metrics.decoded(UInt32(bitPattern: frame.timeStamp))
      callback(frame)
    }
  }
  func startDecode(withNumberOfCores cores: Int32) -> Int { decoder.startDecode(withNumberOfCores: cores) }
  func release() -> Int { decoder.release() }
  func decode(_ image: RTCEncodedImage, missingFrames: Bool, codecSpecificInfo info: RTCCodecSpecificInfo?, renderTimeMs: Int64) -> Int {
    metrics.decoding(image.timeStamp)
    return decoder.decode(image, missingFrames: missingFrames, codecSpecificInfo: info, renderTimeMs: renderTimeMs)
  }
  func implementationName() -> String { decoder.implementationName() }
}
