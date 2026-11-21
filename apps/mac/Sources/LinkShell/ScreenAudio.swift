import AVFoundation
import AudioToolbox
import CoreMedia
import Foundation

/// Wire constants matching `packages/wire/src/screen-audio.ts`:
/// `[u8 version=1][u8 codec][u16 seq BE][u32 timestampMs BE][payload]`
enum ScreenAudioConstants {
  static let version: UInt8 = 1
  static let codecOpus: UInt8 = 1
  static let codecPCM16: UInt8 = 2
  static let sampleRate: Int = 48_000
  static let channels: Int = 2
  static let frameMs: Int = 20
  static let frameSamples: Int = sampleRate * frameMs / 1000 // 960 frames
  static let headerBytes: Int = 8
  static let pcm16FrameBytes: Int = frameSamples * channels * MemoryLayout<Int16>.size // 3840 bytes
  static let opusBitrate: Int = 96_000
  static let maxPacketBytes: Int = 65_536
}

enum ScreenAudioCodec: UInt8, Equatable {
  case opus = 1
  case pcm16 = 2
}

struct ScreenAudioPacket: Equatable {
  let version: UInt8
  let codec: ScreenAudioCodec
  let seq: UInt16
  let timestampMs: UInt32
  let payload: Data

  init(version: UInt8 = ScreenAudioConstants.version, codec: ScreenAudioCodec, seq: UInt16, timestampMs: UInt32, payload: Data) {
    self.version = version
    self.codec = codec
    self.seq = seq
    self.timestampMs = timestampMs
    self.payload = payload
  }

  func encode() -> Data {
    var out = Data(capacity: ScreenAudioConstants.headerBytes + payload.count)
    out.append(version)
    out.append(codec.rawValue)
    out.append(UInt8(truncatingIfNeeded: seq >> 8))
    out.append(UInt8(truncatingIfNeeded: seq))
    out.append(UInt8(truncatingIfNeeded: timestampMs >> 24))
    out.append(UInt8(truncatingIfNeeded: timestampMs >> 16))
    out.append(UInt8(truncatingIfNeeded: timestampMs >> 8))
    out.append(UInt8(truncatingIfNeeded: timestampMs))
    out.append(payload)
    return out
  }

  static func decode(_ data: Data) -> ScreenAudioPacket? {
    guard data.count >= ScreenAudioConstants.headerBytes else { return nil }
    let start = data.startIndex
    let version = data[start]
    guard version == ScreenAudioConstants.version,
          let codec = ScreenAudioCodec(rawValue: data[start + 1]) else {
      return nil
    }
    let seq = (UInt16(data[start + 2]) << 8) | UInt16(data[start + 3])
    let timestampMs = (UInt32(data[start + 4]) << 24)
      | (UInt32(data[start + 5]) << 16)
      | (UInt32(data[start + 6]) << 8)
      | UInt32(data[start + 7])
    let payload = Data(data[(start + ScreenAudioConstants.headerBytes)...])
    return ScreenAudioPacket(version: version, codec: codec, seq: seq, timestampMs: timestampMs, payload: payload)
  }
}

private enum ScreenAudioFormats {
  static let canonicalPCM: AVAudioFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: Double(ScreenAudioConstants.sampleRate),
    channels: AVAudioChannelCount(ScreenAudioConstants.channels),
    interleaved: false
  )!

  static func makeOpusFormat() -> AVAudioFormat? {
    var asbd = AudioStreamBasicDescription(
      mSampleRate: Double(ScreenAudioConstants.sampleRate),
      mFormatID: kAudioFormatOpus,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: UInt32(ScreenAudioConstants.frameSamples),
      mBytesPerFrame: 0,
      mChannelsPerFrame: UInt32(ScreenAudioConstants.channels),
      mBitsPerChannel: 0,
      mReserved: 0
    )
    return AVAudioFormat(streamDescription: &asbd)
  }
}

/// Converts ScreenCaptureKit audio `CMSampleBuffer`s into 20ms stereo 48kHz Opus packets
/// (falling back to PCM16 when Opus `AVAudioConverter` is unavailable) framed per `screen-audio.ts`.
final class ScreenAudioEncoder {
  var onPacket: ((Data) -> Void)?

