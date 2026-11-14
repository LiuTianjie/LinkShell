import Foundation
import Network

/// Fusion lab (experimental): the control connection between the two Macs — negotiation, window
/// lists, app launches. Never pictures or input: those go over the screen's own WebRTC peer
/// (video track, `input` / `pointer` channels), as in ordinary remote desktop.
/// Frames: [length u32 BE][JSON].
final class FusionWire {
  static let port: UInt16 = 47391

  let connection: NWConnection
  var onMessage: (([String: Any]) -> Void)?
  var onReady: (() -> Void)?
  var onClose: (() -> Void)?
  private let queue = DispatchQueue(label: "linkshell.fusion.wire")
  private let lock = NSLock()
  private var closed = false

  init(_ connection: NWConnection) { self.connection = connection }

  static func parameters() -> NWParameters {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    return NWParameters(tls: nil, tcp: tcp)
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready: self?.onReady?()
      case .failed, .cancelled: self?.close()
      default: break
      }
    }
    connection.start(queue: queue)
    readHeader()
  }

  func close() {
    lock.lock(); let was = closed; closed = true; lock.unlock()
    guard !was else { return }
    connection.cancel()
    DispatchQueue.main.async { self.onClose?() }
  }

  private func readHeader() {
    connection.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] data, _, _, error in
      guard let self else { return }
      guard error == nil, let data, data.count == 4 else { return self.close() }
      let b = [UInt8](data)
      let length = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
      guard length > 0, length < 8 << 20 else { return self.close() }
      self.connection.receive(minimumIncompleteLength: length, maximumLength: length) { body, _, _, error in
        guard error == nil, let body, body.count == length else { return self.close() }
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
  static func log(_ s: String) {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"
    FileHandle.standardError.write(Data("\(f.string(from: Date())) \(s)\n".utf8))
  }
}
