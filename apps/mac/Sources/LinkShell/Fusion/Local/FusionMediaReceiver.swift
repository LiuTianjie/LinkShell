import AppKit
import Foundation
import QuartzCore
import WebRTC

/// The local half of `FusionMedia` (docs/v2/fusion.md §5): one peer connection for every fused
/// window and popup layer. Decoded frames go to the stream whose `mid` the remote named last
/// (`streams`); input goes back on the shared channels with its stream key (`k`).
///
/// A transceiver is reused by the remote for a later window, so each one has a router that can
/// change its stream; the window id in each frame's metadata catches the frames in between.
final class FusionMediaReceiver: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  /// Forwards one transceiver's frames to whichever output it currently belongs to.
  final class Router: NSObject, RTCVideoRenderer {
    private let lock = NSLock()
    private var target: FusionOutput?
    func route(to output: FusionOutput?) { lock.lock(); target = output; lock.unlock() }
    func setSize(_ size: CGSize) {}
    func renderFrame(_ frame: RTCVideoFrame?) {
      lock.lock(); let output = target; lock.unlock()
      output?.renderFrame(frame)
    }
  }

  private let queue = DispatchQueue(label: "linkshell.fusion.media", qos: .userInteractive)
  private let onSignal: ([String: Any]) -> Void
  private let onStatus: ([String: Any]) -> Void
  private let onFailure: (String) -> Void
  private var factory: RTCPeerConnectionFactory?
  private var peer: RTCPeerConnection?
  private var channels: [String: RTCDataChannel] = [:]
  private var candidates: [RTCIceCandidate] = []
  /// Outputs by stream key; read on the queue.
  private var outputs: [String: FusionOutput] = [:]
  private var midToKey: [String: String] = [:]
  private var routers: [String: (track: RTCVideoTrack, router: Router)] = [:]
  private var negotiating = false
  private var pendingOffer: String?
  private var controlAsked = false
  private var controlTrusted = false
  private var eventNumber = 0
  private var heldButtons: [String: [String: Any]] = [:]
  private var disconnectedAt: Double?
  private var startedAt = CACurrentMediaTime()
  private var receivedAny = false
  private var timer: DispatchSourceTimer?
  private var closed = false
  private let physicalKeys: Bool

  init(physicalKeys: Bool, onSignal: @escaping ([String: Any]) -> Void, onStatus: @escaping ([String: Any]) -> Void, onFailure: @escaping (String) -> Void) {
    self.physicalKeys = physicalKeys
    self.onSignal = onSignal; self.onStatus = onStatus; self.onFailure = onFailure
    super.init()
    queue.async { [self] in
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now() + 1, repeating: 1)
      timer.setEventHandler { [weak self] in self?.checkConnection() }
      timer.resume()
      self.timer = timer
    }
  }

  /// A window or popup layer the remote announced; its frames start once its track is mapped.
  func add(_ output: FusionOutput) {
    output.onInput = { [weak self, key = output.key] message, replaceable in self?.input(key, message, replaceable: replaceable) }
    output.onFirstFrame = { [weak self, key = output.key] in self?.firstFrame(key) }
    queue.async {
      guard !self.closed else { return }
      self.outputs[output.key] = output
      self.reroute()
      self.publishControl(output.key)
    }
  }

  func remove(_ key: String) {
    queue.async {
      self.outputs.removeValue(forKey: key)
      self.reroute()
    }
  }

  func receive(_ m: [String: Any]) {
    queue.async { [weak self] in self?.message(m) }
  }

  func stop() { queue.async { self.close() } }

  private func message(_ m: [String: Any]) {
    guard !closed else { return }
    switch m["t"] as? String {
    case "config": createPeer(m)
    case "streams":
      for entry in (m["streams"] as? [[String: Any]]) ?? [] {
        guard let key = entry["k"] as? String, let mid = entry["mid"] as? String else { continue }
        midToKey = midToKey.filter { $0.value != key }
        midToKey[mid] = key
      }
      reroute()
    case "offer":
      guard let sdp = m["sdp"] as? String, sdp.utf8.count < 512_000 else { return fail("电脑返回了无效的视频协商信息") }
      if negotiating { pendingOffer = sdp } else { accept(sdp) }
    case "ice": addCandidate(m)
    case "control":
      controlTrusted = m["available"] as? Bool == true && m["trusted"] as? Bool == true
      if controlAsked, !controlTrusted {
        status(["controlError": "远端电脑尚未允许控制，请在该电脑授予辅助功能权限后重试"])
      }
      outputs.keys.forEach(publishControl)
    case "state": break
    default: break
    }
  }

  private func createPeer(_ m: [String: Any]) {
    guard peer == nil else { return }
    _ = Engine.factory
    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.bundlePolicy = .maxBundle
    configuration.rtcpMuxPolicy = .require
    configuration.continualGatheringPolicy = .gatherContinually
    configuration.disableLinkLocalNetworks = true
    configuration.iceServers = ((m["iceServers"] as? [[String: Any]]) ?? []).prefix(16).compactMap { server in
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
      Fusion.log("media: decoder failed: \(message)")
      self?.queue.async { [weak self] in
        self?.status(["decoderError": message])
        self?.fail(message)
      }
    })
    guard !decoder.supportedCodecs().isEmpty else { return fail("此 Mac 不支持远程桌面硬件解码") }
    let factory = RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: decoder)
    self.factory = factory
    peer = factory.peerConnection(with: configuration, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self)
    if peer == nil { fail("融合视频连接无法启动") }
  }

  private func accept(_ sdp: String) {
    guard let peer else { return }
    negotiating = true
    peer.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: DesktopScreenCodec.canonicalNames(inOffer: sdp))) { [weak self, weak peer] error in
      self?.queue.async { [weak self, weak peer] in
        guard let self, let peer, !self.closed else { return }
        if error != nil { return self.fail("融合视频格式协商失败") }
        for candidate in self.candidates { peer.add(candidate) { _ in } }
        self.candidates.removeAll()
        self.preferH264(peer)
        peer.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self, weak peer] answer, error in
          self?.queue.async { [weak self, weak peer] in
            guard let self, let peer, !self.closed else { return }
            guard error == nil, let answer else { return self.fail("无法应答远端的融合视频") }
            peer.setLocalDescription(answer) { [weak self, weak peer] error in
              self?.queue.async { [weak self, weak peer] in
                guard let self, let peer, !self.closed else { return }
                if error != nil { return self.fail("融合视频应答失败") }
                self.attachTracks(peer)
                self.signal(["t": "answer", "sdp": answer.sdp])
                self.negotiating = false
                if let next = self.pendingOffer {
                  self.pendingOffer = nil
                  self.accept(next)
                }
              }
            }
          }
        }
      }
    }
  }

  /// The remote encodes H.264 only (the crop metadata rides in its SEI).
  private func preferH264(_ peer: RTCPeerConnection) {
    guard let factory else { return }
    let available = factory.rtpReceiverCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs
      .filter { $0.name.uppercased() != "FLEXFEC-03" }
    let codecs = available.filter { $0.name.uppercased() == "H264" } + available.filter { $0.name.uppercased() != "H264" }
    for transceiver in peer.transceivers where transceiver.mediaType == .video {
      try? transceiver.setCodecPreferences(codecs, error: ())
    }
  }

  private func attachTracks(_ peer: RTCPeerConnection) {
    for transceiver in peer.transceivers where transceiver.mediaType == .video {
      let mid = transceiver.mid
      guard !mid.isEmpty, let track = transceiver.receiver.track as? RTCVideoTrack else { continue }
      if let existing = routers[mid], existing.track === track { continue }
      if let existing = routers[mid] { existing.track.remove(existing.router) }
      let router = Router()
      track.add(router)
      routers[mid] = (track, router)
    }
    reroute()
  }

  private func reroute() {
    for (mid, entry) in routers {
      entry.router.route(to: midToKey[mid].flatMap { outputs[$0] })
    }
  }

  private func addCandidate(_ m: [String: Any]) {
    guard let candidate = m["candidate"] as? String, candidate.utf8.count < 8192 else { return }
    let index = (m["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
    let value = RTCIceCandidate(sdp: candidate, sdpMLineIndex: index, sdpMid: (m["sdpMid"] as? String).map { String($0.prefix(256)) })
    if let peer, peer.remoteDescription != nil { peer.add(value) { _ in } }
    else if candidates.count < 256 { candidates.append(value) }
  }

  // MARK: Control and input

  private func firstFrame(_ key: String) {
    queue.async {
      guard !self.closed else { return }
      if !self.receivedAny {
        self.receivedAny = true
        Fusion.log("media: first picture (\(key))")
        self.status(["live": true, "transport": "native-webrtc", "renderer": "Metal"])
      }
      self.outputs[key]?.receivedPicture = true
      self.requestControl()
      self.publishControl(key)
    }
  }

  private func requestControl() {
    guard !controlAsked, channels["input"]?.readyState == .open else { return }
    controlAsked = true
    signal(["t": "control"])
  }

  private func publishControl(_ key: String) {
    guard let output = outputs[key] else { return }
    let enabled = !closed && controlTrusted && output.receivedPicture && channels["input"]?.readyState == .open
    let keys = physicalKeys
    DispatchQueue.main.async {
      if output.physicalKeys != keys { output.physicalKeys = keys }
      if output.controlEnabled != enabled { output.controlEnabled = enabled }
    }
  }

  private func input(_ key: String, _ message: [String: Any], replaceable: Bool) {
    queue.async {
      guard !self.closed, self.controlTrusted, let type = message["t"] as? String,
            ["move", "down", "up", "scroll", "key", "text", "keydown", "keyup"].contains(type) else { return }
      self.send(key, message, replaceable: replaceable)
    }
  }

  private func send(_ key: String, _ message: [String: Any], replaceable: Bool) {
    guard let channel = channels[replaceable ? "pointer" : "input"], channel.readyState == .open else { return }
    if channel.bufferedAmount > (replaceable ? 16_384 : 262_144) { return }
    eventNumber += 1
    let event = FusionProtocol.inputEvent(message, stream: key, number: eventNumber)
    guard let data = try? JSONSerialization.data(withJSONObject: event), data.count <= 64_000,
          channel.sendData(RTCDataBuffer(data: data, isBinary: false)) else { return }
    if let button = message["b"] as? String, ["left", "right", "middle"].contains(button) {
      let held = "\(key):\(button)"
      if message["t"] as? String == "down" { heldButtons[held] = event }
      if message["t"] as? String == "up" { heldButtons.removeValue(forKey: held) }
    }
  }

  /// Nothing stays pressed on the remote when the connection goes.
  private func releaseButtons() {
    let held = heldButtons
    heldButtons.removeAll()
    for (_, var message) in held {
      message["t"] = "up"
      let key = FusionProtocol.inputStream(message) ?? ""
      // A button event has no `k` of its own: what is there is the stream, put back by `send`.
      for field in [FusionProtocol.inputStreamField, "k", "i"] { message.removeValue(forKey: field) }
      send(key, message, replaceable: false)
    }
  }

  private func checkConnection() {
    guard !closed else { return }
    let now = CACurrentMediaTime()
    let hasWindow = outputs.keys.contains { $0.hasPrefix("w") }
    let iceUp = peer?.iceConnectionState == .connected || peer?.iceConnectionState == .completed
    if !receivedAny, !outputs.isEmpty, (!iceUp || hasWindow), now - startedAt > 25 {
      return fail("融合视频连接超时，请检查网络后重新连接")
    }
    if let disconnectedAt, now - disconnectedAt > 6 { fail("融合视频连接已中断") }
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
    releaseButtons()
    closed = true
    timer?.cancel(); timer = nil
    for entry in routers.values { entry.track.remove(entry.router); entry.router.route(to: nil) }
    routers.removeAll()
    for channel in channels.values { channel.delegate = nil }
    channels.removeAll(); candidates.removeAll()
    peer?.delegate = nil
    peer?.close(); peer = nil; factory = nil
    let outputs = Array(self.outputs.values)
    DispatchQueue.main.async { outputs.forEach { $0.controlEnabled = false } }
  }

  // MARK: RTCPeerConnectionDelegate

  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    queue.async {
      guard !self.closed, self.peer === peerConnection else { return }
      self.signal(["t": "ice", "candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? NSNull(), "sdpMLineIndex": candidate.sdpMLineIndex])
    }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    queue.async {
      guard !self.closed, self.peer === peerConnection else { return }
      // What a field report needs to tell "never connected" from "connected, no pictures".
      Fusion.log("media: ice \(Self.name(newState))")
      switch newState {
      case .connected, .completed:
        self.disconnectedAt = nil
        self.status(["connected": true])
      case .disconnected: if self.disconnectedAt == nil { self.disconnectedAt = CACurrentMediaTime() }
      case .failed: self.fail("当前网络无法保持融合视频连接")
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
      if dataChannel.label == "input", dataChannel.readyState == .open { self.requestControl() }
      self.outputs.keys.forEach(self.publishControl)
    }
  }

  private static func name(_ state: RTCIceConnectionState) -> String {
    switch state {
    case .new: return "new"
    case .checking: return "checking"
    case .connected: return "connected"
    case .completed: return "completed"
    case .failed: return "failed"
    case .disconnected: return "disconnected"
    case .closed: return "closed"
    case .count: return "?"
    @unknown default: return "?"
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
      if dataChannel.label == "input", dataChannel.readyState == .open { self.requestControl() }
      self.outputs.keys.forEach(self.publishControl)
    }
  }

  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard dataChannel.label == "shape", !buffer.isBinary, buffer.data.count <= 262_144,
          let message = (try? JSONSerialization.jsonObject(with: buffer.data)) as? [String: Any],
          message["t"] as? String == "shape", let key = message["k"] as? String else { return }
    queue.async {
      guard !self.closed, let output = self.outputs[key] else { return }
      DispatchQueue.main.async { output.updateCursor(message) }
    }
  }
}
