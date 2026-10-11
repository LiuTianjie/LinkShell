import AppKit
import CoreMedia
import CryptoKit
import Darwin
import Foundation
import WebRTC

/// An explicitly requested, loopback-only comparison of media scheduling. Both endpoints use
/// the same capture, VideoToolbox and H.264 decoder as the normal path. No remote endpoint,
/// pairing secret or production transport can be selected through this laboratory.
final class MediaLab: NSObject, RTCVideoCapturerDelegate {
  private let link: Link
  private let viewer: String
  private let request: ScreenRequest
  private let codecOnly = Launch.has("--lab-codec-only")
  private let codecPendingLimit = min(8, max(1, Launch.value(after: "--lab-encoder-pending").flatMap(Int.init) ?? 2))
  private let queue = DispatchQueue(label: "com.bd.linkshell.media-lab", qos: .userInteractive)
  private let incoming = Locked((frame: RTCVideoFrame?.none, scheduled: false))
  private let secret = SymmetricKey(size: .bits256)
  private var mediaSend: MediaDatagramCipher!
  private var mediaReceive: MediaDatagramCipher!
  private var feedbackSend: MediaDatagramCipher!
  private var feedbackReceive: MediaDatagramCipher!
  private var sender: MediaLoopbackSocket?
  private var receiver: MediaLoopbackSocket?
  private var capture: ScreenCapturer?
  private var compressor: VideoCompressor?
  private var decoder: RTCVideoDecoder?
  private var motion: MotionWindow?
  private var awake: Awake?
  private var timer: DispatchSourceTimer?
  private var pacing: DispatchSourceTimer?
  private var feedback: DispatchSourceTimer?
  private var closed = false
  private var started = false
  private var deadline = MediaDeadline()
  private var rate = MediaRate(maximum: 24_000_000)
  private var assembler = MediaFrameAssembler()
  private var pending = 0
  private var nextID: UInt32 = 0
  private var previousEncoded: UInt32 = 0
  private var previousSubmitted: UInt32 = 0
  private var awaitingRefresh = true
  private var decoding: [UInt32: (frame: MediaFrame, began: Double)] = [:]
  private var tokens: [UInt32: UInt64] = [:]
  private var qualityReferences: [UInt32: MediaQuality] = [:]
  private var acknowledged: UInt64?
  private var lastDecoded: UInt32 = 0
  private var lastReference: UInt32 = 0
  private var receivedBytes: UInt64 = 0
  private var lastReceivedStamp: UInt64 = 0
  private var lastReceivedAt: Double = 0
  private var lastFeedbackBytes: UInt64 = 0
  private var lastSentAt = 0.0
  private var lastAcknowledgedSend = 0.0
  private var lastProbeAt = 0.0
  private var packetClock = MediaPacing()
  private var lastReported = 0.0
  private var lastDecodedAt: Double?
  private var gap = 0.0
  private var totalDecoded = 0
  private var totalSent = 0
  private var totalPackets = 0
  private var totalRejected = 0
  private var ltrRefreshes = 0
  private var keyframes = 0
  private var frameRate = 60
  private var steps: FrameRate?
  private var dimensions = (width: 0, height: 0)
  private var display: Display?
  private var counts = Counts()

  private struct Counts {
    var encoded = 0, decoded = 0, bytes = 0, packets = 0, encoderDropped = 0
    var encoding: [Double] = [], decoding: [Double] = [], ages: [Double] = [], packetWait: [Double] = [], quantizers: [Double] = []
    var quality: [MediaQuality.Difference] = []
  }

  init(request: ScreenRequest, link: Link) {
    self.request = request; viewer = request.viewer; self.link = link
    super.init()
    if let milliseconds = Launch.value(after: "--lab-deadline-ms").flatMap(Double.init), milliseconds.isFinite {
      deadline = MediaDeadline(frameLifetime: min(500, max(50, milliseconds)) / 1000)
    }
    mediaSend = MediaDatagramCipher(secret: secret, direction: 1)
    mediaReceive = MediaDatagramCipher(secret: secret, direction: 1)
    feedbackSend = MediaDatagramCipher(secret: secret, direction: 2)
    feedbackReceive = MediaDatagramCipher(secret: secret, direction: 2)
  }

