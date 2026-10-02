import AppKit
import CoreMedia
import CoreVideo
import Darwin
import Foundation

/// What the host asks for (`stream.open`), and may change while it runs (`stream.set`).
struct StreamRequest {
  let viewer: String
  /// Which display (see `Display`).
  let screen: Int
  /// The host's socket the frames are written to.
  let socket: String
  /// The widest the picture may be; it is never wider than the display.
  var width = Tuning.defaultMaxWidth
  var fps = Tuning.defaultFps
  /// Bits a second, on average.
  var bitrate = Tuning.startBitrate
  /// Bits in any one second, at most.
  var ceiling: Int?
  /// Seconds: a key frame at least this often.
  let gop: Double
  /// Nil: the encoder's choice (`VideoCompressor.Setup.profile`).
  let profile: VideoCompressor.Profile?

  /// Nil for a message that names no socket.
  init?(viewer: String, _ message: [String: Any]) {
    guard let socket = message["socket"] as? String else { return nil }
    self.viewer = viewer
    self.socket = socket
    screen = (message["screen"] as? Int) ?? 0
    gop = max((message["gop"] as? NSNumber)?.doubleValue ?? 1, Tuning.streamShortestGop)
    profile = (message["profile"] as? String).flatMap(VideoCompressor.Profile.init(rawValue:))
    _ = change(message)
  }

  /// Takes what a message says of the size and the rates; true when something is now different.
  mutating func change(_ message: [String: Any]) -> Bool {
    func number(_ key: String) -> Int? { (message[key] as? NSNumber)?.intValue }
    let before = (width, fps, bitrate, ceiling)
    if let width = number("width") { self.width = max(width, Tuning.narrowestPicture) }
    if let fps = number("fps") { self.fps = min(max(fps, Tuning.fpsRange.lowerBound), Tuning.fpsRange.upperBound) }
    if let bitrate = number("bitrate") { self.bitrate = max(bitrate, Tuning.streamLowestBitrate) }
    if let ceiling = number("ceiling") { self.ceiling = ceiling }
    if let ceiling, ceiling < bitrate { self.ceiling = bitrate }
    return before != (width, fps, bitrate, ceiling)
  }
}

/// The screen for a viewer the video track can't reach: captured with the pointer in it, encoded
/// here (`VideoCompressor`), and written to a socket of the host's a frame at a time. The host
/// sends the frames on down a path that delivers everything in order, and the viewer's page
/// decodes them (WebCodecs).
///
/// A record, for each frame:
///
///   4 bytes   how long the frame is, big-endian
///   1 byte    flags: bit 0, a key frame
///   1 byte    generation: one more (wrapping) each time the size of the picture changes
///   the frame: one access unit in Annex B. No access unit delimiter: a record is a frame.
///
/// A key frame carries its parameter sets, and is where a decoder can begin; the first frame of
/// a generation is one, and a decoder has to begin again there.
///
/// The frames are the stream's rate and no more: a picture that comes too soon after the last
/// waits for its turn and is sent then, unless a newer one has come. While the screen is still,
/// nothing is captured and next to nothing is sent — the last picture again while it can still
/// be made sharper, and a key frame every `gop` seconds for a viewer that has to begin again.
///
/// Its own queue does everything but the windows (the clock strip), which are the main queue's.
final class StreamSession {
  let viewer: String

  private var request: StreamRequest
  private let options: ScreenSession.Options
  private let link: Link
  private let over: (StreamSession) -> Void
  private let queue = DispatchQueue(label: "com.bd.linkshell.stream", qos: .userInteractive)

  private var display = Display.main
  private var capture: StreamCapture?
  private var pipe: RecordPipe?
  private var compressor: VideoCompressor?
  private var generation: UInt8 = 0
  /// The host has been told of this generation (`stream.started`).
  private var announced = false
  private var failures = 0
  private var timer: DispatchSourceTimer?
  private var statsTimer: DispatchSourceTimer?
  private var closed = false
  /// The display is kept on, and was woken, for as long as this stream is sent.
  private var awake: Awake?
  private var strip: ClockStrip?
  private var motion: MotionWindow?

  /// The last picture captured, and whether it has yet to be sent.
  private var latest: CVPixelBuffer?
  private var fresh = false
  /// When the next frame may go, on the host clock (nanoseconds).
  private var nextDue: Int64 = 0
  private var lastKey: Int64 = 0
  private var keyWanted = true
  private var changedSinceKey = true
  /// A still screen's key frame may be made sharper than the encoder would make it. Not once
  /// the encoder has dropped one made so (at a low rate it won't spend that much on a frame):
  /// then its own choice stands, until the rates or the size change.
  private var sharpKeys = true
  /// Until when the last picture is sent again, to be made sharper.
  private var refineUntil: Int64 = 0
  /// Frames the encoder has and hasn't given back.
  private var inFlight = 0

