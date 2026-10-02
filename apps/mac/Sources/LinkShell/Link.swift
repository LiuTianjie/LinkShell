import Darwin
import Foundation

/// Whoever this talks to — the host on its socket, or a parent process on stdin and stdout:
/// one JSON object a line, each way.
final class Link {
  private let input: Int32
  private let output: Int32
  private let writing = NSLock()

  /// The host's socket (`--connect`).
  init?(path: String) {
    guard let descriptor = Link.connect(to: path) else { return nil }
    input = descriptor
    output = descriptor
  }

  private init(input: Int32, output: Int32) {
    self.input = input
    self.output = output
  }

  /// Commands on stdin, answers on stdout.
  static let standard = Link(input: STDIN_FILENO, output: STDOUT_FILENO)

  /// A unix socket someone is listening on, connected.
  static func connect(to path: String) -> Int32? {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return nil }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
      close(descriptor)
      return nil
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
      pointer.withMemoryRebound(to: UInt8.self, capacity: bytes.count + 1) { raw in
        for (index, byte) in bytes.enumerated() { raw[index] = byte }
        raw[bytes.count] = 0
      }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, size) }
    }
    guard result == 0 else {
      close(descriptor)
      return nil
    }
    return descriptor
  }

  /// From any thread. A host that has gone is found out by the reader, not here.
  func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object), var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(10)
    writing.lock()
    defer { writing.unlock() }
    data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      var sent = 0
      while sent < buffer.count {
        let count = write(output, buffer.baseAddress! + sent, buffer.count - sent)
        if count > 0 {
          sent += count
        } else if count < 0, errno == EINTR {
          continue
        } else {
          return
        }
      }
    }
  }

  func log(_ message: String) {
    emit(["t": "log", "message": message])
  }

  /// Each line on the main queue, in order; then `end`, once, when the other side has gone.
  func read(each: @escaping ([String: Any]) -> Void, end: @escaping () -> Void) {
    let descriptor = input
    Thread.detachNewThread {
      var buffer = Data()
      var chunk = [UInt8](repeating: 0, count: 65536)
      while true {
        let count = Darwin.read(descriptor, &chunk, chunk.count)
        if count < 0, errno == EINTR { continue }
        if count <= 0 { break }
        buffer.append(chunk, count: count)
        while let newline = buffer.firstIndex(of: 10) {
          let line = buffer.subdata(in: buffer.startIndex..<newline)
          buffer.removeSubrange(buffer.startIndex...newline)
          guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
          DispatchQueue.main.async { each(message) }
        }
      }
      DispatchQueue.main.async { end() }
    }
  }
}
