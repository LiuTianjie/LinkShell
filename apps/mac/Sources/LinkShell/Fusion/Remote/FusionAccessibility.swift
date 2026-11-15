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
  /// Extracts window-relative rects for `[🔴, 🟡, 🟢]` traffic lights and interactive titlebar controls
  /// (`hitrects`) so the local Stub `.app` intercepts window operations at `0 ms` without hover lag.
  func inspectWindowChrome(pid: pid_t, id: CGWindowID, frame: CGRect) -> ([String: [Double]], [[Double]]) {
    guard let w = axWindow(pid: pid, id: id) else { return ([:], []) }
    func r1(_ v: CGFloat) -> Double { (Double(v) * 10).rounded() / 10 }
    func elementRect(_ el: AXUIElement) -> CGRect? {
      var posRef: CFTypeRef?; var sizeRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
            AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success,
            let pv = posRef, let sv = sizeRef else { return nil }
      var pt = CGPoint.zero; var sz = CGSize.zero
      guard AXValueGetValue(pv as! AXValue, .cgPoint, &pt),
            AXValueGetValue(sv as! AXValue, .cgSize, &sz),
            sz.width > 1, sz.height > 1 else { return nil }
      return CGRect(x: pt.x - frame.minX, y: pt.y - frame.minY, width: sz.width, height: sz.height)
    }
    var buttons: [String: [Double]] = [:]
    var buttonRects: [CGRect] = []
    func readBtn(_ attr: String, key: String) {
      var ref: CFTypeRef?
      if AXUIElementCopyAttributeValue(w, attr as CFString, &ref) == .success, let el = ref,
         let r = elementRect(el as! AXUIElement), r.minY < 60, r.minX < 140 {
        buttons[key] = [r1(r.minX), r1(r.minY), r1(r.width), r1(r.height)]
        buttonRects.append(r.insetBy(dx: -1, dy: -1))
      }
    }
    readBtn(kAXCloseButtonAttribute as String, key: "close")
    readBtn(kAXMinimizeButtonAttribute as String, key: "min")
    readBtn(kAXFullScreenButtonAttribute as String, key: "zoom")
    if buttons["zoom"] == nil {
      readBtn(kAXZoomButtonAttribute as String, key: "zoom")
    }

    let interactiveRoles: Set<String> = [
      "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
      "AXPopUpButton", "AXMenuButton", "AXRadioButton", "AXCheckBox", "AXTabGroup",
      "AXSegmentedControl", "AXSlider", "AXIncrementor", "AXLink", "AXColorWell",
    ]
    let bodyContainerRoles: Set<String> = [
      "AXWebArea", "AXScrollArea", "AXTable", "AXOutline", "AXList",
    ]
    var hitrects: [[Double]] = []
    func walk(_ el: AXUIElement, depth: Int) {
      guard depth <= 8, hitrects.count < 64 else { return }
      var roleRef: CFTypeRef?
      let role = AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleRef) == .success ? (roleRef as? String ?? "") : ""
      if depth > 0, let r = elementRect(el) {
        if r.minY > 58 { return }
        if bodyContainerRoles.contains(role), r.height > 80 { return }
        if interactiveRoles.contains(role), r.width < frame.width * 0.94 {
          let isTrafficLight = buttonRects.contains { $0.intersects(r) && r.width <= 26 && r.height <= 26 }
          if !isTrafficLight {
            hitrects.append([r1(r.minX), r1(r.minY), r1(r.width), r1(r.height)])
          }
          if role != "AXTabGroup" && role != "AXSegmentedControl" { return }
        }
      }
      var chRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &chRef) == .success,
         let children = chRef as? [AXUIElement] {
        for c in children.prefix(40) { walk(c, depth: depth + 1) }
      }
    }
    walk(w, depth: 0)
    return (buttons, hitrects)
  }

  func hasToolbar(pid: pid_t, id: CGWindowID) -> Bool {
    guard let w = axWindow(pid: pid, id: id) else { return false }
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else { return false }
    for child in children {
      var roleRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(child, kAXRoleAttribute as CFString, &roleRef) == .success,
         (roleRef as? String) == "AXToolbar" {
        return true
      }
    }
    return false
  }

  /// Evaluates via Accessibility whether the hovered titlebar spot is empty draggable chrome vs an interactive button/input.
  func evaluateDragZone(id: CGWindowID, pid: pid_t, nx: Double, ny: Double) {
    let now = CACurrentMediaTime()
    guard now - (hoverStamps[id] ?? 0) >= 1.0 / 60 else { return }
    hoverStamps[id] = now
    guard let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first,
          let bounds = info[kCGWindowBounds as String] as? [String: Any],
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return }
    let x = nx * frame.width, y = ny * frame.height
    var ok = false
    if y <= 54, x >= 88 {
      ok = true
      let gx = Float(frame.minX + x), gy = Float(frame.minY + y)
      var hit: AXUIElement?
      if AXUIElementCopyElementAtPosition(FusionRemoteSession.axApp(pid), gx, gy, &hit) == .success, var element = hit {
        let interactive: Set<String> = [
          "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
          "AXPopUpButton", "AXMenuButton", "AXRadioButton", "AXCheckBox", "AXTabGroup",
          "AXSegmentedControl", "AXSlider", "AXIncrementor", "AXLink", "AXColorWell",
        ]
        for _ in 0..<5 {
          var roleRef: CFTypeRef?
          let role = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef) == .success ? (roleRef as? String ?? "") : ""
          if role == "AXWindow" || role == "AXApplication" { break }
          if interactive.contains(role) { ok = false; break }
          var parentRef: CFTypeRef?
          guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parentRef) == .success, let parent = parentRef else { break }
          element = parent as! AXUIElement
        }
      }
    }
    if dragZones[id] != ok {
      dragZones[id] = ok
      wire.send(["t": "dragzone", "id": id, "ok": ok])
    }
  }

  /// Measures true corner radius (accounting for 1x vs 2x scale!) so macOS 26 Tahoe 27pt vs 17pt corners match 1:1.
  func measureStyle(id: CGWindowID, pid: pid_t, bundle: String, title: String, initialToolbar: Bool) {
    guard #available(macOS 14.0, *) else { return }
    let wire = self.wire
    Task {
      try? await Task.sleep(nanoseconds: 120_000_000)
      let content: SCShareableContent? = await withCheckedContinuation { cont in
        ScreenCapturer.fetchShareableContent(maxAge: 0.15) { c, _ in cont.resume(returning: c) }
      }
      guard let content,
            let window = content.windows.first(where: { $0.windowID == id }), window.frame.width > 40 else { return }
      let configuration = SCStreamConfiguration()
      configuration.width = max(Int(window.frame.width * 2), 80)
      configuration.height = max(Int(window.frame.height * 2), 80)
      configuration.scalesToFit = true
      configuration.pixelFormat = kCVPixelFormatType_32BGRA
      configuration.showsCursor = false
      if #available(macOS 14.2, *) { configuration.ignoreShadowsSingleWindow = true }
      guard let image = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration),
            let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return }
      let row = image.bytesPerRow, step = image.bitsPerPixel / 8
      let scale = Double(image.width) / Double(window.frame.width)
      var d = 0
      let limit = min(image.width, image.height) / 3
      while d < limit, bytes[d * row + d * step + 3] < 128 { d += 1 }
      guard d > 0, d < limit, scale > 0 else { return }
      let radius = (Double(d) / (1 - 0.70710678)) / scale
      let toolbar = initialToolbar || radius > 21.5
      let (buttons, hitrects) = await MainActor.run { self.inspectWindowChrome(pid: pid, id: id, frame: window.frame) }
      wire.send(["t": "style", "id": id, "bundle": bundle, "toolbar": toolbar, "r": radius, "title": title, "buttons": buttons, "hitrects": hitrects])
      Fusion.log("window \(id) (\(bundle)) corner \(String(format: "%.1f", radius)) pt toolbar=\(toolbar)")
    }
  }

  static func axApp(_ pid: pid_t) -> AXUIElement {
    let element = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetMessagingTimeout(element, axTimeout)
    return element
  }
}

