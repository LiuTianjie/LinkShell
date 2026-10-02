import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// A display's pictures for the stream down the host's socket (`StreamSession`): ScreenCaptureKit's
/// frames as they are (NV12 on an IOSurface, which the hardware encoder takes without a copy),
/// with the pointer in them — the page that shows this stream draws none of its own. The size
/// and the rate can be changed while it runs.
final class StreamCapture: NSObject, SCStreamOutput, SCStreamDelegate {
  /// Each new picture, on the queue given.
  var onPicture: ((CVPixelBuffer) -> Void)?
  /// The capture ended by itself (the display went, the permission was taken away).
  var onStop: ((String) -> Void)?

  private let queue: DispatchQueue
  private var stream: SCStream?
  private var stopped = false
  private var delivered = false

  /// Everything is called, and calls back, on `queue`.
  init(queue: DispatchQueue) {
    self.queue = queue
  }

  func start(display: Display, width: Int, height: Int, fps: Int, done: @escaping (String?) -> Void) {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
      self?.queue.async {
        guard let self, !self.stopped else { return }
        guard let target = content?.displays.first(where: { $0.displayID == display.id }) else {
          return done(error?.localizedDescription ?? "display \(display.id) can't be captured")
        }
        // Everything on the display, this app's own windows included (the clock strip is one).
        let filter = SCContentFilter(display: target, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: StreamCapture.configuration(width: width, height: height, fps: fps), delegate: self)
        do {
          try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
        } catch {
          return done(error.localizedDescription)
        }
        stream.startCapture { error in
          self.queue.async {
            if let error { return done(error.localizedDescription) }
            // Stopped while it was starting: it must not be left running.
            guard !self.stopped else { return stream.stopCapture { _ in } }
            self.stream = stream
            done(nil)
          }
        }
      }
    }
  }

  /// Another size or rate, without the capture stopping: the pictures already on their way
  /// still come at the old size.
  func update(width: Int, height: Int, fps: Int, failed: @escaping (String) -> Void) {
    stream?.updateConfiguration(StreamCapture.configuration(width: width, height: height, fps: fps)) { [queue] error in
      if let error { queue.async { failed(error.localizedDescription) } }
    }
  }

  /// For good: a capture is started once.
  func stop() {
    stopped = true
    guard let stream else { return }
    self.stream = nil
    stream.stopCapture { _ in }
  }

  private static func configuration(width: Int, height: Int, fps: Int) -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    // A little more than the rate (see `Tuning.captureRateSlack`); what is too many is dropped
    // before the encoder.
    configuration.minimumFrameInterval = CMTime(value: 1000, timescale: CMTimeScale(Double(fps) * 1000 * Tuning.captureRateSlack))
    configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    configuration.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
    configuration.colorSpaceName = CGColorSpace.sRGB
    configuration.queueDepth = Tuning.captureQueueDepth
    configuration.showsCursor = true
    configuration.scalesToFit = true
    return configuration
  }

  // MARK: SCStreamOutput

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !stopped, sampleBuffer.isValid, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let attachments = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
    let status = (attachments?[.status] as? Int).flatMap(SCFrameStatus.init(rawValue:))
    // Only a complete frame is a new picture; the rest say that nothing changed. The first one
    // is taken whatever it is called: a still screen may not give another.
    guard status == .complete || !delivered else { return }
    delivered = true
    onPicture?(buffer)
  }

  // MARK: SCStreamDelegate

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    queue.async {
      guard self.stream === stream else { return }
      self.stream = nil
      self.onStop?(error.localizedDescription)
    }
  }
}