  private var counts = Counts()

  private struct Counts {
    var captured = 0
    var frames = 0
    var keyFrames = 0
    var dropped = 0
    var bytes = 0
    var encodeTime: Int64 = 0
    var quantizers = 0
    var quantized = 0
  }

  /// `over`: on the main queue, when the stream has ended by itself.
  init(request: StreamRequest, options: ScreenSession.Options, link: Link, over: @escaping (StreamSession) -> Void) {
    self.request = request
    self.options = options
    self.link = link
    self.over = over
    viewer = request.viewer
  }

  // MARK: Life (from the main queue)

  func start() {
    // Asking ScreenCaptureKit without the permission makes the system ask the user: don't.
    guard Permissions.recording() else { return refuse(Permissions.notRecording) }
    guard let display = Display.at(request.screen) else { return refuse("there is no display \(request.screen)") }
    guard let pipe = RecordPipe(path: request.socket) else { return refuse("the host's socket could not be reached") }
    awake = Awake()
    if options.clock, let screen = display.screen {
      strip = ClockStrip(screen: screen)
      strip?.show()
    }
    if options.motion, let screen = display.screen {
      motion = MotionWindow(screen: screen)
      motion?.show()
    }
    queue.async { self.begin(display, pipe) }
  }

  func set(_ message: [String: Any]) {
    queue.async { self.change(message) }
  }

  /// The next frame is a key frame, and it goes now: on a still screen there is no other.
  func key() {
    queue.async {
      self.keyWanted = true
      self.tick()
    }
  }

  func close() {
    queue.async { self.shut() }
  }

  private func refuse(_ reason: String) {
    link.emit(["t": "stream.ended", "v": viewer, "error": reason])
    over(self)
  }

  // MARK: On the stream's queue

  private func begin(_ display: Display, _ pipe: RecordPipe) {
    self.display = display
    self.pipe = pipe
    pipe.onBroken = { [weak self] in self?.queue.async { self?.end("the host's socket closed") } }
    let size = display.pictureSize(maxWidth: request.width)
    let capture = StreamCapture(queue: queue)
    self.capture = capture
    capture.onPicture = { [weak self] buffer in self?.captured(buffer) }
    capture.onStop = { [weak self] reason in self?.end("the capture stopped: \(reason)") }
    capture.start(display: display, width: size.width, height: size.height, fps: request.fps) { [weak self] error in
      if let error { self?.end("the screen could not be captured: \(error)") }
    }
    // The first encoder of a process takes a quarter of a second to make: made while the capture starts.
    _ = encoder()
    guard !closed else { return }

    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.schedule(deadline: .distantFuture)
    timer.resume()
    self.timer = timer

    let statsTimer = DispatchSource.makeTimerSource(queue: queue)
    statsTimer.schedule(deadline: .now() + Tuning.statsInterval, repeating: Tuning.statsInterval)
    statsTimer.setEventHandler { [weak self] in self?.reportStats() }
    statsTimer.resume()
    self.statsTimer = statsTimer
  }

  /// Ended, and not because the host said so.
  private func end(_ reason: String) {
    guard !closed else { return }
    link.emit(["t": "stream.ended", "v": viewer, "error": reason])
    shut()
    DispatchQueue.main.async { self.over(self) }
  }

  private func shut() {
    guard !closed else { return }
    closed = true
    awake = nil
    timer?.cancel()
    statsTimer?.cancel()
    capture?.onPicture = nil
    capture?.onStop = nil
    capture?.stop()
    compressor = nil
    latest = nil
    pipe?.close()
    DispatchQueue.main.async {
      self.strip?.hide()
      self.motion?.hide()
    }
  }

  private func change(_ message: [String: Any]) {
    let before = request
    guard !closed, request.change(message) else { return }
    sharpKeys = true
    compressor?.setRates(bitrate: request.bitrate, ceiling: request.ceiling, fps: request.fps)
    let size = display.pictureSize(maxWidth: request.width)
    let resized = size != display.pictureSize(maxWidth: before.width)
    if resized || request.fps != before.fps {
      capture?.update(width: size.width, height: size.height, fps: request.fps) { [link] reason in
        link.log("stream: the capture did not take its new size: \(reason)")
      }
    }
    // The new size begins with the picture there is, not with the screen's next change: the
    // encoder scales what it is given until the capture's own pictures come in the new size.
    if resized { keyWanted = true }
    tick()
  }

