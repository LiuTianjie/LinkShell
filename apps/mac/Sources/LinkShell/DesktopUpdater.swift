import AppKit
import Sparkle

/// Sparkle owns signature verification and atomic replacement. The CLI owns host stop/recovery.
@MainActor final class DesktopUpdater: NSObject, SPUUpdaterDelegate {
  private weak var model: DesktopModel?
  private var controller: SPUStandardUpdaterController?
  private var installRequested = false
  private var installing = false

  init(model: DesktopModel) { self.model = model; super.init() }

  func start() {
    guard DesktopRuntime.bundled, controller == nil else { return }
    let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    self.controller = controller
    do {
      try controller.updater.start()
      // Our timer performs information-only checks. Installation always goes through prepare-update.
      controller.updater.automaticallyChecksForUpdates = false
      controller.updater.automaticallyDownloadsUpdates = false
      controller.updater.sendsSystemProfile = false
    } catch { model?.updateMessage = "更新服务未就绪：\(error.localizedDescription)" }
  }

  func check() {
    guard let updater = controller?.updater, updater.canCheckForUpdates else { return }
    model?.checking = true
    model?.updateMessage = "正在检查 App 更新…"
    updater.checkForUpdateInformation()
  }

  func install() {
    guard let controller, controller.updater.canCheckForUpdates, !installRequested else { return }
    installRequested = true; installing = false
    model?.busy = true; model?.updateMessage = "正在准备更新…"
    Task {
      do {
        _ = try await Task.detached { try DesktopCommand.run(["desktop", "--action", "prepare-update"], timeout: 45) }.value
        controller.checkForUpdates(nil)
      } catch {
        installRequested = false
        model?.busy = false
        model?.updateMessage = "更新已暂停：\(error.localizedDescription)"
        await recover()
      }
    }
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
  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
    installing = true
    model?.updateMessage = "正在安装，LinkShell 将重新打开…"
  }
  func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
    model?.checking = false
    if let error, (error as NSError).code != 1001 { model?.updateMessage = "更新未完成：\(error.localizedDescription)" }
    if installRequested && !installing {
      installRequested = false
      Task { await recover() }
    }
  }
}