extension FusionRemoteSession {
  // MARK: Remote Dock Right-Click Menu Mirroring (Accessibility Menu Bar + Open Recent)

  func syncDockMenuIfNeeded(pid: pid_t, bundle: String, force: Bool = false) {
    guard !bundle.isEmpty else { return }
    let now = CACurrentMediaTime()
    if !force, now - (dockMenuStamps[bundle] ?? 0) < 3.0 { return }
    dockMenuStamps[bundle] = now
    let items = extractDockMenu(pid: pid)
    guard let data = try? JSONSerialization.data(withJSONObject: items),
          let sig = String(data: data, encoding: .utf8),
          force || dockMenuSent[bundle] != sig else { return }
    dockMenuSent[bundle] = sig
    wire.send(["t": "dockmenu", "bundle": bundle, "items": items])
  }

  func extractDockMenu(pid: pid_t) -> [[String: Any]] {
    let axApp = FusionRemoteSession.axApp(pid)
    var mbRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXMenuBarAttribute as CFString, &mbRef) == .success,
          let mb = mbRef else { return [] }
    var barChildrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(mb as! AXUIElement, kAXChildrenAttribute as CFString, &barChildrenRef) == .success,
          let barItems = barChildrenRef as? [AXUIElement], barItems.count > 2 else { return [] }

    var actions: [[String: Any]] = []
    var recents: [[String: Any]] = []
    let candidateBars = Array(2..<min(barItems.count, 5))

