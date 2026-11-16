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
  // MARK: Stub .app Bundle Generation & Badged Icon Compositor

  func iconCacheFile(for bundle: String) -> URL {
    iconCacheDir.appendingPathComponent("\(FusionProtocol.iconFile(bundle)).png")
  }

  func uiIconFile(for bundle: String) -> URL {
    uiIconCacheDir.appendingPathComponent("\(FusionProtocol.iconFile(bundle)).png")
  }

  static func writeUITilePNG(image: NSImage, to url: URL) {
    let px = 160
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return }
    rep.size = NSSize(width: 80, height: 80)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: 80, height: 80), from: .zero, operation: .copy, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()
    if let png = rep.representation(using: .png, properties: [:]) {
      try? png.write(to: url, options: .atomic)
    }
  }

  func saveCatalogToDisk() {
    guard !apps.isEmpty else { return }
    let payload: [String: Any] = [
      "computerKey": computerKey,
      "hostLabel": hostLabel,
      "hostSlug": hostSlug,
      "appsDir": appsDir.path,
      "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
      "apps": apps.map { entry -> [String: Any] in
        [
          "name": entry.name,
          "bundle": entry.bundle,
          "category": entry.category,
          "rawCategory": entry.rawCategory,
          "isSystem": entry.isSystem,
          "stubPath": stubURLs[entry.bundle]?.path ?? "",
        ]
      },
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      try? data.write(to: iconCacheDir.appendingPathComponent("catalog.json"), options: .atomic)
    }
  }

  static func shortSHA256(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
  }

  func preloadCachedIcons() {
    guard let files = try? FileManager.default.contentsOfDirectory(at: iconCacheDir, includingPropertiesForKeys: nil) else { return }
    for file in files where file.pathExtension == "png" {
      let bundle = file.deletingPathExtension().lastPathComponent
      guard !bundle.isEmpty,
            let data = try? Data(contentsOf: file),
            let raw = NSImage(data: data) else { continue }
      let (badged, badgedPNG) = Self.composeBadgedIcon(base: raw, hostLabel: hostLabel)
      icons[bundle] = badged
      iconHashes[bundle] = Self.shortSHA256(data)
      realIconBundles.insert(bundle)
      if let badgedPNG { iconPNGs[bundle] = badgedPNG }
      let uiURL = uiIconFile(for: bundle)
      if !FileManager.default.fileExists(atPath: uiURL.path) {
        stubQueue.async {
          Self.writeUITilePNG(image: badged, to: uiURL)
        }
      }
    }
  }

  /// Resolves the best available icon for `bundle` before the remote icon arrives over the wire:
  /// 1) Disk cache (`~/.linkshell/fusion-icons/<host>/<bundle>.png`),
  /// 2) Same-bundle local macOS app (resolving symlinks so Safari never gets an alias arrow!),
  /// 3) Generic `.applicationBundle` fallback (`isReal = false`).
  struct ResolvedIcon {
    let image: NSImage
    let isReal: Bool
    let hash: String
    let png: String?
    let fromCache: Bool
  }

  /// Pure, so it can run on `stubQueue`: the disk cache, then a same-bundle local app (symlinks
  /// resolved so Safari never gets an alias arrow), then a generic app icon (`isReal = false`).
  static func resolveFallbackIcon(bundle: String, cacheFile: URL, hostLabel: String) -> ResolvedIcon {
    if let data = try? Data(contentsOf: cacheFile), let raw = NSImage(data: data) {
      let (badged, png) = composeBadgedIcon(base: raw, hostLabel: hostLabel)
      return ResolvedIcon(image: badged, isReal: true, hash: shortSHA256(data), png: png, fromCache: true)
    }
    if let localURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle),
       !localURL.path.contains("/Applications/LinkShell/") {
      let raw = NSWorkspace.shared.icon(forFile: localURL.resolvingSymlinksInPath().path)
      let (badged, _) = composeBadgedIcon(base: raw, hostLabel: hostLabel)
      return ResolvedIcon(image: badged, isReal: true, hash: "local-\(bundle)", png: nil, fromCache: false)
    }
    let generic = composeBadgedIcon(base: NSWorkspace.shared.icon(for: .applicationBundle), hostLabel: hostLabel).image
    return ResolvedIcon(image: generic, isReal: false, hash: "generic", png: nil, fromCache: false)
  }

  /// Main thread only: records a cache hit so later lookups are free.
  func adopt(_ icon: ResolvedIcon, for bundle: String) {
    guard icon.fromCache else { return }
    icons[bundle] = icon.image
    iconHashes[bundle] = icon.hash
    realIconBundles.insert(bundle)
    if let png = icon.png { iconPNGs[bundle] = png }
  }

  /// Icons are asked for one at a time. All at once (a hundred apps, up to a megabyte each from a
  /// Mac) they filled the control connection for seconds on a LAN and for minutes through a relay,
  /// where the gateway closes a receiver that falls 4 MB behind, with every window and every
  /// answer queued behind them. `first`: an app being opened now does not wait its turn.
  func requestIconIfNeeded(_ bundle: String, first: Bool = false) {
    guard !bundle.isEmpty else { return }
    // An icon kept from an earlier session is asked for again only when its app is opened: every
    // connect, and every resume after a drop, asked for all of them ahead of the first picture.
    if !first, realIconBundles.contains(bundle) { return }
    if iconRequested.contains(bundle) {
      if first, let index = iconQueue.firstIndex(of: bundle), index > 0 {
        iconQueue.remove(at: index)
        iconQueue.insert(bundle, at: 0)
      }
      return
    }
    iconRequested.insert(bundle)
    if first { iconQueue.insert(bundle, at: 0) } else { iconQueue.append(bundle) }
    requestNextIcon()
  }

  func requestNextIcon() {
    guard iconInFlight == nil, !iconQueue.isEmpty, let wire else { return }
    let bundle = iconQueue.removeFirst()
    iconInFlight = bundle
    // No Dock draws one larger, and a 1024 px icon is four times the bytes.
    wire.send(["t": "icon", "app": bundle, "size": 512])
    // A remote that has no icon for it answers without one; an older remote does not answer at all.
    iconTimer?.invalidate()
    iconTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.iconAnswered(bundle) }
  }

  func iconAnswered(_ bundle: String) {
    guard iconInFlight == bundle else { return }
    iconInFlight = nil
    iconTimer?.invalidate()
    iconTimer = nil
    requestNextIcon()
  }

  func remoteIcon(_ m: [String: Any]) {
    if let answered = m["app"] as? String { iconAnswered(answered) }
    guard let bundle = m["app"] as? String,
          let b64 = m["png"] as? String,
          let data = Data(base64Encoded: b64),
          let raw = NSImage(data: data) else { return }
    let newHash = Self.shortSHA256(data)
    try? data.write(to: iconCacheFile(for: bundle), options: .atomic)
    let (badged, badgedPNG) = Self.composeBadgedIcon(base: raw, hostLabel: hostLabel)
    let uiURL = uiIconFile(for: bundle)
    stubQueue.async {
      Self.writeUITilePNG(image: badged, to: uiURL)
    }
    icons[bundle] = badged
    iconHashes[bundle] = newHash
    realIconBundles.insert(bundle)
    if let badgedPNG {
      iconPNGs[bundle] = badgedPNG
      if !stubHadRealIconOnLaunch.contains(bundle) {
        stubs[bundle]?.send(["t": "app.icon", "png": badgedPNG, "force": true])
        stubHadRealIconOnLaunch.insert(bundle)
      }
    }
    if let entry = apps.first(where: { $0.bundle == bundle }) {
      let shouldMaterialize = !entry.isSystem
        || entry.bundle == "com.apple.Safari"
        || stubs[bundle] != nil
        || launchingStubs.contains(bundle)
        || stubURLs[bundle] != nil
        || existingStubBundles.contains(bundle)
      if shouldMaterialize {
        let isLive = stubs[bundle] != nil || launchingStubs.contains(bundle)
        stubQueue.async { [weak self] in
          guard let self else { return }
          let url = self.materializeStubBundle(
            entry: entry,
            badgedIcon: badged,
            isRealIcon: true,
            iconHash: newHash,
            preserveRunningBinary: isLive
          )
          DispatchQueue.main.async {
            if let url { self.stubURLs[bundle] = url }
          }
        }
      }
    }
    reloadGrid()
    saveCatalogToDisk()
    refreshStatus()
  }

  func launchApp(bundle: String) {
    quittingBundles.removeValue(forKey: bundle)
    syncFastState()
    requestIconIfNeeded(bundle, first: true)
    launchSentAt[bundle] = CACurrentMediaTime()
    wire?.send(["t": "launch", "app": bundle])
    ensureStubRunning(bundle: bundle, activate: true)
  }

  /// Bundle generation (iconutil, codesign, lsregister) runs on the serial `stubQueue`, never on
  /// the main thread that routes frames and control messages, and never twice at once for a bundle.
  func ensureStubRunning(bundle: String, activate: Bool) {
    if let active = stubs[bundle] {
      if activate, let running = NSRunningApplication(processIdentifier: active.pid) {
        running.activate(options: [.activateIgnoringOtherApps])
      }
      return
    }
    guard !launchingStubs.contains(bundle) else { return }
    launchingStubs.insert(bundle)
    let entry = apps.first(where: { $0.bundle == bundle }) ?? AppEntry(name: bundle.split(separator: ".").last.map(String.init) ?? bundle, bundle: bundle, rawCategory: "", category: "其他", isSystem: false)
    let cached: ResolvedIcon? = (realIconBundles.contains(bundle) ? icons[bundle] : nil).map {
      ResolvedIcon(image: $0, isReal: true, hash: iconHashes[bundle] ?? "cached", png: iconPNGs[bundle], fromCache: false)
    }
    let cacheFile = iconCacheFile(for: bundle)
    let label = hostLabel
    stubQueue.async { [weak self] in
      guard let self else { return }
      let resolved = cached ?? Self.resolveFallbackIcon(bundle: bundle, cacheFile: cacheFile, hostLabel: label)
      let appURL = self.materializeStubBundle(
        entry: entry,
        badgedIcon: resolved.image,
        isRealIcon: resolved.isReal,
        iconHash: resolved.hash,
        preserveRunningBinary: false
      )
      DispatchQueue.main.async {
        self.adopt(resolved, for: bundle)
        guard let appURL, self.launchingStubs.contains(bundle) else {
          self.launchingStubs.remove(bundle)
          return
        }
        if resolved.isReal { self.stubHadRealIconOnLaunch.insert(bundle) }
        self.stubURLs[bundle] = appURL
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = activate
        NSWorkspace.shared.openApplication(at: appURL, configuration: cfg) { [weak self] _, error in
          DispatchQueue.main.async {
            if let error {
              Fusion.log("failed to launch stub \(appURL.path): \(error.localizedDescription)")
              self?.launchingStubs.remove(bundle)
            }
          }
        }
      }
    }
  }

  func stubBinarySourceURL() -> URL? {
    let candidates = [
      Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/LinkShellFusionStub"),
      URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("LinkShellFusionStub"),
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0.path) }
  }

  static func registerWithLaunchServices(_ appURL: URL) {
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: appURL.path)
    NSWorkspace.shared.noteFileSystemChanged(appURL.path)
    let lsreg = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    guard FileManager.default.isExecutableFile(atPath: lsreg) else { return }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: lsreg)
    proc.arguments = ["-f", appURL.path]
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()
  }

  /// Prefers a desktop-capable LinkShell bundle (`Contents/MacOS/LinkShell Desktop`) for Dock cold-launch
  /// stubs so running `FusionLocal` from a dev helper build (`apps/mac/build/LinkShell.app`) never points
  /// `LSFusionHubApp` at a helper-only bundle without Electron.
  static var preferredHubAppPath: String {
    let own = Bundle.main.bundlePath
    if FileManager.default.isExecutableFile(atPath: own + "/Contents/MacOS/LinkShell Desktop") {
      return own
    }
    let installed = "/Applications/LinkShell.app"
    if FileManager.default.isExecutableFile(atPath: installed + "/Contents/MacOS/LinkShell Desktop") {
      return installed
    }
    return own
  }

  /// Refreshes existing Stub `.app` bundles on disk (binary, hub path, socket path, and macOS 26
  /// v3 full-size squircle `.icns`) so pinned Dock items and Spotlight launches stay crisp & up to date.
  func upgradeExistingStubs() {
    guard let srcBin = stubBinarySourceURL() else { return }
    let appsDir = self.appsDir
    let socketPath = self.socketPath
    let hubPath = Self.preferredHubAppPath
    let computerKey = self.computerKey
    let fm = FileManager.default
    if let items = try? fm.contentsOfDirectory(at: appsDir, includingPropertiesForKeys: nil) {
      for appURL in items where appURL.pathExtension == "app" {
        let plistURL = appURL.appendingPathComponent("Contents/Info.plist")
        if let dict = NSDictionary(contentsOf: plistURL) as? [String: Any],
           let bundle = dict["LSFusionBundleID"] as? String, !bundle.isEmpty {
          existingStubBundles.insert(bundle)
          stubURLs[bundle] = appURL
        }
      }
    }
    stubQueue.async { [weak self] in
      guard let self else { return }
      guard let items = try? fm.contentsOfDirectory(at: appsDir, includingPropertiesForKeys: nil) else { return }
      let srcData = try? Data(contentsOf: srcBin)
      for appURL in items where appURL.pathExtension == "app" {
        let contentsURL = appURL.appendingPathComponent("Contents", isDirectory: true)
        let dstBin = contentsURL.appendingPathComponent("MacOS/FusionStub")
        let plistURL = contentsURL.appendingPathComponent("Info.plist")
        let icnsURL = contentsURL.appendingPathComponent("Resources/AppIcon.icns")
        guard fm.fileExists(atPath: dstBin.path),
              var plist = NSDictionary(contentsOf: plistURL) as? [String: Any],
              let bundle = plist["LSFusionBundleID"] as? String, !bundle.isEmpty else { continue }

        var binaryUpdated = false
        if let srcData, (try? Data(contentsOf: dstBin)) != srcData {
          try? fm.removeItem(at: dstBin)
          if (try? fm.copyItem(at: srcBin, to: dstBin)) != nil {
            try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dstBin.path)
            binaryUpdated = true
          }
        }

        let schema = (plist["LSFusionIconSchema"] as? Int) ?? 0
        let wasReal = (plist["LSFusionRealIcon"] as? Bool) == true
        var plistChanged = false
        if (plist["LSFusionSocket"] as? String) != socketPath {
          plist["LSFusionSocket"] = socketPath
          plistChanged = true
        }
        if (plist["LSFusionHubApp"] as? String) != hubPath {
          plist["LSFusionHubApp"] = hubPath
          plistChanged = true
        }
        if !computerKey.isEmpty && (plist["LSFusionComputerKey"] as? String) != computerKey {
          plist["LSFusionComputerKey"] = computerKey
          plistChanged = true
        }
        if (plist["LSFusionHostName"] as? String) != self.hostLabel {
          plist["LSFusionHostName"] = self.hostLabel
          plistChanged = true
        }

        var iconUpdated = false
        if schema < Self.currentIconSchema || !wasReal {
          let fallback = Self.resolveFallbackIcon(bundle: bundle, cacheFile: self.iconCacheFile(for: bundle), hostLabel: self.hostLabel)
          Self.writeICNS(image: fallback.image, to: icnsURL)
          plist["LSFusionIconSchema"] = Self.currentIconSchema
          plist["LSFusionRealIcon"] = fallback.isReal
          plist["LSFusionIconHash"] = fallback.hash
          iconUpdated = true
          plistChanged = true
        }

        guard binaryUpdated || plistChanged || iconUpdated else { continue }
        let prevVer = Int(plist["CFBundleVersion"] as? String ?? "1") ?? 1
        plist["CFBundleVersion"] = String(prevVer + 1)
        if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
          try? data.write(to: plistURL, options: .atomic)
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        proc.arguments = ["--force", "--sign", "-", appURL.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
        if iconUpdated || plistChanged {
          Self.registerWithLaunchServices(appURL)
        }
      }
    }
  }

  func hasLocalCollision(name: String, bundle: String) -> Bool {
    if FileManager.default.fileExists(atPath: "/Applications/\(name).app")
      || FileManager.default.fileExists(atPath: "/System/Applications/\(name).app") {
      return true
    }
    if let found = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle),
       !found.path.contains("/Applications/LinkShell/") {
      return true
    }
    return false
  }

  func materializeStubBundle(
    entry: AppEntry,
    badgedIcon: NSImage,
    isRealIcon: Bool,
    iconHash: String,
    preserveRunningBinary: Bool
  ) -> URL? {
    guard let srcBin = stubBinarySourceURL() else {
      Fusion.log("LinkShellFusionStub binary not found next to executable")
      return nil
    }
    let fm = FileManager.default
    let displayName = hasLocalCollision(name: entry.name, bundle: entry.bundle) ? "\(entry.name) · \(hostLabel)" : entry.name
    let safeFileName = displayName.replacingOccurrences(of: "/", with: "-")
    let appURL = appsDir.appendingPathComponent("\(safeFileName).app", isDirectory: true)
    let contentsURL = appURL.appendingPathComponent("Contents", isDirectory: true)
    let macosURL = contentsURL.appendingPathComponent("MacOS", isDirectory: true)
    let resURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)
    let dstBin = macosURL.appendingPathComponent("FusionStub")
    let icnsURL = resURL.appendingPathComponent("Resources/AppIcon.icns").standardizedFileURL
    let actualIcnsURL = resURL.appendingPathComponent("AppIcon.icns")
    let plistURL = contentsURL.appendingPathComponent("Info.plist")
    _ = icnsURL

    let existingPlist = NSDictionary(contentsOf: plistURL) as? [String: Any]
    let existingSchema = (existingPlist?["LSFusionIconSchema"] as? Int) ?? 0
    let existingReal = (existingPlist?["LSFusionRealIcon"] as? Bool) == true
    let existingHash = (existingPlist?["LSFusionIconHash"] as? String) ?? ""
    let existingSocket = (existingPlist?["LSFusionSocket"] as? String) ?? ""
    let existingHub = (existingPlist?["LSFusionHubApp"] as? String) ?? ""
    let existingCompKey = (existingPlist?["LSFusionComputerKey"] as? String) ?? ""

    let srcData = try? Data(contentsOf: srcBin)
    let dstExists = fm.isExecutableFile(atPath: dstBin.path)
    let binMatches = dstExists && srcData != nil && ((try? Data(contentsOf: dstBin)) == srcData)
    let iconMatches = fm.fileExists(atPath: actualIcnsURL.path)
      && existingSchema == Self.currentIconSchema
      && existingReal == isRealIcon
      && (!isRealIcon || existingHash == iconHash)
    let hubPath = Self.preferredHubAppPath
    let metaMatches = existingSocket == socketPath
      && existingHub == hubPath
      && (computerKey.isEmpty || existingCompKey == computerKey)

    if binMatches && iconMatches && metaMatches {
      return appURL
    }
    // Never overwrite a certified real icon on disk with a temporary generic fallback!
    if !isRealIcon && existingReal && existingSchema == Self.currentIconSchema && binMatches && metaMatches {
      return appURL
    }

    try? fm.createDirectory(at: macosURL, withIntermediateDirectories: true)
    try? fm.createDirectory(at: resURL, withIntermediateDirectories: true)

    if !preserveRunningBinary && !binMatches {
      if fm.fileExists(atPath: dstBin.path) { try? fm.removeItem(at: dstBin) }
      do {
        try fm.copyItem(at: srcBin, to: dstBin)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dstBin.path)
      } catch {
        if !fm.isExecutableFile(atPath: dstBin.path) {
          Fusion.log("copy stub bin failed: \(error.localizedDescription)")
          return nil
        }
      }
    }

    let finalRealIcon: Bool
    let finalHash: String
    if !isRealIcon && existingReal && existingSchema == Self.currentIconSchema && fm.fileExists(atPath: actualIcnsURL.path) {
      finalRealIcon = true
      finalHash = existingHash
    } else {
      Self.writeICNS(image: badgedIcon, to: actualIcnsURL)
      finalRealIcon = isRealIcon
      finalHash = iconHash
    }

    let prevVer = Int(existingPlist?["CFBundleVersion"] as? String ?? "0") ?? 0
    let cleanBundle = entry.bundle.lowercased().map { ($0.isLetter || $0.isNumber || $0 == ".") ? String($0) : "-" }.joined()
    let stubBundleID = "com.bd.linkshell.fusion.\(hostSlug).\(cleanBundle)"
    var plist: [String: Any] = [
      "CFBundleDevelopmentRegion": "zh_CN",
      "CFBundleExecutable": "FusionStub",
      "CFBundleIdentifier": stubBundleID,
      "CFBundleInfoDictionaryVersion": "6.0",
      "CFBundleName": displayName,
      "CFBundleDisplayName": displayName,
      "CFBundleIconFile": "AppIcon",
      "CFBundlePackageType": "APPL",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": String(prevVer + 1),
      "LSMinimumSystemVersion": "13.0",
      "NSHighResolutionCapable": true,
      "UIDesignRequiresCompatibility": false,
      "LSFusionBundleID": entry.bundle,
      "LSFusionSocket": socketPath,
      "LSFusionHubApp": hubPath,
      "LSFusionComputerKey": computerKey.isEmpty ? existingCompKey : computerKey,
      "LSFusionHostName": hostLabel,
      "LSFusionIconSchema": Self.currentIconSchema,
      "LSFusionRealIcon": finalRealIcon,
      "LSFusionIconHash": finalHash,
    ]
    if !entry.rawCategory.isEmpty {
      plist["LSApplicationCategoryType"] = entry.rawCategory
    } else if let prevCat = existingPlist?["LSApplicationCategoryType"] as? String, !prevCat.isEmpty {
      plist["LSApplicationCategoryType"] = prevCat
    }
    if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
      try? data.write(to: plistURL, options: .atomic)
    }

    // Ad-hoc sign + LaunchServices re-register so Dock & Spotlight pick up updated icons immediately.
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    proc.arguments = ["--force", "--sign", "-", appURL.path]
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()
    Self.registerWithLaunchServices(appURL)
    return appURL
  }

  /// Composes a `1024×1024` (`512×512 pt @2x`) macOS 26 squircle-compliant app icon:
  /// Clips strictly to macOS's standard `824×824 px` (`412×412 pt` at `(50, 50)`) continuous squircle
  /// and tucks the computer badge inside `(434 - badgeW, 74)` so zero non-transparent pixels exist
  /// outside the squircle mask — preventing macOS 26 `IconServices` from shrinking the icon onto a grey plate!
  static func composeBadgedIcon(base: NSImage, hostLabel: String) -> (image: NSImage, pngBase64: String?) {
    let ptSize = NSSize(width: 512, height: 512)
    let px = 1024
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else {
      return (base, nil)
    }
    rep.size = ptSize
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high

    let squircleRect = NSRect(x: 50, y: 50, width: 412, height: 412)
    let squircleClip = NSBezierPath(roundedRect: squircleRect, xRadius: 92.5, yRadius: 92.5)
    squircleClip.addClip()

    base.draw(in: NSRect(origin: .zero, size: ptSize), from: .zero, operation: .sourceOver, fraction: 1.0)

    let label = String(hostLabel.prefix(4)).uppercased()
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 33, weight: .bold),
      .foregroundColor: NSColor.white,
    ]
    let textSize = (label as NSString).size(withAttributes: attrs)
    let badgeW = max(112, min(176, ceil(textSize.width + 38)))
    let badgeH: CGFloat = 64
    let badgeRect = NSRect(x: 434 - badgeW, y: 74, width: badgeW, height: badgeH)

    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.38)
    shadow.shadowBlurRadius = 10
    shadow.shadowOffset = NSSize(width: 0, height: -2.5)
    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    let bg = NSBezierPath(roundedRect: badgeRect, xRadius: 20, yRadius: 20)
    // LinkShell `accentFill` (#4c5fd5) from `brand-colors.json`.
    NSColor(srgbRed: 0x4c / 255.0, green: 0x5f / 255.0, blue: 0xd5 / 255.0, alpha: 0.97).setFill()
    bg.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSColor.white.withAlphaComponent(0.92).setStroke()
    bg.lineWidth = 3.5
    bg.stroke()

    let textRect = NSRect(
      x: badgeRect.midX - textSize.width / 2,
      y: badgeRect.midY - textSize.height / 2,
      width: textSize.width,
      height: textSize.height
    )
    (label as NSString).draw(in: textRect, withAttributes: attrs)
    NSGraphicsContext.restoreGraphicsState()

    let out = NSImage(size: ptSize)
    out.addRepresentation(rep)
    let pngB64 = rep.representation(using: .png, properties: [:])?.base64EncodedString()
    return (out, pngB64)
  }

  /// Writes a complete 10-representation macOS `.icns` (`16..512 @1x/@2x` up to `1024×1024`) via
  /// `/usr/bin/iconutil` so macOS 26 Dock, Finder, Spotlight, and ⌘Tab render crisp native squircles.
  static func writeICNS(image: NSImage, to url: URL) {
    let fm = FileManager.default
    let tempIconset = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("ls-fusion-\(UUID().uuidString).iconset", isDirectory: true)
    if (try? fm.createDirectory(at: tempIconset, withIntermediateDirectories: true)) != nil {
      defer { try? fm.removeItem(at: tempIconset) }
      let slots: [(pt: Int, scale: Int)] = [
        (16, 1), (16, 2), (32, 1), (32, 2),
        (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2),
      ]
      var wroteAll = true
      for slot in slots {
        let px = slot.pt * slot.scale
        guard let rep = NSBitmapImageRep(
          bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
          hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { wroteAll = false; break }
        rep.size = NSSize(width: slot.pt, height: slot.pt)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: slot.pt, height: slot.pt), from: .zero, operation: .copy, fraction: 1.0)
        NSGraphicsContext.restoreGraphicsState()
        let name = slot.scale == 2 ? "icon_\(slot.pt)x\(slot.pt)@2x.png" : "icon_\(slot.pt)x\(slot.pt).png"
        guard let png = rep.representation(using: .png, properties: [:]),
              (try? png.write(to: tempIconset.appendingPathComponent(name))) != nil else {
          wroteAll = false
          break
        }
      }
      if wroteAll {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
        proc.arguments = ["-c", "icns", tempIconset.path, "-o", url.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
        if proc.terminationStatus == 0 && fm.fileExists(atPath: url.path) {
          return
        }
      }
    }

    let sizes = [1024, 512, 256, 128, 64, 32]
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "com.apple.icns" as CFString, sizes.count, nil) else { return }
    for px in sizes {
      guard let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: px * 4,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
      NSGraphicsContext.current?.imageInterpolation = .high
      image.draw(in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .copy, fraction: 1)
      NSGraphicsContext.restoreGraphicsState()
      if let cg = ctx.makeImage() {
        CGImageDestinationAddImage(dest, cg, nil)
      }
    }
    CGImageDestinationFinalize(dest)
  }
}
