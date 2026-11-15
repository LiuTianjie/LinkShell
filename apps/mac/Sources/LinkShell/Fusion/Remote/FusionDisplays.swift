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

/// The remote Dock is hidden while fused (so window zoom matches the local usable frame). The
/// setting is a persistent preference: a marker file records that we changed it, so a crash or
/// `kill -9` is repaired by the next run instead of leaving the user without a Dock.
enum FusionDock {
  typealias DockGet = @convention(c) () -> Bool
  typealias DockSet = @convention(c) (Bool) -> Void
  static let services = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW)

  static func marker(home: String) -> String { home + "/fusion-dock-hidden" }

  static func hidden() -> Bool? {
    guard let symbol = dlsym(services, "CoreDockGetAutoHideEnabled") else { return nil }
    return unsafeBitCast(symbol, to: DockGet.self)()
  }

  static func setHidden(_ hidden: Bool) {
    guard let symbol = dlsym(services, "CoreDockSetAutoHideEnabled") else { return }
    unsafeBitCast(symbol, to: DockSet.self)(hidden)
  }

  /// Hides the Dock if it is shown; returns whether we did (and so must restore it).
  static func hide(home: String) -> Bool {
    guard hidden() == false else { return false }
    FileManager.default.createFile(atPath: marker(home: home), contents: Data("1".utf8))
    setHidden(true)
    return true
  }

  static func restore(home: String) {
    setHidden(false)
    try? FileManager.default.removeItem(atPath: marker(home: home))
  }

  static func restoreIfMarked(home: String) {
    guard FileManager.default.fileExists(atPath: marker(home: home)) else { return }
    Fusion.log("restoring the Dock an earlier run left hidden")
    restore(home: home)
  }
}

extension FusionRemoteSession {
  // MARK: displays

  static func settings(points: CGSize, scale: Int, hz: Double) -> CGVirtualDisplaySettings {
    let s = CGVirtualDisplaySettings()
    s.hiDPI = scale > 1 ? 1 : 0
    s.modes = [CGVirtualDisplayMode(width: UInt32(points.width.rounded()), height: UInt32(points.height.rounded()), refreshRate: min(max(hz, 60), 120))]
    return s
  }

  static func makeDisplay(index: Int, points: CGSize, scale: Int, hz: Double) -> CGVirtualDisplay? {
    let d = CGVirtualDisplayDescriptor()
    d.queue = .main
    d.name = "LinkShell Fusion \(index + 1)"
    d.maxPixelsWide = UInt32(points.width + 200) * UInt32(scale)
    d.maxPixelsHigh = UInt32(points.height + 200) * UInt32(scale)
    d.sizeInMillimeters = CGSize(width: points.width / 110 * 25.4, height: points.height / 110 * 25.4)
    d.vendorID = FusionProtocol.virtualDisplayVendor; d.productID = 0x4600 + UInt32(index); d.serialNum = 100 + UInt32(index)
    d.terminationHandler = { _, _ in Fusion.log("virtual display \(index) ended by the system") }
    guard let display = CGVirtualDisplay(descriptor: d) else { return nil }
    if !display.apply(settings(points: points, scale: scale, hz: hz)) { Fusion.log("virtual display \(index): settings refused") }
    return display
  }
}

extension FusionRemoteSession {
  /// The local Mac's screens changed (plugged, rescaled, woke): every window stream is closed and
  /// reopened on virtual displays that match again. Windows reappear locally a moment later.
  @MainActor func rebuildDisplays(_ locals: [[String: Any]]) async {
    guard displayReady, !rebuilding else {
      pendingDisplays = locals
      return
    }
    rebuilding = true
    displayReady = false
    Fusion.log("rebuilding virtual displays for \(locals.count) local display(s)")
    for id in Array(streams.keys) { closeStream(id) }
    for mirror in mirrors { media?.closeStream(mirror.streamKey) }
    mirrors.removeAll()
    moved.removeAll()
    lastLayout = ""
    lastPopups = []
    sampler.set(mirrors: [])
    await buildMirrors(locals)
    rebuilding = false
    guard !ended else { return }
    displayReady = true
    sendReady()
    if media == nil { startMedia() } else if restartAfterRebuild { restartMedia() } else { for mirror in mirrors { openOverlay(mirror) } }
    restartAfterRebuild = false
    if let next = pendingDisplays {
      pendingDisplays = nil
      await rebuildDisplays(next)
    }
  }

  @MainActor func buildMirrors(_ locals: [[String: Any]]) async {
    var menuBar: CGFloat = 30
    // Size each virtual display to `screenBounds.width × ceil4(screenBounds.height + menuBar)` so even
    // below the remote macOS menu bar, 100% of a full-screen window's height fits on the desktop with
    // clean macroblock-friendly even pixel alignment!
    func region(_ screen: CGRect) -> CGRect {
      let w = ceil(screen.width / 4.0) * 4.0
      let h = ceil((screen.height + menuBar) / 4.0) * 4.0
      return CGRect(x: screen.minX, y: screen.minY - menuBar, width: w, height: h)
    }
    var hz: [Int: Double] = [:]
    for (i, d) in locals.enumerated() {
      let frame = Fusion.rect(d["frame"]); let scale = FusionProtocol.backingScale(Fusion.number(d["scale"]))
      var visible = Fusion.rect(d["visible"])
      if visible.width < 100 || visible.height < 100 { visible = frame }
      hz[i] = max(Fusion.number(d["hz"]), 60)
      guard let vd = Self.makeDisplay(index: i, points: region(frame).size, scale: scale, hz: hz[i]!) else { continue }
      mirrors.append(Mirror(index: i, screenBounds: frame, local: region(frame), visible: visible, menuBarHeight: menuBar, scale: scale, hz: hz[i]!, display: vd))
    }
    try? await Task.sleep(nanoseconds: 1_500_000_000)
    guard !ended else { return }
    let measured = mirrors.compactMap { mirror -> CGFloat? in
      guard let screen = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == mirror.display.displayID }) else { return nil }
      return screen.frame.maxY - screen.visibleFrame.maxY
    }.max()
    if let measured, measured > 0, abs(measured - menuBar) > 0.5 {
      Fusion.log("menu bar here is \(measured) pt, not \(menuBar): resizing")
      menuBar = measured
      for mirror in mirrors {
        mirror.menuBarHeight = menuBar
        mirror.local = region(mirror.screenBounds)
        _ = mirror.display.apply(Self.settings(points: mirror.local.size, scale: mirror.scale, hz: hz[mirror.index] ?? 60))
      }
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard !ended else { return }
    }
    let ours = Set(mirrors.map { $0.display.displayID })
    let own = Display.all.map(\.id).filter { !ours.contains($0) }
    var cursorX = Int32((own.map { CGDisplayBounds($0).maxX }.max() ?? 0).rounded())
    var config: CGDisplayConfigRef?
    CGBeginDisplayConfiguration(&config)
    for mirror in mirrors {
      CGConfigureDisplayOrigin(config, mirror.display.displayID, cursorX, 0)
      cursorX += Int32(mirror.local.width.rounded())
    }
    CGCompleteDisplayConfiguration(config, .forSession)
    try? await Task.sleep(nanoseconds: 800_000_000)
    guard !ended else { return }
    for mirror in mirrors { mirror.remote = CGDisplayBounds(mirror.display.displayID) }
    sampler.set(mirrors: mirrors.map { .init(id: $0.display.displayID, remote: $0.remote, local: $0.local, scale: $0.scale) })
    sampler.start()
  }
}