  private func captured(_ buffer: CVPixelBuffer) {
    guard !closed else { return }
    latest = buffer
    fresh = true
    changedSinceKey = true
    counts.captured += 1
    tick()
  }

  /// Sends what is due, and sets the timer for what is next.
  private func tick() {
    guard !closed, let picture = latest else { return }
    let now = HostClock.nanoseconds()
    // Nothing more is pushed at a host that isn't reading, or an encoder that isn't done.
    let waiting = pipe?.waiting ?? 0
    let room = (waiting == 0 || Double(waiting) < Double(request.bitrate) / 8 * Tuning.streamPipeSeconds) && inFlight < 2
    // The frame nearest to `gop` after the last key frame is the next one: the one after it
    // would make the wait longer than was asked.
    let keyDue = keyWanted || now - lastKey >= Int64(request.gop * 1e9) - Int64(0.5e9 / Double(request.fps))
    let refining = now < refineUntil
    if room, now >= nextDue - Tuning.streamPaceTolerance, fresh || keyDue || refining {
      submit(picture, key: keyDue, now: now)
    }

    guard !closed else { return }
    let wake: Int64
    if !room {
      wake = now + Tuning.streamRetryInterval
    } else if fresh || keyWanted || now < refineUntil {
      wake = max(nextDue, now)
    } else {
      wake = max(lastKey + Int64(request.gop * 1e9), nextDue)
    }
    timer?.schedule(deadline: .now() + .nanoseconds(Int(max(wake - now, 0))), leeway: .milliseconds(1))
  }

  private func submit(_ picture: CVPixelBuffer, key: Bool, now: Int64) {
    guard let compressor = encoder() else { return }
    let interval = Int64(1e9 / Double(request.fps))
    // By the clock, not by the last frame: one that went a little late doesn't make the rest late.
    nextDue = (now - nextDue < interval ? nextDue : now) + interval
    if fresh || key { refineUntil = now + Int64(Tuning.streamRefineWindow * 1e9) }
    let new = fresh
    fresh = false
    var alone = false
    if key {
      // A key frame takes its share of the second and leaves the rest to the frames after it.
      // The one a still screen is given by the clock is all there is to send: it may take more,
      // and be as sharp as that allows, so that nothing need follow it.
      alone = !keyWanted && !changedSinceKey && sharpKeys
      let share = min(request.gop, 1) * (alone ? Tuning.streamStillKeyShare : Tuning.streamKeyShare)
      compressor.keyPlan = .init(budget: Int(Double(request.bitrate) / 8 * share), finest: alone ? Tuning.streamFineQuantizer : nil)
      keyWanted = false
      lastKey = now
      changedSinceKey = false
    }
    inFlight += 1
    let generation = self.generation
    compressor.encode(picture, at: CMTime(value: now, timescale: 1_000_000_000), key: key) { [weak self] result in
      let took = HostClock.nanoseconds() - now
      self?.queue.async { self?.encoded(result, by: compressor, generation: generation, new: new, asKey: key, alone: alone, sent: now, took: took) }
    }
  }

  /// The encoder for the size asked for now: made when there is none, and made anew — a new
  /// generation — when the size is another.
  private func encoder() -> VideoCompressor? {
    let size = display.pictureSize(maxWidth: request.width)
    if let compressor, compressor.width == size.width, compressor.height == size.height { return compressor }
    let earlier = compressor
    // Its last frames come out, and are written, before the first of the next size.
    earlier?.finish()
    do {
      let made = try VideoCompressor(.init(width: size.width, height: size.height, fps: request.fps, bitrate: request.bitrate, ceiling: request.ceiling, profile: request.profile, lowLatency: Launch.lowLatency))
      if let earlier {
        made.learn(from: earlier)
        generation &+= 1
      }
      compressor = made
      announced = false
      inFlight = 0
      return made
    } catch {
      end("the encoder could not be started: \(error)")
      return nil
    }
  }

