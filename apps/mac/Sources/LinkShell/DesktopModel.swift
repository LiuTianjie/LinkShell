import AppKit
import Foundation
import SwiftUI

struct DesktopSession: Decodable, Identifiable {
  let id: String
  let agent: String
  let title: String?
  let cwd: String
  let state: String
  let pendingPermissions: Int
  let updatedAt: Double
  var name: String { title?.isEmpty == false ? title! : URL(fileURLWithPath: cwd).lastPathComponent }
  var label: String {
    if pendingPermissions > 0 { return "等待确认" }
    return ["running": "运行中", "waiting": "等待输入", "idle": "空闲", "error": "异常", "offline": "离线", "unknown": "未知"][state] ?? "未知"
  }
}
struct DesktopDevice: Decodable, Identifiable {
  let id: String
  let name: String
  let online: Bool
}
struct DesktopSnapshot: Decodable {
  struct Machine: Decodable { let hostname: String; let hostVersion: String }
  struct Gateway: Decodable {
    struct Problem: Decodable { let message: String }
    let status: String
    let url: String?
    let devices: [DesktopDevice]
    let error: Problem?
  }
  struct Account: Decodable { let state: String; let email: String?; let userId: String? }
  let account: Account?
  let status: String
  let cliVersion: String?
  let source: String?
  let hostOwner: String?
  let appBundle: String?
  let home: String?
  let executable: String?
  let machine: Machine?
  let gateway: Gateway?
  let sessions: [DesktopSession]?
  let hasMoreSessions: Bool?
  let error: String?
}

/// No shell interpolation of paths or user text. Login-shell lookup is only a fallback for Finder.
final class DesktopCommandControl: @unchecked Sendable {
  private let lock = NSLock()
  private var process: Process?
  private var cancelled = false
  func start(_ task: Process) throws {
    lock.lock(); defer { lock.unlock() }
    guard !cancelled else { throw CancellationError() }
    try task.run(); process = task
  }
  func cancel() {
    lock.lock(); defer { lock.unlock() }
    cancelled = true
    if let process, process.isRunning { process.terminate() }
  }
}

