import AVFoundation
import ExpoModulesCore
import Speech
import UIKit
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Strict non-reentrant FIFO queue so ActivityKit calls never race across suspension points.
private actor LiveActivitySerialQueue {
  private var tail: Task<Void, Never>?

  func enqueue<T: Sendable>(_ operation: @escaping @MainActor () async -> T) async -> T {
    let previous = tail
    let job = Task<T, Never> { @MainActor in
      await previous?.value
      return await operation()
    }
    tail = Task { _ = await job.value }
    return await job.value
  }
}

private struct LiveActivitySyncInput: Sendable {
  let active: Bool
  let online: Bool
  let computerKey: String?
  let computerName: String
  let phase: String
  let title: String
  let subtitle: String
  let project: String
  let agent: String
  let agents: [String]?
  let actionsData: Data?
  let hasMoreActions: Bool?
  let tasksData: Data?
  let noticeId: String?
  let waitingCount: Int
  let runningCount: Int
  let failedCount: Int
  let deepLink: String

  init(payload: [String: Any]) {
    let rawKey = (payload["computerKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.active = (payload["active"] as? Bool) ?? false
    self.online = (payload["online"] as? Bool) ?? false
    self.computerKey = (rawKey?.isEmpty == false) ? rawKey : nil
    self.computerName = (payload["computerName"] as? String) ?? "电脑"
    self.phase = (payload["phase"] as? String) ?? "running"
    self.title = (payload["title"] as? String) ?? "会话进行中"
    self.subtitle = (payload["subtitle"] as? String) ?? ""
    self.project = (payload["project"] as? String) ?? ""
    self.agent = (payload["agent"] as? String) ?? "claude"
    self.agents = payload["agents"] as? [String]
    self.actionsData = (payload["actions"] as? [[String: Any]]).flatMap {
      try? JSONSerialization.data(withJSONObject: $0)
    }
    self.hasMoreActions = payload["hasMoreActions"] as? Bool
    self.tasksData = (payload["tasks"] as? [[String: Any]]).flatMap {
      try? JSONSerialization.data(withJSONObject: $0)
    }
    self.noticeId = payload["noticeId"] as? String
    self.waitingCount = (payload["waitingCount"] as? Int) ?? 0
    self.runningCount = (payload["runningCount"] as? Int) ?? 0
    self.failedCount = (payload["failedCount"] as? Int) ?? 0
    self.deepLink = (payload["deepLink"] as? String) ?? "linkshell:///"
  }
}

public class LinkLayoutModule: Module {
  private weak var presentationScene: UIWindowScene?
  private var previousOrientation: UIInterfaceOrientation?

  // Native iOS speech recognition state (lazy initialized only when recording starts).
  private var audioEngine: AVAudioEngine?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var speechRecognizer: SFSpeechRecognizer?
  private var speechGeneration = 0
  private var lastLevelSentAt: TimeInterval = 0
  private var simulatorWaveTimer: Timer?
  private var activeActivityId: String?
  private let activityQueue = LiveActivitySerialQueue()
  private var activityUpdatesTask: Task<Void, Never>?
  private var pushTokenTasks: [String: Task<Void, Never>] = [:]
  private var pushToStartTask: Task<Void, Never>?
  private var activityStateTasks: [String: Task<Void, Never>] = [:]
  private var activityActionObserver: NSObjectProtocol?
  private var localNotificationObserver: NSObjectProtocol?
  private var watchCommandObserver: NSObjectProtocol?
  private var watchStatusObserver: NSObjectProtocol?
  private var lanDiscovery: LanDiscoveryIOS?
  private var pushRegistrationBackgroundTask: UIBackgroundTaskIdentifier = .invalid
  private lazy var speechSynthesizer = AVSpeechSynthesizer()

  public func definition() -> ModuleDefinition {
    Name("LinkLayout")
    Events("onSpeechResult", "onSpeechLevel", "onSpeechError", "onLiveActivityAction", "onLiveActivityPushToken", "onLiveActivityPushToStartToken", "onNotificationAction", "onLanHosts", "onWatchCommand", "onWatchStatus")
    OnCreate { [weak self] in
      WatchSessionBridge.shared.start()
      Task { @MainActor [weak self] in
        LocalApprovalNotifications.shared.install()
        self?.observeExistingActivities()
      }
      self?.activityActionObserver = NotificationCenter.default.addObserver(forName: LiveActivityActionQueue.notification, object: nil, queue: .main) { [weak self] notification in
        if let id = notification.userInfo?["id"] as? String { self?.sendEvent("onLiveActivityAction", ["id": id]) }
      }
      self?.localNotificationObserver = NotificationCenter.default.addObserver(forName: LocalNotificationActionQueue.notification, object: nil, queue: .main) { [weak self] notification in
        if let id = notification.userInfo?["id"] as? String { self?.sendEvent("onNotificationAction", ["id": id]) }
      }
      self?.watchCommandObserver = NotificationCenter.default.addObserver(forName: WatchCommandQueue.notification, object: nil, queue: .main) { [weak self] notification in
        if let id = notification.userInfo?["id"] as? String { self?.sendEvent("onWatchCommand", ["id": id]) }
      }
      self?.watchStatusObserver = NotificationCenter.default.addObserver(forName: WatchCommandQueue.statusNotification, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onWatchStatus", WatchSessionBridge.shared.status())
      }
    }
    OnDestroy { [weak self] in
      self?.lanDiscovery?.stop()
      self?.lanDiscovery = nil
      if let self {
        Task { @MainActor in
          self.activityUpdatesTask?.cancel()
          self.activityUpdatesTask = nil
          self.pushToStartTask?.cancel()
          self.pushToStartTask = nil
          self.pushTokenTasks.values.forEach { $0.cancel() }
          self.activityStateTasks.values.forEach { $0.cancel() }
          self.pushTokenTasks.removeAll()
          self.activityStateTasks.removeAll()
          self.endPushRegistrationTask()
          if self.speechSynthesizer.isSpeaking {
            self.speechSynthesizer.stopSpeaking(at: .immediate)
          }
        }
      }
      if let observer = self?.activityActionObserver { NotificationCenter.default.removeObserver(observer) }
      if let observer = self?.localNotificationObserver { NotificationCenter.default.removeObserver(observer) }
      if let observer = self?.watchCommandObserver { NotificationCenter.default.removeObserver(observer) }
      if let observer = self?.watchStatusObserver { NotificationCenter.default.removeObserver(observer) }
    }
    Constants([
      "liveActivityPushURL": Self.pushServiceURL,
      "viewControllerStatusBarAppearance": Bundle.main.object(forInfoDictionaryKey: "UIViewControllerBasedStatusBarAppearance") as? Bool ?? true
    ])
    AsyncFunction("requestLandscape") { [weak self] in
      guard let self, let scene = self.appContext?.utilities?.currentViewController()?.view.window?.windowScene else { return }
      // Keep the interface orientation, not the device sensor (which may be locked or flat).
      if self.previousOrientation == nil {
        self.previousOrientation = scene.interfaceOrientation
        self.presentationScene = scene
      }
      // Request the initial wide presentation without restricting later device rotations.
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscape))
    }.runOnQueue(.main)
    AsyncFunction("clearOrientationRequest") { [weak self] in
      guard let self, let orientation = self.previousOrientation else { return }
      let scene = self.presentationScene
      self.previousOrientation = nil
      self.presentationScene = nil
      let mask: UIInterfaceOrientationMask
      switch orientation {
      case .portrait: mask = .portrait
      case .portraitUpsideDown: mask = .portraitUpsideDown
      case .landscapeLeft: mask = .landscapeLeft
      case .landscapeRight: mask = .landscapeRight
      default: return
      }
      // Removing a lock does not rotate UIKit back; restore once without imposing a lock.
      scene?.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
    }.runOnQueue(.main)

    AsyncFunction("startSpeech") { [weak self] (localeId: String?, promise: Promise) in
      guard let self else {
        promise.resolve(["ok": false, "reason": "模块已卸载"])
        return
      }
      self.startNativeSpeech(localeId: localeId, promise: promise)
    }

    AsyncFunction("stopSpeech") { [weak self] in
      self?.stopNativeSpeech(cancel: false)
    }.runOnQueue(.main)

    AsyncFunction("cancelSpeech") { [weak self] in
      self?.stopNativeSpeech(cancel: true)
    }.runOnQueue(.main)

    AsyncFunction("speakText") { [weak self] (text: String, localeId: String?) in
      guard let self else { return }
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return }
      if self.speechSynthesizer.isSpeaking {
        self.speechSynthesizer.stopSpeaking(at: .immediate)
      }
      if self.audioEngine?.isRunning != true {
        try? AVAudioSession.sharedInstance().setCategory(
          .playback,
          mode: .spokenAudio,
          options: [.duckOthers, .mixWithOthers]
        )
        try? AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
      }
      let utterance = AVSpeechUtterance(string: trimmed)
      let lang = localeId ?? Locale.preferredLanguages.first ?? "zh-CN"
      utterance.voice = AVSpeechSynthesisVoice(language: lang)
        ?? AVSpeechSynthesisVoice(language: "zh-CN")
        ?? AVSpeechSynthesisVoice(language: "en-US")
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate
      self.speechSynthesizer.speak(utterance)
    }.runOnQueue(.main)

