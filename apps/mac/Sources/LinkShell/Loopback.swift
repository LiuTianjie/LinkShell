import CoreVideo
import Foundation
import WebRTC

/// A viewer inside the app (`--loopback`): a second peer connection that answers the offer,
/// receives and decodes the picture, and reports what arrived (`rtc.loopback`, once a second).
/// It proves the whole sending side with nothing else running, and gives the latency of that
/// side alone: with `--clock`, from the strip being on the glass to its frame being decoded.
///
/// It has a viewer's channels too, worked from the socket: `rtc.loopback.channel` says one is
/// open, `rtc.loopback.send` sends events up one, and `rtc.loopback.heard` is each message that
/// came down one.
final class Loopback: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, RTCVideoRenderer {
  private let viewer: String
  private let link: Link
  private let readClock: Bool
  private let toSender: (RTCIceCandidate) -> Void
  private var connection: RTCPeerConnection?
  private var track: RTCVideoTrack?
  private var timer: DispatchSourceTimer?
  private var channels: [RTCDataChannel] = []
  private var announced: Set<String> = []
  private var heard: [String: Int] = [:]
  private var closed = false

  private var bytes = Rate()
  private var bufferTime = Rate()
  private var bufferFrames = Rate()
  private var decodeTime = Rate()
  private var decodedFrames = Rate()

  private let lock = NSLock()
  private var latencies: [Int] = []
  private var unread = 0
  /// When the last frame was decoded, and the longest wait for one since the last report.
  private var lastFrame: Double?
  private var gap = 0.0

  init(viewer: String, link: Link, readClock: Bool, toSender: @escaping (RTCIceCandidate) -> Void) {
    self.viewer = viewer
    self.link = link
    self.readClock = readClock
    self.toSender = toSender
    super.init()
    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.bundlePolicy = .maxBundle
    configuration.rtcpMuxPolicy = .require
    connection = Engine.factory.peerConnection(with: configuration, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self)
  }

