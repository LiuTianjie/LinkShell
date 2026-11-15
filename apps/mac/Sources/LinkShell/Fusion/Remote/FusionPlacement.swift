import AppKit
import ApplicationServices
import CoreVideo
import Foundation
import ImageIO
import LinkShellFusionShim
import LinkShellScreen
import Network
import ScreenCaptureKit
import UniformTypeIdentifiers
import WebRTC

/// High-frequency window geometry ring buffer so each captured `CVPixelBuffer` gets the exact
/// crop and local window coordinates from the `mach_absolute_time()` it was composited.
final class FusionSampler {
  struct Window { let id: CGWindowID; let pid: pid_t; let layer: Int; let frame: CGRect }
  struct Mirror { let id: CGDirectDisplayID; let remote: CGRect; let local: CGRect; let scale: Int }

  let lock = NSLock()
  let queue = DispatchQueue(label: "linkshell.fusion.sampler", qos: .userInteractive)
  var timer: DispatchSourceTimer?
  var pids: Set<pid_t> = []
  var popupWindowIDs: Set<CGWindowID> = []
  var overlayWindowIDs: Set<CGWindowID> = []
  var mirrors: [Mirror] = []
  var ring: [(time: UInt64, windows: [CGWindowID: Window])] = []
  var peakAlpha: [CGWindowID: Double] = [:]
  var previousVisibleIDs: Set<CGWindowID> = []
  var disappearancePending = false
  var onWindowDisappeared: (() -> Void)?
  var ackHistory: [CGWindowID: [(seq: UInt64, time: UInt64)]] = [:]
  var activeTransitions: [CGWindowID: UInt64] = [:]
  var transitionRanges: [CGWindowID: [(start: UInt64, end: UInt64)]] = [:]

  var fused: Set<pid_t> { lock.lock(); defer { lock.unlock() }; return pids }
  var popups: Set<CGWindowID> { lock.lock(); defer { lock.unlock() }; return popupWindowIDs }
  var overlayIncluded: Set<CGWindowID> { lock.lock(); defer { lock.unlock() }; return overlayWindowIDs }
  func set(pids: Set<pid_t>) { lock.lock(); self.pids = pids; lock.unlock() }
  func set(popups: Set<CGWindowID>, parents: Set<CGWindowID> = []) {
    lock.lock()
    self.popupWindowIDs = popups
    self.overlayWindowIDs = popups.union(parents)
    lock.unlock()
  }
  func set(mirrors: [Mirror]) { lock.lock(); self.mirrors = mirrors; lock.unlock() }

  func latestFrame(window id: CGWindowID) -> CGRect? {
    lock.lock()
    defer { lock.unlock() }
    for i in stride(from: ring.count - 1, through: 0, by: -1) {
      if let f = ring[i].windows[id]?.frame { return f }
    }
    return nil
  }

  func beginTransition(window id: CGWindowID, at start: UInt64) {
    lock.lock()
    if activeTransitions[id] == nil {
      activeTransitions[id] = start
    }
    lock.unlock()
  }

  func endTransition(window id: CGWindowID, moved: Bool, at settled: UInt64, seq: UInt64) {
    lock.lock()
    if let start = activeTransitions.removeValue(forKey: id), moved, settled > start {
      var ranges = transitionRanges[id] ?? []
      ranges.append((start, settled))
      if ranges.count > 12 { ranges.removeFirst(ranges.count - 12) }
      transitionRanges[id] = ranges
    }
    if seq > 0 {
      var list = ackHistory[id] ?? []
      if (list.last?.seq ?? 0) < seq {
        list.append((seq, settled))
        if list.count > 16 { list.removeFirst(list.count - 16) }
        ackHistory[id] = list
      }
    }
    lock.unlock()
  }

  func clearWindow(_ id: CGWindowID) {
    lock.lock()
    ackHistory[id] = nil
    activeTransitions[id] = nil
    transitionRanges[id] = nil
    lock.unlock()
  }

  func sampleNow() {
    sample()
  }

