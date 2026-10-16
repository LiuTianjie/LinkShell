import AVFoundation
import ExpoModulesCore
import Speech
import UIKit
#if canImport(ActivityKit)
import ActivityKit
#endif


public class LinkLayoutModule: Module {
  private weak var presentationScene: UIWindowScene?
  private var previousOrientation: UIInterfaceOrientation?

  // Native iOS speech recognition state (lazy initialized only when recording starts).
  private var audioEngine: AVAudioEngine?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var speechRecognizer: SFSpeechRecognizer?
  private var lastLevelSentAt: TimeInterval = 0
  private var simulatorWaveTimer: Timer?
  private var activeActivityId: String?
  private var pushTokenTasks: [String: Task<Void, Never>] = [:]
  private var activityStateTasks: [String: Task<Void, Never>] = [:]
  private var activityActionObserver: NSObjectProtocol?
  private var pushRegistrationBackgroundTask: UIBackgroundTaskIdentifier = .invalid

  public func definition() -> ModuleDefinition {
    Name("LinkLayout")
    Events("onSpeechResult", "onSpeechLevel", "onSpeechError", "onLiveActivityAction", "onLiveActivityPushToken")
    OnCreate { [weak self] in
      Task { @MainActor [weak self] in self?.observeExistingActivities() }
      self?.activityActionObserver = NotificationCenter.default.addObserver(forName: LiveActivityActionQueue.notification, object: nil, queue: .main) { [weak self] notification in
        if let id = notification.userInfo?["id"] as? String { self?.sendEvent("onLiveActivityAction", ["id": id]) }
      }
    }
    OnDestroy { [weak self] in
      if let self {
        Task { @MainActor in
          self.pushTokenTasks.values.forEach { $0.cancel() }
          self.activityStateTasks.values.forEach { $0.cancel() }
          self.pushTokenTasks.removeAll()
          self.activityStateTasks.removeAll()
          self.endPushRegistrationTask()
        }
      }
      if let observer = self?.activityActionObserver { NotificationCenter.default.removeObserver(observer) }
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
        guard let self else { return }
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

  @MainActor private func observeExistingActivities() {
    if #available(iOS 16.2, *), !Self.pushServiceURL.isEmpty {
      for activity in Activity<LinkShellAttentionAttributes>.activities { observePushToken(activity) }
    }
  }

  @available(iOS 16.2, *)
  @MainActor private func observePushToken(_ activity: Activity<LinkShellAttentionAttributes>) {
    guard !Self.pushServiceURL.isEmpty, pushTokenTasks[activity.id] == nil else { return }
    pushTokenTasks[activity.id] = Task { [weak self] in
      for await _ in activity.pushTokenUpdates {
        if Task.isCancelled { break }
        self?.sendEvent("onLiveActivityPushToken", ["activityId": activity.id])
      }
    }
    activityStateTasks[activity.id] = Task { [weak self] in
      for await state in activity.activityStateUpdates {
        if Task.isCancelled { break }
        if state == .ended || state == .dismissed {
          if state == .dismissed, let computerKey = activity.attributes.computerKey {
            UserDefaults.standard.set(activity.content.state.workloadKey, forKey: "LinkShellLiveActivity.dismissed." + computerKey)
          }
          UserDefaults.standard.removeObject(forKey: "LinkShellLiveActivity.remote." + activity.id)
          LiveActivityBrowsing.clear(activityID: activity.id)
          self?.pushTokenTasks.removeValue(forKey: activity.id)?.cancel()
          self?.activityStateTasks.removeValue(forKey: activity.id)
          self?.sendEvent("onLiveActivityPushToken", ["activityId": activity.id, "ended": true])
          break
        }
      }
    }
  }

  @MainActor private func liveActivityPushRegistrations() -> [[String: String]] {
    guard !Self.pushServiceURL.isEmpty else { return [] }
    var registrations: [[String: String]] = []
    if #available(iOS 16.2, *) {
      for activity in Activity<LinkShellAttentionAttributes>.activities where activity.activityState == .active || activity.activityState == .stale {
        observePushToken(activity)
        guard let token = activity.pushToken, let computerKey = activity.attributes.computerKey else { continue }
        if !UserDefaults.standard.bool(forKey: "LinkShellLiveActivity.remote." + activity.id) { beginPushRegistrationTask() }
        registrations.append(["activityId": activity.id, "computerKey": computerKey, "token": token.map { String(format: "%02x", $0) }.joined()])
      }
    }
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

  @MainActor private func syncNativeLiveActivity(payload: [String: Any]) async -> Bool {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        return false
      }
      let pushEnabled = !Self.pushServiceURL.isEmpty
      let computerKey = payload["computerKey"] as? String
      // Once delegated, the host owns foreground and background updates alike.
      // A cached phone snapshot must not end an activity before its final alert.
      let remotelyManaged = Activity<LinkShellAttentionAttributes>.activities.contains {
        ($0.activityState == .active || $0.activityState == .stale) && $0.attributes.computerKey == computerKey
          && UserDefaults.standard.bool(forKey: "LinkShellLiveActivity.remote." + $0.id)
      }
      if remotelyManaged { return true }
      let active = (payload["active"] as? Bool) ?? false
      if !active {
        if let computerKey { UserDefaults.standard.removeObject(forKey: "LinkShellLiveActivity.dismissed." + computerKey) }
        await endNativeLiveActivity(computerKey: computerKey)
        return true
      }
      let computerName = (payload["computerName"] as? String) ?? "电脑"
      let state = LinkShellAttentionAttributes.ContentState(
        phase: (payload["phase"] as? String) ?? "running",
        title: (payload["title"] as? String) ?? "会话进行中",
        subtitle: (payload["subtitle"] as? String) ?? "",
        project: (payload["project"] as? String) ?? "",
        agent: (payload["agent"] as? String) ?? "claude",
        agents: payload["agents"] as? [String],
        actions: (payload["actions"] as? [[String: Any]]).flatMap { actions in
          guard let data = try? JSONSerialization.data(withJSONObject: actions) else { return nil }
          return try? JSONDecoder().decode([LiveActivityAction].self, from: data)
        },
        hasMoreActions: payload["hasMoreActions"] as? Bool,
        tasks: (payload["tasks"] as? [[String: Any]]).flatMap { tasks in
          guard let data = try? JSONSerialization.data(withJSONObject: tasks) else { return nil }
          return try? JSONDecoder().decode([LiveActivityTask].self, from: data)
        },
        noticeId: payload["noticeId"] as? String,
        selectionVersion: nil,
        remotePending: pushEnabled ? true : nil,
        waitingCount: (payload["waitingCount"] as? Int) ?? 0,
        runningCount: (payload["runningCount"] as? Int) ?? 0,
        failedCount: (payload["failedCount"] as? Int) ?? 0,
        deepLink: (payload["deepLink"] as? String) ?? "linkshell:///"
      )
      // Delivery may be deferred by iOS. Keep the latest snapshot until an
      // explicit state change instead of declaring a live task dead on a timer.
      let content = ActivityContent(state: state, staleDate: nil)
      for activity in Activity<LinkShellAttentionAttributes>.activities {
        guard activity.activityState == .active || activity.activityState == .stale else { continue }
        // Switching the foreground connection must not revoke another computer's
        // background delivery grant or dismiss its outstanding approval.
        guard activity.attributes.computerKey == computerKey else { continue }
        if (activity.attributes.remoteUpdates ?? false) != pushEnabled {
          await activity.end(nil, dismissalPolicy: .immediate)
          continue
        }
        observePushToken(activity)
        await activity.update(content)
        activeActivityId = activity.id
        return true
      }
      do {
        guard UIApplication.shared.applicationState == .active else { return false }
        if let computerKey,
           UserDefaults.standard.string(forKey: "LinkShellLiveActivity.dismissed." + computerKey) == state.workloadKey { return true }
        let attributes = LinkShellAttentionAttributes(computerName: computerName, computerKey: computerKey, remoteUpdates: pushEnabled)
        let created = try Activity.request(attributes: attributes, content: content, pushType: pushEnabled ? .token : nil)
        observePushToken(created)
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

  @MainActor private func endNativeLiveActivity(computerKey: String? = nil) async {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      activeActivityId = nil
      endPushRegistrationTask()
      for activity in Activity<LinkShellAttentionAttributes>.activities {
        if let computerKey, activity.attributes.computerKey != computerKey { continue }
        await activity.end(nil, dismissalPolicy: .immediate)
        sendEvent("onLiveActivityPushToken", ["activityId": activity.id, "ended": true])
      }
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
