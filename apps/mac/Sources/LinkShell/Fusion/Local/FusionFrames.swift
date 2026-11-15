import AppKit
import CoreVideo
import CryptoKit
import Darwin
import Foundation
import IOSurface
import ImageIO
import LinkShellScreen
import Network
import UniformTypeIdentifiers
import WebRTC

extension FusionLocal {
  // MARK: Window & Frame Routing to Per-App Stubs

  static func parseButtons(_ any: Any?) -> [String: [Double]] {
    guard let raw = any as? [String: Any] else { return [:] }
    var out: [String: [Double]] = [:]
    for (k, v) in raw {
      if let arr = (v as? [Any])?.compactMap({ ($0 as? NSNumber)?.doubleValue }), arr.count == 4 {
        out[k] = arr
      }
    }
    return out
  }

  static func parseHitRects(_ any: Any?) -> [[Double]] {
    guard let raw = any as? [Any] else { return [] }
    return raw.compactMap { item in
      guard let arr = (item as? [Any])?.compactMap({ ($0 as? NSNumber)?.doubleValue }), arr.count == 4 else { return nil }
      return arr
    }
  }

  func remoteWindowOpened(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let bundle = m["bundle"] as? String ?? ""
    // A window that opens while the app is quitting is usually its "save changes?" prompt: show it.
    quittingBundles.removeValue(forKey: bundle)
    let title = m["title"] as? String ?? (apps.first(where: { $0.bundle == bundle })?.name ?? "")
    let toolbar = m["toolbar"] as? Bool == true
    let radius = toolbar ? 26.0 : 17.0
    let frame = Fusion.rect(m["frame"])
    let buttons = Self.parseButtons(m["buttons"])
    let hitrects = Self.parseHitRects(m["hitrects"])
    windows[id] = WindowRecord(
      id: id, bundle: bundle, title: title, toolbar: toolbar, cornerRadius: radius,
      frame: frame, dragZone: nil, buttons: buttons, hitrects: hitrects, ackSeq: 0
    )

    let key = "w\(id)"
    // Only a window that follows something the person did in that app takes the focus here;
    // windows replayed on reconnect or opened by the app on its own never steal it.
    let activate = m["activate"] as? Bool == true
    receiver(key) { [weak self] buffer, sei in
      self?.handleWindowPicture(id: id, key: key, buffer: buffer, sei: sei)
    }
    if !bundle.isEmpty { ensureStubRunning(bundle: bundle, activate: activate) }
    if let stub = stubs[bundle] {
      let (ctrl, keys) = control(of: key)
      stub.send([
        "t": "wopen", "id": Int(id), "title": title, "toolbar": toolbar, "r": radius,
        "frame": Fusion.dict(frame), "control": ctrl, "keys": keys,
        "buttons": buttons, "hitrects": hitrects, "ack": 0,
        "activate": activate,
      ])
    }
    refreshStatus()
  }

  func remoteWindowClosed(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let key = "w\(id)"
    receivers.removeValue(forKey: key)?.stop()
    outputs.removeValue(forKey: key)
    lastWindowSEI.removeValue(forKey: id)
    clearAlert("webrtc", subject: key)
    let rec = windows.removeValue(forKey: id)
    syncFastState(removedWindowIDs: [id])
    if let rec {
      stubs[rec.bundle]?.send(["t": "wclose", "id": Int(id)])
    }
    refreshStatus()
  }

  func remoteWindowStyle(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let toolbar = m["toolbar"] as? Bool == true
    let r = Fusion.number(m["r"])
    let radius = r >= 6 ? r : (toolbar ? 26.0 : 17.0)
    let title = m["title"] as? String ?? ""
    let buttons = Self.parseButtons(m["buttons"])
    let hitrects = Self.parseHitRects(m["hitrects"])
    windows[id]?.toolbar = toolbar
    windows[id]?.cornerRadius = radius
    if !title.isEmpty { windows[id]?.title = title }
    if !buttons.isEmpty { windows[id]?.buttons = buttons }
    if m["hitrects"] != nil { windows[id]?.hitrects = hitrects }
    if let bundle = windows[id]?.bundle {
      stubs[bundle]?.send([
        "t": "style", "id": Int(id), "toolbar": toolbar, "r": radius, "title": title,
        "buttons": windows[id]?.buttons ?? buttons, "hitrects": windows[id]?.hitrects ?? hitrects,
      ])
    }
  }

