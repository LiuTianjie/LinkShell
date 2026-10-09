import Foundation
import Network
import QuartzCore
import WebRTC

/// Signalling uses the existing authenticated, encrypted loopback forwarder. Only video and
/// input use the peer connection; no second account, pairing or media-relay protocol is added.
final class ScreenConnection: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  var onMessage: (([String: Any]) -> Void)?
  var onFailure: ((String) -> Void)?
  var onStats: (([String: Any]) -> Void)?
  private let queue = DispatchQueue(label: "linkshell.screen.connection", qos: .userInteractive)
  private let renderer: ScreenMetalView
  private let metrics: ScreenMetrics
  private let url: URL
  private let maxFps: Int
  private var socket: NWConnection?
  private var factory: RTCPeerConnectionFactory?
  private var peer: RTCPeerConnection?
  private var track: RTCVideoTrack?
  private var channels: [String: RTCDataChannel] = [:]
  private var candidates: [RTCIceCandidate] = []
  private var closed = false
  private var trusted = false
  private var controlRequested = false
  private var ready = false
  private var eventNumber = 0
  private var timer: DispatchSourceTimer?
  private var startedAt = CACurrentMediaTime()
  private var previousAt = CACurrentMediaTime()
  private var previousFrames: Double?
  private var statsPending = false
  private var senderStats: [String: Any] = [:]
  private var disconnectedAt: Double?
  private var receivedPicture = false
  private static let initialize: Void = { RTCInitializeSSL() }()

  init?(url: String, maxFps: Int, renderer: ScreenMetalView, metrics: ScreenMetrics) {
    guard var target = URLComponents(string: url), target.scheme == "http", target.host == "127.0.0.1", target.port != nil else { return nil }
    target.scheme = "ws"
    target.path = "/stream"
    target.fragment = nil
    target.queryItems = (target.queryItems ?? []).filter { !["video", "maxFps", "diagnostics"].contains($0.name) }
      + [URLQueryItem(name: "video", value: "1"), URLQueryItem(name: "maxFps", value: String(maxFps)), URLQueryItem(name: "diagnostics", value: metrics.enabled ? "1" : "0")]
    guard let address = target.url else { return nil }
    self.url = address; self.maxFps = maxFps; self.renderer = renderer; self.metrics = metrics
    super.init()
  }

  func start() {
    queue.async {
      guard !self.closed else { return }
      _ = Self.initialize
      let options = NWProtocolWebSocket.Options()
      options.autoReplyPing = true
      options.maximumMessageSize = 512 * 1024
      let parameters = NWParameters.tcp
      parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
      parameters.preferNoProxies = true
      let socket = NWConnection(to: .url(self.url), using: parameters)
      self.socket = socket
      socket.stateUpdateHandler = { [weak self] state in
        guard let self, !self.closed else { return }
        switch state {
        case .ready:
          self.ready = true
          if self.controlRequested { self.signal(["t": "control"]) }
          self.receive()
        case .failed: self.fail("屏幕连接失败，可切换兼容模式重试")
        default: break
        }
      }
      self.startedAt = CACurrentMediaTime()
      self.previousAt = self.startedAt
      socket.start(queue: self.queue)
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now() + 1, repeating: 1)
      timer.setEventHandler { [weak self] in self?.report() }
      timer.resume()
      self.timer = timer
    }
  }

  func stop() { queue.async { self.close() } }
  func pictureArrived() { queue.async { self.receivedPicture = true } }

  func requestControl() {
    queue.async {
      guard !self.closed, !self.controlRequested else { return }
      self.controlRequested = true
      if self.ready { self.signal(["t": "control"]) }
    }
  }

  func input(_ message: [String: Any], replaceable: Bool = false) {
    queue.async {
      guard !self.closed, self.trusted || message["t"] as? String == "prompt" else { return }
      // A full reliable queue means the old input is no longer safe to act on. Closing the
      // peer also releases held keys on the host, instead of leaving a delayed mouse-up behind.
      let channel = self.channels[replaceable ? "pointer" : "input"]
      guard let channel, channel.readyState == .open else { return }
      // A deliberate paste can be larger than pointer traffic; it still has a strict bound.
      if channel.bufferedAmount > (replaceable ? 16_384 : 262_144) {
        if !replaceable { self.fail("控制连接拥堵，请重新连接") }
        return
      }
      self.eventNumber += 1
      var event = message
      event["i"] = self.eventNumber
      guard let data = try? JSONSerialization.data(withJSONObject: event), data.count <= 64_000 else { return }
      if !channel.sendData(RTCDataBuffer(data: data, isBinary: false)), !replaceable {
        self.fail("控制连接已中断，请重新连接")
      }
    }
  }

  private func close() {
    guard !closed else { return }
    closed = true
    timer?.cancel(); timer = nil
    track?.remove(renderer); track = nil
    for channel in channels.values { channel.delegate = nil }
    channels.removeAll()
    peer?.delegate = nil
    peer?.close(); peer = nil
    factory = nil
    candidates.removeAll()
    socket?.stateUpdateHandler = nil
    socket?.cancel(); socket = nil
  }

  private func fail(_ message: String) {
    guard !closed else { return }
    close()
    onFailure?(message)
  }

  private func signal(_ message: [String: Any]) {
    guard !closed, let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    let context = NWConnection.ContentContext(identifier: "screen-signal", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
    socket?.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
      if error != nil { self?.fail("屏幕信令连接已中断") }
    })
  }

  private func receive() {
    socket?.receiveMessage { [weak self] data, context, _, error in
      guard let self, !self.closed else { return }
      if error != nil { self.fail("屏幕连接已中断"); return }
      let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
      if metadata?.opcode == .close { self.fail("屏幕连接已结束"); return }
      if metadata?.opcode == .binary { self.fail("当前链路需要兼容模式"); return }
      if let data, let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { self.message(message) }
      if !self.closed { self.receive() }
    }
  }

  private func message(_ message: [String: Any]) {
    if let error = message["error"] as? String { return fail(error) }
    if let state = message["control"] as? [String: Any] {
      trusted = state["available"] as? Bool == true && state["trusted"] as? Bool == true
      onMessage?(["control": state])
    }
    guard let rtc = message["rtc"] as? [String: Any], let type = rtc["t"] as? String else { return }
    switch type {
    case "config":
      guard peer == nil else { return }
      let configuration = RTCConfiguration()
      configuration.sdpSemantics = .unifiedPlan
      configuration.bundlePolicy = .maxBundle
      configuration.rtcpMuxPolicy = .require
      configuration.continualGatheringPolicy = .gatherContinually
      configuration.iceServers = ((rtc["iceServers"] as? [[String: Any]]) ?? []).compactMap { server in
        guard let urls = server["urls"] as? [String], !urls.isEmpty else { return nil }
        return RTCIceServer(urlStrings: urls)
      }
      let factory = RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: ScreenDecoderFactory(metrics: metrics))
      self.factory = factory
      peer = factory.peerConnection(with: configuration, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self)
      if peer == nil { fail("原生视频连接无法启动") }
    case "offer":
      guard let peer, let sdp = rtc["sdp"] as? String, sdp.utf8.count < 128_000 else { return fail("电脑返回了无效的视频协商信息") }
      peer.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { [weak self, weak peer] error in
        self?.queue.async { [weak self, weak peer] in
          guard let self, let peer, !self.closed, self.peer === peer else { return }
          if error != nil { return self.fail("视频格式协商失败") }
          for candidate in self.candidates { peer.add(candidate) { _ in } }
          self.candidates.removeAll()
          self.attachTrack(peer)
          peer.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self, weak peer] answer, error in
            guard let self, let peer else { return }
            self.queue.async {
              guard !self.closed, self.peer === peer else { return }
              guard error == nil, let answer else { return self.fail("无法应答电脑的视频连接") }
              peer.setLocalDescription(answer) { [weak self, weak peer] error in
                self?.queue.async { [weak self, weak peer] in
                  guard let self, let peer, !self.closed, self.peer === peer else { return }
                  if error != nil { return self.fail("视频连接应答失败") }
                  self.attachTrack(peer)
                  self.signal(["t": "rtc.answer", "sdp": answer.sdp])
                }
              }
            }
          }
        }
      }
    case "ice":
      guard let line = rtc["candidate"] as? String, line.utf8.count < 8192 else { return }
      let candidate = RTCIceCandidate(sdp: line, sdpMLineIndex: Int32(clamping: (rtc["sdpMLineIndex"] as? Int) ?? 0), sdpMid: rtc["sdpMid"] as? String)
      if let peer, peer.remoteDescription != nil { peer.add(candidate) { _ in } }
      else if candidates.count < 256 { candidates.append(candidate) }
    case "stats": senderStats = rtc
    case "off": fail("当前网络无法建立视频直连，请使用兼容模式")
    default: break
    }
  }

  private func attachTrack(_ peer: RTCPeerConnection) {
    guard let incoming = peer.transceivers.first(where: { $0.mediaType == .video })?.receiver.track as? RTCVideoTrack, incoming !== track else { return }
    track?.remove(renderer)
    track = incoming
    incoming.add(renderer)
  }

  private func report() {
    guard !closed else { return }
    let now = CACurrentMediaTime()
    if !receivedPicture, now - startedAt > 12 { return fail("视频直连超时，请使用兼容模式") }
    if let disconnectedAt, now - disconnectedAt > 4 { return fail("视频直连已中断，请重新连接") }
    guard metrics.enabled, !statsPending, now - previousAt >= 5, let peer else { return }
    statsPending = true
    peer.statistics { [weak self, weak peer] report in
      self?.queue.async { [weak self, weak peer] in
        guard let self, let peer, !self.closed, self.peer === peer else { return }
        self.statsPending = false
        let elapsed = now - self.previousAt
        self.previousAt = now
        let records = Array(report.statistics.values)
        let inbound = records.first { $0.type == "inbound-rtp" && (($0.values["kind"] as? String ?? $0.values["mediaType"] as? String) == "video") }
        let transport = records.first { $0.type == "transport" }
        let pairID = transport?.values["selectedCandidatePairId"] as? String
        let pair = records.first { $0.type == "candidate-pair" && $0.id == pairID }
          ?? records.first { $0.type == "candidate-pair" && ($0.values["nominated"] as? NSNumber)?.boolValue == true && $0.values["state"] as? String == "succeeded" }
        func number(_ record: RTCStatistics?, _ key: String) -> Double? { (record?.values[key] as? NSNumber)?.doubleValue }
        var stats = self.metrics.snapshot(seconds: elapsed)
        #if targetEnvironment(simulator)
        stats["presentationTimingAvailable"] = false
        #else
        stats["presentationTimingAvailable"] = true
        #endif
        if let frames = number(inbound, "framesDecoded") {
          if let previous = self.previousFrames { stats["decodedFps"] = max(0, frames - previous) / max(0.001, elapsed) }
          self.previousFrames = frames
        }
        stats["requestedFps"] = self.maxFps
        stats["replacedFrames"] = self.renderer.takeReplacements()
        stats["width"] = number(inbound, "frameWidth")
        stats["height"] = number(inbound, "frameHeight")
        stats["rttMs"] = number(pair, "currentRoundTripTime").map { $0 * 1000 }
        stats["packetsLost"] = number(inbound, "packetsLost")
        stats["nack"] = number(inbound, "nackCount")
        stats["pli"] = number(inbound, "pliCount")
        stats["sender"] = self.senderStats
        self.onStats?(stats)
        var measured = stats
        measured.removeValue(forKey: "trace")
        measured["t"] = "measure"; measured["mode"] = "native"
        self.signal(measured)
      }
    }
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
      case .connected, .completed: self.disconnectedAt = nil; self.attachTrack(peerConnection)
      case .disconnected: if self.disconnectedAt == nil { self.disconnectedAt = CACurrentMediaTime() }
      case .failed: self.fail("当前网络无法建立视频直连，请使用兼容模式")
      default: break
      }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
    queue.async {
      guard !self.closed, self.peer === peerConnection else { return }
      self.channels[dataChannel.label] = dataChannel
      dataChannel.delegate = self
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard !buffer.isBinary, buffer.data.count <= 256_000 else { return }
    let data = buffer.data
    queue.async {
      guard !self.closed, self.channels[dataChannel.label] === dataChannel else { return }
      guard let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
      self.onMessage?(message)
    }
  }
}
