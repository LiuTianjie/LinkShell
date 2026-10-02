import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import WebRTC

/// The screen as a libwebrtc video capturer: ScreenCaptureKit's frames, as they are (NV12 on an
/// IOSurface, so the hardware encoder takes them without a copy), stamped with the time they
/// were on the display.
final class ScreenCapturer: RTCVideoCapturer, SCStreamOutput, SCStreamDelegate {
  struct Counts {
    /// New pictures from the screen.
    var captured = 0
    /// The last picture, sent again because the screen was still.
    var repeated = 0
    /// The longest libwebrtc went without a picture, new or repeated, in seconds.
    var gap = 0.0
  }

  /// The stream ended by itself (the display went, the permission was taken away).
  var onStop: ((String) -> Void)?
  /// Each new picture and the host time it was displayed, on the capture queue.
  var onPicture: ((CVPixelBuffer, Double) -> Void)?

  private let queue = DispatchQueue(label: "com.bd.linkshell.capture", qos: .userInteractive)
  private var stream: SCStream?
  private var configuration: SCStreamConfiguration?
  private var fps = 0
  private var stopped = false
  private var timer: DispatchSourceTimer?
  private var last: CVPixelBuffer?
  private var lastSent: Int64 = 0
  private var lastNew: Int64 = 0
  private var counts = Counts()

  func start(display: Display, width: Int, height: Int, fps: Int, done: @escaping (String?) -> Void) {
    queue.async { self.fps = fps }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
      self?.queue.async {
        guard let self, !self.stopped else { return }
        guard let target = content?.displays.first(where: { $0.displayID == display.id }) else {
          return done(error?.localizedDescription ?? "display \(display.id) can't be captured")
        }
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = Self.interval(fps: self.fps)
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.queueDepth = Tuning.captureQueueDepth
        // The pointer goes to the viewer by itself (the `cursor` channel) and is drawn there.
        configuration.showsCursor = false
        configuration.scalesToFit = true

        // Everything on the display, this app's own windows included (the clock strip is one).
        let filter = SCContentFilter(display: target, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
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
            self.configuration = configuration
            // The rate was changed while it was starting.
            if configuration.minimumFrameInterval != Self.interval(fps: self.fps) { self.update(done: { _ in }) }
            self.startRepeating()
            done(nil)
          }
        }
      }
    }
  }

  /// Another frame rate, with the capture running: no picture is missed for it. `done` hears
  /// why not, when the capture would not take it (it then goes on at the rate it had).
  func setRate(_ fps: Int, done: @escaping (String?) -> Void) {
    queue.async {
      self.fps = fps
      // Not started yet: the rate it starts with.
      guard self.stream != nil else { return done(nil) }
      self.update(done: done)
    }
  }

  /// For good: a capturer is started once.
  func stop() {
    queue.async {
      self.stopped = true
      self.timer?.cancel()
      self.timer = nil
      self.last = nil
      guard let stream = self.stream else { return }
      self.stream = nil
      stream.stopCapture { _ in }
    }
  }

  /// What happened since this was last asked.
  func takeCounts() -> Counts {
    queue.sync {
      defer { counts = Counts() }
      return counts
    }
  }

  // MARK: SCStreamOutput

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !stopped, sampleBuffer.isValid else { return }
    let attachments = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
    let status = (attachments?[.status] as? Int).flatMap(SCFrameStatus.init(rawValue:))
    // Only a complete frame is a new picture; the rest say that nothing changed. The first one
    // goes out whatever it is called: a still screen may not give another.
    guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer), status == .complete || last == nil else { return }
    let presented = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let now = HostClock.nanoseconds()
    let stamp = presented.isNumeric ? Int64(CMTimeGetSeconds(presented) * 1e9) : now
    last = buffer
    lastNew = now
    counts.captured += 1
    send(buffer, at: stamp, now: now)
    if let onPicture {
      let displayed = (attachments?[.displayTime] as? UInt64).map { HostClock.seconds(mach: $0) } ?? Double(stamp) / 1e9
      onPicture(buffer, displayed)
    }
  }

  // MARK: SCStreamDelegate

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    queue.async {
      guard self.stream === stream else { return }
      self.stream = nil
      self.timer?.cancel()
      self.timer = nil
      self.onStop?(error.localizedDescription)
    }
  }

  // MARK: Private

  private static func interval(fps: Int) -> CMTime {
    CMTime(value: 1000, timescale: CMTimeScale(Double(fps) * 1000 * Tuning.captureRateSlack))
  }

  private func update(done: @escaping (String?) -> Void) {
    guard let stream, let configuration else { return }
    configuration.minimumFrameInterval = Self.interval(fps: fps)
    stream.updateConfiguration(configuration) { error in done(error?.localizedDescription) }
  }

  private func send(_ buffer: CVPixelBuffer, at stamp: Int64, now: Int64) {
    if lastSent != 0 { counts.gap = max(counts.gap, Double(now - lastSent) / 1e9) }
    lastSent = now
    let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: buffer), rotation: ._0, timeStampNs: stamp)
    delegate?.capturer(self, didCapture: frame)
  }

  private func startRepeating() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    let step = Tuning.settleRepeatInterval / 2
    timer.schedule(deadline: .now() + step, repeating: step, leeway: .milliseconds(5))
    timer.setEventHandler { [weak self] in
      guard let self, let last = self.last else { return }
      let now = HostClock.nanoseconds()
      let settling = Double(now - self.lastNew) / 1e9 < Tuning.settleWindow
      let interval = settling ? Tuning.settleRepeatInterval : Tuning.idleRepeatInterval
      guard Double(now - self.lastSent) / 1e9 >= interval else { return }
      self.counts.repeated += 1
      self.send(last, at: now, now: now)
    }
    timer.resume()
    self.timer = timer
  }
}
