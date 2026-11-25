import ExpoModulesCore
import Foundation
import Network

/// WebSocket connections on Apple's Network framework.
///
/// React Native's built-in WebSocket follows the system proxy (including PAC
/// files that proxy everything), which breaks connections to a computer on
/// the local network. This module connects to loopback and private addresses
/// directly and keeps the system proxy for everything else (the relay).
public class LinkSocketModule: Module {
  private var connections: [String: LinkSocketConnection] = [:]
  private let lock = NSLock()
  private let pathQueue = DispatchQueue(label: "linkshell.network.path")
  private var pathMonitor: NWPathMonitor?
  private var lastPathSignature: String?
  private var pendingPathWork: DispatchWorkItem?

  public func definition() -> ModuleDefinition {
    Name("LinkSocket")

    Events("onOpen", "onMessage", "onClose", "onError", "onNetworkPathChange")

    OnCreate { [weak self] in
      self?.startPathMonitor()
    }

    Function("connect") { (id: String, url: String, direct: Bool) throws in
      guard let target = URL(string: url), let scheme = target.scheme?.lowercased(), scheme == "ws" || scheme == "wss" else {
        throw Exception(name: "ERR_INVALID_URL", description: "Not a WebSocket URL: \(url)")
      }
      let connection = LinkSocketConnection(id: id, url: target, direct: direct, module: self)
      self.lock.lock()
      self.connections[id] = connection
      self.lock.unlock()
      connection.start()
    }

    Function("send") { (id: String, text: String) in
      self.connection(id)?.send(text)
    }

    Function("close") { (id: String, code: Int, reason: String) in
      self.connection(id)?.close(code: code, reason: reason)
    }

    OnDestroy { [weak self] in
      guard let self else { return }
      self.stopPathMonitor()
      self.lock.lock()
      let all = Array(self.connections.values)
      self.connections.removeAll()
      self.lock.unlock()
      for connection in all {
        connection.close(code: 1001, reason: "going away")
      }
    }
  }

  private func startPathMonitor() {
    pathQueue.async { [weak self] in
      guard let self, self.pathMonitor == nil else { return }
      let monitor = NWPathMonitor()
      monitor.pathUpdateHandler = { [weak self] path in
        self?.handlePathUpdate(path)
      }
      self.pathMonitor = monitor
      monitor.start(queue: self.pathQueue)
    }
  }

  private func stopPathMonitor() {
    pathQueue.async { [weak self] in
      guard let self else { return }
      self.pendingPathWork?.cancel()
      self.pendingPathWork = nil
      self.pathMonitor?.pathUpdateHandler = nil
      self.pathMonitor?.cancel()
      self.pathMonitor = nil
      self.lastPathSignature = nil
    }
  }

  private func handlePathUpdate(_ path: NWPath) {
    let status: String
    switch path.status {
    case .satisfied: status = "satisfied"
    case .requiresConnection: status = "requiresConnection"
    default: status = "unsatisfied"
    }

    let iface: String
    if path.status != .satisfied {
      iface = "none"
    } else if path.usesInterfaceType(.wifi) {
      iface = "wifi"
    } else if path.usesInterfaceType(.wiredEthernet) {
      iface = "wired"
    } else if path.usesInterfaceType(.cellular) {
      iface = "cellular"
    } else {
      iface = "other"
    }

    let interfaceNames = path.availableInterfaces.map { "\($0.name):\($0.index)" }.sorted().joined(separator: ",")
    var gatewayKey = ""
    if #available(iOS 14.2, *) {
      gatewayKey = path.gateways.map { "\($0)" }.sorted().joined(separator: ",")
    }
    let signature = "\(status)|\(iface)|\(path.isExpensive)|\(path.isConstrained)|\(interfaceNames)|\(gatewayKey)"

    // Record the initial baseline without emitting so cold start does not trigger redundant reconnects.
    if lastPathSignature == nil {
      lastPathSignature = signature
      return
    }
    guard signature != lastPathSignature else { return }
    lastPathSignature = signature

    pendingPathWork?.cancel()
    let payload: [String: Any?] = [
      "status": status,
      "interface": iface,
      "isExpensive": path.isExpensive,
      "isConstrained": path.isConstrained,
    ]
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.pathMonitor != nil else { return }
      self.emit("onNetworkPathChange", payload)
    }
    pendingPathWork = work
    pathQueue.asyncAfter(deadline: .now() + 0.3, execute: work)
  }

  fileprivate func connection(_ id: String) -> LinkSocketConnection? {
    lock.lock()
    defer { lock.unlock() }
    return connections[id]
  }

  fileprivate func remove(_ id: String) {
    lock.lock()
    connections.removeValue(forKey: id)
    lock.unlock()
  }

  fileprivate func emit(_ event: String, _ body: [String: Any?]) {
    sendEvent(event, body)
  }
}