    AsyncFunction("stopSpeaking") { [weak self] in
      guard let self else { return }
      if self.speechSynthesizer.isSpeaking {
        self.speechSynthesizer.stopSpeaking(at: .immediate)
      }
    }.runOnQueue(.main)

    AsyncFunction("setShortcutItems") { (items: [[String: String]]) in
      let shortcuts = items.compactMap { item -> UIApplicationShortcutItem? in
        guard let id = item["id"], let title = item["title"], let href = item["href"] else { return nil }
        let iconName = item["icon"] ?? "bubble.left.and.text.bubble.right"
        let icon = UIApplicationShortcutIcon(systemImageName: iconName)
        return UIApplicationShortcutItem(
          type: id,
          localizedTitle: title,
          localizedSubtitle: item["subtitle"],
          icon: icon,
          userInfo: ["href": href as NSSecureCoding]
        )
      }
      UIApplication.shared.shortcutItems = shortcuts
    }.runOnQueue(.main)

    AsyncFunction("isLiveActivityAvailable") { () -> Bool in
      #if canImport(ActivityKit)
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      #endif
      return false
    }

    AsyncFunction("syncLiveActivity") { [weak self] (payload: [String: Any]) -> Bool in
      guard let self else { return false }
      return await self.syncNativeLiveActivity(payload: payload)
    }

