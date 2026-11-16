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

extension FusionRemoteSession {
  // MARK: apps, icons, and windows

  static func apps() -> [[String: Any]] {
    var seen: Set<String> = []
    var paths: [String: String] = [:]
    var result: [[String: Any]] = []
    let folders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
    for folder in folders {
      for name in (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? [] where name.hasSuffix(".app") {
        let rawURL = URL(fileURLWithPath: folder).appendingPathComponent(name)
        let resolvedURL = rawURL.resolvingSymlinksInPath()
        guard let bundle = Bundle(url: resolvedURL) ?? Bundle(url: rawURL),
              let id = bundle.bundleIdentifier, !seen.contains(id),
              id != "com.bd.linkshell.host", !id.hasPrefix("com.bd.linkshell."), !id.hasPrefix("LinkShell."),
              bundle.object(forInfoDictionaryKey: "LSUIElement") as? Bool != true,
              bundle.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool != true else { continue }
        seen.insert(id)
        paths[id] = resolvedURL.path
        let cat = bundle.object(forInfoDictionaryKey: "LSApplicationCategoryType") as? String ?? ""
        let isSystem = id != "com.apple.Safari" && (folder.hasPrefix("/System/") || resolvedURL.path.hasPrefix("/System/Applications/"))
        result.append([
          "name": FileManager.default.displayName(atPath: resolvedURL.path).replacingOccurrences(of: ".app", with: ""),
          "app": id,
          "category": cat,
          "system": isSystem,
        ])
      }
    }
    appPathsLock.lock()
    appPaths = paths
    appPathsLock.unlock()
    return result.sorted { ($0["name"] as? String ?? "").localizedStandardCompare($1["name"] as? String ?? "") == .orderedAscending }
  }

  static func resolvedApplicationURL(for bundle: String) -> URL? {
    if let wsURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) {
      return wsURL.resolvingSymlinksInPath()
    }
    appPathsLock.lock()
    let stored = appPaths[bundle]
    appPathsLock.unlock()
    if let stored, FileManager.default.fileExists(atPath: stored) {
      return URL(fileURLWithPath: stored).resolvingSymlinksInPath()
    }
    return nil
  }

  /// `pixels`: the side the local computer wants (a Windows taskbar needs 256, a Mac's Dock 1024).
  /// Always answered, without `png` when there is no icon: the local side asks for the next one then.
  func sendIcon(_ bundle: String, pixels: Int? = nil) {
    guard let data = Self.iconPNG(bundle, pixels: min(1024, max(64, pixels ?? 1024))) else {
      return wire.send(["t": "icon", "app": bundle])
    }
    wire.send(["t": "icon", "app": bundle, "png": data.base64EncodedString()])
  }

  static func iconPNG(_ bundle: String, pixels: Int) -> Data? {
    // Always resolve symlinks (e.g. `/Applications/Safari.app -> .../Cryptexes/.../Safari.app`)
    // before `NSWorkspace.shared.icon(forFile:)` so macOS never stamps a shortcut alias arrow!
    guard let resolvedURL = resolvedApplicationURL(for: bundle) else { return nil }
    let icon = NSWorkspace.shared.icon(forFile: resolvedURL.path)
    // Two pixels to a point, as the Dock draws it.
    let ptSize = NSSize(width: Double(pixels) / 2, height: Double(pixels) / 2)
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return nil }
    rep.size = ptSize
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    icon.draw(in: NSRect(origin: .zero, size: ptSize), from: .zero, operation: .copy, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
  }

