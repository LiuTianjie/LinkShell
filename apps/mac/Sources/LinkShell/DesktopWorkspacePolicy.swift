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
    guard ["https", "http"].contains(url.scheme), let host = url.host?.lowercased(),
          !host.isEmpty, url.user == nil, url.password == nil else { return false }
    // Native links must not turn an untrusted document into a local-file or loopback launcher.
    if host == "localhost" || host.hasSuffix(".localhost") || host == "[::1]" || host == "::1"
      || host == "0.0.0.0" || host.hasPrefix("127.") || host.hasPrefix("169.254.") { return false }
    return true
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
