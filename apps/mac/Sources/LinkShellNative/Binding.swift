import AppKit
import Foundation
import LinkShellNativeShim
import ServiceManagement
import Sparkle

// LinkShellNative.node: what Electron's main process needs of LinkShell.app's Swift code —
// permissions, the login item and Sparkle. Values cross as JSON text; callbacks come back on the
// main thread, where Electron's main process runs AppKit.
//
// The remote screen is not here. Chromium inside Electron ships its own libwebrtc with the same
// Objective-C class names as WebRTC.framework (RTCVideoCodecInfo, RTCVideoFrame, …); the runtime
// keeps one class per name, so the framework in this process ends up with Chromium's classes and
// traps. The window receives the screen with Chromium's WebRTC instead (screen-viewer.ts).

// MARK: Node-API helpers

private func arguments(_ env: napi_env?, _ info: napi_callback_info?, _ count: Int) -> [napi_value?] {
  var argc = count
  var argv = [napi_value?](repeating: nil, count: count)
  _ = napi_get_cb_info(env, info, &argc, &argv, nil, nil)
  return argv
}

private func string(_ env: napi_env?, _ value: napi_value?) -> String? {
  var kind = napi_undefined
  guard napi_typeof(env, value, &kind) == 0, kind == napi_string else { return nil }
  var length = 0
  guard napi_get_value_string_utf8(env, value, nil, 0, &length) == 0, length <= 4096 else { return nil }
  var buffer = [CChar](repeating: 0, count: length + 1)
  guard napi_get_value_string_utf8(env, value, &buffer, length + 1, &length) == 0 else { return nil }
  return String(cString: buffer)
}

private func bool(_ env: napi_env?, _ value: napi_value?) -> Bool? {
  var kind = napi_undefined
  guard napi_typeof(env, value, &kind) == 0, kind == napi_boolean else { return nil }
  var result = false
  return napi_get_value_bool(env, value, &result) == 0 ? result : nil
}

private func make(_ env: napi_env?, _ text: String) -> napi_value? {
  var result: napi_value?
  _ = text.withCString { napi_create_string_utf8(env, $0, text.utf8.count, &result) }
  return result
}

private func undefined(_ env: napi_env?) -> napi_value? {
  var result: napi_value?
  _ = napi_get_undefined(env, &result)
  return result
}

/// JSON text for JS (`JSON.parse(...).v`). Never fails: an unrepresentable value is `null`.
private func json(_ value: Any) -> String {
  guard JSONSerialization.isValidJSONObject(["v": value]),
        let data = try? JSONSerialization.data(withJSONObject: ["v": value]) else { return "{\"v\":null}" }
  return String(decoding: data, as: UTF8.self)
}

private func throwError(_ env: napi_env?, _ message: String) -> napi_value? {
  _ = message.withCString { napi_throw_error(env, nil, $0) }
  return nil
}

/// A JS function kept alive and callable from any thread; delivered on the main thread.
final class Callback {
  private var function: napi_threadsafe_function?

  init?(env: napi_env?, function value: napi_value?) {
    var kind = napi_undefined
    guard napi_typeof(env, value, &kind) == 0, kind == napi_function else { return nil }
    var function: napi_threadsafe_function?
    let name = make(env, "linkshell-native")
    let status = napi_create_threadsafe_function(env, value, nil, name, 0, 1, nil, nil, nil, { env, callback, _, data in
      guard let data else { return }
      let text = Unmanaged<NSString>.fromOpaque(data).takeRetainedValue() as String
      guard let env, let callback else { return }
      var global: napi_value?
      _ = napi_get_global(env, &global)
      var argument: napi_value?
      _ = text.withCString { napi_create_string_utf8(env, $0, text.utf8.count, &argument) }
      var result: napi_value?
      var argv: [napi_value?] = [argument]
      _ = napi_call_function(env, global, callback, 1, &argv, &result)
    }, &function)
    guard status == 0, let function else { return nil }
    // A pending callback must not keep Electron from quitting.
    _ = napi_unref_threadsafe_function(env, function)
    self.function = function
  }

  func call(_ value: Any) {
    guard let function else { return }
    let text = Unmanaged.passRetained(json(value) as NSString).toOpaque()
    if napi_call_threadsafe_function(function, text, napi_tsfn_nonblocking) != 0 {
      Unmanaged<NSString>.fromOpaque(text).release()
    }
  }
}

// MARK: Sparkle

/// Sparkle owns signature verification and replacement; the CLI (through main.ts) prepares the Host.
@MainActor final class NativeUpdater: NSObject, SPUUpdaterDelegate {
  static let shared = NativeUpdater()
  private var controller: SPUStandardUpdaterController?
  private var callback: Callback?
  private var channel = "stable"
  private var waiting: (() -> Void)?
  private var prepared = false

  func start(callback: Callback, channel: String) -> Bool {
    self.callback = callback
    self.channel = channel
    guard controller == nil else { return true }
    let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    self.controller = controller
    do {
      try controller.updater.start()
      // Our timer performs information-only checks. Host stop happens only right before relaunch.
      controller.updater.automaticallyChecksForUpdates = false
      controller.updater.automaticallyDownloadsUpdates = false
      controller.updater.sendsSystemProfile = false
      return true
    } catch {
      emit("message", ["message": "更新服务未就绪：\(error.localizedDescription)"])
      return false
    }
  }

