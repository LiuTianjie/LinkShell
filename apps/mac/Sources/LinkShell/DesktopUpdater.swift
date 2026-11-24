import AppKit
import Sparkle

/// Headless Sparkle user driver for the native macOS host dashboard: once the user confirms
/// update, download, extraction, Host preparation and relaunch proceed without a second prompt.
@MainActor private final class DirectDesktopUserDriver: NSObject, SPUUserDriver {
  private weak var model: DesktopModel?
  private var activeVersion = ""
  private var expectedBytes: UInt64 = 0
  private var receivedBytes: UInt64 = 0
  private var lastProgressEmit = Date.distantPast

  init(model: DesktopModel?) {
    self.model = model
    super.init()
  }

  private func resetProgress() {
    expectedBytes = 0
    receivedBytes = 0
    lastProgressEmit = .distantPast
  }

  func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
    reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false))
  }

  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
    model?.updateMessage = "正在准备更新…"
  }

  func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
    if appcastItem.isInformationOnlyUpdate {
      if let url = appcastItem.infoURL, url.scheme?.lowercased() == "https" {
        NSWorkspace.shared.open(url)
      }
      model?.updateMessage = "此版本需要在浏览器中手动下载安装"
      reply(.dismiss)
      return
    }
    activeVersion = appcastItem.displayVersionString
    resetProgress()
    model?.updateMessage = "正在下载 LinkShell \(activeVersion)（后台服务保持连接）…"
    reply(.install)
  }

  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}

  func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
    resetProgress()
    model?.availableAppUpdate = false
    model?.updateMessage = "当前已是此通道的最新版本"
    acknowledgement()
  }

  func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
    resetProgress()
    acknowledgement()
  }

  func showDownloadInitiated(cancellation: @escaping () -> Void) { resetProgress() }
  func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { expectedBytes = expectedContentLength }

  func showDownloadDidReceiveData(ofLength length: UInt64) {
    receivedBytes &+= length
    guard expectedBytes > 0 else { return }
    let now = Date()
    let percent = min(100, Int((receivedBytes * 100) / expectedBytes))
    guard percent == 100 || now.timeIntervalSince(lastProgressEmit) >= 0.2 else { return }
    lastProgressEmit = now
    let version = activeVersion.isEmpty ? "" : " \(activeVersion)"
    model?.updateMessage = "正在下载 LinkShell\(version)… \(percent)%（后台服务保持连接）"
  }

  func showDownloadDidStartExtractingUpdate() {
    lastProgressEmit = .distantPast
    let version = activeVersion.isEmpty ? "" : " \(activeVersion)"
    model?.updateMessage = "正在解压并校验 LinkShell\(version)…"
  }

  func showExtractionReceivedProgress(_ progress: Double) {
    let now = Date()
    let percent = min(100, max(0, Int((progress * 100).rounded())))
    guard percent == 100 || now.timeIntervalSince(lastProgressEmit) >= 0.2 else { return }
    lastProgressEmit = now
    let version = activeVersion.isEmpty ? "" : " \(activeVersion)"
    model?.updateMessage = "正在解压并校验 LinkShell\(version)… \(percent)%"
  }

  func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    model?.updateMessage = "下载完成，正在准备安装并重启…"
    reply(.install)
  }

  func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
    model?.updateMessage = "正在安装，LinkShell 将重新打开…"
  }

  func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
    resetProgress()
    acknowledgement()
  }

  func dismissUpdateInstallation() { resetProgress() }
  func showUpdateInFocus() {}
}

/// Sparkle owns signature verification and atomic replacement. The CLI owns host stop/recovery.
@MainActor final class DesktopUpdater: NSObject, SPUUpdaterDelegate {
  private weak var model: DesktopModel?
  private var updater: SPUUpdater?
  private var userDriver: DirectDesktopUserDriver?
  private var installRequested = false
  private var waiting: (() -> Void)?
  private var preparing = false
  private var prepared = false

  init(model: DesktopModel) { self.model = model; super.init() }

  func start() {
    guard DesktopRuntime.bundled, updater == nil else { return }
    let driver = DirectDesktopUserDriver(model: model)
    let updater = SPUUpdater(
      hostBundle: Bundle.main,
      applicationBundle: Bundle.main,
      userDriver: driver,
      delegate: self
    )
    self.userDriver = driver
    self.updater = updater
    do {
      try updater.start()
      // Our timer/foreground checks perform information-only checks. Host stop happens only right before relaunch.
      updater.automaticallyChecksForUpdates = false
      updater.automaticallyDownloadsUpdates = false
      updater.sendsSystemProfile = false
    } catch {
      self.updater = nil
      self.userDriver = nil
      model?.updateMessage = "更新服务未就绪：\(error.localizedDescription)"
    }
  }

  func check() {
    guard let updater, updater.canCheckForUpdates, !updater.sessionInProgress else { return }
    model?.checking = true
    model?.updateMessage = "正在检查 App 更新…"
    updater.checkForUpdateInformation()
  }

  func install() {
    if waiting != nil { Task { await prepareHost() }; return }
    guard let updater, updater.canCheckForUpdates, !updater.sessionInProgress, !installRequested else { return }
    installRequested = true
    prepared = false
    model?.updateMessage = "正在准备更新…"
    updater.checkForUpdates()
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
    model?.updateMessage = "下载完成，正在准备安装并重启…"
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
      let message = "更新已暂停：\(error.localizedDescription)。可点击更新并重启重试。"
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