  func start() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(4), leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in self?.sample() }
    timer.resume()
    self.timer = timer
  }

  func stop() { timer?.cancel(); timer = nil }

  func sample() {
    let pids = fused
    guard !pids.isEmpty, let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return }
    let time = mach_absolute_time()
    var windows: [CGWindowID: Window] = [:]
    var rawOnScreenIDs: Set<CGWindowID> = []
    var notifyDisappeared = false

    lock.lock()
    for info in list {
      guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
            let id = info[kCGWindowNumber as String] as? CGWindowID,
            let bounds = info[kCGWindowBounds as String] as? [String: Any],
            let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.width > 1, frame.height > 1 else { continue }
      rawOnScreenIDs.insert(id)
      let alpha = info[kCGWindowAlpha as String] as? Double ?? 1.0
      let peak = max(peakAlpha[id] ?? 0, alpha)
      peakAlpha[id] = peak
      // Drop closing windows on Frame #1 of macOS's close fade-out (`1.0 -> 0.86 -> ... -> 0.0`)
      // so `SCContentFilter` never composites a fading window over its black void background!
      guard alpha > 0.05, alpha >= peak - 0.04 else { continue }
      windows[id] = Window(id: id, pid: pid, layer: info[kCGWindowLayer as String] as? Int ?? 0, frame: frame)
    }
    if peakAlpha.count > rawOnScreenIDs.count {
      peakAlpha = peakAlpha.filter { rawOnScreenIDs.contains($0.key) }
    }
    let currentIDs = Set(windows.keys)
    if !previousVisibleIDs.subtracting(currentIDs).isEmpty, !disappearancePending {
      disappearancePending = true
      notifyDisappeared = true
    }
    previousVisibleIDs = currentIDs
    ring.append((time, windows))
    if ring.count > 64 { ring.removeFirst(ring.count - 64) }
    let callback = notifyDisappeared ? onWindowDisappeared : nil
    lock.unlock()

    if let callback {
      DispatchQueue.main.async { [weak self] in
        if let self {
          self.lock.lock()
          self.disappearancePending = false
          self.lock.unlock()
        }
        callback()
      }
    }
  }

  /// Exact normalized crop (`0..1`) inside `buffer` + local Mac point frame + in-window visible rect + display scale + causal `ackSeq`.
  /// Format: `[lx, ly, lw, lh, nx, ny, nw, nh, ix, iy, iw, ih, scale, ack]`.
  func windowCrop(window id: CGWindowID, display: CGDirectDisplayID, at time: UInt64) -> Data? {
    lock.lock()
    let ring = self.ring
    let mirror = self.mirrors.first { $0.id == display }
    let acks = self.ackHistory[id] ?? []
    let inFlightStart = self.activeTransitions[id]
    let ranges = self.transitionRanges[id] ?? []
    lock.unlock()
    guard let mirror, mirror.remote.width > 0, mirror.remote.height > 0 else { return nil }
    // Drop frames captured while `AXUIElementSetAttributeValue` was actively moving/resizing `id`
    // in WindowServer so a pre-move pixel buffer is never cropped with post-move coordinates!
    if let inFlightStart, time >= inFlightStart { return nil }
    if ranges.contains(where: { time >= $0.start && time < $0.end }) { return nil }
    // If `id` has already vanished or started its close fade in the latest 250Hz sample, drop immediately
    // so a post-close black `SCStream` frame never gets stamped with pre-close SEI coordinates!
    guard let latest = ring.last, latest.windows[id] != nil else { return nil }
    let sampleIdx = ring.lastIndex(where: { $0.time <= time }) ?? 0
    guard let frame = ring[sampleIdx].windows[id]?.frame else { return nil }
    let visible = frame.intersection(mirror.remote)
    guard !visible.isNull, visible.width >= 2, visible.height >= 2 else { return nil }
    let ackAtTime = acks.last(where: { $0.time <= time })?.seq ?? 0
    let nx = min(1, max(0, Double((visible.minX - mirror.remote.minX) / mirror.remote.width)))
    let ny = min(1, max(0, Double((visible.minY - mirror.remote.minY) / mirror.remote.height)))
    let nw = min(1 - nx, max(0.001, Double(visible.width / mirror.remote.width)))
    let nh = min(1 - ny, max(0.001, Double(visible.height / mirror.remote.height)))
    let local = frame.offsetBy(dx: mirror.local.minX - mirror.remote.minX, dy: mirror.local.minY - mirror.remote.minY)
    let inWin = CGRect(x: visible.minX - frame.minX, y: visible.minY - frame.minY, width: visible.width, height: visible.height)
    func r2(_ v: CGFloat) -> Double { (Double(v) * 100).rounded() / 100 }
    func r6(_ v: Double) -> Double { (v * 1_000_000).rounded() / 1_000_000 }
    return try? JSONSerialization.data(withJSONObject: [
      r2(local.minX), r2(local.minY), r2(local.width), r2(local.height),
      r6(nx), r6(ny), r6(nw), r6(nh),
      r2(inWin.minX), r2(inWin.minY), r2(inWin.width), r2(inWin.height),
      Double(mirror.scale), Double(ackAtTime),
    ])
  }

  /// Popup windows (`layer > 0` / ungrouped) on `display` at `time`: `[[id, layer, x, y, w, h]]`.
  func layout(display: CGDirectDisplayID, at time: UInt64) -> Data? {
    lock.lock()
    let ring = self.ring
    let popups = self.popupWindowIDs
    let mirror = mirrors.first { $0.id == display }
    lock.unlock()
    guard let mirror, !ring.isEmpty else { return nil }
    let after = ring.firstIndex { $0.time > time }
    let beforeIndex: Int?
    if let after { beforeIndex = after > 0 ? after - 1 : nil } else { beforeIndex = ring.count - 1 }
    var result: [[Double]] = []
    let base = ring[beforeIndex ?? after!]
    let next = after.map { ring[$0] }
    var weight = 0.0
    if let next, beforeIndex != nil, next.time > base.time {
      weight = min(max(Double(time &- base.time) / Double(next.time - base.time), 0), 1)
    }
    for window in base.windows.values where popups.contains(window.id) {
      var frame = window.frame
      if let other = next?.windows[window.id], weight > 0 {
        frame = CGRect(x: frame.minX + (other.frame.minX - frame.minX) * weight,
                       y: frame.minY + (other.frame.minY - frame.minY) * weight,
                       width: frame.width + (other.frame.width - frame.width) * weight,
                       height: frame.height + (other.frame.height - frame.height) * weight)
      }
      guard frame.intersects(mirror.remote) else { continue }
      let local = frame.offsetBy(dx: mirror.local.minX - mirror.remote.minX, dy: mirror.local.minY - mirror.remote.minY)
      result.append([Double(window.id), Double(window.layer), local.minX, local.minY, local.width, local.height])
    }
    return try? JSONSerialization.data(withJSONObject: result)
  }
}

