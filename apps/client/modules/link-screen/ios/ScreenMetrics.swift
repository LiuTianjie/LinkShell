import Foundation
import QuartzCore

/// Opt-in diagnostics. The normal receiver does not wrap the decoder or install presentation
/// timing callbacks. Sampling is deterministic and shared by the encode/decode timestamp.
final class ScreenMetrics {
  let enabled: Bool
  private let tracing: Bool
  private struct Trace {
    let timestamp: UInt32
    let phase: String
    let start: Double
    let end: Double
    let expected: Double?
  }
  private let lock = NSLock()
  private var decodeMs: [Double] = []
  private var presentMs: [Double] = []
  private var deliveryMs: [Double] = []
  private var submitMs: [Double] = []
  private var displayMs: [Double] = []
  private var gapsMs: [Double] = []
  private var trace: [Trace] = []
  private var started: [UInt32: Double] = [:]
  private var decodedAt: [UInt32: Double] = [:]
  private var receivedAt: [UInt32: Double] = [:]
  private var previousPresented: Double?
  private var presented = 0
  private var skipped = 0
  private var submissions = 0

  func committed() {
    guard enabled else { return }
    lock.lock(); submissions += 1; lock.unlock()
  }
  init(enabled: Bool = false, tracing: Bool = false) {
    self.enabled = enabled
    self.tracing = enabled && tracing
    if enabled {
      decodeMs.reserveCapacity(512); presentMs.reserveCapacity(512); gapsMs.reserveCapacity(512)
      deliveryMs.reserveCapacity(512); submitMs.reserveCapacity(512); displayMs.reserveCapacity(512)
      trace.reserveCapacity(256)
    }
  }

  func samples(_ timestamp: UInt32) -> Bool { enabled && (tracing || timestamp % 31 == 0) }

  func decoding(_ timestamp: UInt32) {
    guard samples(timestamp) else { return }
    lock.lock()
    defer { lock.unlock() }
    if started.count >= 256 { started.removeAll(keepingCapacity: true) }
    started[timestamp] = CACurrentMediaTime()
  }

  func decoded(_ timestamp: UInt32) {
    guard samples(timestamp) else { return }
    let now = CACurrentMediaTime()
    lock.lock()
    defer { lock.unlock() }
    if let began = started.removeValue(forKey: timestamp) {
      if decodeMs.count < 512 { decodeMs.append((now - began) * 1000) }
      if tracing, trace.count < 256 { trace.append(Trace(timestamp: timestamp, phase: "decode", start: began, end: now, expected: nil)) }
    }
    if decodedAt.count >= 256 { decodedAt.removeAll(keepingCapacity: true) }
    decodedAt[timestamp] = now
  }

  /// Separates WebRTC's post-decode delivery from our mailbox and display scheduling.
  func received(_ timestamp: UInt32) {
    guard samples(timestamp) else { return }
    let now = CACurrentMediaTime()
    lock.lock()
    defer { lock.unlock() }
    if let decoded = decodedAt[timestamp], deliveryMs.count < 512 {
      deliveryMs.append((now - decoded) * 1000)
    }
    if receivedAt.count >= 256 { receivedAt.removeAll(keepingCapacity: true) }
    receivedAt[timestamp] = now
  }

  func shown(_ timestamp: UInt32, submitted: Double, expected: Double, actual: Double) {
    guard actual > 0 else { return }
    lock.lock()
    defer { lock.unlock() }
    presented += 1
    if let decoded = decodedAt.removeValue(forKey: timestamp), presentMs.count < 512 {
      presentMs.append((actual - decoded) * 1000)
    }
    if let received = receivedAt.removeValue(forKey: timestamp), submitted >= received, submitMs.count < 512 {
      submitMs.append((submitted - received) * 1000)
    }
    if actual >= submitted, displayMs.count < 512 { displayMs.append((actual - submitted) * 1000) }
    // Intervals between sampled frames do not measure display cadence. Only an explicit full
    // trace may report this field; otherwise it would turn sampling gaps into false freezes.
    if tracing, let previousPresented, actual >= previousPresented, gapsMs.count < 512 {
      gapsMs.append((actual - previousPresented) * 1000)
    }
    previousPresented = actual
    if tracing, trace.count < 256 { trace.append(Trace(timestamp: timestamp, phase: "present", start: submitted, end: actual, expected: expected)) }
  }

  func missed() {
    guard enabled else { return }
    lock.lock()
    skipped += 1
    lock.unlock()
  }

  func snapshot(seconds: Double) -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    var result: [String: Any] = ["decodeSamples": decodeMs.count, "presentationSamples": presented, "renderMisses": skipped, "sampleEvery": tracing ? 1 : 31]
    result["gpuSubmissions"] = submissions
    if tracing { result["presentedFps"] = Double(presented) / max(seconds, 0.001) }
    for (name, values) in [("decode", decodeMs), ("decodeToPresent", presentMs), ("decodeToRenderer", deliveryMs),
                           ("rendererToSubmit", submitMs), ("submitToPresent", displayMs), ("frameGap", gapsMs)] {
      for (suffix, fraction) in [("P50Ms", 0.5), ("P95Ms", 0.95), ("P99Ms", 0.99)] {
        if let value = ScreenTiming.percentile(values, fraction) { result[name + suffix] = value }
      }
    }
    if tracing {
      result["trace"] = trace.map { point -> [String: Any] in
        var row: [String: Any] = ["rtp": point.timestamp, "phase": point.phase, "start": point.start, "end": point.end]
        row["expected"] = point.expected
        return row
      }
    }
    decodeMs.removeAll(keepingCapacity: true)
    presentMs.removeAll(keepingCapacity: true)
    deliveryMs.removeAll(keepingCapacity: true)
    submitMs.removeAll(keepingCapacity: true)
    displayMs.removeAll(keepingCapacity: true)
    gapsMs.removeAll(keepingCapacity: true)
    trace.removeAll(keepingCapacity: true)
    presented = 0
    skipped = 0
    submissions = 0
    return result
  }
}
