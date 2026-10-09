import AppKit
import CoreGraphics
import Foundation
import WebRTC

/// What the host asks for a viewer (`rtc.open`).
struct ScreenRequest {
  let viewer: String
  let iceServers: [RTCIceServer]
  /// Which display (see `Display`).
  let screen: Int
  /// The widest the picture may be; it is never wider than the display.
  let maxWidth: Int
  /// The one frame rate to send at; nil for the app's own choice, which follows what the
  /// network carries (`FrameRate`).
  let fps: Int?
  let maxFps: Int
  let codec: String

  init(viewer: String, _ message: [String: Any]) {
    self.viewer = viewer
    iceServers = ((message["iceServers"] as? [[String: Any]]) ?? []).compactMap { server in
      let urls = (server["urls"] as? [String]) ?? (server["urls"] as? String).map { [$0] } ?? []
      guard !urls.isEmpty else { return nil }
      return RTCIceServer(urlStrings: urls, username: server["username"] as? String, credential: server["credential"] as? String)
    }
    screen = (message["screen"] as? Int) ?? 0
    maxWidth = min(max((message["maxWidth"] as? Int) ?? Tuning.defaultMaxWidth, Tuning.narrowestPicture), Tuning.widestPicture)
    fps = (message["fps"] as? Int).map { min(max($0, Tuning.fpsRange.lowerBound), Tuning.fpsRange.upperBound) }
    let ceiling = (message["maxFps"] as? Int) ?? Tuning.fullFps
    maxFps = [30, 60, 120].contains(ceiling) ? ceiling : Tuning.fullFps
    codec = (message["codec"] as? String) == "hevc" ? "hevc" : "h264"
  }
}

