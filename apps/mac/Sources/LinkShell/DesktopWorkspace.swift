import AppKit
import Combine
import Foundation
import WebKit

/// The local web runtime belongs to this window process, independently of the user's Host.
@MainActor final class DesktopWorkspace: NSObject, ObservableObject {
  @Published private(set) var managing = false
  @Published private(set) var loading = true
  @Published private(set) var problem: String?
  @Published private(set) var contentFocused = false
  var onAppearance: ((String) -> Void)?
  private var appearance = "dark"
  private var windowVisible = false
  private var process: Process?
  private var input: Pipe?
  private var output: Pipe?
  private var errors: Pipe?
  private var generation = UUID()
  private var stdout = Data()
  private var stderr = Data()
  private var readyURL: URL?
  private var policy: DesktopWorkspacePolicy?
  private var startupDeadline: Task<Void, Never>?
  private var hasWorkspaceDocument = false
  private var retrying = false
  private var downloads: [ObjectIdentifier: WKDownload] = [:]
  private var screenReceiver: DesktopScreenReceiver?
  private var screenSurface: DesktopScreenSurface?
  private var screenClip: DesktopWorkspaceContainer?
  private var screenID: String?
  private var screenRect = CGRect.zero
  private var visible: Bool { windowVisible && !managing }

  lazy var view: NSView = {
    let container = DesktopWorkspaceContainer()
    container.onLayout = { [weak self] in self?.layoutNativeScreen() }
    webView.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      webView.topAnchor.constraint(equalTo: container.topAnchor),
      webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
    return container
  }()

  lazy var webView: WKWebView = {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    // Hidden or behind other windows, WebKit throttles the page's timers: connection
    // heartbeats then come late, and a dead link to another computer looks alive past a request's limit.
    if #available(macOS 14.0, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
    // Off by default: without it the page sees fullscreenEnabled false and the remote
    // screen only fills the window instead of taking over the display.
    configuration.preferences.isElementFullscreenEnabled = true
    configuration.userContentController.add(DesktopWorkspaceMessageProxy(self), name: "linkshellDesktop")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    view.allowsBackForwardNavigationGestures = false
    view.underPageBackgroundColor = .windowBackgroundColor
    return view
  }()

