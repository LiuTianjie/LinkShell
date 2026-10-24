import AppKit
import CoreFoundation
import Foundation
import QuartzCore
import WebRTC

/// Only negotiation crosses WebKit. The peer owns native media and input for one screen mount.
final class DesktopScreenReceiver: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  private let queue = DispatchQueue(label: "linkshell.desktop.screen", qos: .userInteractive)
  private let surface: DesktopScreenSurface
  private let onSignal: ([String: Any]) -> Void
  private let onStatus: ([String: Any]) -> Void
  private let onFailure: (String) -> Void
  private var factory: RTCPeerConnectionFactory?
  private var peer: RTCPeerConnection?
  private var track: RTCVideoTrack?
  private var channels: [String: RTCDataChannel] = [:]
  private var candidates: [RTCIceCandidate] = []
  private var inputState = DesktopScreenInputState()
  private var controlRequested = false
  private var controlAsked = false
  private var controlTrusted = false
  private var heldButtons: [String: [String: Any]] = [:]
  private var eventNumber = 0
  private var cursorNumber = 0
  private var publishedControl: Bool?
  private var publishedControlRequested: Bool?
  private var negotiating = false
  private var closed = false
  private var receivedPicture = false
  private var presentationVisible = true
  private var startedAt = CACurrentMediaTime()
  private var disconnectedAt: Double?
  private var timer: DispatchSourceTimer?

  /// Create on the main thread, where the surface lives. All supplied callbacks return there.
  init(surface: DesktopScreenSurface, onSignal: @escaping ([String: Any]) -> Void,
       onStatus: @escaping ([String: Any]) -> Void, onFailure: @escaping (String) -> Void) {
    self.surface = surface; self.onSignal = onSignal; self.onStatus = onStatus; self.onFailure = onFailure
    super.init()
    surface.onInput = { [weak self] message, replaceable in self?.input(message, replaceable: replaceable) }
    surface.onFirstFrame = { [weak self] in self?.pictureArrived() }
    surface.onFailure = { [weak self] message in self?.queue.async { [weak self] in self?.fail(message) } }
    queue.async { [self] in
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now() + 1, repeating: 1)
      timer.setEventHandler { [weak self] in self?.checkConnection() }
      timer.resume()
      self.timer = timer
    }
  }

  func receive(_ message: [String: Any]) {
    guard DesktopScreenBridge.validMessage(message) else { return }
    queue.async { [weak self] in self?.message(message) }
  }

  func setControl(_ enabled: Bool) {
    queue.async {
      guard !self.closed else { return }
      if !enabled { self.releaseButtons() }
      self.controlRequested = enabled
      if !enabled { self.controlAsked = false }
      self.requestControlIfReady()
      self.updateControl()
    }
  }

  func pictureArrived() {
    queue.async {
      guard !self.closed, self.presentationVisible, !self.receivedPicture else { return }
      self.receivedPicture = true
      self.status(["live": true, "transport": "native-webrtc", "renderer": "Metal"])
      self.updateControl()
    }
  }

  func setPresentationVisible(_ visible: Bool) {
    queue.async {
      guard !self.closed, self.presentationVisible != visible else { return }
      if !visible { self.releaseButtons() }
      self.presentationVisible = visible
      self.receivedPicture = false
      if visible { self.startedAt = CACurrentMediaTime() }
      self.status(["live": false])
      self.updateControl()
    }
  }

  func stop() { queue.async { self.close() } }

  private func message(_ message: [String: Any]) {
    guard !closed else { return }
    if let error = message["error"] as? String { return fail(String(error.prefix(2048))) }
    if message["t"] as? String == "screen.configure" {
      // The web controller owns request IDs, but native input must observe the same barrier.
      let previousDisplay = inputState.display
      guard inputState.configure(message) else { return }
      releaseButtons()
      if let previousDisplay, previousDisplay != inputState.display {
        // An RTP frame has no configuration generation. A new native mount is the only
        // unambiguous boundary between pictures from two different displays.
        return fail("显示器已改变，请重新连接以确认新的原生画面")
      }
      controlAsked = false; controlTrusted = false
      updateControl()
      return
    }
    if let session = message["session"] as? [String: Any] {
      if session["t"] as? String == "error" { return fail(String((session["error"] as? String ?? session["message"] as? String ?? "电脑未能应用画面设置，请重新连接").prefix(2048))) }
      inputState.receive(session)
      requestControlIfReady()
      updateControl()
    }
    if let control = message["control"] as? [String: Any] {
      controlTrusted = DesktopScreenBridge.boolean(control["available"]) == true && DesktopScreenBridge.boolean(control["trusted"]) == true
      if controlAsked, controlRequested, !controlTrusted {
        releaseButtons()
        controlRequested = false; controlAsked = false
        let reason = control["reason"] as? String ?? "远程电脑尚未允许控制，请在该电脑授予辅助功能权限后重试"
        status(["control": false, "controlRequested": false, "controlError": String(reason.prefix(2048))])
      }
      updateControl()
    }
    if let cursor = message["cursor"] as? [String: Any] { cursorMessage(cursor.merging(["t": "cursor"]) { _, new in new }) }
    guard let rtc = message["rtc"] as? [String: Any], let type = rtc["t"] as? String else { return }
    switch type {
    case "config": createPeer(rtc)
    case "offer": acceptOffer(rtc)
    case "ice": addCandidate(rtc)
    case "off": fail("此电脑或网络暂不支持原生视频直连，请检查网络后重新连接")
    default: break
    }
  }

  private func createPeer(_ rtc: [String: Any]) {
    guard peer == nil else { return }
    _ = Engine.factory // Share the application's one-time SSL and field-trial initialization.
    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.bundlePolicy = .maxBundle
    configuration.rtcpMuxPolicy = .require
    configuration.continualGatheringPolicy = .gatherContinually
    configuration.disableLinkLocalNetworks = true
    configuration.iceServers = ((rtc["iceServers"] as? [[String: Any]]) ?? []).prefix(16).compactMap { server in
      let urls = (server["urls"] as? [String]) ?? (server["urls"] as? String).map { [$0] } ?? []
      let allowed = urls.prefix(8).filter { value in
        value.utf8.count <= 1024 && ["stun:", "stuns:", "turn:", "turns:"].contains(where: value.hasPrefix)
      }
      guard !allowed.isEmpty else { return nil }
      return RTCIceServer(urlStrings: allowed, username: String((server["username"] as? String ?? "").prefix(512)), credential: String((server["credential"] as? String ?? "").prefix(512)))
    }
    let decoder = DesktopScreenDecoderFactory(onStatus: { [weak self] status in
      self?.queue.async { [weak self] in self?.status(status) }
    }, onFailure: { [weak self] message in
      self?.queue.async { [weak self] in self?.fail(message) }
    })
    guard !decoder.supportedCodecs().isEmpty else { return fail("此 Mac 不支持远程桌面硬件解码") }
    let factory = RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: decoder)
    self.factory = factory
    peer = factory.peerConnection(with: configuration, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self)
    if peer == nil { fail("原生视频连接无法启动") }
  }

  private func acceptOffer(_ rtc: [String: Any]) {
    guard let peer, !negotiating, let sdp = rtc["sdp"] as? String, sdp.utf8.count < 128_000 else {
      return fail("电脑返回了无效的视频协商信息")
    }
    negotiating = true
    peer.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { [weak self, weak peer] error in
      self?.queue.async { [weak self, weak peer] in
        guard let self, let peer, !self.closed, self.peer === peer else { return }
        if error != nil { return self.fail("视频格式协商失败") }
        for candidate in self.candidates { peer.add(candidate) { _ in } }
        self.candidates.removeAll()
        self.attachTrack(peer)
        self.preferReceiveCodecs(peer)
        peer.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self, weak peer] answer, error in
          self?.queue.async { [weak self, weak peer] in
            guard let self, let peer, !self.closed, self.peer === peer else { return }
            guard error == nil, let answer else { return self.fail("无法应答电脑的视频连接") }
            peer.setLocalDescription(answer) { [weak self, weak peer] error in
              self?.queue.async { [weak self, weak peer] in
                guard let self, let peer, !self.closed, self.peer === peer else { return }
                if error != nil { return self.fail("视频连接应答失败") }
                self.negotiating = false
                self.attachTrack(peer)
                self.signal(["t": "rtc.answer", "sdp": answer.sdp])
              }
            }
          }
        }
      }
    }
  }

  private func addCandidate(_ rtc: [String: Any]) {
    guard let candidate = rtc["candidate"] as? String, candidate.utf8.count < 8192,
          let index = DesktopScreenBridge.integer(rtc["sdpMLineIndex"]), (0...65535).contains(index) else { return }
    let mid = (rtc["sdpMid"] as? String).map { String($0.prefix(256)) }
    let value = RTCIceCandidate(sdp: candidate, sdpMLineIndex: Int32(index), sdpMid: mid)
    if let peer, peer.remoteDescription != nil { peer.add(value) { _ in } }
    else if candidates.count < 256 { candidates.append(value) }
  }

  /// Answers as the phone does: HEVC before H.264, and no FlexFEC. The process enables FlexFEC
  /// for its sender; as a receiver it would only take bitrate for a recovery that is unproven.
  private func preferReceiveCodecs(_ peer: RTCPeerConnection) {
    guard let factory, let transceiver = peer.transceivers.first(where: { $0.mediaType == .video }) else { return }
    let available = factory.rtpReceiverCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs
      .filter { $0.name.uppercased() != "FLEXFEC-03" }
    let codecs = available.filter { $0.name.uppercased() == "H265" } + available.filter { $0.name.uppercased() != "H265" }
    guard codecs.contains(where: { ["H264", "H265"].contains($0.name.uppercased()) }) else { return }
    try? transceiver.setCodecPreferences(codecs, error: ())
  }

  private func attachTrack(_ peer: RTCPeerConnection) {
    guard let incoming = peer.transceivers.first(where: { $0.mediaType == .video })?.receiver.track as? RTCVideoTrack, incoming !== track else { return }
    track?.remove(surface)
    track = incoming
    incoming.add(surface)
  }

  private func requestControlIfReady() {
    guard controlRequested, !controlAsked, inputState.allowsInput else { return }
    controlAsked = true
    var message: [String: Any] = ["t": "control"]
    message["screenGeneration"] = inputState.generation
    signal(message)
  }

  private func updateControl() {
    let enabled = !closed && presentationVisible && receivedPicture && inputState.allowsInput && controlRequested && controlTrusted && channels["input"]?.readyState == .open
    DispatchQueue.main.async { [weak self] in self?.surface.controlEnabled = enabled }
    if publishedControl != enabled || publishedControlRequested != controlRequested {
      publishedControl = enabled; publishedControlRequested = controlRequested
      status(["control": enabled, "controlRequested": controlRequested])
    }
  }

  private func input(_ message: [String: Any], replaceable: Bool) {
    queue.async {
      guard !self.closed, self.presentationVisible, self.receivedPicture, self.inputState.allowsInput, self.controlRequested, self.controlTrusted,
            let type = message["t"] as? String, ["move", "down", "up", "scroll", "key", "text"].contains(type) else { return }
      self.sendInput(message, replaceable: replaceable)
    }
  }

  private func sendInput(_ message: [String: Any], replaceable: Bool) {
    guard let channel = channels[replaceable ? "pointer" : "input"], channel.readyState == .open else { return }
    if channel.bufferedAmount > (replaceable ? 16_384 : 262_144) {
      if !replaceable { fail("控制连接拥堵，请重新连接") }
      return
    }
    eventNumber += 1
    var event = message
    event["screenGeneration"] = inputState.generation
    event["i"] = eventNumber
    guard let data = try? JSONSerialization.data(withJSONObject: event), data.count <= 64_000 else { return }
    if !channel.sendData(RTCDataBuffer(data: data, isBinary: false)) {
      if !replaceable { fail("控制连接已中断，请重新连接") }
      return
    }
    if let button = message["b"] as? String, ["left", "right"].contains(button) {
      if message["t"] as? String == "down" { heldButtons[button] = message }
      if message["t"] as? String == "up" { heldButtons.removeValue(forKey: button) }
    }
  }

  private func releaseButtons() {
    let buttons = Array(heldButtons.values)
    heldButtons.removeAll()
    for var message in buttons { message["t"] = "up"; sendInput(message, replaceable: false) }
  }

  private func cursorMessage(_ message: [String: Any]) {
    if message["t"] as? String == "cursor", let number = DesktopScreenBridge.integer(message["i"]) {
      guard number > cursorNumber else { return }
      cursorNumber = number
    }
    DispatchQueue.main.async { [weak self] in self?.surface.updateCursor(message) }
  }

  private func checkConnection() {
    guard !closed else { return }
    let now = CACurrentMediaTime()
    if now - startedAt >= 10, inputState.finishCapabilitiesWait() { requestControlIfReady(); updateControl() }
    if presentationVisible, !receivedPicture, now - startedAt > 25 { return fail("原生视频直连超时，请检查网络后重新连接") }
    if let disconnectedAt, now - disconnectedAt > 4 { fail("原生视频直连已中断，请重新连接") }
  }

  private func signal(_ message: [String: Any]) {
    guard !closed else { return }
    DispatchQueue.main.async { [weak self] in self?.onSignal(message) }
  }

  private func status(_ status: [String: Any]) {
    guard !closed else { return }
    DispatchQueue.main.async { [weak self] in self?.onStatus(status) }
  }

  private func fail(_ message: String) {
    guard !closed else { return }
    close()
    DispatchQueue.main.async { [weak self] in self?.onFailure(message) }
  }

  private func close() {
    guard !closed else { return }
    closed = true
    timer?.cancel(); timer = nil
    track?.remove(surface); track = nil
    for channel in channels.values { channel.delegate = nil }
    channels.removeAll(); candidates.removeAll(); heldButtons.removeAll()
    peer?.delegate = nil
    peer?.close(); peer = nil; factory = nil
    DispatchQueue.main.async { [weak self] in self?.surface.stop() }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    queue.async {
      guard !self.closed, self.peer === peerConnection else { return }
      self.signal(["t": "rtc.ice", "candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? NSNull(), "sdpMLineIndex": candidate.sdpMLineIndex])
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    queue.async {
      guard !self.closed, self.peer === peerConnection else { return }
      switch newState {
      case .connected, .completed:
        self.disconnectedAt = nil; self.attachTrack(peerConnection)
        self.status(["connected": true])
      case .disconnected: if self.disconnectedAt == nil { self.disconnectedAt = CACurrentMediaTime() }
      case .failed, .closed: self.fail("当前网络无法保持原生视频直连，请重新连接")
      default: break
      }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
    queue.async {
      guard !self.closed, self.peer === peerConnection,
            ["input", "pointer", "cursor", "shape"].contains(dataChannel.label), self.channels[dataChannel.label] == nil else {
        dataChannel.close(); return
      }
      self.channels[dataChannel.label] = dataChannel
      dataChannel.delegate = self
      self.updateControl()
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    queue.async {
      guard !self.closed, self.channels[dataChannel.label] === dataChannel else { return }
      if dataChannel.label == "input", dataChannel.readyState == .closed { return self.fail("控制连接已中断，请重新连接") }
      self.updateControl()
    }
  }
  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard !buffer.isBinary, buffer.data.count <= 262_144,
          let message = (try? JSONSerialization.jsonObject(with: buffer.data)) as? [String: Any] else { return }
    queue.async {
      guard !self.closed, self.channels[dataChannel.label] === dataChannel,
            ["cursor", "shape"].contains(dataChannel.label), message["t"] as? String == dataChannel.label else { return }
      self.cursorMessage(message)
    }
  }
}

/// Shared validation keeps malformed bridge values and stale display acknowledgments inert.
enum DesktopScreenBridge {
  static func identifier(_ value: Any?) -> String? {
    guard let value = value as? String, value.utf8.count == 36, UUID(uuidString: value) != nil else { return nil }
    return value
  }
  static func validMessage(_ value: [String: Any]) -> Bool {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return false }
    return data.count <= 262_144
  }
  static func rect(_ value: Any?) -> CGRect? {
    guard let value = value as? [String: Any], let x = number(value["x"]), let y = number(value["y"]),
          let width = number(value["width"]), let height = number(value["height"]),
          abs(x) <= 16_384, abs(y) <= 16_384, (0...16_384).contains(width), (0...16_384).contains(height) else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
  }
  static func integer(_ value: Any?) -> Int? {
    guard let number = number(value), number.rounded() == number, abs(number) <= 9_007_199_254_740_991 else { return nil }
    return Int(number)
  }
  static func boolean(_ value: Any?) -> Bool? {
    guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return value.boolValue
  }
  private static func number(_ value: Any?) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
    return value.doubleValue
  }
}

struct DesktopScreenInputState {
  private(set) var generation: Int?
  var display: Int? { requestedDisplay }
  private var capabilitiesKnown = false
  private var supportsConfiguration = false
  private var requestID: Int?
  private var requestedDisplay: Int?
  private var requestedPaused = false
  private var awaitingConfiguration = false
  var allowsInput: Bool { capabilitiesKnown && !awaitingConfiguration && (!supportsConfiguration || generation != nil) }

  mutating func configure(_ message: [String: Any]) -> Bool {
    guard message["t"] as? String == "screen.configure", let request = DesktopScreenBridge.integer(message["requestId"]),
          request >= 0, request > (requestID ?? -1), let display = DesktopScreenBridge.integer(message["display"]), display >= 0,
          let paused = DesktopScreenBridge.boolean(message["paused"]) else { return false }
    requestID = request; requestedDisplay = display; requestedPaused = paused
    awaitingConfiguration = true
    return true
  }

  mutating func receive(_ message: [String: Any]) {
    switch message["t"] as? String {
    case "capabilities":
      guard DesktopScreenBridge.integer(message["version"]) == 1 else { return }
      guard let configure = DesktopScreenBridge.boolean(message["configure"]) else { return }
      capabilitiesKnown = true
      supportsConfiguration = configure
      if supportsConfiguration, generation == nil { awaitingConfiguration = true }
    case "configured":
      guard supportsConfiguration, let request = DesktopScreenBridge.integer(message["requestId"]), request == requestID,
            let display = DesktopScreenBridge.integer(message["display"]), display == requestedDisplay,
            let generation = DesktopScreenBridge.integer(message["generation"]), generation >= 0,
            let paused = DesktopScreenBridge.boolean(message["paused"]), paused == requestedPaused else { return }
      self.generation = generation
      awaitingConfiguration = paused
    default: break
    }
  }

  mutating func finishCapabilitiesWait() -> Bool {
    guard !capabilitiesKnown else { return false }
    capabilitiesKnown = true
    return true
  }
}