  func check() {
    guard let updater = controller?.updater, updater.canCheckForUpdates, !updater.sessionInProgress else { return }
    emit("checking", ["message": "正在检查 App 更新…"])
    updater.checkForUpdateInformation()
  }

  func install() {
    if waiting != nil {
      emit("installing", ["message": "正在确认后台服务停止…"])
      emit("prepare", [:])
      return
    }
    guard let controller, controller.updater.canCheckForUpdates else { return }
    // Sparkle may only be focusing an install whose termination was postponed.
    if !controller.updater.sessionInProgress { prepared = false }
    emit("message", ["message": "正在打开更新窗口…"])
    controller.checkForUpdates(nil)
  }

  func setChannel(_ value: String) { channel = value }
  func preparedHost() {
    // The update may have failed while the CLI was still confirming the Host stopped.
    guard let resume = waiting else { emit("recover", [:]); return }
    waiting = nil; prepared = true
    resume()
  }

  private func emit(_ name: String, _ detail: [String: Any]) { callback?.call(["name": name, "detail": detail]) }

  nonisolated func allowedChannels(for updater: SPUUpdater) -> Set<String> {
    MainActor.assumeIsolated { channel == "beta" ? ["beta"] : [] }
  }
  nonisolated func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    let version = item.displayVersionString
    MainActor.assumeIsolated { emit("available", ["version": version, "message": "可更新至 LinkShell \(version)"]) }
  }
  nonisolated func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
    MainActor.assumeIsolated { emit("current", ["message": "当前已是此通道的最新版本"]) }
  }
  nonisolated func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
    let version = item.displayVersionString
    MainActor.assumeIsolated { emit("message", ["message": "正在下载 LinkShell \(version)（后台服务保持连接）…"]) }
  }
  nonisolated func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
    MainActor.assumeIsolated { emit("message", ["message": "下载完成，点击“Install and Relaunch”即可安装并重启"]) }
  }
  nonisolated func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
    MainActor.assumeIsolated { emit("installing", ["message": "正在安装，LinkShell 将重新打开…"]) }
  }
  nonisolated func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
    MainActor.assumeIsolated {
      waiting = installHandler
      emit("installing", ["message": "正在安装，LinkShell 将重新打开…"])
      // main.ts runs `desktop --action prepare-update`, then calls updaterPrepared().
      emit("prepare", [:])
    }
    return true
  }
  nonisolated func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
    let message = error.flatMap { ($0 as NSError).code == 1001 ? nil : "更新未完成：\($0.localizedDescription)" }
    MainActor.assumeIsolated {
      if let message { emit("message", ["message": message]) }
      emit("finished", [:])
      let recover = prepared && error != nil
      waiting = nil; prepared = false
      if recover { emit("recover", [:]) }
    }
  }
}

// MARK: Exports

private typealias Export = @convention(c) (napi_env?, napi_callback_info?) -> napi_value?

private func define(_ env: napi_env?, _ exports: napi_value?, _ name: String, _ body: Export) {
  var function: napi_value?
  _ = name.withCString { napi_create_function(env, $0, name.utf8.count, body, nil, &function) }
  _ = name.withCString { napi_set_named_property(env, exports, $0, function) }
}

@_cdecl("linkshell_native_init")
public func linkshellNativeInit(_ env: napi_env?, _ exports: napi_value?) -> napi_value? {
  // permissions(): json {recording, control} — what LinkShell (this bundle id) is allowed.
  define(env, exports, "permissions") { env, _ in
    make(env, json(["recording": CGPreflightScreenCaptureAccess(), "control": AXIsProcessTrusted()]))
  }
  define(env, exports, "loginItem") { env, _ in
    let status = SMAppService.mainApp.status
    return make(env, json(["enabled": status == .enabled || status == .requiresApproval, "approval": status == .requiresApproval]))
  }
  // setLoginItem(enabled): "" when done, else why not.
  define(env, exports, "setLoginItem") { env, info in
    let argv = arguments(env, info, 1)
    let enabled = bool(env, argv[0]) ?? false
    do {
      if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      return make(env, "")
    } catch { return make(env, error.localizedDescription) }
  }
  define(env, exports, "openLoginItems") { env, _ in
    SMAppService.openSystemSettingsLoginItems()
    return undefined(env)
  }
  // updaterStart(callback(json), channel): json is {name, detail}.
  define(env, exports, "updaterStart") { env, info in
    let argv = arguments(env, info, 2)
    guard let callback = Callback(env: env, function: argv[0]) else { return throwError(env, "updaterStart: expected a callback") }
    let channel = string(env, argv[1]) ?? "stable"
    let started = MainActor.assumeIsolated { NativeUpdater.shared.start(callback: callback, channel: channel) }
    var result: napi_value?
    _ = napi_get_boolean(env, started, &result)
    return result
  }
  define(env, exports, "updaterCheck") { env, _ in MainActor.assumeIsolated { NativeUpdater.shared.check() }; return undefined(env) }
  define(env, exports, "updaterInstall") { env, _ in MainActor.assumeIsolated { NativeUpdater.shared.install() }; return undefined(env) }
  define(env, exports, "updaterPrepared") { env, _ in MainActor.assumeIsolated { NativeUpdater.shared.preparedHost() }; return undefined(env) }
  define(env, exports, "updaterChannel") { env, info in
    let argv = arguments(env, info, 1)
    if let channel = string(env, argv[0]) { MainActor.assumeIsolated { NativeUpdater.shared.setChannel(channel) } }
    return undefined(env)
  }
  return exports
}