enum DesktopCommand {
  static func run(_ arguments: [String], timeout: Double = 20, control: DesktopCommandControl? = nil) throws -> Data {
    let task = Process()
    var env = ProcessInfo.processInfo.environment
    env["LINKSHELL_HOME"] = DesktopRuntime.home
    if let path = Launch.value(after: "--cli-path"), !path.isEmpty { env["PATH"] = path }
    task.environment = env
    if DesktopRuntime.bundled {
      env["LINKSHELL_APP_BUNDLE"] = Bundle.main.bundlePath
      task.environment = env
      task.executableURL = URL(fileURLWithPath: DesktopRuntime.node)
      task.arguments = [DesktopRuntime.cli] + arguments
    } else if let node = Launch.value(after: "--cli-node"), let script = Launch.value(after: "--cli-script") {
      task.executableURL = URL(fileURLWithPath: node)
      task.arguments = Launch.values(after: "--cli-arg") + [script] + arguments
    } else {
      task.executableURL = URL(fileURLWithPath: "/bin/zsh")
      task.arguments = ["-lc", "exec linkshell \"$@\"", "linkshell-desktop"] + arguments
    }
    let output = Pipe()
    task.standardOutput = output
    task.standardError = FileHandle.nullDevice
    task.standardInput = FileHandle.nullDevice
    if let control { try control.start(task) } else { try task.run() }
    let deadline = DispatchWorkItem {
      if task.isRunning { task.terminate() }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
    let data = output.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    deadline.cancel()
    guard task.terminationStatus == 0 else {
      if let snapshot = try? JSONDecoder().decode(DesktopSnapshot.self, from: data), let error = snapshot.error {
        throw NSError(domain: "LinkShell", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
      }
      throw NSError(domain: "LinkShell", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "无法运行 CLI。请确认已安装新版 LinkShell，或从终端执行 linkshell app。"])
    }
    return data
  }
}

@MainActor final class DesktopModel: ObservableObject {
  @Published var snapshot: DesktopSnapshot?
  @Published var problem: String?
  @Published var recoveryProblem: String?
  @Published var busy = false
  @Published var checking = false
  @Published var signingIn = false
  @Published var accountMessage = ""
  private var loginControl: DesktopCommandControl?
  private var loginCancelled = false
  @Published var recording = false
  @Published var control = false
  @Published var permissionsKnown = false
  @Published var availableAppUpdate = false
  @Published var commandMessage = ""
  @Published var updateChannel = UserDefaults.standard.string(forKey: "desktop.updateChannel") ?? "stable" {
    didSet { UserDefaults.standard.set(updateChannel, forKey: "desktop.updateChannel"); availableAppUpdate = false; updateMessage = "通道已切换，检查更新后生效" }
  }
  lazy var appUpdater = DesktopUpdater(model: self)
  @Published var latest: String?
  @Published var updateMessage = "尚未检查更新"
  @Published var log = ""
  @Published var activity: [(Date, String)] = []
  @Published var selected = "总览"
  @Published var selectedSession: DesktopSession?
  @Published var autoCheck = UserDefaults.standard.object(forKey: "desktop.autoCheck") as? Bool ?? true {
    didSet { UserDefaults.standard.set(autoCheck, forKey: "desktop.autoCheck") }
  }
  private var polling = false
  private var timer: Timer?
  private var lastUpdateCheck = Date.distantPast
  let preview = Launch.has("--dashboard-preview")
  var sessions: [DesktopSession] { snapshot?.sessions ?? [] }
  var devices: [DesktopDevice] { snapshot?.gateway?.devices ?? [] }
  var online: Int { devices.filter(\.online).count }
  var running: Int { sessions.filter { $0.state == "running" }.count }
  var pending: Int { sessions.reduce(0) { $0 + $1.pendingPermissions } }
  var healthy: Bool { snapshot?.status == "running" && problem == nil }
  var serviceLabel: String {
    if problem != nil { return "状态未知" }
    return ["running": "运行中", "stopped": "已停止", "unreachable": "无法连接"][snapshot?.status ?? ""] ?? "正在连接"
  }
  var gatewayLabel: String {
    guard healthy else { return "未知" }
    return ["online": "已连接", "connecting": "连接中", "offline": "已断开", "off": "未启用"][snapshot?.gateway?.status ?? ""] ?? "未知"
  }
  var signedIn: Bool { snapshot?.account?.state == "signed-in" }
  var accountLabel: String { snapshot?.account?.email ?? snapshot?.account?.userId ?? "未登录" }
  var home: String { snapshot?.home ?? DesktopRuntime.home }
  var standalone: Bool { DesktopRuntime.bundled }
  var externalHost: Bool { standalone && healthy && snapshot?.hostOwner != Bundle.main.bundlePath }
  var newVersion: Bool {
    if standalone { return availableAppUpdate }
    guard let latest, let current = snapshot?.cliVersion else { return false }
    return latest.compare(current, options: .numeric) == .orderedDescending
  }


