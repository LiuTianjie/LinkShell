import CryptoKit
import QuartzCore
import Foundation
import Network
import Security

/// Fusion: the control connection between the two Macs — negotiation, window lists, app launches.
/// Never pictures or input: those go over the screen's own WebRTC peer (video track, `input` /
/// `pointer` channels), as in ordinary remote desktop.
///
/// Frames: [length u32 BE][JSON], inside TLS 1.2 with a pre-shared key derived from the session
/// token. The LAN path is not the end-to-end tunnel, so the token, the window list and the SDP
/// (whose DTLS fingerprints authenticate the media) must never cross it in the clear; a peer
/// without the token cannot even finish the handshake.
final class FusionWire {
  static let port: UInt16 = 47391
  /// Not secret: names the key, so both ends agree on which one is in use.
  static let pskIdentity = "linkshell-fusion-v1"
  /// Domain separation: the token is also the `hello` credential, never the raw key.
  static let pskLabel = "linkshell-fusion-psk-v1"

  let connection: NWConnection
  var onMessage: (([String: Any]) -> Void)?
  var onReady: (() -> Void)?
  /// The reason is a short machine word (`timeout`, `tls`, `refused`, `closed`, …) for alerts.
  var onClose: ((String) -> Void)?
  private let queue = DispatchQueue(label: "linkshell.fusion.wire")
  private let lock = NSLock()
  private var closed = false
  private var lastHeard = CACurrentMediaTime()
  private var watchdog: DispatchSourceTimer?
  private var waitingTimer: DispatchSourceTimer?
  /// How long `.waiting` (no route, refused) may last before the connection is given up.
  var waitingTimeout: TimeInterval = 6

  init(_ connection: NWConnection) { self.connection = connection }

  static func psk(token: String) -> Data {
    let key = SymmetricKey(data: Data(token.utf8))
    return Data(HMAC<SHA256>.authenticationCode(for: Data(pskLabel.utf8), using: key))
  }

  static func parameters(token: String) -> NWParameters {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    // A peer that vanished (sleep, Wi-Fi gone) is noticed by the kernel too, not only by pings.
    tcp.enableKeepalive = true
    tcp.keepaliveIdle = 5
    tcp.keepaliveInterval = 2
    tcp.keepaliveCount = 3
    let tls = NWProtocolTLS.Options()
    let options = tls.securityProtocolOptions
    let key = psk(token: token)
    let keyData = key.withUnsafeBytes { DispatchData(bytes: $0) }
    let identity = Data(pskIdentity.utf8).withUnsafeBytes { DispatchData(bytes: $0) }
    sec_protocol_options_add_pre_shared_key(options, keyData as __DispatchData, identity as __DispatchData)
    // PSK suites exist only up to TLS 1.2; 1.3 would negotiate certificates instead.
    sec_protocol_options_set_min_tls_protocol_version(options, .TLSv12)
    sec_protocol_options_set_max_tls_protocol_version(options, .TLSv12)
    if let suite = tls_ciphersuite_t(rawValue: UInt16(TLS_PSK_WITH_AES_128_GCM_SHA256)) {
      sec_protocol_options_append_tls_ciphersuite(options, suite)
    }
    let parameters = NWParameters(tls: tls, tcp: tcp)
    parameters.allowLocalEndpointReuse = true
    return parameters
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.cancelWaiting()
        self.onReady?()
      case .waiting(let error):
        // A bad key surfaces as a TLS error: retrying cannot fix it.
        if case .tls = error { self.close(reason: "tls") } else { self.armWaiting() }
      case .failed(let error):
        if case .tls = error { self.close(reason: "tls") } else { self.close(reason: "failed") }
      case .cancelled: self.close(reason: "closed")
      default: break
      }
    }
    connection.start(queue: queue)
    readHeader()
  }

  /// Closes the connection when nothing has been heard for `timeout` (the peer pings).
  func startWatchdog(timeout: TimeInterval) {
    queue.async {
      self.lastHeard = CACurrentMediaTime()
      self.watchdog?.cancel()
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now() + 1, repeating: 1)
      timer.setEventHandler { [weak self] in
        guard let self else { return }
        if CACurrentMediaTime() - self.lastHeard > timeout { self.close(reason: "timeout") }
      }
      timer.resume()
      self.watchdog = timer
    }
  }

  private func armWaiting() {
    guard waitingTimer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + waitingTimeout)
    timer.setEventHandler { [weak self] in self?.close(reason: "unreachable") }
    timer.resume()
    waitingTimer = timer
  }

  private func cancelWaiting() {
    waitingTimer?.cancel()
    waitingTimer = nil
  }

  func close(reason: String = "closed") {
    lock.lock(); let was = closed; closed = true; lock.unlock()
    guard !was else { return }
    watchdog?.cancel()
    cancelWaiting()
    connection.cancel()
    DispatchQueue.main.async { self.onClose?(reason) }
  }

  private func readHeader() {
    connection.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] data, _, _, error in
      guard let self else { return }
      if let error, case .tls = error { return self.close(reason: "tls") }
      guard error == nil, let data, data.count == 4 else { return self.close(reason: "closed") }
      let b = [UInt8](data)
      let length = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
      guard length > 0, length < 8 << 20 else { return self.close(reason: "protocol") }
      self.connection.receive(minimumIncompleteLength: length, maximumLength: length) { body, _, _, error in
        guard error == nil, let body, body.count == length else { return self.close(reason: "closed") }
        self.lastHeard = CACurrentMediaTime()
        if let message = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] {
          DispatchQueue.main.async { self.onMessage?(message) }
        }
        self.readHeader()
      }
    }
  }

  func send(_ message: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(message), let body = try? JSONSerialization.data(withJSONObject: message) else { return }
    var frame = Data([UInt8(body.count >> 24 & 0xff), UInt8(body.count >> 16 & 0xff), UInt8(body.count >> 8 & 0xff), UInt8(body.count & 0xff)])
    frame.append(body)
    connection.send(content: frame, completion: .contentProcessed { _ in })
  }
}

