import AppKit
import CoreVideo
import WebRTC
import XCTest
@testable import LinkShell

/// Opt in on a real Mac with LINKSHELL_NATIVE_SCREEN_LOOPBACK=1. This uses local ICE and
/// generated pixels, without screen-recording permission, a window, or OS input injection.
final class DesktopScreenLoopbackTests: XCTestCase {
  func testNativePeerDecodesSyntheticH264InHardwareAndStopsReceiving() throws {
    guard ProcessInfo.processInfo.environment["LINKSHELL_NATIVE_SCREEN_LOOPBACK"] == "1" else {
      throw XCTSkip("Native WebRTC loopback requires explicit local-network and hardware integration opt-in")
    }
    XCTAssertTrue(Thread.isMainThread)
    _ = NSApplication.shared
    let surface = DesktopScreenSurface(frame: CGRect(x: 0, y: 0, width: 640, height: 360))
    let decoded = expectation(description: "VideoToolbox confirms hardware after decoding a real H264 frame")
    var hardwareStatus: [String: Any]?
    var errors: [String] = []
    var lateEvents = 0
    var stopped = false
    var sender: SyntheticScreenSender?
    let receiver = DesktopScreenReceiver(surface: surface, onSignal: { message in
      if stopped { lateEvents += 1 }
      sender?.receive(message)
    }, onStatus: { status in
      if stopped { lateEvents += 1 }
      if status["hardware"] as? Bool == true, hardwareStatus == nil {
        hardwareStatus = status
        decoded.fulfill()
      }
    }, onFailure: { message in
      if stopped { lateEvents += 1 }
      errors.append(message)
    })
    sender = try SyntheticScreenSender(toReceiver: { receiver.receive($0) }, onFailure: { errors.append($0) })
    defer { receiver.stop(); surface.stop(); sender?.stop() }

    sender?.start()
    wait(for: [decoded], timeout: 20)
    XCTAssertEqual(hardwareStatus?["codec"] as? String, "H264")
    XCTAssertEqual(hardwareStatus?["decoder"] as? String, "LinkShellVideoToolboxH264Hardware")
    XCTAssertTrue(eventually { surface.receivedFrameCount >= 3 }, "Decoded CVPixelBuffers must reach the native surface")
    XCTAssertTrue(errors.isEmpty, errors.joined(separator: "\n"))

    // Let already-enqueued main-queue notifications drain, then continue sending real media
    // and stale signaling. A stopped mount must never revive or report an error to its successor.
    receiver.stop()
    settle(for: 0.1)
    stopped = true
    let lastCount = surface.receivedFrameCount
    receiver.receive(["rtc": ["t": "off"]])
    receiver.receive(["rtc": ["t": "config", "iceServers": []]])
    receiver.receive(["rtc": ["t": "offer", "sdp": "stale"]])
    settle(for: 0.3)
    XCTAssertEqual(surface.receivedFrameCount, lastCount)
    XCTAssertEqual(lateEvents, 0)
    XCTAssertTrue(errors.isEmpty, errors.joined(separator: "\n"))
    print("native-screen-loopback: H264 hardware=true decoder=LinkShellVideoToolboxH264Hardware nativeFrames=\(lastCount); stopped mount rejected late signaling/media")
  }

  private func eventually(_ predicate: @escaping () -> Bool) -> Bool {
    let ready = expectation(description: "Native renderer receives decoded pixels")
    let timer = DispatchSource.makeTimerSource(queue: .main)
    var fulfilled = false
    timer.schedule(deadline: .now(), repeating: 0.02)
    timer.setEventHandler {
      if !fulfilled, predicate() { fulfilled = true; ready.fulfill() }
    }
    timer.resume()
    defer { timer.cancel() }
    return XCTWaiter.wait(for: [ready], timeout: 3) == .completed
  }

  private func settle(for duration: TimeInterval) {
    let settled = expectation(description: "Drain native peer callbacks")
    DispatchQueue.main.asyncAfter(deadline: .now() + duration) { settled.fulfill() }
    wait(for: [settled], timeout: duration + 1)
  }
}

private final class SyntheticScreenSender: NSObject, RTCPeerConnectionDelegate {
  private let factory = Engine.screenFactory(maximumFrameRate: 30)
  private let toReceiver: ([String: Any]) -> Void
  private let onFailure: (String) -> Void
  private var peer: RTCPeerConnection?
  private var source: RTCVideoSource?
  private var capturer: RTCVideoCapturer?
  private var timer: DispatchSourceTimer?
  private var pendingCandidates: [RTCIceCandidate] = []
  private var channels: [RTCDataChannel] = []
  private let pixels: CVPixelBuffer
  private var closed = false

