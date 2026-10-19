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
  private var reuse: ReuseProbe?
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
          if self.results.count == 3 { self.writeResults() }
        }
      }
      probes.append(probe)
      probe.start()
    }
    let reuse = ReuseProbe { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        self.results.append(result)
        if self.results.count == 3 { self.writeResults() }
      }
    }
    self.reuse = reuse
    reuse.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + 31) { [weak self] in self?.writeResults() }
  }

  private func writeResults() {
    let output: [String: Any] = ["checks": results, "passed": results.count == 3 && results.allSatisfy { $0["passed"] as? Bool == true }]
    let destination = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.json")
    try? JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys]).write(to: destination)
  }
}

/// The real receiver keeps one signalling socket while targets change and while a page's
/// resume request arrives before the native visibility prop. No capture or second peer is
/// started by this fixture; sender/receiver media identity is checked in the Mac loopback.
private final class ReuseProbe {
  private let done: ([String: Any]) -> Void
  private let queue = DispatchQueue(label: "screen-reuse-audit")
  private var listener: NWListener?
  private var sockets: [NWConnection] = []
  private var connection: ScreenConnection?
  private var configurations: [[String: Any]] = []
  private var hidden = false
  private var finished = false
  private var prematureResume = false

  init(done: @escaping ([String: Any]) -> Void) { self.done = done }

  func start() {
    let parameters = NWParameters.tcp
    parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
    do { listener = try NWListener(using: parameters, on: .any) }
    catch { return finish(error: String(describing: error)) }
    listener?.newConnectionHandler = { [weak self] socket in
      guard let self else { return }
      self.sockets.append(socket)
      socket.stateUpdateHandler = { [weak self] state in
        guard let self, case .ready = state else { return }
        self.send(["session": ["t": "capabilities", "version": 1, "configure": true, "pause": true]], socket)
        self.send(["rtc": ["t": "config", "iceServers": []]], socket)
        self.receive(socket)
      }
      socket.start(queue: self.queue)
    }
    listener?.stateUpdateHandler = { [weak self] state in
      guard let self, case .ready = state, let port = self.listener?.port else { return }
      DispatchQueue.main.async {
        let metrics = ScreenMetrics()
        let renderer = ScreenMetalView(metrics: metrics)
        let connection = ScreenConnection(url: "http://127.0.0.1:\(port.rawValue)?token=reuse", maxFps: 120, renderer: renderer, metrics: metrics)!
        self.connection = connection
        connection.onFailure = { [weak self] message in self?.queue.async { self?.finish(error: message) } }
        connection.onMessage = { [weak self] message in self?.queue.async { self?.message(message) } }
        connection.start()
      }
    }
    listener?.start(queue: queue)
    queue.asyncAfter(deadline: .now() + 5) { [weak self] in self?.finish(error: "reuse timeout") }
  }

  private func configure(_ id: Int, paused: Bool = false) {
    connection?.configure(["t": "screen.configure", "requestId": id, "display": id == 1 ? 0 : 1,
                           "width": id == 1 ? "1920" : "1280", "maxFps": 120, "paused": paused], maxFps: id == 1 ? 120 : 60)
  }

  private func message(_ message: [String: Any]) {
    guard !finished, let session = message["session"] as? [String: Any] else { return }
    if session["t"] as? String == "capabilities" { configure(1); return }
    guard session["t"] as? String == "configured" else { return }
    switch session["requestId"] as? Int {
    case 1: configure(2)
    case 2: connection?.setActive(false); configure(3, paused: true)
    case 3:
      // Mimics RN delivering the page's resume before its native `active` prop.
      configure(4)
      queue.asyncAfter(deadline: .now() + 0.15) { [weak self] in
        guard let self else { return }
        self.prematureResume = self.configurations.contains { $0["requestId"] as? Int == 4 }
        self.connection?.setActive(true)
      }
    case 4: finish()
    default: break
    }
  }

  private func receive(_ socket: NWConnection) {
    socket.receiveMessage { [weak self] data, _, _, error in
      guard let self, !self.finished else { return }
      if let data, let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
        if message["t"] as? String == "hidden" { self.hidden = true }
        if message["t"] as? String == "screen.configure" {
          self.configurations.append(message)
          var applied = message
          applied["t"] = "configured"
          applied["generation"] = message["requestId"]
          applied["height"] = 720
          self.send(["session": applied], socket)
        }
      }
      if error == nil { self.receive(socket) }
      else { self.finish(error: "reuse socket closed") }
    }
  }

  private func send(_ message: [String: Any], _ socket: NWConnection) {
    let context = NWConnection.ContentContext(identifier: "reuse", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
    socket.send(content: try? JSONSerialization.data(withJSONObject: message), contentContext: context, isComplete: true, completion: .idempotent)
  }

  private func finish(error: String? = nil) {
    guard !finished else { return }
    finished = true
    let ids = configurations.compactMap { $0["requestId"] as? Int }
    let passed = error == nil && sockets.count == 1 && ids == [1, 2, 3, 4] && hidden && !prematureResume
      && configurations[1]["display"] as? Int == 1 && configurations[1]["width"] as? Int == 1280
      && configurations[1]["maxFps"] as? Int == 60 && configurations[2]["paused"] as? Bool == true
      && configurations[3]["paused"] as? Bool == false
    done(["reuse": true, "passed": passed, "sockets": sockets.count, "requestIds": ids,
          "hidden": hidden, "prematureResume": prematureResume, "error": error ?? ""])
    connection?.stop()
    sockets.forEach { $0.cancel() }
    listener?.cancel()
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