  func start() {
    guard process == nil else { return }
    hasWorkspaceDocument = false
    problem = nil; loading = true; contentFocused = false
    let assets = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/Workspace", isDirectory: true)
    guard FileManager.default.fileExists(atPath: assets.appendingPathComponent("index.html").path) else {
      problem = "此安装缺少工作台资源。请安装完整的 LinkShell 桌面版，或重新构建 App。"
      loading = false
      return
    }
    let task = DesktopCommand.process(["desktop-workspace", "--assets", assets.path])
    let input = Pipe(), output = Pipe(), errors = Pipe()
    task.standardInput = input; task.standardOutput = output; task.standardError = errors
    self.input = input; self.output = output; self.errors = errors; process = task
    stdout = Data(); stderr = Data()
    let current = generation
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { handle.readabilityHandler = nil; return }
      Task { @MainActor in self?.receive(data, generation: current) }
    }
    errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { handle.readabilityHandler = nil; return }
      Task { @MainActor in
        guard let self, self.generation == current else { return }
        self.stderr.append(data)
        if self.stderr.count > 8192 { self.stderr.removeFirst(self.stderr.count - 8192) }
      }
    }
    task.terminationHandler = { [weak self] _ in
      Task { @MainActor in
        guard let self, self.generation == current else { return }
        let detail = String(data: self.stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.fail(detail.isEmpty ? "工作台服务已退出，请重新连接。" : "工作台启动失败：\(detail)")
      }
    }
    do {
      try task.run()
      startupDeadline = Task { [weak self] in
        try? await Task.sleep(nanoseconds: 30_000_000_000)
        guard !Task.isCancelled, let self, self.generation == current, self.readyURL == nil else { return }
        self.fail("工作台启动超时。请确认配套 CLI 可用后重试。")
      }
    } catch { fail("无法启动工作台：\(error.localizedDescription)") }
  }

  private func receive(_ data: Data, generation current: UUID) {
    guard generation == current, readyURL == nil else { return }
    stdout.append(data)
    guard stdout.count <= 65_536 else { fail("工作台启动响应过长，请更新配套 CLI 后重试。"); return }
    guard let end = stdout.firstIndex(of: 10) else { return }
    do {
      let url = try DesktopWorkspacePolicy.readyURL(from: stdout.prefix(upTo: end))
      startupDeadline?.cancel(); startupDeadline = nil
      readyURL = url; policy = DesktopWorkspacePolicy(origin: url)
      updateUserScripts()
      webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
      stdout = Data()
    } catch { fail(error.localizedDescription) }
  }

  func retry() {
    guard !retrying else { return }
    retrying = true
    Task { @MainActor in
      defer { retrying = false }
      let saved = await flushStorage()
      if !saved, !(await confirmDiscard(continuing: "仍然重新连接")) { return }
      stop()
      webView.stopLoading()
      start()
    }
  }

  func flushStorage() async -> Bool {
    guard hasWorkspaceDocument else { return true }
    guard policy?.isTrusted(webView.url) == true else { return false }
    return await DesktopWorkspaceSaveBarrier.wait { completed in
      webView.callAsyncJavaScript("""
        if (typeof window.__LINKSHELL_DESKTOP_FLUSH__ !== 'function') return {saved: true, pending: 0};
        return await window.__LINKSHELL_DESKTOP_FLUSH__();
        """, arguments: [:], in: nil, in: .page) { result in
        switch result {
        case .success(let value):
          let response = value as? [String: Any]
          completed(response?["saved"] as? Bool == true && response?["pending"] as? Int == 0)
        case .failure: completed(false)
        }
      }
    }
  }

  func confirmDiscard(continuing title: String) async -> Bool {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "部分草稿或设置尚未确认保存"
    alert.informativeText = "保存请求失败或等待超时。你可以返回工作台重试；继续可能丢失最近的修改。"
    alert.addButton(withTitle: "返回工作台")
    alert.addButton(withTitle: title)
    guard let window = webView.window else { return alert.runModal() == .alertSecondButtonReturn }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    return await withCheckedContinuation { continuation in
      alert.beginSheetModal(for: window) { continuation.resume(returning: $0 == .alertSecondButtonReturn) }
    }
  }

  func stop() {
    stopNativeScreen()
    generation = UUID()
    startupDeadline?.cancel(); startupDeadline = nil
    output?.fileHandleForReading.readabilityHandler = nil
    errors?.fileHandleForReading.readabilityHandler = nil
    process?.terminationHandler = nil
    try? input?.fileHandleForWriting.close()
    if let process, process.isRunning {
      // EOF gives the sidecar time to close its proxies. A wedged owned child must not outlive the app.
      DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
        if process.isRunning { process.terminate() }
      }
    }
    process = nil; input = nil; output = nil; errors = nil
    readyURL = nil; policy = nil; contentFocused = false
  }

  private func fail(_ message: String) {
    setPageVisible(false)
    stop()
    loading = false
    problem = message.replacingOccurrences(of: "desktop=[A-Za-z0-9_-]+", with: "desktop=[已隐藏]", options: .regularExpression)
  }

  func setManaging(_ value: Bool) {
    guard value != managing else { return }
    if value { webView.window?.makeFirstResponder(nil) }
    managing = value
    updateUserScripts()
    setPageVisible(visible)
    if !value, visible {
      DispatchQueue.main.async { [weak self] in
        guard let self, self.visible else { return }
        self.webView.window?.makeFirstResponder(self.webView)
      }
    }
  }

  /// Asks the page to run one of its own commands (the native top bar's search opens ⌘K).
  func send(command: String) {
    guard ["palette", "new-session"].contains(command) else { return }
    setManaging(false)
    guard policy?.isTrusted(webView.url) == true else { return }
    webView.window?.makeFirstResponder(webView)
    webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('linkshell-desktop-command', {detail: {command}}));",
                                arguments: ["command": command], in: nil, in: .page, completionHandler: nil)
  }

  func setWindowVisible(_ value: Bool) {
    windowVisible = value
    updateUserScripts()
    setPageVisible(visible)
  }

  func setAppearance(_ value: String) {
    guard DesktopWorkspacePolicy.validAppearance(value) else { return }
    appearance = value
    updateUserScripts()
    applyPageAppearance()
  }

  private func updateUserScripts() {
    let content = webView.configuration.userContentController
    content.removeAllUserScripts()
    let source = DesktopWorkspacePolicy.visibilityScript(visible) + DesktopWorkspacePolicy.appearanceScript(appearance)
    content.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  private func setPageVisible(_ value: Bool) {
    if !value { stopNativeScreen() }
    guard policy?.isTrusted(webView.url) == true else { return }
    webView.evaluateJavaScript(DesktopWorkspacePolicy.visibilityScript(value), completionHandler: nil)
  }

  private func applyPageAppearance() {
    guard policy?.isTrusted(webView.url) == true else { return }
    webView.evaluateJavaScript(DesktopWorkspacePolicy.appearanceScript(appearance), completionHandler: nil)
  }

  fileprivate func message(_ message: WKScriptMessage) {
    guard policy?.allowsBridge(from: message.frameInfo.request.url, mainFrame: message.frameInfo.isMainFrame) == true,
          let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
    if action == "manage" { setManaging(true) }
    else if action == "screen" { screenMessage(body) }
    else if action == "contentFocus", let focused = body["focused"] as? Bool {
      contentFocused = focused
    }
    else if action == "appearance", let value = body["value"] as? String, DesktopWorkspacePolicy.validAppearance(value), value != appearance {
      onAppearance?(value)
    }
    else if action == "external", let value = body["url"] as? String, let url = URL(string: value), DesktopWorkspacePolicy.externalURL(url) {
      NSWorkspace.shared.open(url)
    }
  }

  private func screenMessage(_ body: [String: Any]) {
    guard let id = DesktopScreenBridge.identifier(body["id"]), let type = body["type"] as? String else { return }
    if type == "stop" {
      if screenID == id { stopNativeScreen() }
      return
    }
    guard visible else { return }
    if type == "start" {
      guard let rect = DesktopScreenBridge.rect(body["rect"]) else { return }
      if screenID == id { screenRect = rect; layoutNativeScreen(); return }
      stopNativeScreen()
      screenID = id; screenRect = rect
      let clip = DesktopWorkspaceContainer()
      let surface = DesktopScreenSurface(frame: .zero)
      clip.addSubview(surface)
      screenClip = clip; screenSurface = surface
      view.addSubview(clip, positioned: .above, relativeTo: webView)
      screenReceiver = DesktopScreenReceiver(surface: surface, onSignal: { [weak self] message in
        self?.screenEvent(id: id, type: "signal", value: ["message": message])
      }, onStatus: { [weak self] status in
        guard let self, self.screenID == id else { return }
        self.screenEvent(id: id, type: "status", value: ["status": status])
      }, onFailure: { [weak self] error in
        guard let self, self.screenID == id else { return }
        self.screenEvent(id: id, type: "error", value: ["error": error])
        self.stopNativeScreen()
      })
      layoutNativeScreen()
      return
    }
    guard screenID == id else { return }
    switch type {
    case "signal":
      if let message = body["message"] as? [String: Any] { screenReceiver?.receive(message) }
    case "layout":
      if let rect = DesktopScreenBridge.rect(body["rect"]) { screenRect = rect; layoutNativeScreen() }
    case "control":
      if let enabled = DesktopScreenBridge.boolean(body["enabled"]) { screenReceiver?.setControl(enabled) }
    default: break
    }
  }

  private func layoutNativeScreen() {
    guard let clip = screenClip, let surface = screenSurface else { return }
    let zoom = webView.pageZoom
    let requested = CGRect(x: screenRect.minX * zoom, y: screenRect.minY * zoom,
                           width: screenRect.width * zoom, height: screenRect.height * zoom)
    let clipped = requested.intersection(view.bounds)
    guard !clipped.isNull, !clipped.isEmpty, visible else {
      screenReceiver?.setPresentationVisible(false)
      clip.isHidden = true; surface.setActive(false)
      return
    }
    clip.frame = clipped
    surface.frame = CGRect(x: requested.minX - clipped.minX, y: requested.minY - clipped.minY,
                           width: requested.width, height: requested.height)
    // The surface must be attached and active to present its first frame. Its background stays
    // transparent until then so the page's loading/error state can remain visible underneath.
    clip.isHidden = false
    screenReceiver?.setPresentationVisible(true)
    surface.setActive(true)
  }

  private func screenEvent(id: String, type: String, value: [String: Any]) {
    guard screenID == id, visible, policy?.isTrusted(webView.url) == true else { return }
    var detail = value
    detail["id"] = id; detail["type"] = type
    guard DesktopScreenBridge.validMessage(detail) else { return }
    // Arguments serialize data without interpolating SDP, errors or remote cursor text into JS.
    webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('linkshell-native-screen', {detail}));",
                                arguments: ["detail": detail], in: nil, in: .page, completionHandler: nil)
  }

  private func stopNativeScreen() {
    screenID = nil
    screenReceiver?.stop(); screenReceiver = nil
    screenSurface?.stop(); screenSurface = nil
    screenClip?.removeFromSuperview(); screenClip = nil
  }

  private func own(_ download: WKDownload) {
    downloads[ObjectIdentifier(download)] = download
    download.delegate = self
  }
}