  func start() {
    guard Launch.has("--media-lab"), Launch.has("--loopback"), Permissions.recording(),
          let display = Display.at(request.screen) else { return fail("媒体实验需要回环模式和已有屏幕录制权限") }
    dimensions = display.pictureSize(maxWidth: request.maxWidth)
    self.display = display
    frameRate = request.fps ?? Tuning.fullRate(viewer: request.maxFps, display: display.screen?.maximumFramesPerSecond ?? 60)
    if request.fps == nil, frameRate > 30 { steps = FrameRate(full: frameRate, reduced: frameRate > 60 ? 60 : 30, lowest: 30) }
    rate = MediaRate(maximum: Double(Tuning.maxBitrate(width: dimensions.width, height: dimensions.height, fps: frameRate)))
    if codecOnly, let bitrate = Launch.value(after: "--lab-bitrate").flatMap(Double.init), bitrate.isFinite {
      rate = MediaRate(maximum: 30_000_000, initial: bitrate)
    }
    awake = Awake()
    if let screen = display.screen {
      motion = MotionWindow(screen: screen); motion?.show()
    }
    let capture = ScreenCapturer(delegate: self)
    self.capture = capture
    queue.async { [self] in
      do {
        sender = try MediaLoopbackSocket(queue: queue) { [weak self] in self?.acceptFeedback($0) }
        receiver = try MediaLoopbackSocket(queue: queue) { [weak self] in self?.acceptMedia($0) }
        compressor = try VideoCompressor(.init(width: dimensions.width, height: dimensions.height, fps: frameRate,
          bitrate: Int(rate.bitrate), longTermReferences: !codecOnly && !Launch.has("--lab-no-ltr"),
          codec: codecOnly && request.codec == "hevc" ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264))
        // Only this exact decoder's successful callbacks can acknowledge a reference.
        let decoder = RTCVideoDecoderFactoryH264().createDecoder(RTCVideoCodecInfo(name: "H264"))
        guard let decoder, decoder.startDecode(withNumberOfCores: 2) == 0 else { return fail("媒体实验解码器启动失败") }
        self.decoder = decoder
        decoder.setCallback { [weak self] frame in
          self?.queue.async { [weak self] in self?.decoded(frame) }
        }
        link.emit(["t": "lab.ready", "v": viewer, "senderPort": sender!.port, "receiverPort": receiver!.port,
          "width": dimensions.width, "height": dimensions.height, "fps": frameRate,
          "mode": codecOnly ? "codec-only" : "udp", "codec": codecOnly ? request.codec : "h264",
          "hardware": compressor?.hardware ?? false, "encoderMode": compressor?.mode ?? "unknown",
          "ltr": compressor?.longTermReferences ?? false, "deadlineMs": deadline.frameLifetime * 1000])
      } catch { fail("媒体实验初始化失败：\(error)") }
    }
  }