final class LinkSocketConnection {
  private let id: String
  private weak var module: LinkSocketModule?
  private let connection: NWConnection
  private let queue: DispatchQueue
  private let stateLock = NSLock()
  private var finished = false
  private var isReady = false
  private var cancelled = false

  init(id: String, url: URL, direct: Bool, module: LinkSocketModule) {
    self.id = id
    self.module = module
    self.queue = DispatchQueue(label: "linkshell.socket.\(id)")
    let options = NWProtocolWebSocket.Options()
    options.autoReplyPing = true
    options.maximumMessageSize = 32 * 1024 * 1024
    let parameters: NWParameters = url.scheme?.lowercased() == "wss" ? .tls : .tcp
    parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
    // LAN and loopback hosts are never behind a proxy, and a system PAC file
    // would otherwise route even 127.0.0.1 through one.
    parameters.preferNoProxies = direct
    connection = NWConnection(to: .url(url), using: parameters)
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        let shouldOpen: Bool = {
          self.stateLock.lock()
          defer { self.stateLock.unlock() }
          if self.finished { return false }
          self.isReady = true
          return true
        }()
        if shouldOpen {
          self.module?.emit("onOpen", ["id": self.id])
          self.receive()
        } else {
          self.cancelConnectionOnce()
        }
      case .waiting(let error), .failed(let error):
        self.fail(error.localizedDescription)
      case .cancelled:
        self.finish(code: 1000, reason: "")
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  func send(_ text: String) {
    let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
    let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
    connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
      if let error { self?.fail(error.localizedDescription) }
    })
  }

  func close(code: Int, reason: String) {
    let wasReady: Bool = {
      stateLock.lock()
      defer { stateLock.unlock() }
      return isReady
    }()
    finish(code: code, reason: reason)
    // A connection that never reached .ready will never flush a close frame; cancel immediately
    // so sockets and descriptors cannot leak during Happy Eyeballs races or offline retries.
    guard wasReady else {
      cancelConnectionOnce()
      return
    }
    let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
    metadata.closeCode = (try? NWProtocolWebSocket.CloseCode(rawValue: UInt16(clamping: code))) ?? .protocolCode(.normalClosure)
    let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
    connection.send(content: Data(reason.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] _ in
      self?.cancelConnectionOnce()
    })
    // Guarantee cancellation even if the peer is half-open and .contentProcessed never fires.
    queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      self?.cancelConnectionOnce()
    }
  }

  private func cancelConnectionOnce() {
    let shouldCancel: Bool = {
      stateLock.lock()
      defer { stateLock.unlock() }
      if cancelled { return false }
      cancelled = true
      return true
    }()
    if shouldCancel {
      connection.cancel()
    }
  }

  private func receive() {
    connection.receiveMessage { [weak self] data, context, _, error in
      guard let self else { return }
      if let error {
        self.fail(error.localizedDescription)
        return
      }
      let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
      switch metadata?.opcode {
      case .text?, .binary?:
        if let data {
          self.module?.emit("onMessage", ["id": self.id, "data": String(decoding: data, as: UTF8.self)])
        }
      case .close?:
        var code = 1000
        if case .protocolCode(let value) = metadata?.closeCode { code = Int(value.rawValue) }
        else if case .applicationCode(let value) = metadata?.closeCode { code = Int(value) }
        else if case .privateCode(let value) = metadata?.closeCode { code = Int(value) }
        self.finish(code: code, reason: data.map { String(decoding: $0, as: UTF8.self) } ?? "")
        self.cancelConnectionOnce()
        return
      default:
        break
      }
      self.receive()
    }
  }

  /// Marks the connection finished once; returns false if it already was.
  private func markFinished() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    if finished { return false }
    finished = true
    return true
  }

  private func fail(_ message: String) {
    guard markFinished() else { return }
    module?.emit("onError", ["id": id, "message": message])
    module?.emit("onClose", ["id": id, "code": 1006, "reason": message])
    cancelConnectionOnce()
    module?.remove(id)
  }

  private func finish(code: Int, reason: String) {
    guard markFinished() else { return }
    module?.emit("onClose", ["id": id, "code": code, "reason": reason])
    module?.remove(id)
  }
}