extension FusionRemoteSession {
  /// Coalesces rapid local moves/resizes on a serial background AX queue (`placeQueue`) so intermediate
  /// sizes never pile up in a FIFO backlog and `AXUIElementSetAttributeValue` never blocks the main thread.
  func enqueuePlace(_ id: CGWindowID, seq: UInt64, local: CGRect, resize: Bool) {
    guard let mirror = mirror(local: local) ?? mirrors.first else { return }
    let size = CGSize(width: max(local.width, 80), height: max(local.height, 60))
    var px = local.minX - mirror.local.minX + mirror.remote.minX
    var py = local.minY - mirror.local.minY + mirror.remote.minY
    let topInset = min(max(0, mirror.menuBarHeight), 40)
    let minY = mirror.remote.minY + topInset
    if size.width <= mirror.remote.width {
      px = min(max(px, mirror.remote.minX), mirror.remote.maxX - size.width)
    } else {
      px = mirror.remote.minX
    }
    if size.height <= mirror.remote.height - topInset {
      py = min(max(py, minY), mirror.remote.maxY - size.height)
    } else {
      py = minY
    }
    let remoteTarget = CGRect(origin: CGPoint(x: px, y: py), size: size)
    let candidatePids = (streams[id].map { [$0.pid] } ?? []) + Array(fused)

    placeLock.lock()
    let prevSeq = pendingPlaces[id]?.seq ?? 0
    let prevResize = pendingPlaces[id]?.resize ?? false
    if seq == 0 || seq >= prevSeq {
      pendingPlaces[id] = PendingPlace(seq: max(seq, prevSeq), local: remoteTarget, resize: resize || prevResize, mirrorIndex: mirror.index)
    }
    let shouldStart = !placeWorkerRunning
    if shouldStart { placeWorkerRunning = true }
    placeLock.unlock()

    guard shouldStart else { return }
    placeQueue.async { [weak self] in
      self?.drainPlacements(defaultPids: candidatePids)
    }
  }

