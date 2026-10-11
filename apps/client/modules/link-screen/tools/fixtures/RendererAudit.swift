import UIKit
import CoreVideo
import WebRTC

@main final class RenderApp: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                   options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: nil, sessionRole: session.role)
    config.delegateClass = RenderScene.self
    return config
  }
}

final class RenderScene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  var screen: ScreenMetalView?
  let sink = ScreenShared<ScreenMetalView?>(nil)
  let metrics = ScreenMetrics(enabled: true, tracing: true)
  let blocked = ScreenShared(false)
  let failures = ScreenShared<[String]>([])
  let queue = DispatchQueue(label: "render-audit-source", qos: .userInteractive)
  var timer: DispatchSourceTimer?
  var sampling: DispatchSourceTimer?
  var pool: CVPixelBufferPool?
  var counter = 0
  var rows: [[String: Any]] = []
  var began = 0.0

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    let root = UIViewController()
    window.rootViewController = root
    root.view.backgroundColor = .black
    let screen = ScreenMetalView(metrics: metrics)
    screen.frame = scene.coordinateSpace.bounds
    screen.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    screen.showsPointer = false
    screen.onFailure = { [failures] message in failures.update { $0.append(message) } }
    root.view.addSubview(screen)
    self.window = window; self.screen = screen
    sink.update { $0 = screen }
    window.makeKeyAndVisible()
    screen.layoutIfNeeded()
    screen.start(fps: 60)
    let attributes: [CFString: Any] = [kCVPixelBufferWidthKey: 128, kCVPixelBufferHeightKey: 72,
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferMetalCompatibilityKey: true, kCVPixelBufferIOSurfacePropertiesKey: [:]]
    CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
    began = ProcessInfo.processInfo.systemUptime
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1.0 / 60, leeway: .microseconds(100))
    timer.setEventHandler { [weak self] in self?.produce() }
    timer.resume(); self.timer = timer
    let sampling = DispatchSource.makeTimerSource(queue: queue)
    sampling.schedule(deadline: .now() + 0.1, repeating: 0.1, leeway: .milliseconds(1))
    sampling.setEventHandler { [weak self] in self?.sample() }
    sampling.resume(); self.sampling = sampling
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      guard let self else { return }
      blocked.update { $0 = true }
      Thread.sleep(forTimeInterval: 0.6)
      blocked.update { $0 = false }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.screen?.stop() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 4.2) { [weak self] in self?.screen?.start(fps: 60) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      self?.screen?.zoom = 1.3; self?.screen?.pan = CGPoint(x: 12, y: 8)
      self?.screen?.setNeedsLayout()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5.5) { [weak self] in
      guard let self, let old = self.screen, let parent = old.superview else { return }
      let rect = old.frame
      old.stop(); old.removeFromSuperview(); sink.update { $0 = nil }
      let replacement = ScreenMetalView(metrics: metrics)
      replacement.frame = rect; replacement.showsPointer = false
      replacement.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      replacement.onFailure = { [failures] message in failures.update { $0.append(message) } }
      parent.addSubview(replacement); self.screen = replacement; sink.update { $0 = replacement }
      replacement.start(fps: 60)
    }
  }

  func produce() {
    guard let pool else { return }
    var made: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made) == kCVReturnSuccess, let made else { return }
    CVPixelBufferLockBaseAddress(made, [])
    if let y = CVPixelBufferGetBaseAddressOfPlane(made, 0) {
      let stride = CVPixelBufferGetBytesPerRowOfPlane(made, 0)
      memset(y, 32, stride * 72)
      for row in 0..<72 { memset(y + row * stride + counter % 100, 215, 20) }
    }
    if let uv = CVPixelBufferGetBaseAddressOfPlane(made, 1) { memset(uv, 128, CVPixelBufferGetBytesPerRowOfPlane(made, 1) * 36) }
    CVPixelBufferUnlockBaseAddress(made, [])
    counter += 1
    let timestamp = UInt32(counter * 1500)
    let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: made), rotation: ._0,
      timeStampNs: Int64(ProcessInfo.processInfo.systemUptime * 1e9))
    frame.timeStamp = Int32(bitPattern: timestamp)
    metrics.decoding(timestamp); metrics.decoded(timestamp)
    sink.read()?.renderFrame(frame)
  }

  func sample() {
    let elapsed = ProcessInfo.processInfo.systemUptime - began
    var row = metrics.snapshot(seconds: 0.1)
    row["second"] = elapsed; row["blocked"] = blocked.read()
    rows.append(row)
    if elapsed >= 7 {
      timer?.cancel(); sampling?.cancel()
      let result: [String: Any] = ["rows": rows, "failures": failures.read()]
      let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.json")
      if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: url, options: .atomic) }
    }
  }
}