  func resetWindowTracking(for pids: Set<pid_t>) {
    guard !pids.isEmpty else { return }
    let list = (CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var appWinIDs: Set<CGWindowID> = []
    for info in list {
      if let pid = info[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
         let id = info[kCGWindowNumber as String] as? CGWindowID {
        appWinIDs.insert(id)
      }
    }
    for id in appWinIDs {
      offDisplayStamps[id] = nil
      spaceRescueStamps[id] = nil
      peakWindowAlpha[id] = nil
      if streams[id] == nil {
        moved.remove(id)
        if windowKinds[id]?.isStandardRoot != true { windowKinds[id] = nil }
      }
    }
  }

  func launch(_ bundle: String) {
    guard let url = Self.resolvedApplicationURL(for: bundle) else {
      return wire.send(["t": "alert", "kind": "launch", "subject": bundle, "message": "远端 Mac 上找不到这个应用（\(bundle)）"])
    }
    fusedBundles.insert(bundle)
    let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
    let wasRunning = !existing.isEmpty
    var existingPids: Set<pid_t> = []
    for running in existing {
      let pid = running.processIdentifier
      existingPids.insert(pid)
      if running.isHidden { _ = running.unhide() }
      pidToBundle[pid] = bundle
      fused.insert(pid)
      noteUserAction(pid: pid)
    }
    resetWindowTracking(for: existingPids)
    // When an app is already frontmost on the remote Mac with zero windows, `openApplication` alone
    // may skip `applicationShouldHandleReopen`: yielding frontmost first makes AppKit deliver reopen.
    if existing.contains(where: \.isActive) {
      let hasAnyAXWindow = existing.contains { proc in
        var ref: CFTypeRef?
        return AXUIElementCopyAttributeValue(Self.axApp(proc.processIdentifier), kAXWindowsAttribute as CFString, &ref) == .success
          && ((ref as? [AXUIElement])?.isEmpty == false)
      }
      if !hasAnyAXWindow { NSApp.activate(ignoringOtherApps: true) }
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { [weak self] app, error in
      DispatchQueue.main.async {
        guard let self, !self.ended else { return }
        guard let app else {
          Fusion.log("launch \(bundle) failed: \(error?.localizedDescription ?? "?")")
          self.wire.send(["t": "alert", "kind": "launch", "subject": bundle, "message": "远端应用启动失败：\(error?.localizedDescription ?? "未知原因")"])
          return
        }
        self.wire.send(["t": "alert", "kind": "launch", "subject": bundle, "clear": true])
        var allPids: Set<pid_t> = [app.processIdentifier]
        for proc in NSRunningApplication.runningApplications(withBundleIdentifier: bundle) where !proc.isTerminated {
          if proc.isHidden { _ = proc.unhide() }
          self.pidToBundle[proc.processIdentifier] = bundle
          self.fused.insert(proc.processIdentifier)
          self.noteUserAction(pid: proc.processIdentifier)
          allPids.insert(proc.processIdentifier)
        }
        self.resetWindowTracking(for: allPids)
        _ = app.activate(options: [.activateIgnoringOtherApps])
        Fusion.log("fused \(bundle) (\(app.processIdentifier))")
        self.track()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
          self?.rescueOffDesktopWindows()
          self?.track()
        }
        if wasRunning {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.42) { [weak self] in
            self?.openNewWindowIfStillWindowless(bundle: bundle, preferredPid: app.processIdentifier)
          }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
          self?.syncDockMenuIfNeeded(pid: app.processIdentifier, bundle: bundle, force: true)
        }
      }
    }
  }

  /// A running Mac app that stayed windowless after reopen (some background/Electron/browser states
  /// ignore LaunchServices reopen from an accessory process): press its first "New Window" menu item.
  private func openNewWindowIfStillWindowless(bundle: String, preferredPid: pid_t) {
    guard !ended, fusedBundles.contains(bundle) else { return }
    if streams.values.contains(where: { $0.app == bundle }) { return }
    let pids = Array(Set([preferredPid] + fused.filter { pidToBundle[$0] == bundle }))
    axQueue.async { [weak self] in
      guard let self else { return }
      for pid in pids {
        var ref: CFTypeRef?
        if AXUIElementCopyAttributeValue(Self.axApp(pid), kAXWindowsAttribute as CFString, &ref) == .success,
           let wins = ref as? [AXUIElement], !wins.isEmpty {
          DispatchQueue.main.async { [weak self] in self?.rescueOffDesktopWindows(); self?.track() }
          return
        }
      }
      let items = self.extractDockMenu(pid: preferredPid)
      guard let action = items.first(where: { ($0["section"] as? String) == "action" }),
            let path = (action["path"] as? [Any])?.compactMap({ ($0 as? Int) ?? ($0 as? NSNumber)?.intValue }),
            path.count >= 2 else { return }
      DispatchQueue.main.async { [weak self] in
        guard let self, !self.ended, self.streams.values.allSatisfy({ $0.app != bundle }) else { return }
        Fusion.log("launch \(bundle): still 0 AX windows, pressing menu \(action["title"] ?? "New Window")")
        self.performDockAction(bundle: bundle, path: path)
      }
    }
  }

  func quit(_ bundle: String, force: Bool) {
    fusedBundles.remove(bundle)
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    if running.isEmpty {
      wire.send(["t": "app.exited", "app": bundle])
      return
    }
    for app in running {
      if force {
        _ = app.forceTerminate()
      } else {
        _ = app.activate(options: [.activateIgnoringOtherApps])
        _ = app.terminate()
      }
    }
    guard !force else { return }
    // If an app closed all its visible windows upon `terminate()` (no Save confirmation dialog)
    // yet lingered as a windowless background process, finish terminating it promptly.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
      guard let self, !self.ended else { return }
      let still = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
      guard !still.isEmpty else { return }
      let pids = Set(still.map(\.processIdentifier))
      let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
      let hasVisibleWindow = list.contains { info in
        guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let f = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              f.width >= 80, f.height >= 50,
              (info[kCGWindowLayer as String] as? Int ?? 0) <= 3 else { return false }
        return true
      }
      if !hasVisibleWindow {
        for app in still { _ = app.forceTerminate() }
      }
    }
  }

  func resolveWindowTitle(pid: pid_t, id: CGWindowID, cgTitle: String, bundle: String) -> String {
    if !cgTitle.isEmpty { return cgTitle }
    let now = CACurrentMediaTime()
    if let cached = axTitles[id], now - cached.at < 2.0, !cached.title.isEmpty {
      return cached.title
    }
    var resolved = ""
    if let w = axWindow(pid: pid, id: id) {
      var ref: CFTypeRef?
      if AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &ref) == .success,
         let s = ref as? String, !s.isEmpty {
        resolved = s
      }
    }
    if resolved.isEmpty {
      resolved = NSRunningApplication(processIdentifier: pid)?.localizedName
        ?? bundle.split(separator: ".").last.map(String.init) ?? "Window"
    }
    axTitles[id] = (resolved, now)
    return resolved
  }
}