  private let lock = NSLock()
  private let preferOpus: Bool
  private let canonicalFormat = ScreenAudioFormats.canonicalPCM
  private let opusFormat: AVAudioFormat?
  private var opusEncoder: AVAudioConverter?
  private var resampler: AVAudioConverter?
  private var resamplerSourceFormat: AVAudioFormat?
  private var leftFIFO: [Float] = []
  private var rightFIFO: [Float] = []
  private var seq: UInt16 = 0
  private var firstPtsSeconds: Double?
  private var nextTimestampMs: Double?

  var activeCodec: ScreenAudioCodec {
    lock.lock()
    defer { lock.unlock() }
    return opusEncoder != nil ? .opus : .pcm16
  }

  init(preferOpus: Bool = true, onPacket: ((Data) -> Void)? = nil) {
    self.preferOpus = preferOpus
    self.onPacket = onPacket
    if preferOpus, let opusFormat = ScreenAudioFormats.makeOpusFormat(),
       let converter = AVAudioConverter(from: ScreenAudioFormats.canonicalPCM, to: opusFormat) {
      converter.bitRate = ScreenAudioConstants.opusBitrate
      self.opusFormat = opusFormat
      self.opusEncoder = converter
    } else {
      self.opusFormat = nil
      self.opusEncoder = nil
    }
  }

  func reset() {
    lock.lock()
    leftFIFO.removeAll(keepingCapacity: true)
    rightFIFO.removeAll(keepingCapacity: true)
    seq = 0
    firstPtsSeconds = nil
    nextTimestampMs = nil
    resampler = nil
    resamplerSourceFormat = nil
    opusEncoder?.reset()
    lock.unlock()
  }