  func remoteWindowChrome(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let buttons = Self.parseButtons(m["buttons"])
    let hitrects = Self.parseHitRects(m["hitrects"])
    if !buttons.isEmpty { windows[id]?.buttons = buttons }
    windows[id]?.hitrects = hitrects
    if let bundle = windows[id]?.bundle {
      stubs[bundle]?.send([
        "t": "chrome", "id": Int(id),
        "buttons": windows[id]?.buttons ?? buttons,
        "hitrects": hitrects,
      ])
    }
  }

  func remoteDragZone(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let ok = m["ok"] as? Bool == true
    windows[id]?.dragZone = ok
    if let bundle = windows[id]?.bundle {
      stubs[bundle]?.send(["t": "dragzone", "id": Int(id), "ok": ok])
    }
  }

  func remoteLayout(_ list: [[String: Any]]) {
    var seenPopups: Set<CGWindowID> = []
    var windowsChanged = false
    for entry in list {
      let id = CGWindowID(Fusion.number(entry["id"]))
      let own = entry["own"] as? Bool == true
      let bundle = entry["bundle"] as? String ?? ""
      let frame = Fusion.rect(entry["frame"])
      if own {
        if windows[id] != nil {
          if !bundle.isEmpty, windows[id]?.bundle != bundle {
            windows[id]?.bundle = bundle
            windowsChanged = true
          }
          let ownerBundle = !bundle.isEmpty ? bundle : (windows[id]?.bundle ?? "")
          if let newTitle = entry["title"] as? String, !newTitle.isEmpty, windows[id]?.title != newTitle {
            windows[id]?.title = newTitle
            stubs[ownerBundle]?.send(["t": "title", "id": Int(id), "title": newTitle])
          }
          let ack = DesktopScreenBridge.integer(entry["ack"]) ?? 0
          let prevAck = windows[id]?.ackSeq ?? 0
          let prevFrame = windows[id]?.frame ?? .zero
          if ack != prevAck || frame != prevFrame {
            windows[id]?.ackSeq = ack
            windows[id]?.frame = frame
            windowsChanged = true
            stubs[ownerBundle]?.send(["t": "wlayout", "id": Int(id), "frame": Fusion.dict(frame), "ack": ack])
          }
        }
      } else {
        seenPopups.insert(id)
        let parent = CGWindowID(Fusion.number(entry["parent"]))
        let pdx = (entry["pdx"] as? NSNumber)?.doubleValue
        let pdy = (entry["pdy"] as? NSNumber)?.doubleValue
        popups[id] = PopupRecord(id: id, bundle: bundle, parentID: parent, frame: frame, pdx: pdx, pdy: pdy, layer: Int(Fusion.number(entry["layer"])))
      }
    }
    if windowsChanged { syncFastState() }
    for (pid, rec) in popups where !seenPopups.contains(pid) {
      stubs[rec.bundle]?.send(["t": "popup.hide", "id": Int(pid)])
      popups.removeValue(forKey: pid)
    }
    if let topEntry = list.first(where: { ($0["own"] as? Bool) == true }) {
      let topID = CGWindowID(Fusion.number(topEntry["id"]))
      if topID != frontWindowID {
        frontWindowID = topID
        if let bundle = windows[topID]?.bundle {
          stubs[bundle]?.send(["t": "front", "id": Int(topID)])
        }
      }
    }
  }

  static func computeFallbackWindowCrop(for frame: CGRect, in displays: [Int: (local: CGRect, scale: Int)]) -> [Double]? {
    let best = displays.values.max { a, b in
      let ia = a.local.intersection(frame), ib = b.local.intersection(frame)
      let areaA = ia.isNull ? 0 : ia.width * ia.height
      let areaB = ib.isNull ? 0 : ib.width * ib.height
      return areaA < areaB
    }
    guard let disp = best, disp.local.width > 0, disp.local.height > 0 else { return nil }
    let vis = frame.intersection(disp.local)
    guard !vis.isNull, vis.width >= 2, vis.height >= 2 else { return nil }
    let nx = min(1, max(0, Double((vis.minX - disp.local.minX) / disp.local.width)))
    let ny = min(1, max(0, Double((vis.minY - disp.local.minY) / disp.local.height)))
    let nw = min(1 - nx, max(0.001, Double(vis.width / disp.local.width)))
    let nh = min(1 - ny, max(0.001, Double(vis.height / disp.local.height)))
    return [
      Double(frame.minX), Double(frame.minY), Double(frame.width), Double(frame.height),
      nx, ny, nw, nh,
      Double(vis.minX - frame.minX), Double(vis.minY - frame.minY), Double(vis.width), Double(vis.height),
    ]
  }