    AsyncFunction("endLiveActivity") { [weak self] in
      guard let self else { return }
      await self.endNativeLiveActivity()
    }

    AsyncFunction("consumeLiveActivityAction") { (id: String) -> [String: Any]? in
      guard let action = LiveActivityActionQueue.consume(id),
            let data = try? JSONEncoder().encode(action) else { return nil }
      return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }.runOnQueue(.main)

    AsyncFunction("getLiveActivityPushRegistration") { () async -> [String: String]? in
      await self.liveActivityPushRegistrations().first
    }
    AsyncFunction("getLiveActivityPushRegistrations") { () async -> [[String: String]] in
      await self.liveActivityPushRegistrations()
    }
    AsyncFunction("getLiveActivityPushToStartToken") { () async -> String? in
      await self.liveActivityPushToStartToken()
    }
    AsyncFunction("setLiveActivityPushReady") { (id: String) async in
      await MainActor.run {
        if #available(iOS 16.2, *), Activity<LinkShellAttentionAttributes>.activities.contains(where: { $0.id == id && ($0.activityState == .active || $0.activityState == .stale) }) {
          UserDefaults.standard.set(true, forKey: "LinkShellLiveActivity.remote." + id)
          self.endPushRegistrationTask()
        }
      }
    }

    AsyncFunction("pendingLiveActivityActionId") { () -> String? in
      LiveActivityActionQueue.pendingID()
    }.runOnQueue(.main)

    AsyncFunction("getWatchStatus") { () -> [String: Any] in
      WatchSessionBridge.shared.start()
      return WatchSessionBridge.shared.status()
    }.runOnQueue(.main)

    AsyncFunction("syncWatchSnapshot") { (payload: [String: Any]) -> Bool in
      WatchSessionBridge.shared.syncSnapshot(payload: payload)
    }.runOnQueue(.main)

    AsyncFunction("pendingWatchCommandId") { () -> String? in
      WatchCommandQueue.pendingID()
    }.runOnQueue(.main)

    AsyncFunction("consumeWatchCommand") { (id: String) -> [String: Any]? in
      WatchCommandQueue.consume(id)
    }.runOnQueue(.main)

    AsyncFunction("completeWatchCommand") { (id: String, ok: Bool, message: String?) in
      WatchCommandQueue.complete(id, ok: ok, message: message)
    }.runOnQueue(.main)

    AsyncFunction("pendingNotificationActionId") { () -> String? in
      LocalNotificationActionQueue.shared.pendingId()
    }.runOnQueue(.main)

    AsyncFunction("consumeNotificationAction") { (id: String) -> [String: Any]? in
      LocalNotificationActionQueue.shared.consume(id: id)
    }.runOnQueue(.main)

    AsyncFunction("syncLocalApprovalNotification") { (payload: [String: Any], promise: Promise) in
      LocalApprovalNotifications.shared.sync(payload: payload) { ok in
        promise.resolve(ok)
      }
    }

    AsyncFunction("cancelLocalApprovalNotification") { (id: String) in
      LocalApprovalNotifications.shared.cancel(id: id)
    }

    AsyncFunction("startLanDiscovery") { [weak self] () -> Bool in
      guard let self else { return false }
      let discovery: LanDiscoveryIOS
      if let existing = self.lanDiscovery {
        discovery = existing
      } else {
        let created = LanDiscoveryIOS()
        created.onHostsChanged = { [weak self] hosts in
          self?.sendEvent("onLanHosts", ["hosts": hosts])
        }
        self.lanDiscovery = created
        discovery = created
      }
      return discovery.start()
    }.runOnQueue(.main)

    AsyncFunction("stopLanDiscovery") { [weak self] in
      self?.lanDiscovery?.stop()
    }.runOnQueue(.main)

    AsyncFunction("getLanHosts") { [weak self] () -> [[String: Any]] in
      self?.lanDiscovery?.currentHosts() ?? []
    }.runOnQueue(.main)

    View(LinkLayoutView.self) {
      Events("onMetrics")
      Prop("revision") { (view: LinkLayoutView, revision: String) in view.updateRevision(revision) }
    }
  }

  private func startNativeSpeech(localeId: String?, promise: Promise) {
    SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
      guard let self else { return }
      #if !targetEnvironment(simulator)
      guard authStatus == .authorized else {
        promise.resolve(["ok": false, "reason": "请在系统设置中允许 LinkShell 使用语音识别"])
        return
      }
      #endif
      let requestMic: (@escaping (Bool) -> Void) -> Void = { completion in
        if #available(iOS 17.0, *) {
          AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
          AVAudioSession.sharedInstance().requestRecordPermission(completion)
        }
      }
      requestMic { [weak self] granted in
        DispatchQueue.main.async {
          guard let self else { return }
          #if !targetEnvironment(simulator)
          guard granted else {
            promise.resolve(["ok": false, "reason": "请在系统设置中允许 LinkShell 使用麦克风"])
            return
          }
          #endif
          self.beginAudioAndRecognition(localeId: localeId, promise: promise)
        }
      }
    }
  }

  private func beginAudioAndRecognition(localeId: String?, promise: Promise) {
    stopNativeSpeech(cancel: true)
    let generation = speechGeneration

    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .measurement,
        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .duckOthers]
      )
      // Prefer external / AirPods / headset microphone over the phone's bottom mic.
      if let inputs = session.availableInputs {
        let preferredTypes: [AVAudioSession.Port] = [.bluetoothHFP, .headsetMic, .usbAudio, .carAudio]
        if let match = preferredTypes.lazy.compactMap({ port in inputs.first(where: { $0.portType == port }) }).first {
          try? session.setPreferredInput(match)
        }
      }
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      #if !targetEnvironment(simulator)
      promise.resolve(["ok": false, "reason": error.localizedDescription])
      return
      #endif
    }

    let chosenLocale = Locale(identifier: localeId ?? Locale.preferredLanguages.first ?? "zh-CN")
    let recognizer = SFSpeechRecognizer(locale: chosenLocale) ?? SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) ?? SFSpeechRecognizer()
    self.speechRecognizer = recognizer

    let engine = AVAudioEngine()
    self.audioEngine = engine
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if #available(iOS 16.0, *) {
      request.addsPunctuation = true
    }
    self.recognitionRequest = request

    if let recognizer, recognizer.isAvailable {
      self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
        DispatchQueue.main.async {
          guard let self, self.speechGeneration == generation else { return }
          if let result {
            let text = result.bestTranscription.formattedString
            self.sendEvent("onSpeechResult", [
              "text": text,
              "isFinal": result.isFinal
            ])
          }
          if let error {
            self.sendEvent("onSpeechError", ["message": error.localizedDescription])
          }
        }
      }
    }

    let inputNode = engine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    if format.channelCount > 0 && format.sampleRate > 0 {
      inputNode.removeTap(onBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        guard let self else { return }
        self.recognitionRequest?.append(buffer)
        let now = CACurrentMediaTime()
        guard now - self.lastLevelSentAt >= 0.075 else { return }
        self.lastLevelSentAt = now
        let (db, normalized) = Self.measureLevel(buffer: buffer)
        self.sendEvent("onSpeechLevel", ["db": db, "level": normalized])
      }
      do {
        engine.prepare()
        try engine.start()
      } catch {
        #if !targetEnvironment(simulator)
        stopNativeSpeech(cancel: true)
        promise.resolve(["ok": false, "reason": error.localizedDescription])
        return
        #endif
      }
    }

    #if targetEnvironment(simulator)
    // Simulators often provide zero-amplitude audio buffers; emit a gentle metering wave so UI can be verified.
    simulatorWaveTimer?.invalidate()
    simulatorWaveTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
      guard let self else { return }
      let t = CACurrentMediaTime()
      let level = 0.25 + 0.45 * abs(sin(t * 4.2)) * abs(cos(t * 2.7))
      let db = -45.0 + level * 38.0
      self.sendEvent("onSpeechLevel", ["db": db, "level": level])
    }
    #endif

    promise.resolve(["ok": true])
  }

  private func stopNativeSpeech(cancel: Bool) {
    // finish/cancel may still deliver callbacks after JS starts another session.
    // Retire their identity before asking the old task to stop.
    speechGeneration &+= 1
    simulatorWaveTimer?.invalidate()
    simulatorWaveTimer = nil

    if let engine = audioEngine {
      if engine.isRunning {
        engine.stop()
      }
      engine.inputNode.removeTap(onBus: 0)
    }
    audioEngine = nil

    recognitionRequest?.endAudio()
    recognitionRequest = nil

    if cancel {
      recognitionTask?.cancel()
    } else {
      recognitionTask?.finish()
    }
    recognitionTask = nil

    // Recording has ended; let background music and podcasts resume.
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private static var pushServiceURL: String {
    Bundle.main.object(forInfoDictionaryKey: "LinkShellLiveActivityPushURL") as? String ?? ""
  }

  private static func normalizedComputerKey(_ key: String?) -> String? {
    guard let trimmed = key?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      return nil
    }
    return trimmed
  }

  private static func isRemoteReady(_ activityId: String) -> Bool {
    UserDefaults.standard.bool(forKey: "LinkShellLiveActivity.remote." + activityId)
  }

  @MainActor private func observeExistingActivities() {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      for activity in Activity<LinkShellAttentionAttributes>.activities {
        observeActivityLifecycle(activity)
      }
      observeActivityUpdates()
      Task { [weak self] in
        await self?.reconcileNativeLiveActivities()
      }
    }
    if #available(iOS 17.2, *), !Self.pushServiceURL.isEmpty {
      observePushToStartToken()
    }
    #endif
  }

  #if canImport(ActivityKit)
  @available(iOS 16.2, *)
  @MainActor private func observeActivityUpdates() {
    guard activityUpdatesTask == nil else { return }
    activityUpdatesTask = Task { [weak self] in
      // Catch push-to-start activities created while the app is running or suspended
      // so they are immediately deduplicated, observed, and handed off to JS/Host.
      for await activity in Activity<LinkShellAttentionAttributes>.activityUpdates {
        if Task.isCancelled { break }
        guard let self else { break }
        await self.handleObservedActivity(activity)
      }
    }
  }

  @available(iOS 16.2, *)
  private func handleObservedActivity(_ activity: Activity<LinkShellAttentionAttributes>) async {
    await activityQueue.enqueue { [weak self] in
      guard let self else { return }
      guard activity.activityState == .active || activity.activityState == .stale else { return }
      self.observeActivityLifecycle(activity)
      let key = Self.normalizedComputerKey(activity.attributes.computerKey)
      await self.reconcileActivitiesLocked(preferredActivityId: activity.id, targetComputerKey: key)
      let survived = Activity<LinkShellAttentionAttributes>.activities.contains {
        $0.id == activity.id && ($0.activityState == .active || $0.activityState == .stale)
      }
      guard survived else { return }
      if !Self.pushServiceURL.isEmpty {
        if activity.pushToken != nil && !Self.isRemoteReady(activity.id) {
          self.beginPushRegistrationTask()
        }
        self.sendEvent("onLiveActivityPushToken", ["activityId": activity.id])
      }
    }
  }

  @available(iOS 16.2, *)
  private func reconcileNativeLiveActivities(preferredActivityId: String? = nil, targetComputerKey: String? = nil) async {
    await activityQueue.enqueue { [weak self] in
      guard let self else { return }
      await self.reconcileActivitiesLocked(preferredActivityId: preferredActivityId, targetComputerKey: targetComputerKey)
    }
  }

  @available(iOS 16.2, *)
  @MainActor private func activityRank(
    _ activity: Activity<LinkShellAttentionAttributes>,
    index: Int,
    pushEnabled: Bool,
    preferredActivityId: String?
  ) -> (Int, Int, Int, Int, Int, Int) {
    let stateScore = activity.activityState == .active ? 2 : 1
    let modeScore = (activity.attributes.remoteUpdates ?? false) == pushEnabled ? 1 : 0
    let remoteScore = (pushEnabled && Self.isRemoteReady(activity.id)) ? 1 : 0
    let tokenScore = (pushEnabled && activity.pushToken != nil) ? 1 : 0
    let preferredScore: Int
    if let preferredActivityId, activity.id == preferredActivityId {
      preferredScore = 2
    } else if let activeActivityId, activity.id == activeActivityId {
      preferredScore = 1
    } else {
      preferredScore = 0
    }
    return (stateScore, modeScore, remoteScore, tokenScore, preferredScore, index)
  }

  @available(iOS 16.2, *)
  @MainActor private func bestActivity(
    in group: [Activity<LinkShellAttentionAttributes>],
    pushEnabled: Bool,
    preferredActivityId: String?
  ) -> Activity<LinkShellAttentionAttributes>? {
    group.enumerated().max { lhs, rhs in
      activityRank(lhs.element, index: lhs.offset, pushEnabled: pushEnabled, preferredActivityId: preferredActivityId)
        < activityRank(rhs.element, index: rhs.offset, pushEnabled: pushEnabled, preferredActivityId: preferredActivityId)
    }?.element
  }

  @available(iOS 16.2, *)
  @MainActor private func endActivityLocked(_ activity: Activity<LinkShellAttentionAttributes>) async {
    pushTokenTasks.removeValue(forKey: activity.id)?.cancel()
    activityStateTasks.removeValue(forKey: activity.id)?.cancel()
    UserDefaults.standard.removeObject(forKey: "LinkShellLiveActivity.remote." + activity.id)
    LiveActivityBrowsing.clear(activityID: activity.id)
    if activeActivityId == activity.id { activeActivityId = nil }
    await activity.end(nil, dismissalPolicy: .immediate)
    sendEvent("onLiveActivityPushToken", ["activityId": activity.id, "ended": true])
  }

  /// Enforces strictly at most 1 live activity per computerKey and cleans up untagged zombies.
  @available(iOS 16.2, *)
  @MainActor private func reconcileActivitiesLocked(
    preferredActivityId: String? = nil,
    targetComputerKey: String? = nil
  ) async {
    let pushEnabled = !Self.pushServiceURL.isEmpty
    let live = Activity<LinkShellAttentionAttributes>.activities.filter {
      $0.activityState == .active || $0.activityState == .stale
    }
    var grouped: [String: [Activity<LinkShellAttentionAttributes>]] = [:]
    var untagged: [Activity<LinkShellAttentionAttributes>] = []
    for activity in live {
      if let key = Self.normalizedComputerKey(activity.attributes.computerKey) {
        grouped[key, default: []].append(activity)
      } else {
        untagged.append(activity)
      }
    }

    if !grouped.isEmpty || targetComputerKey != nil {
      for zombie in untagged {
        await endActivityLocked(zombie)
      }
    } else if untagged.count > 1,
              let keeper = bestActivity(in: untagged, pushEnabled: pushEnabled, preferredActivityId: preferredActivityId) {
      for duplicate in untagged where duplicate.id != keeper.id {
        await endActivityLocked(duplicate)
      }
    }

    for (_, group) in grouped {
      guard let keeper = bestActivity(in: group, pushEnabled: pushEnabled, preferredActivityId: preferredActivityId) else {
        continue
      }
      observeActivityLifecycle(keeper)
      for duplicate in group where duplicate.id != keeper.id {
        await endActivityLocked(duplicate)
      }
    }
  }
  #endif

  @available(iOS 17.2, *)
  @MainActor private func observePushToStartToken() {
    guard !Self.pushServiceURL.isEmpty, pushToStartTask == nil else { return }
    pushToStartTask = Task { [weak self] in
      for await tokenData in Activity<LinkShellAttentionAttributes>.pushToStartTokenUpdates {
        if Task.isCancelled { break }
        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
        if !hex.isEmpty {
          self?.sendEvent("onLiveActivityPushToStartToken", ["token": hex])
        }
      }
    }
  }

  @MainActor private func liveActivityPushToStartToken() -> String? {
    guard !Self.pushServiceURL.isEmpty else { return nil }
    #if canImport(ActivityKit)
    if #available(iOS 17.2, *), ActivityAuthorizationInfo().areActivitiesEnabled {
      observePushToStartToken()
      if let tokenData = Activity<LinkShellAttentionAttributes>.pushToStartToken {
        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
        return hex.isEmpty ? nil : hex
      }
    }
    #endif
    return nil
  }

  @available(iOS 16.2, *)
  @MainActor private func observeActivityLifecycle(_ activity: Activity<LinkShellAttentionAttributes>) {
    if !Self.pushServiceURL.isEmpty, pushTokenTasks[activity.id] == nil {
      pushTokenTasks[activity.id] = Task { [weak self] in
        for await _ in activity.pushTokenUpdates {
          if Task.isCancelled { break }
          self?.sendEvent("onLiveActivityPushToken", ["activityId": activity.id])
        }
      }
    }
    if activityStateTasks[activity.id] == nil {
      activityStateTasks[activity.id] = Task { [weak self] in
        for await state in activity.activityStateUpdates {
          if Task.isCancelled { break }
          if state == .ended || state == .dismissed {
            if state == .dismissed, let computerKey = Self.normalizedComputerKey(activity.attributes.computerKey) {
              UserDefaults.standard.set(activity.content.state.workloadKey, forKey: "LinkShellLiveActivity.dismissed." + computerKey)
            }
            UserDefaults.standard.removeObject(forKey: "LinkShellLiveActivity.remote." + activity.id)
            LiveActivityBrowsing.clear(activityID: activity.id)
            self?.pushTokenTasks.removeValue(forKey: activity.id)?.cancel()
            self?.activityStateTasks.removeValue(forKey: activity.id)
            if self?.activeActivityId == activity.id { self?.activeActivityId = nil }
            self?.sendEvent("onLiveActivityPushToken", ["activityId": activity.id, "ended": true])
            break
          }
        }
      }
    }
  }

  @MainActor private func liveActivityPushRegistrations() -> [[String: String]] {
    guard !Self.pushServiceURL.isEmpty else { return [] }
    var registrations: [[String: String]] = []
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      let live = Activity<LinkShellAttentionAttributes>.activities.filter {
        $0.activityState == .active || $0.activityState == .stale
      }
      var grouped: [String: [Activity<LinkShellAttentionAttributes>]] = [:]
      var needsReconcile = false
      for activity in live {
        observeActivityLifecycle(activity)
        guard let computerKey = Self.normalizedComputerKey(activity.attributes.computerKey) else {
          needsReconcile = true
          continue
        }
        grouped[computerKey, default: []].append(activity)
      }
      for (computerKey, group) in grouped {
        if group.count > 1 { needsReconcile = true }
        guard let winner = bestActivity(in: group, pushEnabled: true, preferredActivityId: nil),
              let token = winner.pushToken else { continue }
        if !Self.isRemoteReady(winner.id) { beginPushRegistrationTask() }
        registrations.append(["activityId": winner.id, "computerKey": computerKey, "token": token.map { String(format: "%02x", $0) }.joined()])
      }
      if needsReconcile {
        Task { [weak self] in
          await self?.reconcileNativeLiveActivities()
        }
      }
    }
    #endif
    return registrations
  }

  @MainActor private func beginPushRegistrationTask() {
    guard pushRegistrationBackgroundTask == .invalid else { return }
    pushRegistrationBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Connect live activity updates") { [weak self] in
      self?.endPushRegistrationTask()
    }
  }

  @MainActor private func endPushRegistrationTask() {
    guard pushRegistrationBackgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(pushRegistrationBackgroundTask)
    pushRegistrationBackgroundTask = .invalid
  }

  private static func measureLevel(buffer: AVAudioPCMBuffer) -> (Double, Double) {
    guard let channelData = buffer.floatChannelData?[0] else { return (-60.0, 0.05) }
    let frameLength = Int(buffer.frameLength)
    guard frameLength > 0 else { return (-60.0, 0.05) }
    var sum: Float = 0
    for i in 0..<frameLength {
      let sample = channelData[i]
      sum += sample * sample
    }
    let rms = sqrt(sum / Float(frameLength))
    let db = Double(max(-60.0, min(0.0, 20.0 * log10(max(rms, 0.000_01)))))
    let normalized = max(0.05, min(1.0, (db + 52.0) / 46.0))
    return (db, normalized)
  }

  private func syncNativeLiveActivity(payload: [String: Any]) async -> Bool {
    let input = LiveActivitySyncInput(payload: payload)
    return await activityQueue.enqueue { [weak self] in
      guard let self else { return false }
      return await self.syncNativeLiveActivityLocked(input: input)
    }
  }

  @MainActor private func syncNativeLiveActivityLocked(input: LiveActivitySyncInput) async -> Bool {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        return false
      }
      let pushEnabled = !Self.pushServiceURL.isEmpty
      let computerKey = input.computerKey
      // Always deduplicate per computerKey and clear untagged zombies BEFORE any early return,
      // including when the surviving activity is already remotely managed by Host.
      await reconcileActivitiesLocked(targetComputerKey: computerKey)
      let surviving = Activity<LinkShellAttentionAttributes>.activities.first {
        ($0.activityState == .active || $0.activityState == .stale)
          && Self.normalizedComputerKey($0.attributes.computerKey) == computerKey
      }
      // Once delegated, the host owns background and routine progress updates.
      // A cached/offline phone snapshot must not end an activity before its final alert.
      // However, when the app is active in foreground with a live online snapshot and the card
      // is still stuck displaying a resolved attention prompt (waiting/failed), reconcile locally
      // right away so an already-answered prompt never lingers if APNs delivery was delayed.
      let survivingRemoteReady = surviving.map { Self.isRemoteReady($0.id) } ?? false
      if let surviving, survivingRemoteReady {
        observeActivityLifecycle(surviving)
        activeActivityId = surviving.id
        let isAttentionPhase: (String) -> Bool = { phase in
          phase == "waiting_for_approval" || phase == "waiting_for_input" || phase == "failed"
        }
        let resolvedInForeground =
          input.online &&
          UIApplication.shared.applicationState == .active &&
          isAttentionPhase(surviving.content.state.phase) &&
          (!input.active || !isAttentionPhase(input.phase))
        if !resolvedInForeground {
          return true
        }
        if !input.active {
          await endActivityLocked(surviving)
          return true
        }
      }
      if !input.active {
        if let computerKey { UserDefaults.standard.removeObject(forKey: "LinkShellLiveActivity.dismissed." + computerKey) }
        await endNativeLiveActivityLocked(computerKey: computerKey)
        return true
      }
      let state = LinkShellAttentionAttributes.ContentState(
        phase: input.phase,
        title: input.title,
        subtitle: input.subtitle,
        project: input.project,
        agent: input.agent,
        agents: input.agents,
        actions: input.actionsData.flatMap { try? JSONDecoder().decode([LiveActivityAction].self, from: $0) },
        hasMoreActions: input.hasMoreActions,
        tasks: input.tasksData.flatMap { try? JSONDecoder().decode([LiveActivityTask].self, from: $0) },
        noticeId: input.noticeId,
        selectionVersion: nil,
        remotePending: (pushEnabled && !survivingRemoteReady) ? true : nil,
        waitingCount: input.waitingCount,
        runningCount: input.runningCount,
        failedCount: input.failedCount,
        deepLink: input.deepLink
      )
      // Delivery may be deferred by iOS. Keep the latest snapshot until an
      // explicit state change instead of declaring a live task dead on a timer.
      let content = ActivityContent(state: state, staleDate: nil)
      if let existing = surviving {
        if (existing.attributes.remoteUpdates ?? false) != pushEnabled {
          await endActivityLocked(existing)
        } else {
          observeActivityLifecycle(existing)
          await existing.update(content)
          activeActivityId = existing.id
          return true
        }
      }
      do {
        guard UIApplication.shared.applicationState == .active else { return false }
        if let computerKey,
           UserDefaults.standard.string(forKey: "LinkShellLiveActivity.dismissed." + computerKey) == state.workloadKey { return true }
        let attributes = LinkShellAttentionAttributes(computerName: input.computerName, computerKey: computerKey, remoteUpdates: pushEnabled)
        let created = try Activity.request(attributes: attributes, content: content, pushType: pushEnabled ? .token : nil)
        observeActivityLifecycle(created)
        sendEvent("onLiveActivityPushToken", ["activityId": created.id])
        activeActivityId = created.id
        return true
      } catch {
        return false
      }
    }
    #endif
    return false
  }

  private func endNativeLiveActivity(computerKey: String? = nil) async {
    await activityQueue.enqueue { [weak self] in
      guard let self else { return }
      await self.endNativeLiveActivityLocked(computerKey: computerKey)
    }
  }

  @MainActor private func endNativeLiveActivityLocked(computerKey: String? = nil) async {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      let targetKey = Self.normalizedComputerKey(computerKey)
      if targetKey == nil {
        activeActivityId = nil
        endPushRegistrationTask()
      }
      for activity in Activity<LinkShellAttentionAttributes>.activities {
        let activityKey = Self.normalizedComputerKey(activity.attributes.computerKey)
        if let targetKey, let activityKey, activityKey != targetKey { continue }
        await endActivityLocked(activity)
      }
      let remaining = Activity<LinkShellAttentionAttributes>.activities.contains {
        $0.activityState == .active || $0.activityState == .stale
      }
      if !remaining { endPushRegistrationTask() }
    }
    #endif
  }
}