    for barIdx in candidateBars {
      var subRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(barItems[barIdx], kAXChildrenAttribute as CFString, &subRef) == .success,
            let menu = (subRef as? [AXUIElement])?.first else { continue }
      var itemsRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(menu, kAXChildrenAttribute as CFString, &itemsRef) == .success,
            let items = itemsRef as? [AXUIElement] else { continue }

      var passedCreationGroup = false
      for (itemIdx, item) in items.prefix(28).enumerated() {
        var roleRef: CFTypeRef?
        let role = AXUIElementCopyAttributeValue(item, kAXRoleAttribute as CFString, &roleRef) == .success ? (roleRef as? String ?? "") : ""
        if role == "AXMenuItem" {
          var titleRef: CFTypeRef?
          let title = (AXUIElementCopyAttributeValue(item, kAXTitleAttribute as CFString, &titleRef) == .success ? (titleRef as? String) : nil)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
          if title.isEmpty {
            if !actions.isEmpty { passedCreationGroup = true }
            continue
          }
          var enRef: CFTypeRef?
          let enabled = (AXUIElementCopyAttributeValue(item, kAXEnabledAttribute as CFString, &enRef) == .success ? (enRef as? Bool) : nil) ?? true
          var childMenuRef: CFTypeRef?
          let childMenus = (AXUIElementCopyAttributeValue(item, kAXChildrenAttribute as CFString, &childMenuRef) == .success ? (childMenuRef as? [AXUIElement]) : nil) ?? []

          let lower = title.lowercased()
          // Capture "Open Recent" / "打开最近..." submenu items (workspaces, documents, projects).
          if !childMenus.isEmpty, lower.contains("recent") || title.contains("最近") {
            var subItemsRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(childMenus[0], kAXChildrenAttribute as CFString, &subItemsRef) == .success,
               let subItems = subItemsRef as? [AXUIElement] {
              for (subIdx, subItem) in subItems.prefix(12).enumerated() where recents.count < 8 {
                var stRef: CFTypeRef?; var senRef: CFTypeRef?
                let st = (AXUIElementCopyAttributeValue(subItem, kAXTitleAttribute as CFString, &stRef) == .success ? (stRef as? String) : nil)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let sen = (AXUIElementCopyAttributeValue(subItem, kAXEnabledAttribute as CFString, &senRef) == .success ? (senRef as? Bool) : nil) ?? true
                guard !st.isEmpty, sen else { continue }
                let stLower = st.lowercased()
                if st.contains("清除") || stLower.contains("clear ") || stLower == "clear" || stLower.contains("more…") || stLower.contains("more...") {
                  continue
                }
                recents.append(["title": st, "section": "recent", "path": [barIdx, itemIdx, subIdx]])
              }
            }
            continue
          }

          guard childMenus.isEmpty, enabled, actions.count < 6 else { continue }
          let isNewPrefix = title.hasPrefix("新建") || lower.hasPrefix("new ") || title == "New"
          let isWindowKeyword = title.contains("窗口") || lower.contains("window") || title.contains("无痕") || lower.contains("private") || lower.contains("incognito") || title.contains("标签") || lower.contains("tab") || title.contains("对话") || lower.contains("chat") || lower.contains("conversation")
          if barIdx == 2 && (!passedCreationGroup && isNewPrefix || (isNewPrefix && isWindowKeyword)) {
            if !actions.contains(where: { ($0["title"] as? String) == title }) {
              actions.append(["title": title, "section": "action", "path": [barIdx, itemIdx]])
            }
          } else if barIdx > 2 && actions.isEmpty && isNewPrefix && isWindowKeyword {
            actions.append(["title": title, "section": "action", "path": [barIdx, itemIdx]])
          }
        }
      }
      if !actions.isEmpty && !recents.isEmpty { break }
    }
    return recents + actions
  }

  // MARK: Menu bar mirroring (the stub shows the remote app's menus as its own)

  /// The menu at `path` ([] is the bar itself, [i] the i-th bar item's menu, [i, j] item j's
  /// submenu…), resolved from the app's AX tree. Runs on `axQueue`.
  static func axMenuChildren(pid: pid_t, path: [Int]) -> [AXUIElement]? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp(pid), kAXMenuBarAttribute as CFString, &ref) == .success, let bar = ref else { return nil }
    func children(_ element: AXUIElement) -> [AXUIElement] {
      var childRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childRef) == .success else { return [] }
      return childRef as? [AXUIElement] ?? []
    }
    var items = children(bar as! AXUIElement)
    for index in path {
      guard index >= 0, index < items.count, let menu = children(items[index]).first else { return nil }
      items = children(menu)
    }
    return items
  }

  static func describeMenuItem(_ item: AXUIElement) -> [String: Any] {
    func attr(_ name: String) -> CFTypeRef? {
      var ref: CFTypeRef?
      return AXUIElementCopyAttributeValue(item, name as CFString, &ref) == .success ? ref : nil
    }
    let title = (attr(kAXTitleAttribute as String) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    var entry: [String: Any] = ["title": title]
    if title.isEmpty { entry["sep"] = true; return entry }
    entry["enabled"] = attr(kAXEnabledAttribute as String) as? Bool ?? true
    if let mark = attr(kAXMenuItemMarkCharAttribute as String) as? String, !mark.isEmpty { entry["checked"] = true }
    if let key = attr(kAXMenuItemCmdCharAttribute as String) as? String, !key.isEmpty {
      entry["key"] = key
      entry["mods"] = (attr(kAXMenuItemCmdModifiersAttribute as String) as? NSNumber)?.intValue ?? 0
    }
    var childRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(item, kAXChildrenAttribute as CFString, &childRef) == .success,
       let children = childRef as? [AXUIElement], !children.isEmpty {
      entry["sub"] = true
    }
    return entry
  }

  func sendMenu(bundle: String, path: [Int]) {
    guard let pid = fused.first(where: { pidToBundle[$0] == bundle }) ?? NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.processIdentifier else { return }
    axQueue.async { [weak self] in
      // A large menu is cut short: a mirror must answer quickly, and nobody scrolls 200 items here.
      let items = Self.axMenuChildren(pid: pid, path: path).map { Array($0.prefix(120)).map(Self.describeMenuItem) }
      DispatchQueue.main.async {
        guard let self, !self.ended else { return }
        if let items {
          self.wire.send(["t": "menu", "bundle": bundle, "path": path, "items": items])
        } else {
          self.wire.send(["t": "menu", "bundle": bundle, "path": path, "error": true])
        }
      }
    }
  }

  func pressMenu(bundle: String, path: [Int]) {
    guard path.count >= 2, let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first(where: { !$0.isTerminated }) else { return }
    let pid = app.processIdentifier
    noteUserAction(pid: pid)
    if !app.isActive { _ = app.activate(options: [.activateIgnoringOtherApps]) }
    let parent = Array(path.dropLast()), index = path[path.count - 1]
    axQueue.asyncAfter(deadline: .now() + (app.isActive ? 0 : 0.08)) { [weak self] in
      guard let items = Self.axMenuChildren(pid: pid, path: parent), index >= 0, index < items.count else { return }
      AXUIElementPerformAction(items[index], kAXPressAction as CFString)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { self?.track() }
    }
  }

  func performDockAction(bundle: String, path: [Int]) {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first(where: { !$0.isTerminated }) else {
      launch(bundle)
      return
    }
    let pid = app.processIdentifier
    pidToBundle[pid] = bundle
    fused.insert(pid)
    noteUserAction(pid: pid)
    let wasActive = app.isActive
    _ = app.activate(options: [.activateIgnoringOtherApps])
    let axApp = FusionRemoteSession.axApp(pid)
    AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    guard path.count >= 2 else {
      launch(bundle)
      return
    }
    let invoke = { [weak self] in
      guard let self, !self.ended else { return }
      var mbRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(axApp, kAXMenuBarAttribute as CFString, &mbRef) == .success,
            let mb = mbRef else { return }
      var barRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(mb as! AXUIElement, kAXChildrenAttribute as CFString, &barRef) == .success,
            let barItems = barRef as? [AXUIElement], path[0] < barItems.count else { return }
      var menuRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(barItems[path[0]], kAXChildrenAttribute as CFString, &menuRef) == .success,
            let menu = (menuRef as? [AXUIElement])?.first else { return }
      var itemsRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(menu, kAXChildrenAttribute as CFString, &itemsRef) == .success,
            let items = itemsRef as? [AXUIElement], path[1] < items.count else { return }

      var target = items[path[1]]
      if path.count >= 3 {
        var subMenuRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(target, kAXChildrenAttribute as CFString, &subMenuRef) == .success,
              let subMenu = (subMenuRef as? [AXUIElement])?.first else { return }
        var subItemsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(subMenu, kAXChildrenAttribute as CFString, &subItemsRef) == .success,
              let subItems = subItemsRef as? [AXUIElement], path[2] < subItems.count else { return }
        target = subItems[path[2]]
      }
      AXUIElementPerformAction(target, kAXPressAction as CFString)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in self?.track() }
    }
    if wasActive {
      invoke()
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: invoke)
    }
  }

  func closeRemoteWindow(_ id: CGWindowID) {
    for pid in fused {
      guard let w = axWindow(pid: pid, id: id) else { continue }
      var button: CFTypeRef?
      if AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &button) == .success, let button {
        AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
        sampler.sampleNow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.008) { [weak self] in self?.track() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.024) { [weak self] in self?.track() }
      }
      return
    }
  }
}