  func handleWindowPictureFast(id: CGWindowID, key: String, buffer: CVPixelBuffer, sei: Data?) {
    let parsedSEI = sei.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [Double] }
    let now = CACurrentMediaTime()
    fastLock.lock()
    guard let winInfo = fastWindows[id], !winInfo.bundle.isEmpty else { fastLock.unlock(); return }
    guard let stub = fastStubs[winInfo.bundle] else { fastLock.unlock(); return }
    var resolved: [Double]?
    if let arr = parsedSEI, arr.count >= 12 {
      fastWindowSEI[id] = arr
      resolved = arr
    } else if fastWindowSEI[id] == nil {
      resolved = Self.computeFallbackWindowCrop(for: winInfo.frame, in: fastDisplays)
    }
    fastLock.unlock()

    // Never apply stale `fastWindowSEI` to an SEI-less buffer, and never fall back to uncropped `(0, 0, bw, bh)`.
    guard let arr = resolved, arr.count >= 12 else { return }
    guard let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else { return }
    let bw = min(CVPixelBufferGetWidth(buffer), IOSurfaceGetWidth(surface))
    let bh = min(CVPixelBufferGetHeight(buffer), IOSurfaceGetHeight(surface))
    guard bw >= 4, bh >= 4 else { return }

    let lx = arr[0], ly = arr[1], lw = arr[2], lh = arr[3]
    var cx: Int, cy: Int, cw: Int, ch: Int
    if arr[6] <= 1.0001 && arr[7] <= 1.0001 {
      cx = Int((arr[4] * Double(bw)).rounded())
      cy = Int((arr[5] * Double(bh)).rounded())
      cw = Int((arr[6] * Double(bw)).rounded())
      ch = Int((arr[7] * Double(bh)).rounded())
    } else {
      cx = Int(arr[4]); cy = Int(arr[5]); cw = Int(arr[6]); ch = Int(arr[7])
    }
    let ix = arr[8], iy = arr[9], iw = arr[10], ih = arr[11]
    let fscale = arr.count >= 13 ? arr[12] : 1.0
    let fack = arr.count >= 14 ? Int(arr[13]) : 0
    cx = max(0, min(cx, bw - 2)); cy = max(0, min(cy, bh - 2))
    cw = max(2, min(cw, bw - cx)); ch = max(2, min(ch, bh - cy))
    let matrix = (CVBufferCopyAttachment(buffer, kCVImageBufferYCbCrMatrixKey, nil) as? String) ?? ""
    let metaObj: [String: Any] = [
      "width": cw, "height": ch, "rotation": 0,
      "x": cx, "y": cy, "w": cw, "h": ch, "matrix": matrix,
      "wid": Int(id), "popup": false, "key": key,
      "f": [lx, ly, lw, lh],
      "in": [ix, iy, iw, ih],
      "fscale": fscale,
      "fack": fack,
    ]
    guard let meta = try? JSONSerialization.data(withJSONObject: metaObj), meta.count < 1024 else { return }
    stub.deliver(windowKey: id, buffer: buffer, surface: surface, metadata: meta)
  }

  func handleWindowPicture(id: CGWindowID, key: String, buffer: CVPixelBuffer, sei: Data?) {
    handleWindowPictureFast(id: id, key: key, buffer: buffer, sei: sei)
  }

  func handleDisplayPicture(_ index: Int, _ buffer: CVPixelBuffer, _ sei: Data?) {
    guard let display = displays[index],
          let sei, let list = (try? JSONSerialization.jsonObject(with: sei)) as? [[Double]] else { return }
    guard let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else { return }
    let bw = min(CVPixelBufferGetWidth(buffer), IOSurfaceGetWidth(surface))
    let bh = min(CVPixelBufferGetHeight(buffer), IOSurfaceGetHeight(surface))
    let scale = CGFloat(bw) / max(display.local.width, 1)
    let key = "d\(index)"
    let matrix = (CVBufferCopyAttachment(buffer, kCVImageBufferYCbCrMatrixKey, nil) as? String) ?? ""
    var active: Set<CGWindowID> = []

    for e in list where e.count == 6 {
      let id = CGWindowID(e[0])
      guard let rec = popups[id], let stub = stubs[rec.bundle] else { continue }
      let frame = CGRect(x: e[2], y: e[3], width: e[4], height: e[5])
      let visible = frame.intersection(display.local)
      guard !visible.isNull, visible.width >= 2, visible.height >= 2 else { continue }
      let crop = CGRect(x: (visible.minX - display.local.minX) * scale,
                        y: (visible.minY - display.local.minY) * scale,
                        width: visible.width * scale,
                        height: visible.height * scale)
        .integral.intersection(CGRect(x: 0, y: 0, width: bw, height: bh))
      guard crop.width >= 2, crop.height >= 2 else { continue }
      active.insert(id)
      let inWin = CGRect(x: visible.minX - frame.minX, y: visible.minY - frame.minY, width: visible.width, height: visible.height)
      var metaObj: [String: Any] = [
        "width": Int(crop.width), "height": Int(crop.height), "rotation": 0,
        "x": Int(crop.minX), "y": Int(crop.minY), "w": Int(crop.width), "h": Int(crop.height), "matrix": matrix,
        "wid": Int(id), "popup": true, "parent": Int(rec.parentID), "key": key, "layer": rec.layer,
        "disp": [Double(bw), Double(bh)],
        "f": [Double(frame.minX), Double(frame.minY), Double(frame.width), Double(frame.height)],
        "in": [Double(inWin.minX), Double(inWin.minY), Double(inWin.width), Double(inWin.height)],
      ]
      if let pdx = rec.pdx, let pdy = rec.pdy {
        metaObj["rel"] = [pdx, pdy]
      }
      if let meta = try? JSONSerialization.data(withJSONObject: metaObj), meta.count < 1024 {
        stub.deliver(windowKey: id, buffer: buffer, surface: surface, metadata: meta)
      }
    }

    let previous = shownPopupsByDisplay[key] ?? []
    for gone in previous.subtracting(active) {
      if let rec = popups[gone] { stubs[rec.bundle]?.send(["t": "popup.hide", "id": Int(gone)]) }
    }
    shownPopupsByDisplay[key] = active
  }

  func controlChanged(_ key: String) {
    let (enabled, keys) = control(of: key)
    if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()), let bundle = windows[id]?.bundle {
      stubs[bundle]?.send(["t": "control", "key": key, "enabled": enabled, "keys": keys])
    } else {
      for stub in stubs.values {
        stub.send(["t": "control", "key": key, "enabled": enabled, "keys": keys])
      }
    }
  }

  func control(of key: String) -> (Bool, Bool) {
    (outputs[key]?.controlEnabled ?? false, outputs[key]?.physicalKeys ?? false)
  }

  func cursor(_ key: String, _ message: [String: Any]) {
    guard message["t"] as? String == "shape" else { return }
    if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()), let bundle = windows[id]?.bundle {
      stubs[bundle]?.send(["t": "cursor", "key": key, "m": message])
    } else {
      for stub in stubs.values { stub.send(["t": "cursor", "key": key, "m": message]) }
    }
  }
}

