import UIKit
import Network

// Exercises the actual receiver against sockets that never deliver a picture. One withholds
// config (there is no peer), the other sends config but no offer (diagnostics can run).
@main final class ConnectionAudit: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                   options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: nil, sessionRole: session.role)
    config.delegateClass = ConnectionScene.self
    return config
  }
}

final class ConnectionScene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var probes: [Probe] = []
  private var results: [[String: Any]] = []

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = UIViewController()
    window.makeKeyAndVisible()
    self.window = window
    for config in [false, true] {
      let probe = Probe(config: config) { [weak self] result in
        DispatchQueue.main.async {
          guard let self else { return }
          self.results.append(result)
          if self.results.count == 2 { self.writeResults() }
        }
      }
      probes.append(probe)
      probe.start()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 31) { [weak self] in self?.writeResults() }
  }

  private func writeResults() {
    let output: [String: Any] = ["checks": results, "passed": results.count == 2 && results.allSatisfy { $0["passed"] as? Bool == true }]
    let destination = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.json")
    try? JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys]).write(to: destination)
  }
}

private final class Probe {
  private let config: Bool
  private let done: ([String: Any]) -> Void
  private let queue = DispatchQueue(label: "screen-connection-audit")
  private var listener: NWListener?
  private var sockets: [NWConnection] = []
  private var connection: ScreenConnection?
  private var started = 0.0
  private var diagnostic = false
  private var finished = false

  init(config: Bool, done: @escaping ([String: Any]) -> Void) { self.config = config; self.done = done }

  func start() {
    let parameters = NWParameters.tcp
    parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
    do { listener = try NWListener(using: parameters, on: .any) }
    catch { return done(["passed": false, "error": String(describing: error)]) }
    listener?.newConnectionHandler = { [weak self] socket in
      guard let self else { return }
      self.sockets.append(socket)
      socket.stateUpdateHandler = { [weak self] state in
        guard let self, case .ready = state else { return }
        if self.config {
          let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
          let context = NWConnection.ContentContext(identifier: "config", metadata: [metadata])
          socket.send(content: Data(#"{"rtc":{"t":"config","iceServers":[]}}"#.utf8), contentContext: context, isComplete: true, completion: .idempotent)
        }
        self.receive(socket)
      }
      socket.start(queue: self.queue)
    }
    listener?.stateUpdateHandler = { [weak self] state in
      guard let self, case .ready = state, let port = self.listener?.port else { return }
      DispatchQueue.main.async {
        let metrics = ScreenMetrics()
        let renderer = ScreenMetalView(metrics: metrics)
        let connection = ScreenConnection(url: "http://127.0.0.1:\(port.rawValue)?token=test", maxFps: 60, renderer: renderer, metrics: metrics)!
        self.connection = connection
        self.started = ProcessInfo.processInfo.systemUptime
        connection.onFailure = { [weak self] message in self?.queue.async { self?.finish(message) } }
        connection.start()
      }
    }
    listener?.start(queue: queue)
  }

  private func receive(_ socket: NWConnection) {
    socket.receiveMessage { [weak self] data, _, _, error in
      guard let self, !self.finished else { return }
      if let data, String(data: data, encoding: .utf8)?.contains("rtc.diagnosis") == true { self.diagnostic = true }
      if error == nil { self.receive(socket) }
    }
  }

  private func finish(_ message: String) {
    guard !finished else { return }
    finished = true
    let elapsed = ProcessInfo.processInfo.systemUptime - started
    done(["config": config, "message": message, "seconds": elapsed, "diagnostic": diagnostic,
          "passed": message == "视频直连超时" && elapsed >= 25 && elapsed < 29 && (!config || diagnostic)])
    connection?.stop()
    sockets.forEach { $0.cancel() }
    listener?.cancel()
  }
}
