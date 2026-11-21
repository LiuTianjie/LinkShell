import AVFoundation
import AudioToolbox
import Foundation

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

/// Decodes incoming `ScreenAudioPacket` frames (`Opus` or `PCM16`) and plays low-latency stereo
/// 48kHz audio via `AVAudioEngine` + `AVAudioPlayerNode`.
final class ScreenAudioPlayer {
  private static let maxQueuedBuffers = 8

  private let queue = DispatchQueue(label: "com.bd.linkshell.screen.audio.player", qos: .userInteractive)
  private let pendingLock = NSLock()
  private let canonicalFormat = ScreenAudioFormats.canonicalPCM
  private let opusFormat = ScreenAudioFormats.makeOpusFormat()
  private let outputEnabled: Bool

  private var opusDecoder: AVAudioConverter?
  private var engine: AVAudioEngine?
  private var playerNode: AVAudioPlayerNode?
  private var configObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?
  private var pendingBuffers = 0
  private var playbackGeneration: UInt64 = 0
  private var sessionActive = false
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
        self.deactivateSessionIfNeeded()
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

  private func activateSessionIfNeeded() {
    guard outputEnabled else { return }
#if os(iOS) || os(tvOS)
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      try session.setActive(true)
      sessionActive = true
    } catch {
      // Allow playback attempt even if simulator or route setup ignores session activation.
    }
#else
    sessionActive = true
#endif
  }

  private func deactivateSessionIfNeeded() {
    guard sessionActive else { return }
    sessionActive = false
#if os(iOS) || os(tvOS)
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
#endif
  }

  private func ensureStartedIfNeeded() -> Bool {
    guard outputEnabled, !stopped else { return false }
    activateSessionIfNeeded()
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

#if os(iOS) || os(tvOS)
    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: nil
    ) { [weak self] notification in
      let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      let type = typeValue.flatMap { AVAudioSession.InterruptionType(rawValue: $0) }
      self?.queue.async {
        guard let self, !self.stopped else { return }
        if type == .began {
          self.flushPlayback()
        } else if type == .ended, !self.isMuted {
          _ = self.ensureStartedIfNeeded()
        }
      }
    }
#endif

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
      if let observer = interruptionObserver {
        NotificationCenter.default.removeObserver(observer)
        interruptionObserver = nil
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
    if let observer = interruptionObserver {
      NotificationCenter.default.removeObserver(observer)
      interruptionObserver = nil
    }
    playerNode?.stop()
    engine?.stop()
    if let engine, let playerNode {
      engine.detach(playerNode)
    }
    playerNode = nil
    engine = nil
    opusDecoder = nil
    deactivateSessionIfNeeded()
  }
}