final class LinkLayoutView: ExpoView {
  let onMetrics = EventDispatcher()
  private var last: NSDictionary?
  private var revision = ""
  private var recheckScheduled = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    #if LINK_LAYOUT_RESERVED_REGIONS
    if #available(iOS 27.1, *) {
      addInteraction(UIHingeInteraction { [weak self] _, _ in self?.scheduleRecheck() })
    }
    #endif
  }

  func updateRevision(_ revision: String) {
    guard self.revision != revision else { return }
    self.revision = revision
    scheduleRecheck()
  }

  // UIKit can update reserved regions after the hinge notification's layout pass.
  private func scheduleRecheck() {
    setNeedsLayout()
    guard !recheckScheduled else { return }
    recheckScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.recheckScheduled = false
      self.setNeedsLayout()
      self.layoutIfNeeded()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    fixWindowTypography()
    setNeedsLayout()
  }

  private func fixWindowTypography() {
    guard let window else { return }
    // Native navigation, tabs and presented menus must use the same fixed scale as RN text.
    // Set an explicit override even if the inherited category is currently already .large.
    if #available(iOS 17.0, *) {
      window.windowScene?.traitOverrides.preferredContentSizeCategory = .large
      window.traitOverrides.preferredContentSizeCategory = .large
    } else {
      window.minimumContentSizeCategory = .large
      window.maximumContentSizeCategory = .large
    }
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return }
    var divisions: [[String: Any]] = []
    var occlusions: [[String: Any]] = []
    #if LINK_LAYOUT_RESERVED_REGIONS
    if #available(iOS 27.1, *) {
      divisions = reservedRegions(kind: .division, options: [.includeInactive]).map { region in
        ["x": region.frame.minX, "y": region.frame.minY, "width": region.frame.width,
         "height": region.frame.height, "active": region.isActive]
      }
      occlusions = reservedRegions(kind: .occlusion).map { region in
        ["x": region.frame.minX, "y": region.frame.minY, "width": region.frame.width,
         "height": region.frame.height, "active": region.isActive]
      }
    }
    #endif
    let metrics: [String: Any] = [
      "revision": revision, "width": bounds.width, "height": bounds.height, "divisions": divisions, "occlusions": occlusions,
      "insets": ["top": safeAreaInsets.top, "right": safeAreaInsets.right,
                 "bottom": safeAreaInsets.bottom, "left": safeAreaInsets.left]
    ]
    let next = metrics as NSDictionary
    guard last == nil || !next.isEqual(last) else { return }
    last = next
    onMetrics(metrics)
  }
}
