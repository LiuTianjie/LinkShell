import UIKit
import WebKit

/// Uses the existing RN WebView, including its keyboard and clipboard integration.
/// No private WebKit APIs, duplicated HTML controls, or React pointer-event bridge.
final class ScreenControlsBridge: NSObject, WKScriptMessageHandler {
  var expectedURL: URL?
  private weak var webView: WKWebView?
  private let receive: ([String: Any]) -> Void
  private static let name = "linkshellScreen"

  init(receive: @escaping ([String: Any]) -> Void) {
    self.receive = receive
  }

  func attach(in root: UIView) -> Bool {
    func find(_ view: UIView) -> WKWebView? {
      if let web = view as? WKWebView { return web }
      for child in view.subviews { if let web = find(child) { return web } }
      return nil
    }
    guard let next = find(root) else { return false }
    guard webView !== next else { return true }
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.name)
    webView = next
    next.configuration.userContentController.removeScriptMessageHandler(forName: Self.name)
    next.configuration.userContentController.add(self, name: Self.name)
    // Also attach when a retained WebView comes back after its native parent.
    next.evaluateJavaScript("if (window.linkshellNative) window.webkit.messageHandlers.linkshellScreen.postMessage({kind:'ready',version:1}); true;", completionHandler: nil)
    return true
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == Self.name, message.frameInfo.isMainFrame,
          let expectedURL, let source = message.frameInfo.request.url,
          source.scheme == "http", source.host == "127.0.0.1", source.port == expectedURL.port,
          let body = message.body as? [String: Any] else { return }
    receive(body)
  }

  func call(_ method: String, _ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let json = String(data: data, encoding: .utf8) else { return }
    webView?.evaluateJavaScript("window.linkshellNative && window.linkshellNative.\(method)(\(json)); true;", completionHandler: nil)
  }
}
