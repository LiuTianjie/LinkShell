import Foundation

/// The signed page owns the native bridge. Screen and port frames never inherit that authority.
struct DesktopWorkspacePolicy {
  let origin: URL

  static func readyURL(from data: Data) throws -> URL {
    struct Ready: Decodable { let url: String }
    let ready = try JSONDecoder().decode(Ready.self, from: data)
    guard let url = URL(string: ready.url), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
          parts.scheme == "http", parts.host == "127.0.0.1", let port = parts.port, (1...65535).contains(port),
          parts.user == nil, parts.password == nil, parts.path == "/", parts.query == nil,
          let fragment = parts.percentEncodedFragment,
          fragment.range(of: "^desktop=[A-Za-z0-9_-]{32,256}$", options: .regularExpression) != nil else {
      throw NSError(domain: "LinkShell", code: 1, userInfo: [NSLocalizedDescriptionKey: "工作台返回了无效的本地地址，请更新配套 CLI 后重试。"])
    }
    return url
  }

  func isTrusted(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
      && url.user == nil && url.password == nil
  }

  func isPreview(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == "http" && url.host == "localhost" && url.port == origin.port
      && url.user == nil && url.password == nil
  }

  func allowsBridge(from url: URL?, mainFrame: Bool) -> Bool { mainFrame && isTrusted(url) }

  func allowsSubframe(_ url: URL) -> Bool {
    if isTrusted(url) || isPreview(url) || Self.externalURL(url) { return true }
    if ["about:blank", "about:srcdoc"].contains(url.absoluteString) { return true }
    return allowsBlob(url, opaque: true)
  }

  func allowsBlob(_ url: URL, opaque: Bool = false) -> Bool {
    guard url.scheme == "blob" else { return false }
    let content = String(url.absoluteString.dropFirst(5))
    if opaque && content.hasPrefix("null/") { return true }
    guard let nested = URL(string: content) else { return false }
    return isTrusted(nested) || isPreview(nested)
  }

  static func externalURL(_ url: URL) -> Bool {
    guard ["https", "http"].contains(url.scheme), let rawHost = url.host?.lowercased(),
          !rawHost.isEmpty, url.user == nil, url.password == nil else { return false }
    let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "."))
    // Native links must not turn an untrusted document into a local-file or loopback launcher.
    return !isBlockedExternalHost(host)
  }

  private static func isBlockedIPv4(_ host: String) -> Bool {
    host == "0.0.0.0" || host.hasPrefix("127.") || host.hasPrefix("169.254.")
  }

  private static func parseIPv6Groups(_ raw: String) -> [UInt16]? {
    let withoutZone = raw.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    var text = withoutZone
    if let lastColon = text.lastIndex(of: ":") {
      let tail = String(text[text.index(after: lastColon)...])
      if tail.contains(".") {
        let parts = tail.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return nil }
        let hi = String((parts[0] << 8) | parts[1], radix: 16)
        let lo = String((parts[2] << 8) | parts[3], radix: 16)
        text = String(text[...lastColon]) + hi + ":" + lo
      }
    }
    let halves = text.components(separatedBy: "::")
    guard halves.count <= 2 else { return nil }
    func parsePart(_ part: String) -> [UInt16]? {
      if part.isEmpty { return [] }
      var out: [UInt16] = []
      for group in part.split(separator: ":", omittingEmptySubsequences: false) {
        guard (1...4).contains(group.count), let value = UInt16(group, radix: 16) else { return nil }
        out.append(value)
      }
      return out
    }
    guard let left = parsePart(halves[0]),
          let right = halves.count == 2 ? parsePart(halves[1]) : [] else { return nil }
    if halves.count == 1 { return left.count == 8 ? left : nil }
    let missing = 8 - left.count - right.count
    guard missing >= 1 else { return nil }
    return left + Array(repeating: 0, count: missing) + right
  }

  private static func isBlockedExternalHost(_ host: String) -> Bool {
    if host.isEmpty || host == "localhost" || host.hasSuffix(".localhost") { return true }
    if isBlockedIPv4(host) { return true }
    let bare = (host.hasPrefix("[") && host.hasSuffix("]")) ? String(host.dropFirst().dropLast()) : host
    guard bare.contains(":") else { return false }
    guard let groups = parseIPv6Groups(bare) else { return true }
    let allZero = groups.allSatisfy { $0 == 0 }
    let isLoopback = groups[0..<7].allSatisfy { $0 == 0 } && groups[7] == 1
    let isLinkLocal = (groups[0] & 0xffc0) == 0xfe80
    if allZero || isLoopback || isLinkLocal { return true }
    let isIPv4Mapped = groups[0..<5].allSatisfy { $0 == 0 } && (groups[5] == 0xffff || groups[5] == 0)
    if isIPv4Mapped {
      let a = Int((groups[6] >> 8) & 0xff)
      let b = Int(groups[6] & 0xff)
      let c = Int((groups[7] >> 8) & 0xff)
      let d = Int(groups[7] & 0xff)
      return isBlockedIPv4("\(a).\(b).\(c).\(d)")
    }
    return false
  }

  static func visibilityScript(_ visible: Bool) -> String {
    "window.__LINKSHELL_DESKTOP_VISIBLE__ = \(visible ? "true" : "false"); window.dispatchEvent(new CustomEvent('linkshell-desktop-visibility', {detail:{visible:\(visible ? "true" : "false")}}));"
  }

  static func validAppearance(_ appearance: String) -> Bool { ["light", "dark", "system"].contains(appearance) }

  static func appearanceScript(_ value: String) -> String {
    let appearance = validAppearance(value) ? value : "system"
    return "window.__LINKSHELL_DESKTOP_APPEARANCE__ = '\(appearance)'; window.dispatchEvent(new CustomEvent('linkshell-desktop-appearance', {detail:{appearance:'\(appearance)'}}));"
  }
}
