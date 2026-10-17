import Foundation

enum DesktopStartup {
  enum Failure: LocalizedError {
    case recovery(Error)
    case start(Error)
    var errorDescription: String? {
      switch self {
      case .recovery(let error): return "服务恢复需要处理：\(error.localizedDescription)"
      case .start(let error): return "后台服务启动失败：\(error.localizedDescription)"
      }
    }
  }
  /// Recover updates first; never replace a running or temporarily unreachable host.
  static func run(command: ([String]) throws -> Data) throws -> DesktopSnapshot {
    let snapshot: DesktopSnapshot
    do {
      let recovered = try command(["desktop", "--action", "recover-update"])
      snapshot = try JSONDecoder().decode(DesktopSnapshot.self, from: recovered)
    } catch { throw Failure.recovery(error) }
    guard snapshot.status == "stopped" else { return snapshot }
    do {
      return try JSONDecoder().decode(DesktopSnapshot.self, from: command(["desktop", "--action", "start"]))
    } catch { throw Failure.start(error) }
  }
}