private final class DesktopWorkspaceMessageProxy: NSObject, WKScriptMessageHandler {
  private weak var workspace: DesktopWorkspace?
  init(_ workspace: DesktopWorkspace) { self.workspace = workspace }
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated { workspace?.message(message) }
  }
}

extension DesktopWorkspace: WKNavigationDelegate {
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url, let policy else { decisionHandler(.cancel); return }
    if navigationAction.targetFrame?.isMainFrame == false {
      decisionHandler(policy.allowsSubframe(url) ? (navigationAction.shouldPerformDownload ? .download : .allow) : .cancel)
      return
    }
    if navigationAction.shouldPerformDownload && (policy.isTrusted(url) || policy.allowsBlob(url)) {
      decisionHandler(.download)
    } else if policy.isTrusted(url), navigationAction.targetFrame != nil {
      decisionHandler(.allow)
    } else {
      if DesktopWorkspacePolicy.externalURL(url) { NSWorkspace.shared.open(url) }
      decisionHandler(.cancel)
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
  }
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { own(download) }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { own(download) }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard policy?.isTrusted(webView.url) == true else { return }
    hasWorkspaceDocument = true
    loading = false; problem = nil
    setPageVisible(visible)
    applyPageAppearance()
  }
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    if policy?.isTrusted(webView.url) == true { hasWorkspaceDocument = true }
  }
  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { stopNativeScreen(); contentFocused = false }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { loading = false; problem = "无法打开工作台：\(error.localizedDescription)" }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { loading = false; problem = "工作台载入失败：\(error.localizedDescription)" }
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    stopNativeScreen()
    contentFocused = false; loading = false; problem = "工作台页面意外退出。请重新连接以恢复电脑与会话。"
  }
}