  /// Only loopback ports, whether direct or supplied by the owned congestion proxy.
  func route(senderPort: Int, receiverPort: Int) {
    guard (1...65535).contains(senderPort), (1...65535).contains(receiverPort) else { return }
    queue.async { [self] in
      guard !closed, !started, let display else { return }
      started = true
      sender?.destination = UInt16(senderPort)
      receiver?.destination = UInt16(receiverPort)
      lastReported = Self.now
      let pacing = DispatchSource.makeTimerSource(queue: queue)
      pacing.setEventHandler { [weak self] in self?.sendPacket() }
      pacing.schedule(deadline: .distantFuture); pacing.resume(); self.pacing = pacing
      let feedback = DispatchSource.makeTimerSource(queue: queue)
      feedback.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(1))
      feedback.setEventHandler { [weak self] in self?.sendFeedback(); self?.probeIfQuiet() }
      feedback.resume(); self.feedback = feedback
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(5))
      timer.setEventHandler { [weak self] in self?.report() }
      timer.resume(); self.timer = timer
      capture?.start(display: display, width: dimensions.width, height: dimensions.height, fps: frameRate) { [weak self] error in
        if let error { self?.fail(error) }
      }
    }
  }

  func close() {
    capture?.stop(); motion?.hide(); motion = nil; awake = nil
    queue.async { [self] in
      closed = true
      timer?.cancel(); pacing?.cancel(); feedback?.cancel()
      timer = nil; pacing = nil; feedback = nil
      sender?.close(); receiver?.close(); sender = nil; receiver = nil
      _ = decoder?.release(); decoder = nil; compressor = nil
      decoding.removeAll(); tokens.removeAll()
      qualityReferences.removeAll()
      incoming.withLock { $0.frame = nil }
    }
  }

  // The capture thread only replaces one raw frame. It cannot enqueue a growing list of
  // pixel buffers while the encoder/transport queue is occupied.
  func capturer(_ capturer: RTCVideoCapturer, didCapture frame: RTCVideoFrame) {
    let schedule = incoming.withLock { value in
      value.frame = frame
      if value.scheduled { return false }
      value.scheduled = true; return true
    }
    if schedule { queue.async { [weak self] in self?.encodeNewest() } }
  }

  private func encodeNewest() {
    let frame = incoming.withLock { value -> RTCVideoFrame? in
      defer { value.frame = nil; value.scheduled = false }; return value.frame
    }
    guard !closed, let frame, let native = frame.buffer as? RTCCVPixelBuffer, let compressor else { return }
    let began = Self.now
    rate.tick(at: began, outstanding: lastSentAt > lastAcknowledgedSend)
    if codecOnly { guard pending < codecPendingLimit else { return } }
    else { guard deadline.admitRaw(at: began, bitrate: rate.bitrate, pending: pending) else { return } }
    guard nextID < UInt32.max else { return fail("媒体实验帧序号耗尽") }
    nextID += 1; let id = nextID
    let recover = codecOnly ? nextID == 1 : deadline.needsRefresh
    let reference = acknowledged
    let refresh = recover && compressor.longTermReferences && reference != nil
    let key = recover && !refresh
    if Launch.has("--lab-quality"), recover || id % 31 == 0 {
      if qualityReferences.count >= 64, let oldest = qualityReferences.keys.min() { qualityReferences[oldest] = nil }
      qualityReferences[id] = MediaQuality(native.pixelBuffer)
    }
    compressor.setRates(bitrate: Int(rate.bitrate), ceiling: nil, fps: frameRate)
    compressor.keyPlan = .init(budget: max(1024, Int(rate.bitrate) / 8 / 5), finest: nil)
    pending += 1
    compressor.encode(native.pixelBuffer, at: CMTime(value: frame.timeStampNs, timescale: 1_000_000_000),
      key: key, refresh: refresh, acknowledged: reference.map { [$0] } ?? []) { [weak self] result in
      self?.queue.async { [weak self] in
        guard let self, !self.closed else { return }
        self.pending -= 1
        switch result {
        case .failure(let error): self.fail("媒体实验编码失败：\(error)")
        case .success(nil): self.counts.encoderDropped += 1; self.qualityReferences[id] = nil
        case .success(let encoded?):
          self.counts.encoded += 1; self.counts.encoding.append((Self.now - began) * 1000)
          if self.codecOnly {
            self.counts.bytes += CMSampleBufferGetTotalSampleSize(encoded.sample)
            return
          }
          guard let bytes = encoded.accessUnit() else { return self.fail("媒体实验收到无效 H.264") }
          if let qp = encoded.quantizer { self.counts.quantizers.append(Double(qp)) }
          if encoded.key { self.keyframes += 1 }
          if refresh && !encoded.key { self.ltrRefreshes += 1 }
          if let token = encoded.referenceToken {
            self.tokens[id] = token
            if self.tokens.count > 256, let oldest = self.tokens.keys.min() { self.tokens[oldest] = nil }
          }
          let flags: UInt8 = (encoded.key ? 1 : 0) | (refresh && !encoded.key ? 2 : 0) | (encoded.referenceToken != nil ? 4 : 0)
          let picture = MediaFrame(id: id, previous: self.previousEncoded, capturedNs: UInt64(began * 1e9), flags: flags, data: bytes)
          self.previousEncoded = id
          if self.deadline.enqueue(picture, at: Self.now) { self.schedulePacket() }
        }
      }
    }
  }

  private func schedulePacket() {
    guard !deadline.queue.isEmpty else { return }
    pacing?.schedule(deadline: .now() + max(0, packetClock.next - Self.now), leeway: .microseconds(100))
  }

  private func sendPacket() {
    guard !closed else { return }
    for _ in 0..<8 {
      let now = Self.now
      guard packetClock.ready(at: now) else { break }
      guard let next = deadline.nextPacket(at: now) else { pacing?.schedule(deadline: .distantFuture); return }
      var payload = Data(); payload.mediaAppend(UInt64(now * 1e9)); payload.append(next.payload)
      do {
        let packet = try mediaSend.seal(payload)
        try sender?.send(packet)
        lastSentAt = now
        totalSent += packet.count; totalPackets += 1
        counts.bytes += packet.count; counts.packets += 1; counts.packetWait.append(next.waitMs)
        packetClock.sent(bytes: packet.count, at: now, bitrate: rate.pacingBitrate)
      } catch { return fail("媒体实验发送失败：\(error)") }
    }
    schedulePacket()
  }

  private func acceptMedia(_ packet: Data) {
    guard !closed else { return }
    do {
      var reader = MediaReader(try mediaReceive.open(packet))
      guard let sent = reader.uint64() else { totalRejected += 1; return }
      let now = Self.now
      receivedBytes += UInt64(packet.count); lastReceivedStamp = sent; lastReceivedAt = now
      let body = reader.rest
      if body.first == 3 { sendFeedback(force: true) }
      else { assembler.receive(body, at: now); drainDecoder() }
    } catch { totalRejected += 1 }
  }

  private func drainDecoder() {
    guard let decoder, decoding.count < 2,
          let frame = assembler.take(after: previousSubmitted, needsRefresh: awaitingRefresh) else { return }
    let now = Self.now
    let maximumAge = lastDecoded == 0 || frame.independent ? 0.8 : deadline.frameLifetime
    guard now - Double(frame.capturedNs) / 1e9 <= maximumAge else { awaitingRefresh = true; return }
    if awaitingRefresh && !frame.independent { return }
    let image = RTCEncodedImage()
    image.buffer = frame.data; image.timeStamp = frame.id
    image.encodedWidth = Int32(dimensions.width); image.encodedHeight = Int32(dimensions.height)
    image.frameType = frame.key ? .videoFrameKey : .videoFrameDelta
    image.captureTimeMs = Int64(frame.capturedNs / 1_000_000)
    decoding[frame.id] = (frame, now)
    previousSubmitted = frame.id; awaitingRefresh = false
    let status = decoder.decode(image, missingFrames: false, codecSpecificInfo: nil, renderTimeMs: 0)
    if status != 0 { decoding[frame.id] = nil; awaitingRefresh = true }
  }

  private func decoded(_ picture: RTCVideoFrame) {
    guard !closed, let job = decoding.removeValue(forKey: UInt32(bitPattern: picture.timeStamp)) else { return }
    let now = Self.now
    let age = (now - Double(job.frame.capturedNs) / 1e9) * 1000
    if let reference = qualityReferences.removeValue(forKey: job.frame.id), let native = picture.buffer as? RTCCVPixelBuffer,
       let shown = MediaQuality(native.pixelBuffer), let difference = reference.compare(shown) { counts.quality.append(difference) }
    counts.decoded += 1; totalDecoded += 1
    counts.decoding.append((now - job.began) * 1000); counts.ages.append(age)
    if let lastDecodedAt { gap = max(gap, now - lastDecodedAt) }; lastDecodedAt = now
    lastDecoded = max(lastDecoded, job.frame.id)
    if job.frame.reference { lastReference = max(lastReference, job.frame.id) }
    sendFeedback(force: true)
    drainDecoder()
  }

  private func sendFeedback(force: Bool = false) {
    guard !closed, lastReceivedStamp > 0, force || receivedBytes != lastFeedbackBytes else { return }
    lastFeedbackBytes = receivedBytes
    var payload = Data([2])
    payload.mediaAppend(receivedBytes); payload.mediaAppend(UInt64(lastReceivedAt * 1e9)); payload.mediaAppend(lastReceivedStamp)
    payload.mediaAppend(lastDecoded); payload.mediaAppend(lastReference)
    do { try receiver?.send(feedbackSend.seal(payload)) } catch { fail("媒体实验反馈失败：\(error)") }
  }

  private func acceptFeedback(_ packet: Data) {
    guard !closed else { return }
    do {
      var reader = MediaReader(try feedbackReceive.open(packet))
      guard reader.uint8() == 2, let bytes = reader.uint64(), let received = reader.uint64(), let sent = reader.uint64(),
            let decoded = reader.uint32(), let reference = reader.uint32(), reader.rest.isEmpty else { totalRejected += 1; return }
      let now = Self.now
      lastAcknowledgedSend = max(lastAcknowledgedSend, Double(sent) / 1e9)
      rate.feedback(bytes: bytes, receivedAt: Double(received) / 1e9, echoedSend: Double(sent) / 1e9, now: now)
      deadline.decoded(decoded, at: now)
      if reference <= decoded, let token = tokens[reference] { acknowledged = token }
    } catch { totalRejected += 1 }
  }

  /// Silence from an application-limited encoder is not proof that the network is congested.
  /// A small authenticated probe keeps delivery feedback alive without knowing link capacity.
  private func probeIfQuiet() {
    let now = Self.now
    guard !closed, !codecOnly, now - lastSentAt >= 0.18, now - lastProbeAt >= 0.2 else { return }
    var payload = Data(); payload.mediaAppend(UInt64(now * 1e9)); payload.append(3)
    do {
      let packet = try mediaSend.seal(payload)
      try sender?.send(packet)
      lastProbeAt = now; lastSentAt = now
      totalSent += packet.count; totalPackets += 1; counts.bytes += packet.count; counts.packets += 1
    } catch { fail("媒体实验探测失败：\(error)") }
  }

  private func report() {
    guard !closed else { return }
    let now = Self.now, seconds = max(0.001, now - lastReported)
    let captured = capture?.takeCounts()
    let age = Self.percentiles(counts.ages)
    let wait = Self.percentiles(counts.packetWait)
    link.emit(["t": "lab.stats", "v": viewer, "frameRate": frameRate, "captureFps": captured?.captured ?? 0,
      "encodedFps": Double(counts.encoded) / seconds, "decodedFps": Double(counts.decoded) / seconds,
      "framesDecoded": totalDecoded, "bitrate": Double(counts.bytes * 8) / seconds, "targetBitrate": rate.bitrate,
      "encodeMs": json(Self.mean(counts.encoding)), "decodeMs": json(Self.mean(counts.decoding)),
      "encodeInputToDecode": age, "sendDelay": wait, "qp": json(Self.mean(counts.quantizers)),
      "quality": MediaQuality.report(counts.quality),
      "decodeGapMs": max(gap, lastDecodedAt.map { now - $0 } ?? 0) * 1000,
      "encoderDropped": counts.encoderDropped, "rawSkipped": deadline.skippedRaw, "expiredFrames": deadline.expiredFrames,
      "pendingFrames": pending,
      "keyframes": keyframes, "ltrRefreshes": ltrRefreshes, "ltrAcknowledged": acknowledged != nil,
      "bufferedFrames": assembler.bufferedFrames, "rejectedPackets": totalRejected,
      "rttMs": json(rate.roundTripMs), "packetsSent": totalPackets, "bytesSent": totalSent,
      "width": dimensions.width, "height": dimensions.height])
    let sample = FrameRate.Second(captured: Double(captured?.captured ?? 0), encoded: Double(counts.encoded) / seconds,
      sentShare: 1, limitation: "none", available: rate.bitrate, sendDelayMs: Self.mean(counts.packetWait))
    switch steps?.judge(sample) {
    case .up, .down:
      if let changed = steps?.current {
        frameRate = changed
        capture?.setRate(changed) { [weak self] error in if let error { self?.fail(error) } }
      }
    case .keep, nil: break
    }
    counts = Counts(); gap = 0; lastReported = now
    assembler.expire(at: now); deadline.expire(at: now); rate.tick(at: now, outstanding: lastSentAt > lastAcknowledgedSend)
  }

  private func fail(_ message: String) { link.emit(["t": "lab.error", "v": viewer, "message": message]) }
  private static var now: Double { ProcessInfo.processInfo.systemUptime }
  private static func mean(_ values: [Double]) -> Double? { values.isEmpty ? nil : values.reduce(0, +) / Double(values.count) }
  private static func percentiles(_ values: [Double]) -> [String: Any] {
    let sorted = values.sorted()
    guard !sorted.isEmpty else { return ["n": 0] }
    func at(_ q: Double) -> Double { sorted[min(sorted.count - 1, Int(ceil(Double(sorted.count) * q)) - 1)] }
    return ["n": sorted.count, "meanMs": mean(sorted)!, "p50Ms": at(0.5), "p95Ms": at(0.95), "maxMs": sorted.last!]
  }
}

