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
  private var starting = false
  private var stopping = false
  private var stoppingStream: SCStream?
  private var ended = false
  private var stopCompletions: [(String?) -> Void] = []
  private var timer: DispatchSourceTimer?
  private var last: CVPixelBuffer?
  private var lastSent: Int64 = 0
  private var lastNew: Int64 = 0
  private var counts = Counts()
  private var displayID: CGDirectDisplayID = 0
  private var windowID: CGWindowID = 0
  private var fusionGroupIDs: Set<CGWindowID> = []
  private var lastExcludedPIDs: Set<pid_t> = []
  private var initialRepeatsSent = 0
  private var fusionIdleOverlay = false
  private var filterTimer: DispatchSourceTimer?

  /// Fusion (experimental, `FusionRemote`): which windows go into the picture, re-asked every
  /// two seconds, and a note on each new picture (where the fused windows were in it). Both nil
  /// for ordinary screen sharing, which is then unchanged.
  static var fusionFilter: ((SCDisplay, SCShareableContent) -> SCContentFilter)?
  static var fusionAnnotate: ((CGDirectDisplayID, CVPixelBuffer, UInt64) -> Void)?
  /// Fusion: a note on each new picture of one window group on a virtual display (exact crop + local frame);
  /// returns `false` if the window is no longer on `displayID` so off-display empty buffers are dropped cleanly.
  static var fusionAnnotateWindow: ((CGWindowID, CGDirectDisplayID, CVPixelBuffer, UInt64) -> Bool)?

  private static let contentLock = NSLock()
  private static var cachedContent: (content: SCShareableContent, at: Double)?
  private static var contentWaiters: [(SCShareableContent?, Error?) -> Void] = []

  /// Single-flight `SCShareableContent` coalescer so concurrent streams and filter refreshes
  /// never pile up XPC requests inside macOS `replayd`.
  static func fetchShareableContent(maxAge: Double = 0.08, completion: @escaping (SCShareableContent?, Error?) -> Void) {
    let now = CACurrentMediaTime()
    contentLock.lock()
    if maxAge > 0, let cached = cachedContent, now - cached.at <= maxAge {
      let val = cached.content
      contentLock.unlock()
      completion(val, nil)
      return
    }
    let isFirst = contentWaiters.isEmpty
    contentWaiters.append(completion)
    contentLock.unlock()
    guard isFirst else { return }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
      contentLock.lock()
      if let content {
        cachedContent = (content, CACurrentMediaTime())
      }
      let waiters = contentWaiters
      contentWaiters.removeAll()
      contentLock.unlock()
      for w in waiters { w(content, error) }
    }
  }

  func start(display: Display, width: Int, height: Int, fps: Int, done: @escaping (String?) -> Void) {
    queue.async {
      guard !self.stopped else { return done("the capture was stopped") }
      self.fps = fps
      self.displayID = display.id
      self.starting = true
      Self.fetchShareableContent(maxAge: 0) { content, error in
        self.queue.async {
          guard !self.stopped else {
            self.starting = false
            self.finishStopping()
            return done("the capture was stopped")
          }
          guard let target = content?.displays.first(where: { $0.displayID == display.id }) else {
            self.starting = false
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

          // Everything on the display except local privacy-curtain overlays, this app's own clock strip included.
          let curtainIDs = ScreenPrivacy.shared.curtainWindowIDs()
          let excluded = curtainIDs.isEmpty ? [] : (content?.windows.filter { curtainIDs.contains($0.windowID) } ?? [])
          let filter = content.flatMap { content in Self.fusionFilter?(target, content) } ?? SCContentFilter(display: target, excludingWindows: excluded)
          let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
          do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
          } catch {
            self.starting = false
            return done(error.localizedDescription)
          }
          self.stream = stream
          stream.startCapture { error in
            self.queue.async {
              self.starting = false
              guard self.stream === stream else {
                self.finishStopping()
                return done(error?.localizedDescription ?? "the capture stopped while starting")
              }
              if let error {
                self.stream = nil
                self.finishStopping()
                return done(error.localizedDescription)
              }
              // Stopped while it was starting: it must not be left running.
              guard !self.stopped else {
                self.stopStream()
                return done("the capture was stopped")
              }
              self.configuration = configuration
              // The rate was changed while it was starting.
              if configuration.minimumFrameInterval != Self.interval(fps: self.fps) { self.update(done: { _ in }) }
              self.startRepeating()
              if Self.fusionFilter != nil { self.startFilterRefresh(display: target) }
              done(nil)
            }
          }
        }
      }
    }
  }

  /// Fusion: captures a root window AND its child/auxiliary windows (such as Electron traffic-light
  /// titlebar widgets, sheets, and popovers) on `display` at 1:1 coordinates and fixed display
  /// resolution (`excludingApplications: content.applications, exceptingWindows: group`, refreshed
  /// whenever apps launch), preserving native red/yellow/green traffic lights without macOS's
  /// per-window sharing pill while staying isolated from other apps and other root windows.
  func start(fusionDisplay display: Display, rootWindow id: CGWindowID, windowIDs: Set<CGWindowID>, width: Int, height: Int, fps: Int, done: @escaping (String?) -> Void) {
    queue.async {
      guard !self.stopped else { return done("the capture was stopped") }
      self.fps = fps
      self.displayID = display.id
      self.windowID = id
      self.fusionGroupIDs = windowIDs
      self.startFusionGroupStream(displayID: display.id, width: width, height: height, done: done)
    }
  }

  private func startFusionGroupStream(displayID: CGDirectDisplayID, width: Int, height: Int, done: @escaping (String?) -> Void) {
    starting = true
    Self.fetchShareableContent(maxAge: 0) { content, error in
      self.queue.async {
        guard !self.stopped else { self.starting = false; self.finishStopping(); return done("the capture was stopped") }
        guard let content, let target = content.displays.first(where: { $0.displayID == displayID }) else {
          self.starting = false
          return done(error?.localizedDescription ?? "display \(displayID) can't be captured")
        }
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = Self.interval(fps: self.fps)
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.queueDepth = Tuning.captureQueueDepth
        configuration.showsCursor = false
        configuration.scalesToFit = true
        if #available(macOS 14.0, *) { configuration.ignoreShadowsDisplay = true }
        if #available(macOS 14.2, *) { configuration.includeChildWindows = true }
        let group = content.windows.filter { self.fusionGroupIDs.contains($0.windowID) }
        self.lastExcludedPIDs = Set(content.applications.map(\.processID))
        let filter = SCContentFilter(display: target, excludingApplications: content.applications, exceptingWindows: group)
        if #available(macOS 14.2, *) { filter.includeMenuBar = false }
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        do { try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue) } catch {
          self.starting = false
          return done(error.localizedDescription)
        }
        self.stream = stream
        stream.startCapture { error in
          self.queue.async {
            self.starting = false
            guard self.stream === stream else { self.finishStopping(); return done(error?.localizedDescription ?? "the capture stopped while starting") }
            if let error { self.stream = nil; self.finishStopping(); return done(error.localizedDescription) }
            guard !self.stopped else { self.stopStream(); return done("the capture was stopped") }
            self.configuration = configuration
            if self.timer == nil { self.startRepeating() }
            done(nil)
          }
        }
      }
    }
  }

  /// Updates the captured window group in-place without restarting `SCStream` or `VTCompressionSession`.
  func updateFusionWindowGroup(_ windowIDs: Set<CGWindowID>) {
    queue.async {
      guard !self.stopped, windowIDs != self.fusionGroupIDs else { return }
      self.fusionGroupIDs = windowIDs
      let displayID = self.displayID
      guard displayID != 0, self.stream != nil else { return }
      Self.fetchShareableContent(maxAge: 0) { content, _ in
        self.queue.async {
          guard !self.stopped, let content, let stream = self.stream,
                let target = content.displays.first(where: { $0.displayID == displayID }) else { return }
          let group = content.windows.filter { self.fusionGroupIDs.contains($0.windowID) }
          self.lastExcludedPIDs = Set(content.applications.map(\.processID))
          let filter = SCContentFilter(display: target, excludingApplications: content.applications, exceptingWindows: group)
          if #available(macOS 14.2, *) { filter.includeMenuBar = false }
          stream.updateContentFilter(filter) { _ in }
        }
      }
    }
  }

  /// Refreshes `excludingApplications` immediately when a new app launches on the remote Mac so its
  /// windows never appear inside an existing window stream.
  func refreshFusionGroupApps() {
    queue.async {
      let displayID = self.displayID
      guard !self.stopped, displayID != 0, self.windowID != 0, self.stream != nil else { return }
      Self.fetchShareableContent(maxAge: 0.12) { content, _ in
        self.queue.async {
          guard !self.stopped, let content, let stream = self.stream,
                let target = content.displays.first(where: { $0.displayID == displayID }) else { return }
          let pids = Set(content.applications.map(\.processID))
          guard pids != self.lastExcludedPIDs else { return }
          self.lastExcludedPIDs = pids
          let group = content.windows.filter { self.fusionGroupIDs.contains($0.windowID) }
          let filter = SCContentFilter(display: target, excludingApplications: content.applications, exceptingWindows: group)
          if #available(macOS 14.2, *) { filter.includeMenuBar = false }
          stream.updateContentFilter(filter) { _ in }
        }
      }
    }
  }

  /// Moves a window-group capture to another virtual display (e.g. 1x ↔ 2x cross-screen drag) on the same WebRTC track.
  func switchFusionDisplay(display: Display, windowIDs: Set<CGWindowID>, width: Int, height: Int) {
    queue.async {
      guard !self.stopped else { return }
      self.fusionGroupIDs = windowIDs
      guard display.id != self.displayID else { return }
      self.displayID = display.id
      self.last = nil
      self.initialRepeatsSent = 0
      let previous = self.stream
      self.stream = nil
      self.configuration = nil
      previous?.stopCapture { _ in }
      self.startFusionGroupStream(displayID: display.id, width: width, height: height) { _ in }
    }
  }

  /// Prompts an immediate filter refresh on a display-overlay stream when popups appear or close.
  func refreshDisplayFilterNow(idle: Bool = false) {
    queue.async {
      self.fusionIdleOverlay = idle
      let displayID = self.displayID
      guard !self.stopped, displayID != 0, self.windowID == 0, Self.fusionFilter != nil else { return }
      Self.fetchShareableContent(maxAge: 0) { content, _ in
        self.queue.async {
          guard !self.stopped, let content, let stream = self.stream, let make = Self.fusionFilter,
                let target = content.displays.first(where: { $0.displayID == displayID }) else { return }
          stream.updateContentFilter(make(target, content)) { _ in }
        }
      }
    }
  }

  /// Another frame rate, with the capture running: no picture is missed for it. `done` hears
  /// why not, when the capture would not take it (it then goes on at the rate it had).
  func setRate(_ fps: Int, done: @escaping (String?) -> Void) {
    queue.async {
      guard !self.stopped else { return done("the capture was stopped") }
      self.fps = fps
      // Not started yet: the rate it starts with.
      guard self.stream != nil, self.configuration != nil else { return done(nil) }
      self.update(done: done)
    }
  }

  /// For good: a capturer is started once.
  func stop(done: @escaping (String?) -> Void = { _ in }) {
    queue.async {
      self.stopCompletions.append(done)
      self.stopped = true
      self.timer?.cancel()
      self.timer = nil
      self.filterTimer?.cancel()
      self.filterTimer = nil
      self.last = nil
      // A new display must wait for an in-flight start and its subsequent stop to finish.
      guard !self.starting else { return }
      self.stopStream()
    }
  }

  private func stopStream() {
    guard !stopping else { return }
    guard let stream else { return finishStopping() }
    self.stream = nil
    stopping = true
    stoppingStream = stream
    stream.stopCapture { error in
      self.queue.async {
        self.stopping = false
        self.stoppingStream = nil
        // didStopWithError can win the race with stopCapture's completion (display unplugged).
        let failure = self.ended ? nil : error
        // Keep ownership after a failed stop, so a later request can retry without overlap.
        if failure != nil { self.stream = stream }
        self.finishStopping(error: failure?.localizedDescription)
      }
    }
  }

  private func finishStopping(error: String? = nil) {
    guard stopped, !starting, !stopping, stream == nil || error != nil else { return }
    let completions = stopCompletions
    stopCompletions.removeAll()
    completions.forEach { $0(error) }
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
    guard type == .screen, self.stream === stream, !stopped, sampleBuffer.isValid else { return }
    let attachments = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
    let status = (attachments?[.status] as? Int).flatMap(SCFrameStatus.init(rawValue:))
    // Only a complete frame is a new picture; the rest say that nothing changed. The first one
    // goes out whatever it is called: a still screen may not give another.
    guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer), status == .complete || last == nil else { return }
    let presented = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let now = HostClock.nanoseconds()
    let stamp = presented.isNumeric ? Int64(CMTimeGetSeconds(presented) * 1e9) : now
    let nowMach = mach_absolute_time()
    let shown = (attachments?[.displayTime] as? UInt64) ?? nowMach
    if windowID != 0 {
      // Use the sample buffer's actual capture PTS (`CMClockConvertHostTimeToSystemUnits`) rather than
      // `SCStreamFrameInfo.displayTime` (which is +16..33ms in the future for target vsync scanout),
      // preventing pre-move pixel buffers from matching post-move window coordinates!
      var captureMach = nowMach
      if presented.isNumeric {
        let ptsMach = CMClockConvertHostTimeToSystemUnits(presented)
        if ptsMach > 0, ptsMach <= nowMach &+ 2_400_000 { captureMach = ptsMach }
      }
      if Self.fusionAnnotateWindow?(windowID, displayID, buffer, captureMach) == false {
        return
      }
    } else {
      Self.fusionAnnotate?(displayID, buffer, shown)
    }
    last = buffer
    lastNew = now
    counts.captured += 1
    FrameTrace.mark("captured")
    send(buffer, at: stamp, now: now)
    if let onPicture {
      let displayed = (attachments?[.displayTime] as? UInt64).map { HostClock.seconds(mach: $0) } ?? Double(stamp) / 1e9
      onPicture(buffer, displayed)
    }
  }

  // MARK: SCStreamDelegate

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    queue.async {
      guard self.stream === stream || self.stoppingStream === stream else { return }
      self.ended = true
      self.stream = nil
      self.timer?.cancel()
      self.timer = nil
      if !self.stopped { self.onStop?(error.localizedDescription) }
      self.finishStopping()
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

  /// Fused apps come and go: the filter follows them without restarting the stream.
  private func startFilterRefresh(display: SCDisplay) {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler { [weak self] in
      guard let self, !self.stopped, !self.fusionIdleOverlay else { return }
      Self.fetchShareableContent(maxAge: 0.25) { content, _ in
        guard let content, let make = Self.fusionFilter else { return }
        self.queue.async {
          guard let stream = self.stream, !self.stopped,
                let target = content.displays.first(where: { $0.displayID == display.displayID }) else { return }
          stream.updateContentFilter(make(target, content)) { _ in }
        }
      }
    }
    timer.resume()
    filterTimer = timer
  }

  private func startRepeating() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    let step = Tuning.settleRepeatInterval / 2
    timer.schedule(deadline: .now() + step, repeating: step, leeway: .milliseconds(5))
    timer.setEventHandler { [weak self] in
      guard let self, let last = self.last else { return }
      let now = HostClock.nanoseconds()
      let interval: Double
      if self.fusionIdleOverlay {
        // Send only the first 2 frames so WebRTC `receivedPicture` turns true immediately, then
        // stay completely silent until a popup menu opens so idle overlay streams cost 0% GPU/encoder!
        guard self.initialRepeatsSent < 2 else { return }
        interval = Tuning.settleRepeatInterval
      } else {
        let settling = Double(now - self.lastNew) / 1e9 < Tuning.settleWindow
        interval = settling ? Tuning.settleRepeatInterval : Tuning.idleRepeatInterval
      }
      guard Double(now - self.lastSent) / 1e9 >= interval else { return }
      self.initialRepeatsSent &+= 1
      // Per-window buffers (`windowID != 0`) keep the exact `FusionMetadata` attached when `last`
      // was captured so repeating a still frame never mixes old pixels with newer window coordinates!
      if self.windowID == 0 {
        let shown = mach_absolute_time()
        Self.fusionAnnotate?(self.displayID, last, shown)
      }
      self.counts.repeated += 1
      self.send(last, at: now, now: now)
    }
    timer.resume()
    self.timer = timer
  }
}
