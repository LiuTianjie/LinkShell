import AVFoundation
import ExpoModulesCore
import Speech
import UIKit
#if canImport(ActivityKit)
import ActivityKit
#endif

#if canImport(ActivityKit)
@available(iOS 16.2, *)
public struct LinkShellAttentionAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var phase: String
    public var title: String
    public var subtitle: String
    public var project: String
    public var agent: String
    public var waitingCount: Int
    public var runningCount: Int
    public var failedCount: Int
    public var deepLink: String
  }
  public var computerName: String
}
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

  public func definition() -> ModuleDefinition {
    Name("LinkLayout")
    Events("onSpeechResult", "onSpeechLevel", "onSpeechError")
    Constants([
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

    // Explicitly deactivate AVAudioSession so background music / podcasts resume immediately.
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
      let active = (payload["active"] as? Bool) ?? false
      if !active {
        await endNativeLiveActivity()
        return true
      }
      let computerName = (payload["computerName"] as? String) ?? "电脑"
      let state = LinkShellAttentionAttributes.ContentState(
        phase: (payload["phase"] as? String) ?? "running",
        title: (payload["title"] as? String) ?? "会话进行中",
        subtitle: (payload["subtitle"] as? String) ?? "",
        project: (payload["project"] as? String) ?? "",
        agent: (payload["agent"] as? String) ?? "claude",
        waitingCount: (payload["waitingCount"] as? Int) ?? 0,
        runningCount: (payload["runningCount"] as? Int) ?? 0,
        failedCount: (payload["failedCount"] as? Int) ?? 0,
        deepLink: (payload["deepLink"] as? String) ?? "linkshell:///"
      )
      // Mark stale after 2 minutes without a heartbeat so the Lock Screen never lies when offline.
      let staleDate = Date().addingTimeInterval(120)
      let content = ActivityContent(state: state, staleDate: staleDate)
      for activity in Activity<LinkShellAttentionAttributes>.activities {
        await activity.update(content)
        activeActivityId = activity.id
        return true
      }
      do {
        let attributes = LinkShellAttentionAttributes(computerName: computerName)
        let created = try Activity.request(attributes: attributes, content: content, pushType: nil)
        activeActivityId = created.id
        return true
      } catch {
        return false
      }
    }
    #endif
    return false
  }

  private func endNativeLiveActivity() async {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      activeActivityId = nil
      for activity in Activity<LinkShellAttentionAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
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
