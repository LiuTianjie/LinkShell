import Foundation
import IOSurface
import LinkShellScreenShim

public enum DesktopMediaIPC {
  public static func data(_ message: [String: Any]) -> Data? {
    guard JSONSerialization.isValidJSONObject(message), let data = try? JSONSerialization.data(withJSONObject: message), data.count <= 262_144 else { return nil }
    return data
  }
  public static func message(_ data: Data) -> [String: Any]? {
    guard data.count <= 262_144 else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }
}

/// Frames cross directly between native processes as IOSurface Mach rights. The kernel's
/// audit trailer identifies the media child; no global surface IDs or pixel copies are used.
public final class DesktopFramePort {
  public let name: String
  private let port: mach_port_t
  private let receiver: Bool
  private let lock = NSLock()
  private var stopped = false
  private var receiving = false

  public init?(name: String = "com.bd.linkshell.frame." + UUID().uuidString, receiver: Bool) {
    self.name = name; self.receiver = receiver
    port = name.withCString { receiver ? ls_screen_listen($0) : ls_screen_connect($0) }
    if port == MACH_PORT_NULL { return nil }
  }
  deinit { stop() }
  public func stop() {
    lock.lock(); defer { lock.unlock() }
    guard !stopped else { return }; stopped = true
    if !receiving { ls_screen_close(port, receiver ? 1 : 0) }
  }
  public func send(_ surface: IOSurface, token: UInt64, metadata: Data) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard !stopped, !receiver, metadata.count <= 1024 else { return false }
    let shared = IOSurfaceCreateMachPort(surface)
    defer { ls_screen_close(shared, 0) }
    return metadata.withUnsafeBytes { ls_screen_send(port, shared, token, $0.baseAddress, UInt32(metadata.count)) != 0 }
  }
  public func receive(child: pid_t, each: @escaping (IOSurface?, UInt64, Data) -> Void) {
    lock.lock()
    guard receiver, !stopped, !receiving else { lock.unlock(); return }
    receiving = true
    lock.unlock()
    // The reader owns the receive right until it exits. A newly opened viewer cannot reuse
    // the numeric port name while this thread is between its stop check and mach_msg.
    Thread.detachNewThread { [self] in
      defer {
        lock.lock(); stopped = true; receiving = false
        ls_screen_close(port, 1)
        lock.unlock()
      }
      var bytes = [UInt8](repeating: 0, count: 1024)
      while true {
        lock.lock(); let finished = stopped; lock.unlock()
        if finished { return }
        var shared: mach_port_t = 0, size: UInt32 = 0
        var token: UInt64 = 0
        let result = ls_screen_receive(port, child, &shared, &token, &bytes, &size)
        if result < 0 { return }
        guard result == 1 else { continue }
        let surface = IOSurfaceLookupFromMachPort(shared)
        ls_screen_close(shared, 0)
        each(surface, token, Data(bytes.prefix(Int(size))))
      }
    }
  }
}

/// Bounded newline control/status transport over inherited pipes; never carries a frame.
public final class DesktopMediaPipe {
  private let output: FileHandle
  private let lock = NSLock()
  private var closed = false
  public init(output: FileHandle) { self.output = output }
  public func send(_ message: [String: Any]) {
    guard var data = DesktopMediaIPC.data(message) else { return }
    data.append(10)
    lock.lock(); defer { lock.unlock() }
    guard !closed else { return }
    do { try output.write(contentsOf: data) } catch { closed = true; try? output.close() }
  }
  public func close() {
    lock.lock(); defer { lock.unlock() }
    guard !closed else { return }; closed = true
    try? output.close()
  }
  public static func read(_ input: FileHandle, each: @escaping ([String: Any]) -> Void, end: @escaping () -> Void) {
    Thread.detachNewThread {
      var buffer = Data()
      var chunk = [UInt8](repeating: 0, count: 65_536)
      while true {
        let count = Darwin.read(input.fileDescriptor, &chunk, chunk.count)
        if count < 0, errno == EINTR { continue }
        if count <= 0 { break }
        buffer.append(chunk, count: count)
        while let newline = buffer.firstIndex(of: 10) {
          let line = buffer.subdata(in: buffer.startIndex..<newline)
          buffer.removeSubrange(buffer.startIndex...newline)
          guard let message = DesktopMediaIPC.message(line) else { end(); return }
          each(message)
        }
        if buffer.count > 262_144 { break }
      }
      end()
    }
  }
}