  func append(sampleBuffer: CMSampleBuffer) {
    guard sampleBuffer.isValid,
          CMSampleBufferDataIsReady(sampleBuffer),
          let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
          CMFormatDescriptionGetMediaType(formatDescription) == kCMMediaType_Audio else {
      return
    }
    let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
    guard frameCount > 0 else { return }

    let sourceFormat = AVAudioFormat(cmAudioFormatDescription: formatDescription)
    guard let rawBuffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(frameCount)) else {
      return
    }
    rawBuffer.frameLength = AVAudioFrameCount(frameCount)
    let copyStatus = CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sampleBuffer,
      at: 0,
      frameCount: Int32(frameCount),
      into: rawBuffer.mutableAudioBufferList
    )
    guard copyStatus == noErr else { return }

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let ptsSeconds = pts.isNumeric ? CMTimeGetSeconds(pts) : nil
    append(pcmBuffer: rawBuffer, ptsSeconds: ptsSeconds)
  }

  func append(pcmBuffer: AVAudioPCMBuffer, ptsSeconds: Double? = nil) {
    guard pcmBuffer.frameLength > 0 else { return }

    var emittedPackets: [Data] = []
    let handler: ((Data) -> Void)?

    lock.lock()
    handler = onPacket

    guard let canonical = convertToCanonical(pcmBuffer),
          let channels = canonical.floatChannelData,
          canonical.frameLength > 0 else {
      lock.unlock()
      return
    }

    let count = Int(canonical.frameLength)
    let bufferedBeforeMs = Double(leftFIFO.count) * 1000.0 / Double(ScreenAudioConstants.sampleRate)
    if let ptsSeconds {
      if firstPtsSeconds == nil { firstPtsSeconds = ptsSeconds }
      let relMs = max(0.0, (ptsSeconds - (firstPtsSeconds ?? ptsSeconds)) * 1000.0)
      if let expectedStart = nextTimestampMs {
        let expectedEnd = expectedStart + bufferedBeforeMs
        if abs(expectedEnd - relMs) > 60.0 {
          nextTimestampMs = max(0.0, relMs - bufferedBeforeMs)
        }
      } else {
        nextTimestampMs = relMs
      }
    } else if nextTimestampMs == nil {
      nextTimestampMs = 0.0
    }

    leftFIFO.append(contentsOf: UnsafeBufferPointer(start: channels[0], count: count))
    rightFIFO.append(contentsOf: UnsafeBufferPointer(start: channels[1], count: count))

    let frameSamples = ScreenAudioConstants.frameSamples
    while leftFIFO.count >= frameSamples, rightFIFO.count >= frameSamples {
      let leftSlice = Array(leftFIFO[0..<frameSamples])
      let rightSlice = Array(rightFIFO[0..<frameSamples])
      leftFIFO.removeFirst(frameSamples)
      rightFIFO.removeFirst(frameSamples)

      let tsMs = UInt32(truncatingIfNeeded: Int64((nextTimestampMs ?? 0.0).rounded()))
      nextTimestampMs = (nextTimestampMs ?? 0.0) + Double(ScreenAudioConstants.frameMs)

      if let packet = encode20msFrame(left: leftSlice, right: rightSlice, seq: seq, timestampMs: tsMs) {
        emittedPackets.append(packet)
        seq &+= 1
      }
    }
    lock.unlock()

    if let handler {
      for packet in emittedPackets { handler(packet) }
    }
  }

  private func convertToCanonical(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    let fmt = input.format
    if fmt.sampleRate == canonicalFormat.sampleRate,
       fmt.channelCount == canonicalFormat.channelCount,
       fmt.commonFormat == .pcmFormatFloat32,
       !fmt.isInterleaved {
      return input
    }
    if resampler == nil || resamplerSourceFormat != fmt {
      guard let made = AVAudioConverter(from: fmt, to: canonicalFormat) else { return nil }
      if fmt.channelCount == 1 {
        made.channelMap = [0, 0]
      }
      resampler = made
      resamplerSourceFormat = fmt
    }
    guard let resampler else { return nil }
    let ratio = canonicalFormat.sampleRate / max(fmt.sampleRate, 1)
    let outCapacity = AVAudioFrameCount(ceil(Double(input.frameLength) * ratio) + 64)
    guard let output = AVAudioPCMBuffer(pcmFormat: canonicalFormat, frameCapacity: outCapacity) else { return nil }
    var err: NSError?
    var provided = false
    let status = resampler.convert(to: output, error: &err) { _, outStatus in
      if provided {
        outStatus.pointee = .noDataNow
        return nil
      }
      provided = true
      outStatus.pointee = .haveData
      return input
    }
    guard err == nil, status == .haveData || status == .inputRanDry, output.frameLength > 0 else { return nil }
    return output
  }

  private func encode20msFrame(left: [Float], right: [Float], seq: UInt16, timestampMs: UInt32) -> Data? {
    if let opusEncoder, let opusFormat,
       let pcm = AVAudioPCMBuffer(pcmFormat: canonicalFormat, frameCapacity: AVAudioFrameCount(ScreenAudioConstants.frameSamples)),
       let dst = pcm.floatChannelData {
      pcm.frameLength = AVAudioFrameCount(ScreenAudioConstants.frameSamples)
      left.withUnsafeBufferPointer { ptr in
        if let base = ptr.baseAddress { dst[0].update(from: base, count: ScreenAudioConstants.frameSamples) }
      }
      right.withUnsafeBufferPointer { ptr in
        if let base = ptr.baseAddress { dst[1].update(from: base, count: ScreenAudioConstants.frameSamples) }
      }
      let outBuffer = AVAudioCompressedBuffer(
        format: opusFormat,
        packetCapacity: 1,
        maximumPacketSize: max(4096, opusEncoder.maximumOutputPacketSize)
      )
      var error: NSError?
      var provided = false
      let status = opusEncoder.convert(to: outBuffer, error: &error) { _, outStatus in
        if provided {
          outStatus.pointee = .noDataNow
          return nil
        }
        provided = true
        outStatus.pointee = .haveData
        return pcm
      }
      if error == nil, (status == .haveData || status == .inputRanDry),
         outBuffer.packetCount > 0, outBuffer.byteLength > 0 {
        let totalBytes = Int(outBuffer.byteLength)
        let desc = outBuffer.packetDescriptions?[0]
        let offset = max(0, min(totalBytes, Int(desc?.mStartOffset ?? 0)))
        let length = max(0, min(totalBytes - offset, Int(desc?.mDataByteSize ?? outBuffer.byteLength)))
        if length > 0 {
          let payload = Data(bytes: outBuffer.data.advanced(by: offset), count: length)
          return ScreenAudioPacket(codec: .opus, seq: seq, timestampMs: timestampMs, payload: payload).encode()
        }
      }
      // Fall back to PCM16 if Opus conversion fails at runtime.
      self.opusEncoder = nil
    }

    var pcmPayload = Data(count: ScreenAudioConstants.pcm16FrameBytes)
    pcmPayload.withUnsafeMutableBytes { raw in
      guard let out = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
      for i in 0..<ScreenAudioConstants.frameSamples {
        out[i * 2] = Self.floatToInt16(left[i]).littleEndian
        out[i * 2 + 1] = Self.floatToInt16(right[i]).littleEndian
      }
    }
    return ScreenAudioPacket(codec: .pcm16, seq: seq, timestampMs: timestampMs, payload: pcmPayload).encode()
  }

  private static func floatToInt16(_ sample: Float) -> Int16 {
    let clamped = max(-1.0, min(1.0, sample))
    if clamped >= 0 {
      return Int16(min(32767.0, (clamped * 32767.0).rounded()))
    }
    return Int16(max(-32768.0, (clamped * 32768.0).rounded()))
  }
}

