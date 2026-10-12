import Foundation
import WebRTC

/// H.264 and HEVC keep the decoded picture in a CVPixelBuffer backed by the system video
/// decoder. The receiver never converts it to I420/UIImage on the CPU to put it on the screen.
/// HEVC (`HEVCDecoder`) comes first where the hardware decodes it: the Mac then sends it, and
/// a Mac app from before it could keeps to H.264.
final class ScreenDecoderFactory: NSObject, RTCVideoDecoderFactory {
  let metrics: ScreenMetrics
  private let stock = RTCVideoDecoderFactoryH264()
  init(metrics: ScreenMetrics) { self.metrics = metrics }
  func supportedCodecs() -> [RTCVideoCodecInfo] { (HEVCDecoder.available ? [HEVCDecoder.codecInfo] : []) + stock.supportedCodecs() }
  func createDecoder(_ info: RTCVideoCodecInfo) -> RTCVideoDecoder? {
    let made: RTCVideoDecoder? = info.name == HEVCDecoder.codecInfo.name ? HEVCDecoder() : stock.createDecoder(info)
    guard let decoder = made else { return nil }
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