/// A point maps to a CSS pixel at pageZoom=1. Both layers use the same top-left origin.
private final class DesktopWorkspaceContainer: NSView {
  var onLayout: (() -> Void)?
  override var isFlipped: Bool { true }
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true
  }
  required init?(coder: NSCoder) { nil }
  override func layout() { super.layout(); onLayout?() }
}

extension DesktopWorkspace: WKUIDelegate {
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url, DesktopWorkspacePolicy.externalURL(url) { NSWorkspace.shared.open(url) }
    return nil
  }
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    guard policy?.allowsBridge(from: frame.request.url, mainFrame: frame.isMainFrame) == true else { completionHandler(nil); return }
    let panel = NSOpenPanel()
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.prompt = "选择"
    if let window = webView.window { panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) } }
    else { completionHandler(nil) }
  }
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    guard policy?.allowsBridge(from: frame.request.url, mainFrame: frame.isMainFrame) == true, let window = webView.window else { completionHandler(); return }
    let alert = NSAlert(); alert.messageText = "LinkShell"; alert.informativeText = message; alert.addButton(withTitle: "好")
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    guard policy?.allowsBridge(from: frame.request.url, mainFrame: frame.isMainFrame) == true, let window = webView.window else { completionHandler(false); return }
    let alert = NSAlert(); alert.messageText = "LinkShell"; alert.informativeText = message
    alert.addButton(withTitle: "继续"); alert.addButton(withTitle: "取消")
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }
}

extension DesktopWorkspace: WKDownloadDelegate {
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    guard let window = webView.window else { completionHandler(nil); return }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
    panel.canCreateDirectories = true
    panel.prompt = "保存"
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.url : nil) }
  }
  func downloadDidFinish(_ download: WKDownload) { downloads.removeValue(forKey: ObjectIdentifier(download)) }
  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloads.removeValue(forKey: ObjectIdentifier(download))
    guard (error as NSError).code != NSURLErrorCancelled, let window = webView.window else { return }
    let alert = NSAlert(); alert.messageText = "文件未能保存"; alert.informativeText = error.localizedDescription
    alert.beginSheetModal(for: window)
  }
}