/// Decodes incoming `ScreenAudioPacket` frames (`Opus` or `PCM16`) and plays low-latency stereo
/// 48kHz audio via `AVAudioEngine` + `AVAudioPlayerNode`.
final class ScreenAudioPlayer {
  private static let maxQueuedBuffers = 8

  private let queue = DispatchQueue(label: "com.bd.linkshell.audio.player", qos: .userInteractive)
  private let pendingLock = NSLock()
  private let canonicalFormat = ScreenAudioFormats.canonicalPCM
  private let opusFormat = ScreenAudioFormats.makeOpusFormat()
  private let outputEnabled: Bool

  private var opusDecoder: AVAudioConverter?
  private var engine: AVAudioEngine?
  private var playerNode: AVAudioPlayerNode?
  private var configObserver: NSObjectProtocol?
  private var pendingBuffers = 0
  private var playbackGeneration: UInt64 = 0
  private var muted: Bool
  private var stopped = false

  var isMuted: Bool {
    pendingLock.lock()
    defer { pendingLock.unlock() }
    return muted
  }

  init(muted: Bool = false, outputEnabled: Bool = true) {
    self.muted = muted
    self.outputEnabled = outputEnabled
  }

  deinit {
    stopSync()
  }

  func setMuted(_ value: Bool) {
    pendingLock.lock()
    muted = value
    pendingLock.unlock()
    queue.async { [weak self] in
      guard let self, !self.stopped else { return }
      if value {
        self.flushPlayback()
        self.playerNode?.volume = 0
        self.opusDecoder?.reset()
      } else {
        self.playerNode?.volume = 1
        _ = self.ensureStartedIfNeeded()
      }
    }
  }

  func enqueue(_ packetData: Data) {
    queue.async { [weak self] in
      self?.handlePacket(packetData)
    }
  }

  func stop() {
    queue.async { [weak self] in
      self?.stopSync()
    }
  }

  /// Exposed for unit testing packet decoding independently of hardware audio output.
  func decodePacket(_ data: Data) -> AVAudioPCMBuffer? {
    guard let packet = ScreenAudioPacket.decode(data),
          !packet.payload.isEmpty,
          packet.payload.count <= ScreenAudioConstants.maxPacketBytes else {
      return nil
    }
    switch packet.codec {
    case .pcm16:
      return decodePCM16(packet.payload)
    case .opus:
      return decodeOpus(packet.payload)
    }
  }

  private func handlePacket(_ data: Data) {
    guard !stopped, !isMuted else { return }
    guard let pcmBuffer = decodePacket(data), pcmBuffer.frameLength > 0 else { return }
    guard outputEnabled else { return }
    guard ensureStartedIfNeeded(), let playerNode else { return }

    pendingLock.lock()
    let queued = pendingBuffers
    pendingLock.unlock()
    if queued >= Self.maxQueuedBuffers {
      flushPlayback()
    }

    pendingLock.lock()
    pendingBuffers += 1
    let generation = playbackGeneration
    pendingLock.unlock()

    playerNode.scheduleBuffer(pcmBuffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      guard let self else { return }
      self.pendingLock.lock()
      if self.playbackGeneration == generation, self.pendingBuffers > 0 {
        self.pendingBuffers -= 1
      }
      self.pendingLock.unlock()
    }
    if !playerNode.isPlaying {
      playerNode.play()
    }
  }