  func start() {
    if preview {
      let json = #"{"status":"running","cliVersion":"0.10.42","source":"npm","machine":{"hostname":"这台 Mac","hostVersion":"0.10.42"},"gateway":{"status":"online","devices":[{"id":"preview","name":"我的 iPhone","online":true}]},"sessions":[{"id":"one","agent":"codex","title":"登录流程","cwd":"/Projects/LinkShell","state":"running","pendingPermissions":0,"updatedAt":0},{"id":"two","agent":"claude","title":"发布检查","cwd":"/Projects/LinkShell","state":"waiting","pendingPermissions":1,"updatedAt":0},{"id":"three","agent":"codex","title":"项目文档","cwd":"/Projects/LinkShell","state":"idle","pendingPermissions":0,"updatedAt":0}]}"#
      snapshot = try? JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8))
      recording = true; control = true; permissionsKnown = true
      activity = [(Date(), "手机已连接"), (Date().addingTimeInterval(-240), "本机服务已连接")]
      return
    }
    if standalone {
      appUpdater.start()
      busy = true
      Task { await appUpdater.recover() }
    } else { refresh() }
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
  }

  func refresh() {
    guard !preview, !polling, !busy else { return }
    polling = true
    Task {
      do {
        let data = try await Task.detached { try DesktopCommand.run(["desktop"]) }.value
        let next = try JSONDecoder().decode(DesktopSnapshot.self, from: data)
        if next.status != snapshot?.status { event(next.status == "running" ? "本机服务已连接" : "本机服务：\(next.status == "stopped" ? "已停止" : "无法连接")") }
        if let before = snapshot?.gateway?.status, before != next.gateway?.status { event("网关连接状态已变化") }
        snapshot = next; problem = next.error ?? recoveryProblem
        let allowed = await Task.detached { (Permissions.recording(), Permissions.trusted()) }.value
        recording = allowed.0; control = allowed.1; permissionsKnown = true
      } catch {
        snapshot = nil
        problem = error.localizedDescription
      }
      polling = false
      if autoCheck && Date().timeIntervalSince(lastUpdateCheck) > 21600 { checkUpdates() }
      if selected == "日志" { readLog() }
    }
  }

  func event(_ text: String) { activity.insert((Date(), text), at: 0); activity = Array(activity.prefix(20)) }

  func action(_ action: String) {
    guard !preview, !busy else { return }
    busy = true; problem = nil
    Task {
      do {
        _ = try await Task.detached { try DesktopCommand.run(["desktop", "--action", action], timeout: 45) }.value
        event(["start": "已启动本机服务", "stop": "已停止本机服务", "restart": "已重启本机服务"][action] ?? action)
      } catch { problem = error.localizedDescription }
      busy = false; refresh()
    }
  }

  func checkUpdates() {
    guard !checking, !preview else { return }
    lastUpdateCheck = Date()
    if standalone { appUpdater.check(); return }
    checking = true; updateMessage = "正在检查…"
    Task {
      defer { checking = false }
      do {
        var request = URLRequest(url: URL(string: "https://registry.npmjs.org/linkshell-cli/latest")!)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = body["version"] as? String else { throw URLError(.badServerResponse) }
        latest = version
        updateMessage = snapshot?.cliVersion == nil ? "最新稳定版 \(version)；当前 CLI 版本未知" : (newVersion ? "有新版本 \(version)" : "当前已是最新稳定版")
      } catch { updateMessage = "检查失败：\(error.localizedDescription)" }
    }
  }

  func upgrade() {
    guard !busy, !preview else { return }
    if standalone { appUpdater.install(); return }
    busy = true; updateMessage = "正在更新 CLI 和 Host…"
    Task {
      do {
        _ = try await Task.detached { try DesktopCommand.run(["upgrade"], timeout: 240) }.value
        updateMessage = "更新完成。重新打开 LinkShell 可加载新版界面。"
        event("CLI 更新完成")
      } catch { updateMessage = "更新未完成，请在终端运行 linkshell upgrade 查看详情。" }
      busy = false; refresh()
    }
  }

  func login() {
    guard !preview, !busy else { return }
    busy = true; signingIn = true; loginCancelled = false
    accountMessage = "请在浏览器中完成登录，完成后会自动返回账号状态。"
    let control = DesktopCommandControl(); loginControl = control
    Task {
      do {
        let data = try await Task.detached { try DesktopCommand.run(["desktop", "--action", "login"], timeout: 350, control: control) }.value
        snapshot = try JSONDecoder().decode(DesktopSnapshot.self, from: data)
        accountMessage = "登录成功。手机登录同一账号后，可通过官方网关连接这台 Mac（需要 Pro）。"
        event("账号已登录")
      } catch { accountMessage = loginCancelled ? "已取消登录" : error.localizedDescription }
      signingIn = false; busy = false; loginControl = nil; refresh()
    }
  }

  func cancelLogin() { loginCancelled = true; loginControl?.cancel() }

  func accountAction(_ action: String) {
    guard !preview, !busy else { return }
    busy = true; accountMessage = "正在处理…"
    Task {
      do {
        let data = try await Task.detached { try DesktopCommand.run(["desktop", "--action", action], timeout: 60) }.value
        snapshot = try JSONDecoder().decode(DesktopSnapshot.self, from: data)
        accountMessage = action == "logout" ? "已退出当前电脑的账号。" : "已应用官方网关设置，请查看连接状态。"
      } catch { accountMessage = error.localizedDescription }
      busy = false; refresh()
    }
  }

  func installCommand() {
    do { commandMessage = "已安装：\(try DesktopRuntime.installCommand())。请将 ~/.local/bin 加入 PATH。" }
    catch { commandMessage = error.localizedDescription }
  }

  func readLog() {
    guard !preview else { return }
    let path = home + "/host.log"
    Task {
      let text = await Task.detached { () -> String in
        guard let file = FileHandle(forReadingAtPath: path) else { return "暂无日志。启动服务后，这里会显示 Host 日志。" }
        defer { try? file.close() }
        let length = (try? file.seekToEnd()) ?? 0
        try? file.seek(toOffset: length > 65536 ? length - 65536 : 0)
        return String(decoding: (try? file.readToEnd()) ?? Data(), as: UTF8.self)
      }.value
      log = text
    }
  }

  func permissions() {
    guard !preview else { return }
    let task = Process(); task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = ["-n", "-a", Bundle.main.bundlePath, "--args", "--setup"]
    try? task.run()
  }
}
