import CoreGraphics
import Foundation

/// Fusion's control protocol, as both Mac processes speak it. The spec is docs/v2/fusion.md and
/// the schema packages/wire/src/fusion.ts; FusionProtocolTests reads the same fixtures.
enum FusionProtocol {
  static let version = 2
  /// How long the remote keeps a dropped session for `resume`.
  static let resumeGrace: TimeInterval = 30
  /// Frames above this close the connection (`protocol`).
  static let maxFrame = 16 << 20
  /// What a Mac remote offers (`welcome.features`).
  static let remoteFeatures = ["menubar", "dockmenu", "clipboard", "virtual-displays", "keys"]
  /// What a Mac local computer offers (`hello.features`).
  static let localFeatures = ["clipboard", "keys"]

  /// Every message type, for the fixture test: a type the schema has and these files don't
  /// handle is a gap in one of them.
  static let types: Set<String> = [
    "hello", "welcome", "bye", "ping", "pong", "displays", "apps", "ready", "launch", "quit",
    "app.exited", "app.hidden", "app.active", "icon", "wopen", "wclose", "wstyle", "layout", "place",
    "wclose.req", "focus", "prewarm", "fullscreen", "minimize", "menu.fetch", "menu.press", "menu",
    "dockmenu", "dockmenu.press", "clip", "alert", "rtc",
  ]

  /// Both Fusion processes are windowless background apps: App Nap would delay their pings past
  /// the other side's watchdog and drop the session while the person isn't looking. Held for life.
  private static var activity: NSObjectProtocol?
  static func stayAwake(_ reason: String) {
    activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: reason)
  }

  static func path(_ value: Any?) -> [Int] {
    (value as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } ?? []
  }

  /// What a rebuild of the remote's virtual displays depends on (not `hz`).
  static func displaysSignature(_ displays: [[String: Any]]) -> String {
    displays.map { d -> String in
      let f = Fusion.rect(d["frame"]), v = Fusion.rect(d["visible"])
      return "\(f.minX),\(f.minY),\(f.width),\(f.height)|\(v.minY),\(v.height)|\(Fusion.number(d["scale"]))"
    }.joined(separator: ";")
  }

  /// Virtual displays are 1x or 2x: Windows' 1.25 and 1.5 become 2x, drawn sharper than asked.
  static func backingScale(_ scale: Double) -> Int { scale > 1.01 ? 2 : 1 }

  // MARK: Window chrome (§4.7)

  /// The Mac remote's measurements (`[x, y, w, h]` arrays, keyed `close` / `min` / `zoom`) as `chrome`.
  static func chrome(toolbar: Bool, radius: Double?, buttons: [String: [Double]], hitrects: [[Double]]) -> [String: Any] {
    var out: [String: Any] = ["style": "mac", "toolbar": toolbar]
    if let radius { out["radius"] = radius }
    var named: [String: Any] = [:]
    for (from, to) in [("close", "close"), ("min", "minimize"), ("zoom", "zoom")] {
      if let rect = buttons[from], rect.count == 4 { named[to] = ["x": rect[0], "y": rect[1], "w": rect[2], "h": rect[3]] }
    }
    if !named.isEmpty { out["buttons"] = named }
    if !hitrects.isEmpty { out["hitrects"] = hitrects.filter { $0.count == 4 }.map { ["x": $0[0], "y": $0[1], "w": $0[2], "h": $0[3]] } }
    return out
  }

  struct Chrome: Equatable {
    var style = "mac"
    var toolbar = false
    var radius: Double?
    /// As the stub reads them: `close` / `min` / `zoom` → `[x, y, w, h]`.
    var buttons: [String: [Double]] = [:]
    var hitrects: [[Double]] = []
    var hasButtons: Bool { !buttons.isEmpty }
  }

  static func chrome(_ value: Any?) -> Chrome {
    guard let d = value as? [String: Any] else { return Chrome() }
    var chrome = Chrome()
    chrome.style = d["style"] as? String ?? "mac"
    chrome.toolbar = d["toolbar"] as? Bool ?? false
    chrome.radius = (d["radius"] as? NSNumber)?.doubleValue
    func array(_ rect: Any?) -> [Double]? {
      guard let r = rect as? [String: Any] else { return nil }
      let a = [Fusion.number(r["x"]), Fusion.number(r["y"]), Fusion.number(r["w"]), Fusion.number(r["h"])]
      return a[2] > 0 && a[3] > 0 ? a : nil
    }
    let buttons = d["buttons"] as? [String: Any] ?? [:]
    for (from, to) in [("close", "close"), ("minimize", "min"), ("zoom", "zoom")] {
      if let rect = array(buttons[from]) { chrome.buttons[to] = rect }
    }
    chrome.hitrects = ((d["hitrects"] as? [Any]) ?? []).compactMap(array)
    return chrome
  }
}
