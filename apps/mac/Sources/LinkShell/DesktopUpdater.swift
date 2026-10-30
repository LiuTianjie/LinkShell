import AppKit
import Sparkle

/// Sparkle owns signature verification and atomic replacement. The CLI owns host stop/recovery.
@MainActor final class DesktopUpdater: NSObject, SPUUpdaterDelegate {
  private weak var model: DesktopModel?
  private var controller: SPUStandardUpdaterController?
  private var installRequested = false
  private var waiting: (() -> Void)?
  private var preparing = false
  private var prepared = false

  init(model: DesktopModel) { self.model = model; super.init() }

  func start() {
    guard DesktopRuntime.bundled, controller == nil else { return }
    let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    self.controller = controller
    do {
      try controller.updater.start()
      // Our timer performs information-only checks. Host stop happens only right before relaunch.
      controller.updater.automaticallyChecksForUpdates = false
      controller.updater.automaticallyDownloadsUpdates = false
      controller.updater.sendsSystemProfile = false
    } catch { model?.updateMessage = "更新服务未就绪：\(error.localizedDescription)" }
  }

  func check() {
    guard let updater = controller?.updater, updater.canCheckForUpdates, !updater.sessionInProgress else { return }
    model?.checking = true
    model?.updateMessage = "正在检查 App 更新…"
    updater.checkForUpdateInformation()
  }

  func install() {
    if waiting != nil { Task { await prepareHost() }; return }
    guard let controller, controller.updater.canCheckForUpdates, !installRequested else { return }
    installRequested = true
    if !controller.updater.sessionInProgress { prepared = false }
    model?.updateMessage = "正在打开更新窗口…"
    controller.checkForUpdates(nil)
  }

  func recover() async {
    guard DesktopRuntime.bundled else { return }
    do {
      _ = try await Task.detached { try DesktopCommand.run(["desktop", "--action", "recover-update"], timeout: 45) }.value
      model?.recoveryProblem = nil
    } catch { model?.recoveryProblem = "服务恢复需要处理：\(error.localizedDescription)" }
    model?.busy = false
    model?.refresh()
  }

  func allowedChannels(for updater: SPUUpdater) -> Set<String> { model?.updateChannel == "beta" ? ["beta"] : [] }

  func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    model?.latest = item.displayVersionString
    model?.availableAppUpdate = true
    model?.updateMessage = "可更新至 LinkShell \(item.displayVersionString)"
  }
  func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
    model?.availableAppUpdate = false
    model?.updateMessage = "当前已是此通道的最新版本"
  }
  func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
    model?.updateMessage = "正在下载 LinkShell \(item.displayVersionString)（后台服务保持连接）…"
  }
  func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
    model?.updateMessage = "下载完成，点击“Install and Relaunch”即可安装并重启"
  }
  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
    model?.updateMessage = "正在安装，LinkShell 将重新打开…"
  }
  func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
    waiting = installHandler
    Task { await prepareHost() }
    return true
  }

  private func prepareHost() async {
    guard waiting != nil, !preparing else { return }
    preparing = true
    defer { preparing = false }
    model?.busy = true
    model?.updateMessage = "正在安装，LinkShell 将重新打开…"
    do {
      _ = try await Task.detached { try DesktopCommand.run(["desktop", "--action", "prepare-update"], timeout: 45) }.value
      guard let resume = waiting else { await recover(); return }
      waiting = nil; prepared = true
      resume()
    } catch {
      // Sparkle remains postponed; an interrupted CLI may still have stopped the Host.
      let message = "更新已暂停：\(error.localizedDescription)。可点击下载并更新重试。"
      await recover()
      model?.updateMessage = message
    }
  }
  func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
    model?.checking = false
    installRequested = false
    if let error, (error as NSError).code != 1001 { model?.updateMessage = "更新未完成：\(error.localizedDescription)" }
    let needsRecovery = prepared && error != nil
    waiting = nil; prepared = false
    if needsRecovery {
      Task { await recover() }
    } else {
      model?.busy = false
    }
  }
}