  init(toReceiver: @escaping ([String: Any]) -> Void, onFailure: @escaping (String) -> Void) throws {
    self.toReceiver = toReceiver
    self.onFailure = onFailure
    var buffer: CVPixelBuffer?
    let properties: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any], kCVPixelBufferMetalCompatibilityKey: true]
    let result = CVPixelBufferCreate(nil, 320, 180, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, properties as CFDictionary, &buffer)
    guard result == kCVReturnSuccess, let buffer else { throw NativeLoopbackError("Could not allocate test pixels: \(result)") }
    pixels = buffer
    super.init()
    CVPixelBufferLockBaseAddress(pixels, [])
    for plane in 0..<CVPixelBufferGetPlaneCount(pixels) {
      if let address = CVPixelBufferGetBaseAddressOfPlane(pixels, plane) {
        memset(address, plane == 0 ? 96 : 128, CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane))
      }
    }
    CVPixelBufferUnlockBaseAddress(pixels, [])

    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.bundlePolicy = .maxBundle
    configuration.rtcpMuxPolicy = .require
    configuration.iceServers = []
    configuration.disableLinkLocalNetworks = true
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
      throw NativeLoopbackError("Could not create synthetic sender peer")
    }
    self.peer = peer
    let source = factory.videoSource(forScreenCast: true)
    self.source = source
    capturer = RTCVideoCapturer(delegate: source)
    let track = factory.videoTrack(with: source, trackId: "synthetic-screen")
    let sending = RTCRtpTransceiverInit()
    sending.direction = .sendOnly
    sending.streamIds = ["native-screen-test"]
    guard let transceiver = peer.addTransceiver(with: track, init: sending) else {
      throw NativeLoopbackError("Could not add synthetic video track")
    }
    // The integration must prove our H264 decoder, rather than happen to negotiate another codec.
    let preferred = Codecs.preferences("h264", from: factory.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs)
    let codecs = preferred.codecs.filter { ["H264", "RTX", "RED", "ULPFEC", "FLEXFEC-03"].contains($0.name.uppercased()) }
    try transceiver.setCodecPreferences(codecs, error: ())
    for label in ["input", "pointer", "cursor", "shape"] {
      let delivery = RTCDataChannelConfiguration()
      if label == "pointer" || label == "cursor" { delivery.isOrdered = false; delivery.maxRetransmits = 0 }
      if let channel = peer.dataChannel(forLabel: label, configuration: delivery) { channels.append(channel) }
    }
  }

  func start() {
    guard let peer, !closed else { return }
    toReceiver(["session": ["t": "capabilities", "version": 1, "configure": true, "pause": true]])
    toReceiver(["rtc": ["t": "config", "iceServers": []]])
    peer.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self] description, error in
      DispatchQueue.main.async {
        guard let self, !self.closed else { return }
        guard let description, error == nil else { self.onFailure("Synthetic offer failed: \(String(describing: error))"); return }
        peer.setLocalDescription(description) { [weak self] error in
          DispatchQueue.main.async {
            guard let self, !self.closed else { return }
            if let error { self.onFailure("Synthetic local SDP failed: \(error)"); return }
            self.toReceiver(["rtc": ["t": "offer", "sdp": description.sdp]])
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now(), repeating: 1.0 / 15.0)
            timer.setEventHandler { [weak self] in self?.capture() }
            timer.resume()
            self.timer = timer
          }
        }
      }
    }
  }

  func receive(_ message: [String: Any]) {
    guard let peer, !closed else { return }
    switch message["t"] as? String {
    case "rtc.answer":
      guard let sdp = message["sdp"] as? String else { return }
      peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
        DispatchQueue.main.async {
          guard let self, !self.closed else { return }
          if let error { self.onFailure("Synthetic answer failed: \(error)"); return }
          self.pendingCandidates.forEach { peer.add($0) { _ in } }
          self.pendingCandidates.removeAll()
        }
      }
    case "rtc.ice":
      guard let sdp = message["candidate"] as? String, let index = message["sdpMLineIndex"] as? Int else { return }
      let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32(index), sdpMid: message["sdpMid"] as? String)
      if peer.remoteDescription != nil { peer.add(candidate) { _ in } } else { pendingCandidates.append(candidate) }
    default: break
    }
  }

  func stop() {
    guard !closed else { return }
    closed = true
    timer?.cancel(); timer = nil
    peer?.delegate = nil
    peer?.close(); peer = nil
    channels.removeAll(); pendingCandidates.removeAll()
    capturer = nil; source = nil
  }

  private func capture() {
    guard !closed, let capturer, let source else { return }
    let timestamp = Int64(ProcessInfo.processInfo.systemUptime * 1_000_000_000)
    source.capturer(capturer, didCapture: RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixels), rotation: ._0, timeStampNs: timestamp))
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.closed else { return }
      var signal: [String: Any] = ["t": "ice", "candidate": candidate.sdp, "sdpMLineIndex": Int(candidate.sdpMLineIndex)]
      signal["sdpMid"] = candidate.sdpMid.map { $0 as Any } ?? NSNull()
      self.toReceiver(["rtc": signal])
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

private struct NativeLoopbackError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}