/// One viewer watching one display: the capture, the connection that carries it, the channels
/// beside it — the viewer's hands one way, the pointer the other — and the numbers about it.
/// Everything here happens on the main queue.
///
/// The channels:
///
///   input    ordered, reliable       viewer → app   the events of `InputEvent`: what must arrive
///   pointer  unordered, sent once    viewer → app   the same events, for the ones a later one
///                                                   replaces (`move`) or that can be missed (`scroll`)
///   cursor   unordered, sent once    app → viewer   {t:"cursor", x, y, i}: where the pointer is
///   shape    ordered, reliable       app → viewer   {t:"shape", id, png, w, h, hotX, hotY, scale,
///                                                   displayW, displayH}, then {t:"shape", id}
///
/// The pointer's picture has a channel of its own because it is a few kilobytes: more than one
/// packet. On a channel that sends once, one lost packet loses the whole message, and the
/// viewer would then be told by id of a picture it never got.
final class ScreenSession: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  struct Options {
    /// Show the clock strip on the display while it is captured.
    var clock = false
    /// Answer the offer in this process (see `Loopback`), for a test with no viewer.
    var loopback = false
    /// Show something moving on the display while it is captured (see `MotionWindow`).
    var motion = false
  }

  let viewer: String

  private let request: ScreenRequest
  private let options: Options
  private let link: Link
  private var display = Display.main
  private var connection: RTCPeerConnection?
  private var peerFactory: RTCPeerConnectionFactory?
  private var transceiver: RTCRtpTransceiver?
  /// Kept here: the capturer's hold on the source is weak, and libwebrtc's own is on the C++
  /// object behind it — let go of this one and the frames go nowhere.
  private var source: RTCVideoSource?
  private var capturer: ScreenCapturer?
  private var cursor: RTCDataChannel?
  private var shape: RTCDataChannel?
  private var channels: [RTCDataChannel] = []
  /// Messages that came up each channel, for the numbers.
  private var heard: [String: Int] = [:]
  private var control: Control?
  /// The highest number ("i") on an event applied so far.
  private var newestEvent = -1
  private var cursorCount = 0
  /// The pictures of the pointer this viewer has, and the one it is showing.
  private var shapesSent: Set<String> = []
  private var shapeShown: String?
  private var statsTimer: DispatchSourceTimer?
  private var cursorTimer: DispatchSourceTimer?
  private var shapeTimer: DispatchSourceTimer?
  private var said = ""
  private var strip: ClockStrip?
  private var motion: MotionWindow?
  private var stripCheck: StripCheck?
  private var loopback: Loopback?
  /// The display is kept on, and was woken, for as long as this viewer watches it.
  private var awake: Awake?
  private var closed = false

  private var bytes = Rate()
  private var encodeTime = Rate()
  private var encodedFrames = Rate()
  private var sendDelay = Rate()
  private var packetsSent = Rate()
  private var size = (width: 0, height: 0)
  /// The frame rate in force, why it last changed, and what changes it (nothing, when the host
  /// named the rate).
  private var frameRate: Int
  private var frameRateReason: String?
  private var steps: FrameRate?
  /// The most the track may send for now, in bits a second, where that is not the frame rate's
  /// ceiling: the second after the rate went up (`change`).
  private var eased: Int?

  init(request: ScreenRequest, options: Options, link: Link) {
    self.request = request
    self.options = options
    self.link = link
    viewer = request.viewer
    frameRate = request.fps ?? Tuning.fullFps
  }

  // MARK: Life

  func start() {
    // Asking ScreenCaptureKit without the permission makes the system ask the user: don't.
    guard Permissions.recording() else { return fail(Permissions.notRecording) }
    guard let display = Display.at(request.screen) else { return fail("there is no display \(request.screen)") }
    self.display = display
    awake = Awake()
    size = display.pictureSize(maxWidth: request.maxWidth)
    if request.fps == nil {
      frameRate = Tuning.fullRate(viewer: request.maxFps, display: display.screen?.maximumFramesPerSecond ?? 60)
      if frameRate > 30 {
        steps = FrameRate(full: frameRate, reduced: frameRate > 60 ? 60 : 30, lowest: 30,
                          ceiling: Tuning.maxBitrate(width: size.width, height: size.height, fps: frameRate))
      }
    }
    // The viewer's hands are on the display it is shown, wherever that display is moved to.
    control = Control(id: viewer, link: link, bounds: { CGDisplayBounds(display.id) }, everyPosition: { [weak self] x, y in self?.sendCursor(x, y) })

    let factory = Engine.screenFactory(maximumFrameRate: frameRate)
    peerFactory = factory
    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.iceServers = request.iceServers
    configuration.bundlePolicy = .maxBundle
    configuration.rtcpMuxPolicy = .require
    // A phone changes network (Wi-Fi to cellular) without the connection being made again.
    configuration.continualGatheringPolicy = .gatherContinually
    configuration.enableDscp = true
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let connection = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
      return fail("the peer connection could not be made")
    }
    self.connection = connection

    // The picture.
    let source = factory.videoSource(forScreenCast: true)
    self.source = source
    let capturer = ScreenCapturer(delegate: source)
    self.capturer = capturer
    let track = factory.videoTrack(with: source, trackId: "screen")
    let encoding = RTCRtpEncodingParameters()
    apply(to: encoding)
    let sending = RTCRtpTransceiverInit()
    sending.direction = .sendOnly
    sending.streamIds = ["screen"]
    sending.sendEncodings = [encoding]
    guard let transceiver = connection.addTransceiver(with: track, init: sending) else { return fail("the video could not be added") }
    self.transceiver = transceiver

    let capabilities = factory.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs
    let preferred = Codecs.preferences(request.codec, from: capabilities)
    if !preferred.found { link.log("\(request.codec) can't be encoded by this build of libwebrtc: offering H.264") }
    do {
      try transceiver.setCodecPreferences(preferred.codecs, error: ())
    } catch {
      link.log("codec preferences were not taken: \(error.localizedDescription)")
    }

    setParameters { $0.degradationPreference = NSNumber(value: Tuning.degradation.rawValue) }
    _ = connection.setBweMinBitrateBps(nil, currentBitrateBps: NSNumber(value: Tuning.startBitrate), maxBitrateBps: nil)

    // The channels beside it.
    let reliable = RTCDataChannelConfiguration()
    let lossy = RTCDataChannelConfiguration()
    lossy.isOrdered = false
    lossy.maxRetransmits = 0
    for (label, delivery) in [("input", reliable), ("pointer", lossy), ("cursor", lossy), ("shape", reliable)] {
      guard let channel = connection.dataChannel(forLabel: label, configuration: delivery) else { continue }
      channel.delegate = self
      channels.append(channel)
      if label == "cursor" { cursor = channel }
      if label == "shape" { shape = channel }
    }

    if options.clock, let screen = display.screen {
      let strip = ClockStrip(screen: screen)
      strip.show()
      self.strip = strip
      let check = StripCheck()
      stripCheck = check
      capturer.onPicture = { buffer, displayed in check.add(buffer, displayed: displayed) }
    }
    if options.motion, let screen = display.screen {
      motion = MotionWindow(screen: screen)
      motion?.show()
    }
    if options.loopback {
      loopback = Loopback(viewer: viewer, link: link, readClock: options.clock) { [weak self] candidate in
        self?.connection?.add(candidate) { _ in }
      }
    }

    capturer.onStop = { [weak self] reason in
      DispatchQueue.main.async { self?.fail("the capture stopped: \(reason)") }
    }
    let rate = steps.map { "\($0.full) fps, \($0.reduced) while that is not carried" } ?? "\(frameRate) fps"
    capturer.start(display: display, width: size.width, height: size.height, fps: frameRate) { [weak self] error in
      DispatchQueue.main.async {
        guard let self, !self.closed else { return }
        if let error { return self.fail("the screen could not be captured: \(error)") }
        self.link.log("capturing display \(display.id) (\(display.pixelWidth)×\(display.pixelHeight)) as \(self.size.width)×\(self.size.height) at \(rate)")
      }
    }
    offer()
    startTimers()
  }

  func close() {
    guard !closed else { return }
    closed = true
    awake = nil
    statsTimer?.cancel()
    cursorTimer?.cancel()
    shapeTimer?.cancel()
    // The viewer left: nothing stays pressed.
    control?.releaseAll()
    capturer?.stop()
    source = nil
    strip?.hide()
    motion?.hide()
    loopback?.close()
    channels.forEach { $0.delegate = nil }
    connection?.delegate = nil
    connection?.close()
    connection = nil
    channels.removeAll()
    cursor = nil
    shape = nil
    transceiver = nil
    capturer = nil
    loopback = nil
    peerFactory = nil
  }

  // MARK: Signalling

  func answer(_ sdp: String) {
    connection?.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
      DispatchQueue.main.async {
        guard let self, !self.closed else { return }
        if let error { return self.fail("the answer was not taken: \(error.localizedDescription)") }
        self.describe()
      }
    }
  }

  func candidate(_ message: [String: Any]) {
    guard let sdp = message["candidate"] as? String, !sdp.isEmpty else { return }
    let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32((message["sdpMLineIndex"] as? Int) ?? 0), sdpMid: message["sdpMid"] as? String)
    connection?.add(candidate) { [weak self] error in
      if let error { self?.link.log("a candidate was not taken: \(error.localizedDescription)") }
    }
  }

  private func offer() {
    guard let connection else { return }
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    connection.offer(for: constraints) { [weak self] description, error in
      guard let description else {
        DispatchQueue.main.async { self?.fail("no offer: \(error?.localizedDescription ?? "unknown")") }
        return
      }
      connection.setLocalDescription(description) { error in
        DispatchQueue.main.async {
          guard let self, !self.closed else { return }
          if let error { return self.fail("the offer was not set: \(error.localizedDescription)") }
          self.link.emit(["t": "rtc.offer", "v": self.viewer, "sdp": description.sdp])
          self.loopback?.answer(description.sdp) { [weak self] sdp in self?.answer(sdp) }
        }
      }
    }
  }

  /// What was agreed, for the log: the things that decide latency and can't be seen in the numbers.
  private func describe() {
    guard let transceiver else { return }
    let extensions = transceiver.negotiatedHeaderExtensions.filter { $0.direction != .stopped }.map(\.uri)
    let playout = extensions.contains { $0.hasSuffix("playout-delay") }
    let parameters = transceiver.sender.parameters
    let codec = parameters.codecs.first
    let encoding = parameters.encodings.first
    let degradation = parameters.degradationPreference.flatMap { RTCDegradationPreference(rawValue: $0.intValue) }
    link.log(
      "agreed: \(codec?.name ?? "?") \(codec?.parameters["profile-level-id"] as? String ?? ""), playout-delay extension \(playout ? "kept" : "dropped by the answer")"
        + (Engine.playoutDelay ? "" : " (not sent: --no-playout-delay)")
        + ", max \(encoding?.maxBitrateBps?.intValue ?? 0) bit/s, max \(encoding?.maxFramerate?.intValue ?? 0) fps, degradation \(degradation.map(Self.name) ?? "default")"
    )
  }

  private func apply(to encoding: RTCRtpEncodingParameters) {
    encoding.maxBitrateBps = NSNumber(value: eased ?? Tuning.maxBitrate(width: size.width, height: size.height, fps: frameRate))
    encoding.maxFramerate = NSNumber(value: frameRate)
    encoding.networkPriority = Tuning.networkPriority
  }

  /// The sender's parameters as they should now be, with whatever else `also` wants of them.
  private func setParameters(_ also: (RTCRtpParameters) -> Void = { _ in }) {
    guard let sender = transceiver?.sender else { return }
    let parameters = sender.parameters
    parameters.encodings.forEach(apply(to:))
    also(parameters)
    sender.parameters = parameters
  }

  /// Another frame rate, and the ceiling that goes with it, from the next frame on: the capture
  /// goes on, the encoder stays as it is, and nothing is negotiated. `sending`: the bits a
  /// second it sends.
  private func change(to rate: Int, because reason: String, sending: Double?) {
    link.log("frame rate \(frameRate) → \(rate): \(reason)")
    let lower = rate < frameRate
    frameRate = rate
    frameRateReason = reason
    if lower {
      eased = nil
    } else {
      // The higher rate starts on half of what the lower one was sending, for a second. The
      // encoder is told the frame rate libwebrtc has counted over the last second, so for that
      // second it gives each of twice the frames a share meant for half as many, and what it
      // makes over the rate waits to be sent: 0.3 s behind for two seconds, measured.
      eased = max(Int((sending ?? 0) * Tuning.frameRateEase), Tuning.frameRateEaseFloor)
    }
    setParameters()
    capturer?.setRate(rate) { [weak self] error in
      // libwebrtc holds the track to the rate whatever the capture gives it.
      if let error { self?.link.log("the capture kept its frame rate: \(error)") }
    }
  }

  private func fail(_ message: String) {
    guard !closed else { return }
    link.emit(["t": "rtc.error", "v": viewer, "message": message])
    close()
  }

  // MARK: RTCPeerConnectionDelegate (on libwebrtc's signalling thread)

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    let connection = peerConnection.connectionState
    DispatchQueue.main.async { self.state(ice: newState, connection: connection) }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    let ice = peerConnection.iceConnectionState
    DispatchQueue.main.async { self.state(ice: ice, connection: newState) }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    DispatchQueue.main.async {
      guard !self.closed else { return }
      self.link.emit(["t": "rtc.ice", "v": self.viewer, "candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? NSNull(), "sdpMLineIndex": Int(candidate.sdpMLineIndex)])
      self.loopback?.add(candidate)
    }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

  /// On every change of either state, and only then.
  private func state(ice: RTCIceConnectionState, connection: RTCPeerConnectionState) {
    guard !closed else { return }
    let now = Self.name(ice) + "/" + Self.name(connection)
    guard now != said else { return }
    said = now
    link.emit(["t": "rtc.state", "v": viewer, "ice": Self.name(ice), "connection": Self.name(connection)])
    // A viewer that can't be heard can't let go of what it holds.
    if [.disconnected, .failed, .closed].contains(connection) { control?.releaseAll() }
  }

  // MARK: RTCDataChannelDelegate

  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    let label = dataChannel.label
    let open = dataChannel.readyState == .open
    let closedNow = dataChannel.readyState == .closed
    guard open || closedNow else { return }
    DispatchQueue.main.async {
      guard !self.closed else { return }
      self.link.log("channel \(label) is \(open ? "open" : "closed")")
      // Where the pointer is and what it looks like, as soon as there is somewhere to say it.
      if open, label == "cursor" { self.control?.reportAfresh() }
      if open, label == "shape" {
        self.shapeShown = nil
        self.reportShape()
      }
      if closedNow, label == "input" { self.control?.releaseAll() }
    }
  }

  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    let label = dataChannel.label
    guard label == "input" || label == "pointer" else { return }
    let event = buffer.isBinary ? nil : InputEvent(json: buffer.data)
    DispatchQueue.main.async {
      guard !self.closed else { return }
      self.heard[label, default: 0] += 1
      if let event { self.apply(event, replaceable: label == "pointer") }
    }
  }

  // MARK: The viewer's hands

  /// What the viewer sent, done as the host's own viewers' events are (`Control`).
  ///
  /// The two channels don't keep time with each other, and `pointer` doesn't keep its own order.
  /// A `move` that arrives late — after a `down` sent after it, or after a newer `move` — would
  /// drag from the place of the press to somewhere the finger had already left, or leave the
  /// pointer behind. A viewer that numbers its events ("i", one count over both channels) has
  /// such a `move` dropped: one from `pointer` older than the newest event applied. Everything
  /// on `input` is done, in the order it was sent. Without numbers nothing is dropped.
  private func apply(_ event: InputEvent, replaceable: Bool) {
    if let number = event.number {
      if replaceable, event.kind == "move", number < newestEvent { return }
      newestEvent = max(newestEvent, number)
    }
    control?.handle(event.command)
  }

  // MARK: Pointer and numbers

  private func startTimers() {
    let cursorTimer = DispatchSource.makeTimerSource(queue: .main)
    cursorTimer.schedule(deadline: .now(), repeating: 1 / Tuning.cursorRate, leeway: .milliseconds(1))
    cursorTimer.setEventHandler { [weak self] in self?.control?.report() }
    cursorTimer.resume()
    self.cursorTimer = cursorTimer

    let shapeTimer = DispatchSource.makeTimerSource(queue: .main)
    shapeTimer.schedule(deadline: .now(), repeating: 1 / Tuning.shapeRate, leeway: .milliseconds(20))
    shapeTimer.setEventHandler { [weak self] in self?.reportShape() }
    shapeTimer.resume()
    self.shapeTimer = shapeTimer

    let statsTimer = DispatchSource.makeTimerSource(queue: .main)
    statsTimer.schedule(deadline: .now() + Tuning.statsInterval, repeating: Tuning.statsInterval)
    statsTimer.setEventHandler { [weak self] in self?.reportStats() }
    statsTimer.resume()
    self.statsTimer = statsTimer
  }

  /// Where the pointer is, as fractions of the display. Numbered, because the channel doesn't
  /// keep order: the viewer drops one older than the last it drew.
  private func sendCursor(_ x: Double, _ y: Double) {
    guard let cursor, cursor.readyState == .open else { return }
    cursorCount += 1
    let message = String(format: "{\"t\":\"cursor\",\"x\":%.5f,\"y\":%.5f,\"i\":%d}", x, y, cursorCount)
    cursor.sendData(RTCDataBuffer(data: Data(message.utf8), isBinary: false))
  }

  /// What the pointer looks like, when that has changed: the picture the first time this viewer
  /// meets it, its id alone after that.
  private func reportShape() {
    guard let shape, shape.readyState == .open, let now = PointerShape.current(), now.id != shapeShown else { return }
    shapeShown = now.id
    var message: [String: Any] = ["t": "shape", "id": now.id]
    if shapesSent.insert(now.id).inserted {
      let bounds = CGDisplayBounds(display.id)
      message["png"] = now.png.base64EncodedString()
      message["w"] = now.width
      message["h"] = now.height
      message["hotX"] = now.hotX
      message["hotY"] = now.hotY
      message["scale"] = now.scale
      // The display in the same points, so that the viewer can draw the pointer as large as it is here.
      message["displayW"] = Double(bounds.width)
      message["displayH"] = Double(bounds.height)
    }
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    shape.sendData(RTCDataBuffer(data: data, isBinary: false))
  }

  /// `--loopback` only: has the viewer inside the app send these events up one of its channels.
  func sendFromLoopback(_ events: [Any], on label: String) {
    loopback?.send(events, on: label)
  }

  /// `--loopback` only: holds the bandwidth estimate to so many bits a second, as a narrow
  /// network does (without its loss and delay); nil lets it go.
  func limitFromLoopback(_ bitrate: Int?) {
    guard options.loopback else { return }
    _ = connection?.setBweMinBitrateBps(nil, currentBitrateBps: nil, maxBitrateBps: bitrate.map { NSNumber(value: $0) })
  }

  private func reportStats() {
    guard let connection, let capturer else { return }
    let captured = capturer.takeCounts()
    let strip = stripCheck?.take()
    connection.statistics { [weak self] report in
      DispatchQueue.main.async {
        guard let self, !self.closed else { return }
        let reader = StatsReader(report: report)
        let outbound = reader.first("outbound-rtp", kind: "video")
        let remote = reader.first("remote-inbound-rtp", kind: "video")
        let codec = reader.linked(outbound, "codecId")
        let pair = reader.pair
        let time = (outbound?.timestamp_us ?? report.timestamp_us) / 1e6
        let number = StatsReader.number
        let text = StatsReader.text
        let frames = self.encodedFrames.step(number(outbound, "framesEncoded"))
        let seconds = self.encodeTime.step(number(outbound, "totalEncodeTime"))
        let round = number(remote, "roundTripTime") ?? number(pair, "currentRoundTripTime")
        // The name libwebrtc was given when the encoder was made, unless its own has taken over since.
        let named = text(outbound, "encoderImplementation")
        let encoder = named == LowLatencyH264Encoder.name && LowLatencyH264Encoder.tookOver.withLock({ $0 }) ? "VideoToolbox" : named
        let waited = self.sendDelay.step(number(outbound, "totalPacketSendDelay"))
        let packets = self.packetsSent.step(number(outbound, "packetsSent"))
        let bitrate = self.bytes.per(second: number(outbound, "bytesSent"), at: time).map { ($0 * 8).rounded() }
        let second = FrameRate.Second(
          captured: Double(captured.captured),
          encoded: number(outbound, "framesPerSecond"),
          sentShare: number(outbound, "frameWidth").flatMap { width in number(outbound, "frameHeight").map { width * $0 / Double(self.size.width * self.size.height) } },
          limitation: text(outbound, "qualityLimitationReason"),
          available: number(pair, "availableOutgoingBitrate")
        )
        self.link.emit([
          "t": "rtc.stats",
          "v": self.viewer,
          "bitrate": json(bitrate),
          "fps": json(second.encoded),
          "frameRate": self.frameRate,
          "frameRateReason": json(self.frameRateReason),
          "width": json(number(outbound, "frameWidth")),
          "height": json(number(outbound, "frameHeight")),
          "encoder": json(encoder),
          "codec": json(text(codec, "mimeType").map { $0.replacingOccurrences(of: "video/", with: "") }),
          "keyFrames": json(number(outbound, "keyFramesEncoded")),
          "qualityLimitation": json(second.limitation),
          "rttMs": json(round.map { $0 * 1000 }),
          "availableOutgoing": json(second.available),
          "packetsLost": json(number(remote, "packetsLost")),
          "nack": json(number(outbound, "nackCount")),
          "pli": json(number(outbound, "pliCount")),
          "captureFps": captured.captured,
          "repeated": captured.repeated,
          "gapMs": (captured.gap * 1000).rounded(),
          "fmtp": json(text(codec, "sdpFmtpLine")),
          "hardware": (outbound?.values["powerEfficientEncoder"] as? NSNumber)?.boolValue ?? NSNull(),
          "targetBitrate": json(number(outbound, "targetBitrate")),
          "encodeMs": json(frames.flatMap { count in seconds.flatMap { count > 0 ? $0 / count * 1000 : nil } }),
          // How long a packet waited to be sent, between the encoder and the network.
          "sendDelayMs": json(packets.flatMap { count in waited.flatMap { count > 0 ? $0 / count * 1000 : nil } }),
          "hugeFrames": json(number(outbound, "hugeFramesSent")),
          "heard": self.heard,
          // With --clock: the strip as captured, against the time the capture says it was displayed.
          "clock": strip ?? NSNull(),
        ])
        // What a change of rate left to be undone.
        if self.eased != nil {
          self.eased = nil
          self.setParameters()
        }
        // Only a connection that is up says anything about a rate: while one is being made, or
        // is lost, no frame is sent at any.
        guard connection.connectionState == .connected else { return }
        switch self.steps?.judge(second) {
        case .down(let reason), .up(let reason):
          if let rate = self.steps?.current { self.change(to: rate, because: reason, sending: bitrate) }
        case .keep, nil:
          break
        }
      }
    }
  }

  // MARK: Names, as a browser spells them

  static func name(_ state: RTCIceConnectionState) -> String {
    switch state {
    case .new: return "new"
    case .checking: return "checking"
    case .connected: return "connected"
    case .completed: return "completed"
    case .failed: return "failed"
    case .disconnected: return "disconnected"
    case .closed: return "closed"
    default: return "unknown"
    }
  }

  static func name(_ state: RTCPeerConnectionState) -> String {
    switch state {
    case .new: return "new"
    case .connecting: return "connecting"
    case .connected: return "connected"
    case .disconnected: return "disconnected"
    case .failed: return "failed"
    case .closed: return "closed"
    @unknown default: return "unknown"
    }
  }

  static func name(_ preference: RTCDegradationPreference) -> String {
    switch preference {
    case .maintainFramerate: return "maintain-framerate"
    case .maintainResolution: return "maintain-resolution"
    case .balanced: return "balanced"
    default: return "none"
    }
  }
}
