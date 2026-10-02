import Foundation

/// Everything the setup window says, in one language.
struct SetupText: Equatable {
  let title: String
  let sentence: String
  /// The permissions' names, as System Settings lists them. Screen Recording was renamed in
  /// macOS 15.
  let recording: String
  let recordingBefore15: String
  let recordingPurpose: String
  let control: String
  let controlPurpose: String
  let off: String
  let on: String
  let open: String
  /// What to do in System Settings, once it is open.
  let hint: String
  /// About the system's own question after the Screen Recording switch is turned on.
  let reopen: String
  let later: String
  let doneTitle: String
  let doneSentence: String
  let done: String

  static let chinese = SetupText(
    title: "让手机看到并控制这台 Mac",
    sentence: "在系统设置里打开下面两项，只需要设置这一次。",
    recording: "录屏与系统录音",
    recordingBefore15: "屏幕录制",
    recordingPurpose: "手机上能看到这台电脑的屏幕",
    control: "辅助功能",
    controlPurpose: "手机上能移动鼠标、点击和打字",
    off: "未开启",
    on: "已开启",
    open: "打开系统设置",
    hint: "在列表里打开 LinkShell 的开关",
    reopen: "如果系统提示要退出并重新打开 LinkShell，选「以后」就可以。",
    later: "以后再说",
    doneTitle: "都设置好了",
    doneSentence: "现在可以在手机上查看和控制这台电脑。",
    done: "完成"
  )

  static let english = SetupText(
    title: "Let your phone see and control this Mac",
    sentence: "Turn on these two in System Settings. You only need to do it once.",
    recording: "Screen & System Audio Recording",
    recordingBefore15: "Screen Recording",
    recordingPurpose: "Your phone can show this Mac’s screen",
    control: "Accessibility",
    controlPurpose: "Your phone can move the pointer, click and type",
    off: "Off",
    on: "On",
    open: "Open System Settings",
    hint: "Turn on the switch next to LinkShell in the list",
    reopen: "If macOS says LinkShell has to quit and reopen, you can choose Later.",
    later: "Not Now",
    doneTitle: "All set",
    doneSentence: "You can now see and control this Mac from your phone.",
    done: "Done"
  )

  /// Chinese when the language the user put first is Chinese, English otherwise.
  static func preferred(_ languages: [String] = Locale.preferredLanguages) -> SetupText {
    languages.first?.lowercased().hasPrefix("zh") == true ? chinese : english
  }

  func name(_ permission: Permission) -> String {
    switch permission {
    case .recording:
      if #available(macOS 15, *) { return recording }
      return recordingBefore15
    case .control:
      return control
    }
  }

  func purpose(_ permission: Permission) -> String {
    permission == .recording ? recordingPurpose : controlPurpose
  }
}
