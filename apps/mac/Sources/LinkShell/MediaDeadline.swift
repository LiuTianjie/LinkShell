import Foundation

/// Keep the absolute pacing timeline when a timer runs late. Restarting it at `now` after
/// every packet silently caps throughput at the timer's wakeup rate. Catch-up is bounded so
/// a suspended process cannot dump a whole old queue into the network on its next wakeup.
struct MediaPacing {
  private(set) var next = 0.0
  func ready(at now: Double) -> Bool { now + 0.0001 >= next }
  mutating func sent(bytes: Int, at now: Double, bitrate: Double) {
    next = max(next, now - 0.002) + Double(bytes * 8) / max(80_000, bitrate)
  }
}

/// One run's raw-frame admission, packet deadlines and recovery state. A compressed P frame
/// cannot simply be replaced: skipping it also abandons the chain until a real refresh arrives.
struct MediaDeadline {
  struct Queued {
    let frame: MediaFrame
    let encodedAt: Double
    let deadline: Double
    let fragments: [Data]
    var next = 0
  }
  private(set) var queue: [Queued] = []
  private(set) var needsRefresh = true
  private(set) var expiredFrames = 0
  private(set) var skippedRaw = 0
  private(set) var hasDecoded = false
  private(set) var lastDecoded: UInt32 = 0
  private(set) var lastProgress: Double?
  private(set) var lastSubmitted: UInt32 = 0
  private var refreshing: UInt32?
  let frameLifetime: Double

  init(frameLifetime: Double = 0.12) { self.frameLifetime = frameLifetime }

  mutating func admitRaw(at now: Double, bitrate: Double, pending: Int) -> Bool {
    expire(at: now)
    let bytes = queue.reduce(0) { total, queued in
      total + queued.fragments.dropFirst(queued.next).reduce(0) { $0 + $1.count + 40 }
    }
    guard pending < 2, !(needsRefresh && pending > 0), bytes * 8 < Int(max(1, bitrate) * 0.04) else { skippedRaw += 1; return false }
    // A refresh already in flight must not be followed by unbounded speculative work.
    if let refreshing, refreshing > lastDecoded {
      skippedRaw += 1; return false
    }
    return true
  }

  mutating func enqueue(_ frame: MediaFrame, at now: Double) -> Bool {
    expire(at: now)
    guard !needsRefresh || frame.independent else { return false }
    if frame.independent {
      queue.removeAll(keepingCapacity: true)
      needsRefresh = false
      refreshing = frame.id
      lastProgress = now
    }
    let age = frame.independent || !hasDecoded ? 0.8 : frameLifetime
    let deadline = Double(frame.capturedNs) / 1e9 + age
    guard deadline > now else { abandon(); return false }
    let pieces = frame.fragments()
    guard !pieces.isEmpty, queue.count < 8 else { abandon(); return false }
    queue.append(Queued(frame: frame, encodedAt: now, deadline: deadline, fragments: pieces))
    lastSubmitted = frame.id
    if lastProgress == nil { lastProgress = now }
    return true
  }

  mutating func nextPacket(at now: Double) -> (payload: Data, waitMs: Double)? {
    expire(at: now)
    guard !queue.isEmpty else { return nil }
    let item = queue[0]
    let payload = item.fragments[item.next]
    queue[0].next += 1
    if queue[0].next == item.fragments.count { queue.removeFirst() }
    return (payload, max(0, now - item.encodedAt) * 1000)
  }

  mutating func decoded(_ id: UInt32, at now: Double) {
    guard id > lastDecoded, id <= lastSubmitted else { return }
    lastDecoded = id; lastProgress = now; hasDecoded = true
    if let refreshing, id >= refreshing { self.refreshing = nil }
  }

  mutating func expire(at now: Double) {
    if queue.contains(where: { $0.deadline <= now }) { abandon() }
    let timeout = hasDecoded && refreshing == nil ? frameLifetime * 1.5 : 0.9
    if let lastProgress, lastSubmitted > lastDecoded, now - lastProgress > timeout {
      abandon(); self.lastProgress = now
    }
  }

  private mutating func abandon() {
    expiredFrames += queue.count
    queue.removeAll(keepingCapacity: true)
    needsRefresh = true
    refreshing = nil
  }
}

/// Deliberately small, inspectable congestion controller for the UDP comparison. It receives
/// only authenticated delivery feedback, never the proxy's configured capacity. No guarantee
/// of Internet fairness or stability is implied by a loopback experiment.
struct MediaRate {
  private(set) var bitrate: Double = 2_000_000
  let maximum: Double
  private(set) var roundTripMs: Double?
  private(set) var minimumRoundTripMs: Double?
  private var last: (bytes: UInt64, receivedAt: Double)?
  private var lastFeedback: Double?
  private var changedAt = 0.0
  private var pacingCeiling: Double?
  var pacingBitrate: Double { min(bitrate * 2.5, pacingCeiling ?? .greatestFiniteMagnitude) }

  init(maximum: Double, initial: Double = 2_000_000) {
    self.maximum = max(80_000, maximum)
    bitrate = min(max(80_000, initial), self.maximum)
  }

  mutating func feedback(bytes: UInt64, receivedAt: Double, echoedSend: Double, now: Double) {
    let roundTrip = (now - echoedSend) * 1000
    guard now.isFinite, receivedAt.isFinite, roundTrip >= 0, roundTrip < 5000 else { return }
    roundTripMs = roundTrip
    minimumRoundTripMs = min(minimumRoundTripMs ?? roundTrip, roundTrip)
    lastFeedback = now
    guard let previous = last else { last = (bytes, receivedAt); return }
    guard bytes >= previous.bytes, receivedAt > previous.receivedAt else { return }
    let interval = receivedAt - previous.receivedAt
    guard interval >= 0.1 else { return }
    last = (bytes, receivedAt)
    let delivered = Double(bytes - previous.bytes) * 8 / interval
    let queued = roundTrip - (minimumRoundTripMs ?? roundTrip)
    if queued > 35, now - changedAt >= 0.15 {
      bitrate = max(80_000, min(bitrate * 0.75, max(80_000, delivered * 0.9)))
      pacingCeiling = max(100_000, delivered * 1.05)
      changedAt = now
    } else if queued < 10, now - changedAt >= 0.4 {
      bitrate = min(maximum, bitrate * 1.10 + 10_000)
      if let pacingCeiling { self.pacingCeiling = min(maximum * 2.5, pacingCeiling * 1.1 + 12_000) }
      changedAt = now
    }
  }

  mutating func tick(at now: Double, outstanding: Bool) {
    guard outstanding, let lastFeedback, now - lastFeedback > 0.25, now - changedAt > 0.25 else { return }
    bitrate = max(80_000, bitrate * 0.75)
    changedAt = now
  }
}