/// Always binds and sends to 127.0.0.1. Source checks are followed by per-packet authentication;
/// neither a local port nor a claimed frame number is treated as authentication.
private final class MediaLoopbackSocket {
  enum Failure: Error { case system(Int32), oversized }
  let port: UInt16
  var destination: UInt16?
  private let descriptor: Int32
  private var source: DispatchSourceRead?
  private var closed = false

  init(queue: DispatchQueue, receive: @escaping (Data) -> Void) throws {
    let descriptor = Darwin.socket(AF_INET, SOCK_DGRAM, 0)
    guard descriptor >= 0 else { throw Failure.system(errno) }
    self.descriptor = descriptor
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard result == 0 else { let error = errno; Darwin.close(descriptor); throw Failure.system(error) }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) }
    }
    port = UInt16(bigEndian: address.sin_port)
    _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
    let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
    source.setEventHandler { [weak self] in
      guard let self, !self.closed else { return }
      var buffer = [UInt8](repeating: 0, count: MediaDatagramCipher.maximumPacket + 1)
      for _ in 0..<256 {
        var peer = sockaddr_in(), size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let count = withUnsafeMutablePointer(to: &peer) { pointer in
          pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            recvfrom(self.descriptor, &buffer, buffer.count, 0, $0, &size)
          }
        }
        if count <= 0 { break }
        if count <= MediaDatagramCipher.maximumPacket, peer.sin_addr.s_addr == inet_addr("127.0.0.1"),
           UInt16(bigEndian: peer.sin_port) == self.destination { receive(Data(buffer.prefix(count))) }
      }
    }
    source.setCancelHandler { [descriptor] in Darwin.close(descriptor) }
    source.resume(); self.source = source
  }

  func send(_ packet: Data) throws {
    guard !closed, let destination else { return }
    guard packet.count <= MediaDatagramCipher.maximumPacket else { throw Failure.oversized }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1"); address.sin_port = destination.bigEndian
    let result = packet.withUnsafeBytes { buffer in
      withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          sendto(descriptor, buffer.baseAddress, buffer.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
    }
    if result != packet.count { throw Failure.system(errno) }
  }

  func close() { guard !closed else { return }; closed = true; source?.cancel(); source = nil }
  deinit { close() }
}
