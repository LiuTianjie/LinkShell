import AppKit
import SwiftUI

private enum DesktopStyle {
  static let background = Color(red: 0.025, green: 0.028, blue: 0.035)
  static let sidebar = Color(red: 0.043, green: 0.047, blue: 0.057)
  static let secondary = Color(red: 0.66, green: 0.68, blue: 0.71)
  static let mint = Color(red: 0.24, green: 0.88, blue: 0.75)
  static let line = Color.white.opacity(0.10)
}

struct DesktopBrand: View {
  var size: CGFloat = 40
  var body: some View {
    HStack(spacing: 13) {
      Image(nsImage: NSImage(named: NSImage.applicationIconName) ?? NSImage()).resizable().frame(width: size, height: size)
      Text("LinkShell").font(.system(size: 20, weight: .semibold))
    }
  }
}
struct DesktopStatus: View {
  let text: String
  var tone: Color = DesktopStyle.secondary
  var body: some View {
    HStack(spacing: 9) { Circle().fill(tone).frame(width: 7, height: 7); Text(text).foregroundStyle(DesktopStyle.secondary) }
      .font(.system(size: 13)).accessibilityElement(children: .combine)
  }
}

struct DesktopView: View {
  @ObservedObject var model: DesktopModel
  @State private var confirm: String?
  private let mainPages = [("总览", "house"), ("会话", "bubble.left"), ("设备", "laptopcomputer"), ("日志", "list.bullet.rectangle")]
  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        DesktopBrand().padding(.horizontal, 16).padding(.top, 24).padding(.bottom, 30)
        ForEach(mainPages, id: \.0) { page in navigation(page.0, page.1) }
        Spacer()
        rule.padding(.horizontal, 16).padding(.bottom, 12)
        navigation("更新", "arrow.down.circle")
        navigation("设置", "gearshape")
        if model.preview { Text("设计预览 · 示例数据").font(.system(size: 10)).foregroundStyle(DesktopStyle.secondary).padding(16) }
      }
      .padding(10).padding(.bottom, 12).frame(width: 210).background(DesktopStyle.sidebar)
      Rectangle().fill(DesktopStyle.line).frame(width: 1)
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .top) {
          VStack(alignment: .leading, spacing: 7) {
            Text(model.selected == "总览" ? "这台 Mac" : model.selected).font(.system(size: 28, weight: .semibold))
            Text(subtitle).font(.system(size: 13)).foregroundStyle(DesktopStyle.secondary)
          }
          Spacer()
          if model.busy { ProgressView().controlSize(.small) }
          Menu {
            Button("刷新状态") { model.refresh() }
            Button("启动服务") { model.action("start") }.disabled(model.healthy)
            Button("重启服务…") { confirm = "restart" }.disabled(!model.healthy)
            Button("停止服务…") { confirm = "stop" }.disabled(!model.healthy)
          } label: { Image(systemName: "ellipsis").frame(width: 24, height: 22) }
            .menuStyle(.borderlessButton).fixedSize().padding(7)
            .background(RoundedRectangle(cornerRadius: 7).strokeBorder(DesktopStyle.line))
            .disabled(model.busy || model.preview).accessibilityLabel("服务操作")
        }.padding(.bottom, 30)
        if let problem = model.problem {
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
            Text(problem).font(.system(size: 12)).textSelection(.enabled)
            Spacer()
            Button("重试") { model.refresh() }
          }.padding(14).background(Color.orange.opacity(0.07)).padding(.bottom, 18)
        }
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            switch model.selected {
            case "会话": sessions
            case "设备": devices
            case "日志": logs
            case "更新": updates
            case "设置": settings
            default: overview
            }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
        if model.selected != "更新" {
          rule.padding(.top, 18)
          HStack {
            DesktopStatus(text: model.newVersion ? "有新版本可用" : "服务\(model.serviceLabel) · 网关\(model.gatewayLabel)", tone: model.newVersion ? DesktopStyle.mint : DesktopStyle.secondary)
            Spacer()
            Button(model.newVersion ? "查看更新" : "检查更新") { model.selected = "更新"; model.checkUpdates() }.buttonStyle(.plain).font(.system(size: 12))
          }.padding(.top, 15)
        }
      }.padding(.horizontal, 36).padding(.top, 34).padding(.bottom, 24)
    }
    .background(DesktopStyle.background).foregroundStyle(Color(red: 0.94, green: 0.945, blue: 0.953))
    .preferredColorScheme(.dark).frame(minWidth: 880, minHeight: 620)
    .alert(confirm == "logout" ? "退出当前账号？" : confirm == "connect-gateway" ? "连接官方网关？" : confirm == "upgrade" ? "安装更新？" : "\(confirm == "stop" ? "停止" : "重启")本机服务？", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } })) {
      Button("取消", role: .cancel) { confirm = nil }
      Button("继续", role: .destructive) {
        if let action = confirm { if action == "upgrade" { model.upgrade() } else if action == "logout" || action == "connect-gateway" { model.accountAction(action) } else { model.action(action) } }
        confirm = nil
      }
    } message: { Text(confirm == "logout" ? "当前电脑将退出账号，账号关联的远程连接可能断开。本机会话和配对记录会保留。" : confirm == "connect-gateway" ? "将切换到官方网关，手机登录同一账号即可发现这台 Mac。官方网关需要 Pro，现有远程连接可能断开。" : "正在执行的代理任务、终端与远程连接可能中断。会话记录和配对信息会保留。") }
    .sheet(item: $model.selectedSession) { session in
      VStack(alignment: .leading, spacing: 20) {
        Text(session.name).font(.title2.bold())
        DesktopStatus(text: session.label, tone: sessionTone(session))
        Text(session.cwd).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
        Text("代理：\(agentName(session.agent))").foregroundStyle(DesktopStyle.secondary)
        if session.pendingPermissions > 0 { Text("有 \(session.pendingPermissions) 个请求等待确认，请在手机或原代理终端处理。") }
        HStack { Spacer(); Button("完成") { model.selectedSession = nil }.keyboardShortcut(.defaultAction) }
      }.padding(32).frame(width: 480).background(DesktopStyle.background).preferredColorScheme(.dark)
    }
  }
  private var subtitle: String {
    switch model.selected {
    case "会话": return "当前 Host 中的会话与待处理请求"
    case "设备": return "与这台 Mac 配对的设备"
    case "日志": return "Host 最近 64 KB 日志 · 每 5 秒刷新"
    case "更新": return "检查版本与管理现有安装"
    case "设置": return "本机权限与应用偏好"
    default: return model.healthy ? "LinkShell 正在后台运行" : "本机服务\(model.serviceLabel)"
    }
  }
  private var rule: some View { Rectangle().fill(DesktopStyle.line).frame(height: 1) }
  private func navigation(_ title: String, _ symbol: String) -> some View {
    Button {
      model.selected = title
      if title == "日志" { model.readLog() }
    } label: {
      HStack(spacing: 13) {
        Image(systemName: symbol).font(.system(size: 17)).frame(width: 22)
        Text(title).font(.system(size: 14, weight: model.selected == title ? .medium : .regular))
        Spacer()
        if title == "更新" && model.newVersion { Circle().fill(DesktopStyle.mint).frame(width: 6, height: 6) }
      }.padding(.horizontal, 14).frame(height: 42).contentShape(Rectangle())
        .background(RoundedRectangle(cornerRadius: 6).fill(model.selected == title ? Color.white.opacity(0.075) : .clear))
    }.buttonStyle(.plain).foregroundStyle(model.selected == title ? .white : DesktopStyle.secondary)
  }
  private func row(_ title: String, _ value: String, good: Bool = false, warning: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack { Text(title).font(.system(size: 14)); Spacer(); DesktopStatus(text: value, tone: warning ? .orange : good ? DesktopStyle.mint : DesktopStyle.secondary) }.padding(.vertical, 18)
      rule
    }
  }
  private var overview: some View {
    VStack(alignment: .leading, spacing: 0) {
      accountSection
      if model.snapshot?.status == "stopped" {
        HStack { Text("启动后台服务后，即可从手机连接这台 Mac。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary); Spacer(); Button("启动服务") { model.action("start") }.disabled(model.busy || model.preview) }.padding(.bottom, 16)
      }
      if model.externalHost {
        HStack { Text("当前服务由另一套 CLI 启动").font(.system(size: 12)).foregroundStyle(.orange); Spacer(); Button("切换到 App 内置服务…") { confirm = "restart" }.disabled(model.busy) }.padding(.bottom, 16)
      }
      row("本机服务", model.serviceLabel, good: model.healthy)
      row("网关连接", model.gatewayLabel, good: model.healthy && model.snapshot?.gateway?.status == "online")
      HStack {
        Text("屏幕与控制").font(.system(size: 14)); Spacer()
        Button { model.permissions() } label: {
          DesktopStatus(text: !model.permissionsKnown ? "检查中" : model.recording && model.control ? "权限已就绪" : "需要授权", tone: !model.permissionsKnown ? DesktopStyle.secondary : model.recording && model.control ? DesktopStyle.mint : .orange)
        }.buttonStyle(.plain).disabled(model.preview)
      }.padding(.vertical, 18)
      rule
      HStack(spacing: 10) { Text("会话").font(.system(size: 19, weight: .semibold)); Text("\(model.sessions.count)").foregroundStyle(DesktopStyle.secondary); Spacer(); Button("查看全部") { model.selected = "会话" }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary) }.padding(.top, 32).padding(.bottom, 17)
      sessionTable(Array(model.sessions.prefix(4)))
      Text("最近活动").font(.system(size: 19, weight: .semibold)).padding(.top, 30).padding(.bottom, 16)
      if model.activity.isEmpty { empty("尚无活动", "连接服务后，状态变化会显示在这里。") }
      ForEach(Array(model.activity.prefix(4).enumerated()), id: \.offset) { _, event in
        HStack(spacing: 20) { Text(event.0, style: .time).font(.system(size: 12, design: .monospaced)); Text(event.1).font(.system(size: 13)) }.foregroundStyle(DesktopStyle.secondary).padding(.bottom, 12)
      }
    }
  }
  private func sessionTone(_ session: DesktopSession) -> Color {
    if session.pendingPermissions > 0 || session.state == "waiting" { return .orange }
    if session.state == "running" { return DesktopStyle.mint }
    if session.state == "error" { return .red }
    return DesktopStyle.secondary
  }
  private func agentName(_ agent: String) -> String { ["codex": "Codex", "claude": "Claude Code"][agent] ?? agent }
  private func sessionTable(_ entries: [DesktopSession]) -> some View {
    VStack(spacing: 0) {
      if entries.isEmpty { empty(model.healthy ? "暂无会话" : "会话不可用", model.healthy ? "从终端使用 linkshell codex 或 linkshell claude 开始。" : "连接本机服务后查看会话。") }
      else {
        HStack { Text("项目").frame(maxWidth: .infinity, alignment: .leading); Text("代理").frame(width: 125, alignment: .leading); Text("状态").frame(width: 110, alignment: .leading) }.font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).padding(.bottom, 12)
        rule
        ForEach(entries) { session in
          Button { model.selectedSession = session } label: {
            HStack {
              Text(session.name).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
              Text(agentName(session.agent)).frame(width: 125, alignment: .leading)
              DesktopStatus(text: session.label, tone: sessionTone(session)).frame(width: 110, alignment: .leading)
            }.font(.system(size: 13)).padding(.vertical, 17).contentShape(Rectangle())
          }.buttonStyle(.plain)
          rule
        }
      }
    }
  }
  private var sessions: some View {
    VStack(alignment: .leading, spacing: 16) {
      sessionTable(model.sessions)
      if model.snapshot?.hasMoreSessions == true { Text("显示最近 200 个会话。更多历史可在手机端查看。").font(.footnote).foregroundStyle(DesktopStyle.secondary) }
    }
  }
  private var devices: some View {
    VStack(alignment: .leading, spacing: 0) {
      if model.devices.isEmpty { empty("暂无设备", "在终端运行 linkshell pair 配对手机，或让手机与电脑登录同一账号。") }
      ForEach(model.devices) { device in row(device.name, device.online ? "在线" : "离线", good: device.online) }
      if let url = model.snapshot?.gateway?.url { Text(url).font(.system(size: 12, design: .monospaced)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled).padding(.top, 24) }
      if let error = model.snapshot?.gateway?.error?.message { Text(error).font(.footnote).foregroundStyle(.orange).padding(.top, 16) }
    }
  }
  private var logs: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Button("刷新日志") { model.readLog() }
        Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: model.home + "/host.log")]) }.disabled(model.preview)
      }
      Text(model.preview ? "设计预览不读取本机日志。" : model.log).font(.system(size: 11, design: .monospaced)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
  }
  private var updates: some View {
    VStack(alignment: .leading, spacing: 0) {
      row("安装来源", model.standalone ? "独立 App · 内置运行环境" : model.snapshot?.source == "homebrew" ? "Homebrew" : model.snapshot?.source == "npm" ? "npm / CLI" : "未知")
      row("CLI 版本", model.snapshot?.cliVersion ?? "未知")
      row("运行中的 Host", model.snapshot?.machine?.hostVersion ?? "未连接")
      row("Mac 界面版本", Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版")
      if model.standalone {
        HStack {
          Text("更新通道").font(.system(size: 14)); Spacer()
          Picker("更新通道", selection: $model.updateChannel) { Text("稳定版").tag("stable"); Text("测试版").tag("beta") }.labelsHidden().pickerStyle(.segmented).frame(width: 200).disabled(model.busy || model.checking)
        }.padding(.vertical, 18)
        rule
      } else { row("更新通道", "稳定版 · latest") }
      Toggle("自动检查更新", isOn: $model.autoCheck).toggleStyle(.switch).padding(.vertical, 20).disabled(model.preview)
      rule
      Text(model.updateMessage).font(.system(size: 14)).padding(.top, 25).textSelection(.enabled)
      Text(model.standalone ? "App、内置 CLI、Host 与运行时作为整体更新。安装前会暂停本 App 托管的服务，完成后自动恢复；其他安装不会被覆盖。" : "此安装通过 npm 或 Homebrew 更新。安装时可能重启后台服务，请先完成正在执行的任务。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineSpacing(5).padding(.top, 10)
      HStack(spacing: 12) {
        Button(model.checking ? "正在检查…" : "检查更新") { model.checkUpdates() }.disabled(model.checking || model.preview)
        if model.newVersion { Button(model.standalone ? "下载并更新 App…" : "安装更新…") { confirm = "upgrade" }.disabled(model.busy || model.checking || model.preview) }
      }.padding(.top, 22)
    }
  }
  private var accountSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 6) {
          Text("LinkShell 账号").font(.system(size: 14, weight: .semibold))
          Text(model.signedIn ? model.accountLabel : "登录后，在手机上使用同一账号连接这台 Mac。")
            .font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled)
        }
        Spacer()
        if model.signingIn {
          ProgressView().controlSize(.small)
          Button("取消登录") { model.cancelLogin() }
        } else if model.signedIn {
          Button("退出登录…") { confirm = "logout" }.disabled(model.busy)
        } else {
          Button("登录 / 注册") { model.login() }.buttonStyle(.borderedProminent).tint(DesktopStyle.mint).foregroundStyle(.black).disabled(model.busy || model.preview)
        }
      }
      if !model.accountMessage.isEmpty { Text(model.accountMessage).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled) }
      if model.signedIn {
        HStack {
          Text("网关：\(model.gatewayLabel)").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
          if model.snapshot?.gateway?.status != "online" {
            Button("连接官方网关…") { confirm = "connect-gateway" }.disabled(model.busy || model.preview)
          }
        }
        if let error = model.snapshot?.gateway?.error?.message { Text(error).font(.system(size: 12)).foregroundStyle(.orange).textSelection(.enabled) }
      } else {
        Text("官方网关需要 Pro；自建网关仍可通过配对使用。").font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
      }
    }.padding(.vertical, 20)
    .overlay(alignment: .bottom) { rule }
    .padding(.bottom, 12)
  }

  private var settings: some View {
    VStack(alignment: .leading, spacing: 0) {
      accountSection
      row("屏幕录制", !model.permissionsKnown ? "未知" : model.recording ? "已授权" : "未授权", good: model.permissionsKnown && model.recording)
      row("辅助功能", !model.permissionsKnown ? "未知" : model.control ? "已授权" : "未授权", good: model.permissionsKnown && model.control)
      Button("打开权限设置") { model.permissions() }.padding(.vertical, 20).disabled(model.preview)
      rule
      Text("数据目录").font(.system(size: 14, weight: .medium)).padding(.top, 24)
      Text(model.home).font(.system(size: 12, design: .monospaced)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled).padding(.top, 9)
      Text("窗口关闭后，LinkShell 留在菜单栏。退出界面不会停止 Host 或代理任务。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineSpacing(5).padding(.top, 25)
      if model.standalone {
        rule.padding(.top, 24)
        Text("命令行工具").font(.system(size: 14, weight: .medium)).padding(.top, 20)
        Text("使用 App 内置 CLI，与 App 一起升级。已有 npm / Homebrew 安装不会被改动。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).padding(.top, 9)
        Button("安装到 ~/.local/bin") { model.installCommand() }.padding(.top, 14).disabled(model.preview)
        if !model.commandMessage.isEmpty { Text(model.commandMessage).font(.system(size: 12)).textSelection(.enabled).padding(.top, 10) }
        Button("重试恢复后台服务") { Task { await model.appUpdater.recover() } }.padding(.top, 16).disabled(model.busy || model.preview)
      }
      Button("退出 LinkShell 界面") { NSApp.terminate(nil) }.padding(.top, 20)
    }
  }
  private func empty(_ title: String, _ detail: String) -> some View {
    VStack(alignment: .leading, spacing: 9) { Text(title).font(.system(size: 14)); Text(detail).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary) }.padding(.vertical, 20)
  }
}

