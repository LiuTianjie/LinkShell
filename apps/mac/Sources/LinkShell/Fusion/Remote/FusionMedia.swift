import AppKit
import CoreGraphics
import Foundation
import WebRTC

/// The pictures of one Fusion session (docs/v2/fusion.md §5): one peer connection, one video
/// sender per stream — a fused window (`w<id>`) or a virtual display's popup layer (`d<index>`) —
/// and the four channels of ordinary screen sharing, shared by every stream. Input names its
/// stream (`k`); the sender offers again whenever streams come or go.
///
/// One connection means one ICE/DTLS handshake, one TURN allocation and one bandwidth estimate
/// for all windows, which the senders split by focus (`maxBitrateBps`, `bitratePriority`).
/// Everything here happens on the main queue.
final class FusionMedia: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  enum Kind { case window, overlay }

  final class Stream {
    let key: String
    let kind: Kind
    let transceiver: RTCRtpTransceiver
    let source: RTCVideoSource
    let capturer: ScreenCapturer
    var control: Control
    var display: Display
    var size: (width: Int, height: Int)
    var maxFps: Int
    var focused = false
    var boost: DispatchSourceTimer?
    var overlayActive = false
    init(key: String, kind: Kind, transceiver: RTCRtpTransceiver, source: RTCVideoSource, capturer: ScreenCapturer,
         control: Control, display: Display, size: (width: Int, height: Int), maxFps: Int) {
      self.key = key; self.kind = kind; self.transceiver = transceiver; self.source = source; self.capturer = capturer
      self.control = control; self.display = display; self.size = size; self.maxFps = maxFps
    }
    var active: Bool { kind == .window ? (focused || boost != nil) : overlayActive }
  }

  /// `rtc` payloads for the control connection (§5.2).
  var onSignal: (([String: Any]) -> Void)?
  /// Something other than a pointer move happened in a stream: the remote focuses that window.
  var onInteract: ((String) -> Void)?
  var onScroll: ((String) -> Void)?
  /// A stream's capture stopped on its own, for an alert.
  var onStreamError: ((String, String) -> Void)?

  private let factory: RTCPeerConnectionFactory
  private var connection: RTCPeerConnection?
  private let iceServers: [[String: Any]]
  private(set) var streams: [String: Stream] = [:]
  /// Transceivers of closed streams, reused before new ones are added so a long session's SDP
  /// does not grow with every window it ever opened.
  private var spare: [RTCRtpTransceiver] = []
  private var input: RTCDataChannel?
  private var pointer: RTCDataChannel?
  private var shape: RTCDataChannel?
  private var channels: [RTCDataChannel] = []
  private var negotiating = false
  private var offerWanted = false
  private var offerScheduled = false
  private var everConnected = false
  private var iceRestarts = 0
  private var restartTimer: DispatchSourceTimer?
  private var shapeTimer: DispatchSourceTimer?
  private var statsTimer: DispatchSourceTimer?
  /// One count over both input channels and all streams, as the receiver numbers them.
  private var newestEvent = -1
  private var lastInputKey: String?
  /// Per stream: each local window draws the pointer itself and knows only the pictures it was sent.
  private var shapesSent: [String: Set<String>] = [:]
  private var shapeShown: [String: String] = [:]
  private var offerFailures = 0
  private var relayed = false
  private var virtualAddresses: Set<String> = []
  private var awake: Awake?
  private var closed = false
  /// `Control` reports only in a dry run or for viewers without their own pointer; neither here.
  private static let quiet = Link(input: -1, output: open("/dev/null", O_WRONLY))

  init(iceServers: [[String: Any]]) {
    self.iceServers = iceServers
    // 120 Hz windows exist (ProMotion locals): the codec level must allow it from the start.
    factory = Engine.screenFactory(maximumFrameRate: Tuning.fpsRange.upperBound)
    super.init()
  }

  func start() {
    virtualAddresses = Networks.virtualAddresses()
    awake = Awake()
    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.iceServers = Self.servers(iceServers)
    configuration.bundlePolicy = .maxBundle
    configuration.rtcpMuxPolicy = .require
    configuration.continualGatheringPolicy = .gatherContinually
    configuration.disableLinkLocalNetworks = true
    configuration.enableDscp = true
    guard let connection = factory.peerConnection(with: configuration, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self) else {
      Fusion.log("media: the peer connection could not be made")
      return
    }
    self.connection = connection
    _ = connection.setBweMinBitrateBps(nil, currentBitrateBps: NSNumber(value: 10_000_000), maxBitrateBps: nil)
    let reliable = RTCDataChannelConfiguration()
    let lossy = RTCDataChannelConfiguration()
    lossy.isOrdered = false
    lossy.maxRetransmits = 0
    // `cursor` is kept for parity with screen sharing; fused windows draw the pointer from `shape`.
    for (label, delivery) in [("input", reliable), ("pointer", lossy), ("cursor", lossy), ("shape", reliable)] {
      guard let channel = connection.dataChannel(forLabel: label, configuration: delivery) else { continue }
      channel.delegate = self
      channels.append(channel)
      switch label {
      case "input": input = channel
      case "pointer": pointer = channel
      case "shape": shape = channel
      default: break
      }
    }
    onSignal?(["t": "config", "iceServers": iceServers])
    startTimers()
    wantOffer()
  }

  func close() {
    guard !closed else { return }
    closed = true
    restartTimer?.cancel(); shapeTimer?.cancel(); statsTimer?.cancel()
    for stream in streams.values {
      stream.boost?.cancel()
      stream.control.releaseAll()
      stream.capturer.stop()
    }
    streams.removeAll()
    spare.removeAll()
    channels.forEach { $0.delegate = nil }
    channels.removeAll()
    connection?.delegate = nil
    connection?.close()
    connection = nil
    awake = nil
  }

  // MARK: Streams

  /// A fused window, captured as its group (root, children, titlebar widgets) on `display`.
  func openWindow(id: CGWindowID, display: Display, group: Set<CGWindowID>, bounds: @escaping () -> CGRect) {
    let key = "w\(id)"
    guard !closed, streams[key] == nil else { return }
    let size = display.pictureSize(maxWidth: min(display.pixelWidth, 5120))
    let maxFps = Self.refreshRate(display) >= 90 ? 120 : 60
    guard let stream = makeStream(key: key, kind: .window, display: display, size: size, maxFps: maxFps, bounds: bounds) else { return }
    stream.focused = true
    apply(stream)
    stream.capturer.start(fusionDisplay: display, rootWindow: id, windowIDs: group.isEmpty ? [id] : group, width: size.width, height: size.height, fps: fps(stream)) { [weak self] error in
      DispatchQueue.main.async {
        guard let error else { return }
        self?.onStreamError?(key, "窗口画面无法采集：\(error)")
      }
    }
    wantOffer()
  }

  /// A virtual display's popup layer: menus and tooltips over their parent windows.
  func openOverlay(index: Int, display: Display, width: Int) {
    let key = "d\(index)"
    guard !closed, streams[key] == nil else { return }
    let size = display.pictureSize(maxWidth: width)
    guard let stream = makeStream(key: key, kind: .overlay, display: display, size: size, maxFps: 60, bounds: { CGDisplayBounds(display.id) }) else { return }
    apply(stream)
    stream.capturer.start(display: display, width: size.width, height: size.height, fps: fps(stream)) { [weak self] error in
      DispatchQueue.main.async {
        guard let error else { return }
        self?.onStreamError?(key, "弹出菜单画面无法采集：\(error)")
      }
    }
    stream.capturer.refreshDisplayFilterNow(idle: true)
    wantOffer()
  }

  func closeStream(_ key: String) {
    guard let stream = streams.removeValue(forKey: key) else { return }
    stream.boost?.cancel()
    stream.control.releaseAll()
    stream.capturer.stop()
    stream.transceiver.sender.track = nil
    var error: NSError?
    stream.transceiver.setDirection(.inactive, error: &error)
    spare.append(stream.transceiver)
    if lastInputKey == key { lastInputKey = nil }
    shapesSent[key] = nil
    shapeShown[key] = nil
    wantOffer()
  }

  private func makeStream(key: String, kind: Kind, display: Display, size: (width: Int, height: Int), maxFps: Int, bounds: @escaping () -> CGRect) -> Stream? {
    guard let connection else { return nil }
    let source = factory.videoSource(forScreenCast: true)
    let track = factory.videoTrack(with: source, trackId: key)
    let transceiver: RTCRtpTransceiver
    if let reused = spare.popLast() {
      reused.sender.track = track
      var error: NSError?
      reused.setDirection(.sendOnly, error: &error)
      transceiver = reused
    } else {
      let sending = RTCRtpTransceiverInit()
      sending.direction = .sendOnly
      sending.streamIds = ["fusion"]
      sending.sendEncodings = [RTCRtpEncodingParameters()]
      guard let added = connection.addTransceiver(with: track, init: sending) else {
        Fusion.log("media: \(key) could not be added")
        return nil
      }
      let preferred = Codecs.preferences("h264", from: factory.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs)
      try? added.setCodecPreferences(preferred.codecs, error: ())
      transceiver = added
    }
    let capturer = ScreenCapturer(delegate: source)
    capturer.onStop = { [weak self] reason in
      DispatchQueue.main.async { self?.onStreamError?(key, "画面采集已停止：\(reason)") }
    }
    let control = Control(id: key, link: Self.quiet, bounds: bounds)
    let stream = Stream(key: key, kind: kind, transceiver: transceiver, source: source, capturer: capturer,
                        control: control, display: display, size: size, maxFps: maxFps)
    streams[key] = stream
    return stream
  }

  /// A window moved to another virtual display: same sender, new capture size.
  func moveWindow(_ key: String, to display: Display, group: Set<CGWindowID>) {
    guard let stream = streams[key], stream.kind == .window else { return }
    stream.display = display
    stream.size = display.pictureSize(maxWidth: min(display.pixelWidth, 5120))
    stream.maxFps = Self.refreshRate(display) >= 90 ? 120 : 60
    apply(stream)
    stream.capturer.switchFusionDisplay(display: display, windowIDs: group, width: stream.size.width, height: stream.size.height)
    stream.capturer.setRate(fps(stream)) { _ in }
  }

  func updateGroup(_ key: String, _ group: Set<CGWindowID>) {
    streams[key]?.capturer.updateFusionWindowGroup(group)
  }

  /// A newly launched app may own windows of a group already captured.
  func refreshGroupApps() {
    for stream in streams.values where stream.kind == .window { stream.capturer.refreshFusionGroupApps() }
  }

  func focus(_ key: String?) {
    for stream in streams.values where stream.kind == .window {
      let focused = stream.key == key
      guard stream.focused != focused else { continue }
      stream.focused = focused
      if focused { stream.boost?.cancel(); stream.boost = nil }
      apply(stream)
    }
  }

  func setOverlaysActive(_ active: (Int) -> Bool) {
    for stream in streams.values where stream.kind == .overlay {
      let on = Int(stream.key.dropFirst()).map(active) ?? false
      guard stream.overlayActive != on else { continue }
      stream.overlayActive = on
      apply(stream)
      stream.capturer.refreshDisplayFilterNow(idle: !on)
    }
  }

  /// Scrolling an unfocused window keeps it at full rate for a moment, without taking the focus.
  private func boost(_ stream: Stream) {
    guard stream.kind == .window, !stream.focused else { return }
    let had = stream.boost != nil
    stream.boost?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 3.5)
    timer.setEventHandler { [weak self, weak stream] in
      guard let self, let stream else { return }
      stream.boost?.cancel()
      stream.boost = nil
      self.apply(stream)
    }
    timer.resume()
    stream.boost = timer
    if !had { apply(stream) }
  }

  // MARK: Rates

  private func fps(_ stream: Stream) -> Int {
    switch stream.kind {
    case .window: return stream.active ? Tuning.fullRate(viewer: stream.maxFps, display: Self.refreshRate(stream.display)) : 30
    case .overlay: return stream.overlayActive ? 60 : 2
    }
  }

  static func cap(kind: Kind, retina: Bool, fps: Int, active: Bool) -> Int {
    switch kind {
    case .overlay: return active ? 6_000_000 : 400_000
    case .window:
      if !active { return retina ? 6_000_000 : 4_000_000 }
      if fps >= 90 { return retina ? 28_000_000 : 16_000_000 }
      return retina ? 20_000_000 : 12_000_000
    }
  }

  /// Through a TURN relay (held to its share by the gateway's coturn), the window in use gets most
  /// of it and the rest just enough to stay legible.
  static func relayCap(active: Bool) -> Int { active ? 2_400_000 : 300_000 }

  private func apply(_ stream: Stream) {
    let rate = fps(stream)
    let retina = max(stream.size.width, stream.display.pixelWidth) > 2800
    var ceiling = min(Tuning.maxBitrate(width: stream.size.width, height: stream.size.height, fps: rate),
                      Self.cap(kind: stream.kind, retina: retina, fps: rate, active: stream.active))
    if relayed { ceiling = min(ceiling, Self.relayCap(active: stream.active)) }
    let sender = stream.transceiver.sender
    let parameters = sender.parameters
    for encoding in parameters.encodings {
      encoding.maxBitrateBps = NSNumber(value: ceiling)
      encoding.maxFramerate = NSNumber(value: rate)
      encoding.networkPriority = stream.active ? .high : .low
      encoding.bitratePriority = stream.active ? 4 : 1
    }
    // Text must stay sharp: drop frames, never resolution.
    parameters.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
    sender.parameters = parameters
    stream.capturer.setRate(rate) { _ in }
  }

  static func refreshRate(_ display: Display) -> Int {
    let cgHz = Int((CGDisplayCopyDisplayMode(display.id)?.refreshRate ?? 0).rounded())
    return max(cgHz, display.screen?.maximumFramesPerSecond ?? 60, 60)
  }

  // MARK: Signalling (§5.2)

  func receive(_ m: [String: Any]) {
    guard !closed else { return }
    switch m["t"] as? String {
    case "answer":
      guard let sdp = m["sdp"] as? String else { return }
      connection?.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
        DispatchQueue.main.async {
          guard let self, !self.closed else { return }
          if let error { Fusion.log("media: the answer was not taken: \(error.localizedDescription)") }
          self.negotiating = false
          if self.offerWanted { self.wantOffer() }
        }
      }
    case "ice":
      guard let sdp = m["candidate"] as? String, !sdp.isEmpty else { return }
      let index = (m["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
      connection?.add(RTCIceCandidate(sdp: sdp, sdpMLineIndex: index, sdpMid: m["sdpMid"] as? String)) { error in
        if let error { Fusion.log("media: a candidate was not taken: \(error.localizedDescription)") }
      }
    case "control":
      onSignal?(["t": "control", "available": true, "trusted": AXIsProcessTrusted()])
    default:
      break
    }
  }

  /// Streams change in bursts (an app opening three windows): one offer covers them all.
  private func wantOffer() {
    offerWanted = true
    guard !negotiating, !offerScheduled, connection != nil else { return }
    offerScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      guard let self else { return }
      self.offerScheduled = false
      self.offer()
    }
  }

  private func offer() {
    guard let connection, !closed, !negotiating, offerWanted else { return }
    offerWanted = false
    negotiating = true
    scheduleRestart()
    connection.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self] description, error in
      guard let description else {
        DispatchQueue.main.async {
          Fusion.log("media: no offer: \(error?.localizedDescription ?? "unknown")")
          self?.offerFailed()
        }
        return
      }
      connection.setLocalDescription(description) { error in
        DispatchQueue.main.async {
          guard let self, !self.closed else { return }
          if let error {
            Fusion.log("media: the offer was not set: \(error.localizedDescription)")
            self.offerFailed()
            return
          }
          self.offerFailures = 0
          // The mids exist only now; the receiver must know them before it sees the tracks.
          let map = self.streams.values.compactMap { stream -> [String: String]? in
            guard let mid = stream.transceiver.mid as String?, !mid.isEmpty else { return nil }
            return ["k": stream.key, "mid": mid]
          }
          self.onSignal?(["t": "streams", "streams": map])
          self.onSignal?(["t": "offer", "sdp": description.sdp])
        }
      }
    }
  }

  /// The streams that wanted this offer still need one: try again shortly, a few times.
  private func offerFailed() {
    negotiating = false
    offerFailures += 1
    guard offerFailures <= 3 else { return }
    offerWanted = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5 * Double(offerFailures)) { [weak self] in self?.wantOffer() }
  }

  /// The first attempt to connect may stall; a fresh gathering often clears it.
  private func scheduleRestart() {
    guard !everConnected, iceRestarts < Tuning.iceRestartLimit, restartTimer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + Tuning.iceRestartAfter)
    timer.setEventHandler { [weak self] in
      guard let self, !self.closed, !self.everConnected, let connection = self.connection else { return }
      self.restartTimer = nil
      self.iceRestarts += 1
      Fusion.log("media: no path after \(Int(Tuning.iceRestartAfter)) s, restarting ICE (\(self.iceRestarts))")
      connection.restartIce()
      self.wantOffer()
    }
    timer.resume()
    restartTimer = timer
  }

  static func servers(_ list: [[String: Any]]) -> [RTCIceServer] {
    list.compactMap { server in
      let urls = (server["urls"] as? [String]) ?? (server["urls"] as? String).map { [$0] } ?? []
      guard !urls.isEmpty else { return nil }
      return RTCIceServer(urlStrings: urls, username: server["username"] as? String, credential: server["credential"] as? String)
    }
  }

  // MARK: Pointer shape and path

  private func startTimers() {
    let shapeTimer = DispatchSource.makeTimerSource(queue: .main)
    shapeTimer.schedule(deadline: .now(), repeating: 1 / Tuning.shapeRate, leeway: .milliseconds(20))
    shapeTimer.setEventHandler { [weak self] in self?.reportShape() }
    shapeTimer.resume()
    self.shapeTimer = shapeTimer
    let statsTimer = DispatchSource.makeTimerSource(queue: .main)
    statsTimer.schedule(deadline: .now() + 2, repeating: 2)
    statsTimer.setEventHandler { [weak self] in self?.checkPath() }
    statsTimer.resume()
    self.statsTimer = statsTimer
  }

  /// The pointer's picture goes to the window the person is using: it is the same for every window.
  private func reportShape() {
    guard let key = lastInputKey, let stream = streams[key], let shape, shape.readyState == .open,
          let now = PointerShape.current(), now.id != shapeShown[key] else { return }
    shapeShown[key] = now.id
    var message: [String: Any] = ["t": "shape", "k": key, "id": now.id]
    if shapesSent[key, default: []].insert(now.id).inserted {
      let bounds = CGDisplayBounds(stream.display.id)
      message["png"] = now.png.base64EncodedString()
      message["w"] = now.width
      message["h"] = now.height
      message["hotX"] = now.hotX
      message["hotY"] = now.hotY
      message["scale"] = now.scale
      message["displayW"] = Double(bounds.width)
      message["displayH"] = Double(bounds.height)
    }
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    shape.sendData(RTCDataBuffer(data: data, isBinary: false))
  }

  private func checkPath() {
    guard let connection, connection.connectionState == .connected else { return }
    connection.statistics { [weak self] report in
      DispatchQueue.main.async {
        guard let self, !self.closed else { return }
        let reader = StatsReader(report: report)
        let types = ["localCandidateId", "remoteCandidateId"].compactMap { StatsReader.text(reader.linked(reader.pair, $0), "candidateType") }
        let through = types.contains("relay")
        guard through != self.relayed else { return }
        self.relayed = through
        Fusion.log("media: the video goes \(through ? "through a TURN relay" : "directly")")
        self.streams.values.forEach(self.apply)
      }
    }
  }

  // MARK: Input

  private func apply(_ data: Data, replaceable: Bool) {
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let key = object["k"] as? String, let stream = streams[key], let event = InputEvent(json: data) else { return }
    if let number = event.number {
      if replaceable, event.kind == "move", number < newestEvent { return }
      newestEvent = max(newestEvent, number)
    }
    lastInputKey = key
    if event.kind == "scroll" {
      boost(stream)
      onScroll?(key)
    } else if event.kind != "move" {
      onInteract?(key)
    }
    stream.control.handle(event.command)
  }

  private func releaseAll() { streams.values.forEach { $0.control.releaseAll() } }

  // MARK: RTCPeerConnectionDelegate (libwebrtc's signalling thread)

  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    DispatchQueue.main.async {
      guard !self.closed, !Networks.isUselessHost(candidate.sdp, virtual: self.virtualAddresses) else { return }
      self.onSignal?(["t": "ice", "candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? NSNull(), "sdpMLineIndex": Int(candidate.sdpMLineIndex)])
    }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    DispatchQueue.main.async {
      guard !self.closed else { return }
      Fusion.log("media: connection \(ScreenSession.name(newState))")
      self.onSignal?(["t": "state", "connection": ScreenSession.name(newState)])
      if newState == .connected {
        self.everConnected = true
        self.restartTimer?.cancel()
        self.restartTimer = nil
      }
      if [.disconnected, .failed, .closed].contains(newState) { self.releaseAll() }
    }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

  // MARK: RTCDataChannelDelegate

  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    let label = dataChannel.label, state = dataChannel.readyState
    DispatchQueue.main.async {
      guard !self.closed else { return }
      if state == .open, label == "shape" { self.shapeShown.removeAll(); self.reportShape() }
      if state == .closed, label == "input" { self.releaseAll() }
    }
  }

  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    let label = dataChannel.label
    guard label == "input" || label == "pointer", !buffer.isBinary else { return }
    let data = buffer.data
    DispatchQueue.main.async {
      guard !self.closed else { return }
      self.apply(data, replaceable: label == "pointer")
    }
  }
}