enum Fusion {
  static func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? 0 }
  static func rect(_ value: Any?) -> CGRect {
    let d = value as? [String: Any] ?? [:]
    return CGRect(x: number(d["x"]), y: number(d["y"]), width: number(d["w"]), height: number(d["h"]))
  }
  static func dict(_ r: CGRect) -> [String: Double] { ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height] }

  /// Where `log` writes; stderr is discarded for processes started by `open` or a detached spawn.
  static var logPath: String? {
    didSet { logLock.lock(); logHandle = nil; logLock.unlock() }
  }
  static let logLimit: UInt64 = 2 << 20
  private static let logLock = NSLock()
  private static var logHandle: FileHandle?
  private static let formatter: DateFormatter = {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"; return f
  }()

  static func log(_ s: String) {
    logLock.lock()
    defer { logLock.unlock() }
    let line = Data("\(formatter.string(from: Date())) \(s)\n".utf8)
    guard let path = logPath else { FileHandle.standardError.write(line); return }
    if logHandle == nil {
      if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) }
      logHandle = FileHandle(forWritingAtPath: path)
      _ = try? logHandle?.seekToEnd()
    }
    guard let handle = logHandle else { FileHandle.standardError.write(line); return }
    handle.write(line)
    // One older file is kept: enough to see what led up to a failure, bounded on disk.
    if let size = try? handle.offset(), size > logLimit {
      try? handle.close()
      logHandle = nil
      let old = path + ".1"
      try? FileManager.default.removeItem(atPath: old)
      try? FileManager.default.moveItem(atPath: path, toPath: old)
    }
  }

  /// The hub's socket, icon cache and stub bundle ids are keyed by this, never by the computer's
  /// name: two computers may share a name, and a rename must not orphan anything. Must equal
  /// `fusionSlug` in apps/desktop/src/main/main.ts (shared test vector in both suites).
  static func slug(computerKey: String) -> String {
    let digest = SHA256.hash(data: Data("linkshell-fusion:\(computerKey)".utf8))
    return digest.prefix(6).map { String(format: "%02x", $0) }.joined()
  }
}