  func answer(_ offer: String, done: @escaping (String) -> Void) {
    guard let connection else { return }
    connection.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: offer)) { [weak self] error in
      if let error { self?.link.log("loopback: the offer was not taken: \(error.localizedDescription)") }
      if Launch.has("--loopback-no-flexfec"), let video = connection.transceivers.first(where: { $0.mediaType == .video }) {
        // Real negotiation, without editing SDP: models a viewer whose receiver has no FlexFEC.
        let codecs = Engine.factory.rtpReceiverCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs.filter { $0.name.lowercased() != "flexfec-03" }
        do { try video.setCodecPreferences(codecs, error: ()) }
        catch { self?.link.log("loopback: FlexFEC could not be removed from codec preferences: \(error)") }
      }
      connection.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { description, error in
        guard let description else {
          self?.link.log("loopback: no answer: \(error?.localizedDescription ?? "unknown")")
          return
        }
        connection.setLocalDescription(description) { _ in
          DispatchQueue.main.async {
            guard let self, !self.closed else { return }
            // Decoded frames come here; nothing is drawn.
            self.track = connection.transceivers.first { $0.mediaType == .video }?.receiver.track as? RTCVideoTrack
            self.track?.add(self)
            self.startTimer()
            done(description.sdp)
          }
        }
      }
    }
  }

  func add(_ candidate: RTCIceCandidate) {
    connection?.add(candidate) { _ in }
  }

  func close() {
    closed = true
    timer?.cancel()
    track?.remove(self)
    channels.forEach { $0.delegate = nil }
    connection?.delegate = nil
    connection?.close()
    connection = nil
  }

  // MARK: RTCVideoRenderer (on libwebrtc's decoding thread)

  func setSize(_ size: CGSize) {}

  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame else { return }
    let host = HostClock.seconds()
    lock.lock()
    if let lastFrame { gap = max(gap, host - lastFrame) }
    lastFrame = host
    lock.unlock()
    guard readClock else { return }
    let now = StripCode.count(host: host)
    var read: UInt16?
    if let native = frame.buffer as? RTCCVPixelBuffer {
      read = StripCode.read(native.pixelBuffer)
    } else {
      let planes = frame.buffer.toI420()
      read = StripCode.read(luma: planes.dataY, stride: Int(planes.strideY), width: Int(planes.width), height: Int(planes.height))
    }
    lock.lock()
    defer { lock.unlock() }
    if let read {
      let latency = StripCode.difference(now, read)
      // The count goes round every 65 seconds: more than 30 (or a frame from the future) is a
      // misreading, as the viewer page takes it too.
      if latency >= 0, latency <= 30000 { latencies.append(latency) } else { unread += 1 }
    } else {
      unread += 1
    }
  }

  // MARK: RTCPeerConnectionDelegate

  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    DispatchQueue.main.async {
      guard !self.closed else { return }
      self.toSender(candidate)
    }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
    dataChannel.delegate = self
    DispatchQueue.main.async {
      guard !self.closed else { return }
      self.channels.append(dataChannel)
      self.announce(dataChannel)
    }
  }

  // MARK: RTCDataChannelDelegate

  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    DispatchQueue.main.async { self.announce(dataChannel) }
  }

  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    let label = dataChannel.label
    let message = (try? JSONSerialization.jsonObject(with: buffer.data, options: .fragmentsAllowed)) ?? NSNull()
    let bytes = buffer.data.count
    DispatchQueue.main.async {
      guard !self.closed else { return }
      self.heard[label, default: 0] += 1
      self.link.emit(["t": "rtc.loopback.heard", "v": self.viewer, "channel": label, "bytes": bytes, "message": message])
    }
  }

  private func announce(_ channel: RTCDataChannel) {
    guard !closed, channel.readyState == .open, announced.insert(channel.label).inserted else { return }
    link.emit(["t": "rtc.loopback.channel", "v": viewer, "channel": channel.label])
  }

  /// Each event as one message up the channel, as a viewer's page would send it. Anything JSON
  /// can say may be given, so that what the app does with a message that is not an event is seen.
  func send(_ events: [Any], on label: String) {
    guard !closed, let channel = channels.first(where: { $0.label == label && $0.readyState == .open }) else {
      return link.log("loopback: channel \(label) is not open")
    }
    for event in events {
      guard let data = try? JSONSerialization.data(withJSONObject: event, options: .fragmentsAllowed) else { continue }
      channel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }
  }

  // MARK: Numbers

  private func startTimer() {
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + Tuning.statsInterval, repeating: Tuning.statsInterval)
    timer.setEventHandler { [weak self] in self?.report() }
    timer.resume()
    self.timer = timer
  }

  private func report() {
    lock.lock()
    let sorted = latencies.sorted()
    let invalid = unread
    let longest = gap
    latencies = []
    unread = 0
    gap = 0
    lock.unlock()
    connection?.statistics { [weak self] report in
      DispatchQueue.main.async {
        guard let self, !self.closed else { return }
        let reader = StatsReader(report: report)
        let inbound = reader.first("inbound-rtp", kind: "video")
        let codec = reader.linked(inbound, "codecId")
        let time = (inbound?.timestamp_us ?? report.timestamp_us) / 1e6
        let number = StatsReader.number
        let text = StatsReader.text
        func average(_ total: inout Rate, _ totalKey: String, _ count: inout Rate, _ countKey: String) -> Double? {
          let seconds = total.step(number(inbound, totalKey))
          let frames = count.step(number(inbound, countKey))
          guard let seconds, let frames, frames > 0 else { return nil }
          return seconds / frames * 1000
        }
        var message: [String: Any] = [
          "t": "rtc.loopback",
          "v": self.viewer,
          "framesReceived": json(number(inbound, "framesReceived")),
          "framesDecoded": json(number(inbound, "framesDecoded")),
          "fps": json(number(inbound, "framesPerSecond")),
          "width": json(number(inbound, "frameWidth")),
          "height": json(number(inbound, "frameHeight")),
          "bitrate": json(self.bytes.per(second: number(inbound, "bytesReceived"), at: time).map { ($0 * 8).rounded() }),
          "codec": json(text(codec, "mimeType").map { $0.replacingOccurrences(of: "video/", with: "") }),
          "decoder": json(text(inbound, "decoderImplementation")),
          "keyFrames": json(number(inbound, "keyFramesDecoded")),
          "jitterBufferMs": json(average(&self.bufferTime, "jitterBufferDelay", &self.bufferFrames, "jitterBufferEmittedCount")),
          "decodeMs": json(average(&self.decodeTime, "totalDecodeTime", &self.decodedFrames, "framesDecoded")),
          "framesDropped": json(number(inbound, "framesDropped")),
          "freezes": json(number(inbound, "freezeCount")),
          // The longest the receiving end went without a decoded frame.
          "gapMs": (longest * 1000).rounded(),
          "packetsLost": json(number(inbound, "packetsLost")),
          "fecPacketsReceived": json(number(inbound, "fecPacketsReceived")),
          "fecBytesReceived": json(number(inbound, "fecBytesReceived")),
          "nack": json(number(inbound, "nackCount")),
          "pli": json(number(inbound, "pliCount")),
          // Messages that came down each channel (the pointer's place, on `cursor`).
          "heard": self.heard,
        ]
        if self.readClock {
          message["invalid"] = invalid
          message["latency"] = sorted.isEmpty
            ? ["n": 0]
            : ["n": sorted.count, "min": sorted[0], "p50": sorted[sorted.count / 2], "p95": sorted[min(sorted.count - 1, sorted.count * 95 / 100)], "max": sorted[sorted.count - 1]]
        }
        self.link.emit(message)
      }
    }
  }
}