struct DesktopPopover: View {
  @ObservedObject var model: DesktopModel
  let open: (String) -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      DesktopBrand(size: 38).padding(.bottom, 10)
      DesktopStatus(text: "服务\(model.serviceLabel)", tone: model.healthy ? DesktopStyle.mint : DesktopStyle.secondary).padding(.leading, 51).padding(.bottom, 20)
      Divider()
      entry("network", "网关", model.gatewayLabel)
      entry("laptopcomputer", "设备", model.healthy ? "\(model.online) 台在线" : "未知")
      entry("bubble.left", "会话", model.healthy ? "\(model.running) 个运行中" : "未知")
      if model.pending > 0 {
        Divider()
        Button { open("会话") } label: { DesktopStatus(text: "\(model.pending) 个请求等待确认", tone: .orange).padding(.vertical, 18) }.buttonStyle(.plain)
      }
      Divider().padding(.bottom, 10)
      link("arrow.up.forward.square", "打开 LinkShell", "总览")
      link("arrow.triangle.2.circlepath", "检查更新…", "更新")
      link("gearshape", "设置…", "设置")
    }.padding(22).frame(width: 300).background(DesktopStyle.sidebar).foregroundStyle(.white).preferredColorScheme(.dark)
  }
  private func entry(_ icon: String, _ title: String, _ value: String) -> some View {
    HStack(spacing: 12) { Image(systemName: icon).frame(width: 20); Text(title); Spacer(); Text(value).foregroundStyle(DesktopStyle.secondary) }.font(.system(size: 13)).padding(.vertical, 12)
  }
  private func link(_ icon: String, _ title: String, _ page: String) -> some View {
    Button { open(page); if page == "更新" { model.checkUpdates() } } label: {
      HStack(spacing: 12) { Image(systemName: icon).frame(width: 20); Text(title); Spacer() }.font(.system(size: 13)).padding(.vertical, 10).contentShape(Rectangle())
    }.buttonStyle(.plain)
  }
}