  func drainPlacements(defaultPids: [pid_t]) {
    while true {
      placeLock.lock()
      guard let (id, job) = pendingPlaces.first else {
        placeWorkerRunning = false
        placeLock.unlock()
        break
      }
      pendingPlaces.removeValue(forKey: id)
      placeLock.unlock()

      let beforeBounds = Self.liveCGWindowBounds(id)
      let transitionStart = mach_absolute_time()
      sampler.beginTransition(window: id, at: transitionStart)
      var matchedPid: pid_t = 0
      var targetPoint = job.local.origin
      var targetSize = job.local.size
      for pid in defaultPids {
        guard let w = axWindow(pid: pid, id: id) else { continue }
        matchedPid = pid
        if job.resize {
          AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &targetPoint)!)
          AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &targetSize)!)
          AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &targetPoint)!)
        } else {
          AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &targetPoint)!)
        }
        break
      }

      // Poll at 1.5ms–4ms resolution on background `placeQueue` for the target process to commit
      // `CGWindowBounds` to WindowServer before stamping `appliedSeq` / switching virtual display,
      // aborting immediately if a newer `PendingPlace` arrives for `id`.
      var superseded = false
      if matchedPid != 0 {
        if job.resize {
          var prevSample: CGSize?
          var stableTicks = 0
          for _ in 0..<24 {
            placeLock.lock()
            let hasNewer = pendingPlaces[id] != nil
            placeLock.unlock()
            if hasNewer { superseded = true; break }
            if let live = Self.liveCGWindowBounds(id) {
              let posOk = abs(live.minX - targetPoint.x) <= 2 && abs(live.minY - targetPoint.y) <= 2
              let sizeOk = abs(live.width - targetSize.width) <= 2 && abs(live.height - targetSize.height) <= 2
              if posOk && sizeOk { break }
              if let b = beforeBounds, (abs(live.width - b.width) > 1.5 || abs(live.height - b.height) > 1.5) {
                if let prev = prevSample, abs(live.width - prev.width) < 0.5, abs(live.height - prev.height) < 0.5 {
                  stableTicks += 1
                  if stableTicks >= 2 && posOk { break }
                } else {
                  stableTicks = 0
                }
              }
              prevSample = live.size
            }
            usleep(4_000)
          }
        } else {
          for _ in 0..<20 {
            placeLock.lock()
            let hasNewer = pendingPlaces[id] != nil
            placeLock.unlock()
            if hasNewer { superseded = true; break }
            if let live = Self.liveCGWindowBounds(id),
               abs(live.minX - targetPoint.x) <= 2, abs(live.minY - targetPoint.y) <= 2 {
              break
            }
            usleep(1_500)
          }
        }
      }
      if superseded { continue }

      let settledAt = mach_absolute_time()
      let settledRect = Self.liveCGWindowBounds(id) ?? job.local
      let didMoveRect: Bool
      if let b = beforeBounds {
        didMoveRect = abs(settledRect.minX - b.minX) > 1 || abs(settledRect.minY - b.minY) > 1 || abs(settledRect.width - b.width) > 1 || abs(settledRect.height - b.height) > 1
      } else {
        didMoveRect = true
      }
      sampler.sampleNow()
      sampler.endTransition(window: id, moved: didMoveRect, at: settledAt, seq: job.seq)
      placeLock.lock()
      if job.seq > (appliedSeq[id] ?? 0) {
        appliedSeq[id] = job.seq
      }
      placeLock.unlock()

      let didResize = job.resize
      let resolvedPid = matchedPid
      DispatchQueue.main.async { [weak self] in
        guard let self, !self.ended else { return }
        if didResize, resolvedPid != 0, self.streams[id] != nil {
          let (buttons, hitrects) = self.inspectWindowChrome(pid: resolvedPid, id: id, frame: settledRect)
          self.wire.send(["t": "chrome", "id": id, "buttons": buttons, "hitrects": hitrects])
        }
        self.lastLayout = ""
        self.track()
      }
    }
  }
}
