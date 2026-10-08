import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

/// A read-only window capture in a helper process separate from screen sharing and input.
/// The title must still identify the expected tab before every frame; switching tabs pauses it.
final class ComputerPreview: NSObject, SCStreamOutput, SCStreamDelegate {
  private let viewer: String
  private let bundle: String
  private let title: String?
  private let nativeApp: Bool
  private var ownerPID: pid_t?
  private let link: Link
  private let queue = DispatchQueue(label: "com.bd.linkshell.computer-preview", qos: .utility)
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var capture: SCStream?
  private var window: CGWindowID?
  private var stopped = false
  private var retry: DispatchWorkItem?
  private var nextFrame = 0.0
  private var reported: String?

  init?(viewer: String, command: [String: Any], link: Link) {
    guard let bundle = command["bundleId"] as? String, bundle.count <= 256,
          bundle.range(of: "^[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$", options: .regularExpression) != nil else { return nil }
    let title = command["title"] as? String
    let nativeApp = command["app"] as? Bool == true
    guard title == nil || (!title!.isEmpty && title!.count <= 512),
          nativeApp || (title != nil && ["com.google.Chrome", "com.microsoft.edgemac"].contains(bundle)) else { return nil }
    self.viewer = viewer; self.bundle = bundle; self.title = title; self.nativeApp = nativeApp; self.link = link
  }

  func start() {
    guard Permissions.recording() else { return problem("电脑未允许 LinkShell 录制屏幕") }
    queue.async { self.findWindow() }
  }

  func close() {
    queue.async {
      self.stopped = true; self.retry?.cancel(); self.retry = nil
      let capture = self.capture; self.capture = nil
      capture?.stopCapture { _ in }
    }
  }

  private func problem(_ message: String) {
    guard reported != message else { return }
    reported = message
    link.emit(["t": "preview.paused", "v": viewer, "error": message])
  }

  private func findWindow() {
    guard !stopped, capture == nil else { return }
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { [weak self] content, error in
      self?.queue.async {
        guard let self, !self.stopped else { return }
        let candidates = content?.windows.filter { $0.owningApplication?.bundleIdentifier == self.bundle && (self.title == nil || $0.title == self.title) && $0.windowLayer == 0 && $0.frame.width > 100 && $0.frame.height > 100 } ?? []
        guard candidates.count == 1, let window = candidates.first else {
          self.problem(candidates.count > 1 ? "无法唯一确定目标窗口，已暂停预览" : "目标窗口暂不可用，已暂停预览")
          return self.later()
        }
        let configuration = SCStreamConfiguration()
        // Chrome may withhold its AX tree when no assistive client is using it.
        // Capture the identified window in that case; never change Chrome's accessibility mode.
        let crop = (self.nativeApp ? nil : Self.webViewport(window)) ?? CGRect(origin: .zero, size: window.frame.size)
        let scale = min(1, min(480 / crop.width, 720 / crop.height))
        configuration.width = max(2, Int(crop.width * scale))
        configuration.height = max(2, Int(crop.height * scale))
        configuration.sourceRect = crop
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 3)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.scalesToFit = true
        if #available(macOS 14.2, *) { configuration.ignoreShadowsSingleWindow = true }
        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration, delegate: self)
        do { try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue) }
        catch { self.problem("窗口采集暂时不可用"); return self.later() }
        self.window = window.windowID; self.ownerPID = window.owningApplication?.processID; self.capture = stream
        stream.startCapture { error in
          self.queue.async {
            if self.stopped { stream.stopCapture { _ in }; return }
            if error != nil { self.capture = nil; self.problem("窗口采集暂时不可用"); self.later() }
          }
        }
      }
    }
  }

  private func later() {
    guard !stopped else { return }
    retry?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.findWindow() }
    retry = work; queue.asyncAfter(deadline: .now() + 2, execute: work)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    queue.async {
      guard !self.stopped, self.capture === stream else { return }
      self.capture = nil; self.problem("窗口采集已暂停"); self.later()
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard !stopped, capture === stream, type == .screen, sample.isValid,
          let buffer = CMSampleBufferGetImageBuffer(sample), let window else { return }
    let attachments = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
    guard let status = attachments?[.status] as? Int, status == SCFrameStatus.complete.rawValue else { return }
    // A window can now show a different tab. Do not send its pixels under the old target's name.
    let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, window) as? [[String: Any]]
    guard info?.first?[kCGWindowOwnerPID as String] as? pid_t == ownerPID,
          title == nil || info?.first?[kCGWindowName as String] as? String == title else {
      problem("目标窗口已改变，已暂停预览")
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    guard now >= nextFrame else { return }
    nextFrame = now + 1.0 / 3.0
    let image = CIImage(cvPixelBuffer: buffer)
    guard let cg = context.createCGImage(image, from: image.extent) else { return }
    let bitmap = NSBitmapImageRep(cgImage: cg)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.6]), jpeg.count <= 192 * 1024 else { return }
    reported = nil
    link.emit(["t": "preview.frame", "v": viewer, "data": jpeg.base64EncodedString()])
  }

  /// Crop browser chrome when Accessibility exposes the document's viewport. No input is posted.
  private static func webViewport(_ window: SCWindow) -> CGRect? {
    guard AXIsProcessTrusted(), let pid = window.owningApplication?.processID else { return nil }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.15)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement] else { return nil }
    func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
      var value: CFTypeRef?
      return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
    }
    func rect(_ element: AXUIElement) -> CGRect? {
      guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute),
            CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
      var point = CGPoint.zero; var dimensions = CGSize.zero
      guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
            AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions) else { return nil }
      return CGRect(origin: point, size: dimensions)
    }
    let positioned = windows.filter {
      guard let bounds = rect($0) else { return false }
      return abs(bounds.minX - window.frame.minX) < 4 && abs(bounds.minY - window.frame.minY) < 4
        && abs(bounds.width - window.frame.width) < 4 && abs(bounds.height - window.frame.height) < 4
    }
    // Chrome's AX frame can briefly lag its ScreenCaptureKit frame during a move/resize.
    let named = windows.filter {
      guard let expected = window.title, let name = attribute($0, kAXTitleAttribute) as? String else { return false }
      return name == expected || name.hasPrefix(expected + " - ")
    }
    let matching = positioned.isEmpty ? named : positioned
    guard matching.count == 1, let root = matching.first else { return nil }
    var pending: [(AXUIElement, CGRect?)] = [(root, nil)]
    var count = 0
    let deadline = ProcessInfo.processInfo.systemUptime + 1
    while !pending.isEmpty, count < 120, ProcessInfo.processInfo.systemUptime < deadline {
      let (element, scroll) = pending.removeFirst(); count += 1
      let role = attribute(element, kAXRoleAttribute) as? String
      if role == "AXWebArea", let bounds = scroll ?? rect(element) {
        let visible = bounds.intersection(window.frame)
        guard visible.width > 100, visible.height > 100 else { return nil }
        return visible.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
      }
      let container = role == kAXScrollAreaRole ? rect(element) : scroll
      for child in (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(30) { pending.append((child, container)) }
    }
    return nil
  }
}