final class FusionOutput: NSObject, DesktopScreenOutput {
  let key: String
  let windowID: CGWindowID?
  weak var owner: FusionLocal?
  let picture: (CVPixelBuffer, Data?) -> Void
  var onInput: (([String: Any], Bool) -> Void)?
  var onFirstFrame: (() -> Void)?
  var onFailure: ((String) -> Void)?
  var controlEnabled = false { didSet { owner?.controlChanged(key) } }
  var physicalKeys = false { didSet { owner?.controlChanged(key) } }
  var first = true

  init(key: String, owner: FusionLocal, picture: @escaping (CVPixelBuffer, Data?) -> Void) {
    self.key = key
    self.windowID = key.hasPrefix("w") ? CGWindowID(key.dropFirst()) : nil
    self.owner = owner
    self.picture = picture
  }

  func setSize(_ size: CGSize) {}

  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame, let buffer = frame.buffer as? RTCCVPixelBuffer else { return }
    let pixels = buffer.pixelBuffer
    let layout = FusionMetadata.layout(of: pixels)
    if first { first = false; onFirstFrame?() }
    if let wid = windowID, let owner {
      let k = key
      owner.frameQueue.async { [weak owner] in
        owner?.handleWindowPictureFast(id: wid, key: k, buffer: pixels, sei: layout)
      }
    } else {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.picture(pixels, layout)
      }
    }
  }

  func updateCursor(_ message: [String: Any]) { owner?.cursor(key, message) }
  func stop() {}
}