  private func encoded(_ result: Result<VideoCompressor.Frame?, VideoCompressor.Failure>, by encoder: VideoCompressor, generation: UInt8, new: Bool, asKey: Bool, alone: Bool, sent: Int64, took: Int64) {
    guard !closed else { return }
    // The last frames of an encoder since replaced are still written; they count for nothing else.
    let current = encoder === compressor
    if current { inFlight -= 1 }
    switch result {
    case .failure(let failure):
      // A session the system took back (after sleep, or when the encoder was reset) is made
      // again, once; an encoder that fails twice running is not coming back.
      guard current else { break }
      failures += 1
      guard failures < 2 else { return end("the encoder failed: \(failure)") }
      link.log("stream: \(failure): starting the encoder again")
      compressor = nil
      keyWanted = true
      fresh = true
    case .success(nil):
      // Dropped by the encoder to keep to the rate. A new picture has still to be sent, and a
      // key frame still to be made; one that was only the last picture again is let go.
      counts.dropped += 1
      if new { fresh = true }
      if asKey { keyWanted = true }
      if alone { sharpKeys = false }
    case .success(let frame?):
      failures = 0
      guard var record = frame.accessUnit(reserved: RecordPipe.headerSize) else { return end("the encoder's frame could not be read") }
      RecordPipe.writeHeader(into: &record, key: frame.key, generation: generation)
      pipe?.write(record)
      counts.frames += 1
      counts.bytes += record.count - RecordPipe.headerSize
      counts.encodeTime += took
      if frame.key {
        counts.keyFrames += 1
        // One the encoder made unasked (its first frame) counts as much as one asked for.
        lastKey = max(lastKey, sent)
      }
      if let quantizer = frame.quantizer {
        counts.quantizers += quantizer
        counts.quantized += 1
        // Sharp enough: sending the same picture again would add nothing.
        if quantizer <= Tuning.streamFineQuantizer, inFlight == 0 { refineUntil = 0 }
      }
      if !announced, current {
        announced = true
        link.emit([
          "t": "stream.started", "v": viewer, "width": encoder.width, "height": encoder.height, "fps": request.fps,
          "generation": Int(generation), "mode": encoder.mode, "profile": encoder.profile.rawValue, "hardware": encoder.hardware,
        ])
      }
    }
    tick()
  }

  private func reportStats() {
    guard !closed, let compressor else { return }
    let counted = counts
    counts = Counts()
    link.emit([
      "t": "stream.stats",
      "v": viewer,
      "width": compressor.width,
      "height": compressor.height,
      "generation": Int(generation),
      "captured": counted.captured,
      "fps": counted.frames,
      "keyFrames": counted.keyFrames,
      "dropped": counted.dropped,
      "bitrate": counted.bytes * 8,
      "quantizer": counted.quantized > 0 ? json(Double(counted.quantizers) / Double(counted.quantized)) : NSNull(),
      "encodeMs": counted.frames > 0 ? json(Double(counted.encodeTime) / Double(counted.frames) / 1e6) : NSNull(),
      "waiting": pipe?.waiting ?? 0,
    ])
  }
}

/// The host's socket, written to a record at a time and never from the thread that encodes: a
/// host slow to read holds up this pipe's queue, and `waiting` says by how much.
final class RecordPipe {
  static let headerSize = 6

  /// The socket can't be written to any more.
  var onBroken: (() -> Void)?

  private let descriptor: Int32
  private let queue = DispatchQueue(label: "com.bd.linkshell.stream-pipe", qos: .userInteractive)
  private let pending = Locked(0)
  private let closed = Locked(false)

  init?(path: String) {
    guard let descriptor = Link.connect(to: path) else { return nil }
    self.descriptor = descriptor
    var size = Int32(Tuning.streamSocketBuffer)
    setsockopt(descriptor, SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size))
  }

  /// Bytes given to `write` that the host has yet to take.
  var waiting: Int { pending.withLock { $0 } }

  static func writeHeader(into record: inout Data, key: Bool, generation: UInt8) {
    let length = UInt32(record.count - headerSize)
    record[0] = UInt8(truncatingIfNeeded: length >> 24)
    record[1] = UInt8(truncatingIfNeeded: length >> 16)
    record[2] = UInt8(truncatingIfNeeded: length >> 8)
    record[3] = UInt8(truncatingIfNeeded: length)
    record[4] = key ? 1 : 0
    record[5] = generation
  }

  func write(_ record: Data) {
    pending.withLock { $0 += record.count }
    queue.async { [self] in
      let whole = record.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Bool in
        var sent = 0
        while sent < buffer.count {
          let count = Darwin.write(descriptor, buffer.baseAddress! + sent, buffer.count - sent)
          if count > 0 {
            sent += count
          } else if count < 0, errno == EINTR {
            continue
          } else {
            return false
          }
        }
        return true
      }
      pending.withLock { $0 -= record.count }
      if !whole, !closed.withLock({ $0 }) { onBroken?() }
    }
  }

  /// A write that is waiting on the host is let go, and the socket closed behind the last one.
  func close() {
    closed.withLock { $0 = true }
    shutdown(descriptor, SHUT_RDWR)
    queue.async { [descriptor] in Darwin.close(descriptor) }
  }
}