  private func decodePCM16(_ payload: Data) -> AVAudioPCMBuffer? {
    let bytesPerFrame = ScreenAudioConstants.channels * MemoryLayout<Int16>.size
    guard payload.count >= bytesPerFrame, payload.count % bytesPerFrame == 0 else { return nil }
    let frameCount = payload.count / bytesPerFrame
    guard let buffer = AVAudioPCMBuffer(pcmFormat: canonicalFormat, frameCapacity: AVAudioFrameCount(frameCount)),
          let dst = buffer.floatChannelData else {
      return nil
    }
    buffer.frameLength = AVAudioFrameCount(frameCount)
    payload.withUnsafeBytes { raw in
      let samples = raw.bindMemory(to: Int16.self)
      for i in 0..<frameCount {
        let left = Int16(littleEndian: samples[i * 2])
        let right = Int16(littleEndian: samples[i * 2 + 1])
        dst[0][i] = Float(left) / 32768.0
        dst[1][i] = Float(right) / 32768.0
      }
    }
    return buffer
  }

  private func decodeOpus(_ payload: Data) -> AVAudioPCMBuffer? {
    guard let opusFormat else { return nil }
    if opusDecoder == nil {
      opusDecoder = AVAudioConverter(from: opusFormat, to: canonicalFormat)
    }
    guard let opusDecoder else { return nil }

    let compressed = AVAudioCompressedBuffer(
      format: opusFormat,
      packetCapacity: 1,
      maximumPacketSize: max(4096, payload.count)
    )
    payload.withUnsafeBytes { raw in
      if let base = raw.baseAddress {
        memcpy(compressed.data, base, payload.count)
      }
    }
    compressed.byteLength = UInt32(payload.count)
    compressed.packetCount = 1
    compressed.packetDescriptions?[0] = AudioStreamPacketDescription(
      mStartOffset: 0,
      mVariableFramesInPacket: 0,
      mDataByteSize: UInt32(payload.count)
    )

    // 2880 samples covers up to 60ms Opus packets at 48kHz.
    guard let output = AVAudioPCMBuffer(pcmFormat: canonicalFormat, frameCapacity: 2880) else { return nil }
    var err: NSError?
    var provided = false
    let status = opusDecoder.convert(to: output, error: &err) { _, outStatus in
      if provided {
        outStatus.pointee = .noDataNow
        return nil
      }
      provided = true
      outStatus.pointee = .haveData
      return compressed
    }
    guard err == nil, status == .haveData || status == .inputRanDry, output.frameLength > 0 else { return nil }
    return output
  }

  private func ensureStartedIfNeeded() -> Bool {
    guard outputEnabled, !stopped else { return false }
    if let engine, let playerNode {
      if !engine.isRunning {
        do {
          try engine.start()
          if !isMuted { playerNode.play() }
        } catch {
          return false
        }
      }
      return true
    }

    let engine = AVAudioEngine()
    let playerNode = AVAudioPlayerNode()
    engine.attach(playerNode)
    engine.connect(playerNode, to: engine.mainMixerNode, format: canonicalFormat)
    playerNode.volume = isMuted ? 0 : 1

    configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async {
        guard let self, !self.stopped, !self.isMuted, let engine = self.engine else { return }
        if !engine.isRunning {
          try? engine.start()
          self.playerNode?.play()
        }
      }
    }

    do {
      try engine.start()
      if !isMuted { playerNode.play() }
      self.engine = engine
      self.playerNode = playerNode
      return true
    } catch {
      if let observer = configObserver {
        NotificationCenter.default.removeObserver(observer)
        configObserver = nil
      }
      engine.detach(playerNode)
      return false
    }
  }

  private func flushPlayback() {
    pendingLock.lock()
    playbackGeneration &+= 1
    pendingBuffers = 0
    pendingLock.unlock()
    playerNode?.stop()
    if !stopped, !isMuted, engine?.isRunning == true {
      playerNode?.play()
    }
  }

  private func stopSync() {
    pendingLock.lock()
    let alreadyStopped = stopped
    stopped = true
    playbackGeneration &+= 1
    pendingBuffers = 0
    pendingLock.unlock()
    guard !alreadyStopped else { return }

    if let observer = configObserver {
      NotificationCenter.default.removeObserver(observer)
      configObserver = nil
    }
    playerNode?.stop()
    engine?.stop()
    if let engine, let playerNode {
      engine.detach(playerNode)
    }
    playerNode = nil
    engine = nil
    opusDecoder = nil
  }
}
