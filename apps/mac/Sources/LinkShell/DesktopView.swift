import AppKit
import SwiftUI

enum DesktopStyle {
  private static func adaptive(_ light: NSColor, _ dark: NSColor) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
    })
  }
  static let windowBackground = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      ? NSColor(srgbRed: 0.059, green: 0.063, blue: 0.071, alpha: 1)
      : NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 1)
  }
  static let background = Color(nsColor: windowBackground)
  static let sidebar = adaptive(
    NSColor(srgbRed: 0.953, green: 0.957, blue: 0.965, alpha: 1),
    NSColor(srgbRed: 0.043, green: 0.047, blue: 0.055, alpha: 1)
  )
  static let card = adaptive(
    NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 1),
    NSColor(srgbRed: 0.078, green: 0.082, blue: 0.098, alpha: 1)
  )
  static let primary = adaptive(
    NSColor(srgbRed: 0.090, green: 0.094, blue: 0.106, alpha: 1),
    NSColor(srgbRed: 0.941, green: 0.945, blue: 0.953, alpha: 1)
  )
  static let secondary = adaptive(
    NSColor(srgbRed: 0.361, green: 0.373, blue: 0.408, alpha: 1),
    NSColor(srgbRed: 0.627, green: 0.639, blue: 0.671, alpha: 1)
  )
  static let accent = adaptive(
    NSColor(srgbRed: 0.369, green: 0.416, blue: 0.824, alpha: 1),
    NSColor(srgbRed: 0.408, green: 0.447, blue: 0.898, alpha: 1)
  )
  static let mint = adaptive(
    NSColor(srgbRed: 0.129, green: 0.502, blue: 0.345, alpha: 1),
    NSColor(srgbRed: 0.424, green: 0.761, blue: 0.604, alpha: 1)
  )
  static let line = adaptive(
    NSColor(srgbRed: 0.094, green: 0.102, blue: 0.125, alpha: 0.10),
    .white.withAlphaComponent(0.10)
  )
  static let selection = adaptive(
    NSColor(srgbRed: 0.094, green: 0.102, blue: 0.125, alpha: 0.065),
    .white.withAlphaComponent(0.08)
  )
  static let onAccent = Color.white
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
    HStack(spacing: 8) { Circle().fill(tone).frame(width: 7, height: 7); Text(text).foregroundStyle(DesktopStyle.secondary) }
      .font(.system(size: 13)).accessibilityElement(children: .combine)
  }
}

struct DesktopView: View {
  @ObservedObject var model: DesktopModel
  @State private var confirm: String?
  private let mainPages = [("总览", "house"), ("设备", "laptopcomputer"), ("用量统计", "chart.bar"), ("日志", "list.bullet.rectangle")]
  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 4) {
        Color.clear.frame(height: 104)
        Text("本机与服务")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(DesktopStyle.secondary)
          .padding(.horizontal, 12)
          .padding(.top, 6)
          .padding(.bottom, 2)
        ScrollView(showsIndicators: false) {
          VStack(alignment: .leading, spacing: 3) {
            ForEach(mainPages, id: \.0) { page in navigation(page.0, page.1) }
          }
        }
        rule.padding(.horizontal, 12).padding(.bottom, 8)
        navigation("更新", "arrow.down.circle")
        navigation("设置", "gearshape")
        if model.preview { Text("设计预览 · 示例数据").font(.system(size: 10.5)).foregroundStyle(DesktopStyle.secondary).padding(.horizontal, 12).padding(.top, 8) }
      }
      .padding(.horizontal, 14).padding(.bottom, 18)
      .frame(width: 232).background(DesktopStyle.sidebar)
      .overlay(alignment: .trailing) { Rectangle().fill(DesktopStyle.line).frame(width: 1).ignoresSafeArea(.container, edges: .top) }

      VStack(alignment: .leading, spacing: 0) {
        if model.selected != "用量统计" {
          HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
              Text(model.selected == "总览" ? "这台 Mac" : model.selected).font(.system(size: 19, weight: .semibold))
              Text(subtitle).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
            }
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            Menu {
              Button("刷新状态") { model.refresh() }
              Button("启动服务") { model.action("start") }.disabled(model.healthy)
              Button("重启服务…") { confirm = "restart" }.disabled(!model.healthy)
              Button("停止服务…") { confirm = "stop" }.disabled(!model.healthy)
            } label: {
              HStack(spacing: 6) {
                Text("本机服务").font(.system(size: 12, weight: .medium))
                Image(systemName: "ellipsis").frame(width: 20, height: 18)
              }
            }
            .menuStyle(.borderlessButton).fixedSize().padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(DesktopStyle.card))
            .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(DesktopStyle.line, lineWidth: 1) }
            .disabled(model.busy || model.preview).accessibilityLabel("服务操作")
          }.padding(.bottom, 14)
          rule.padding(.bottom, 18)
        }
        if let problem = model.problem {
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
            Text(problem).font(.system(size: 12)).textSelection(.enabled)
            Spacer()
            Button("重试") { model.refresh() }
          }.padding(14).background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.08))).padding(.bottom, 16)
        }
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            switch model.selected {
            case "设备": devices
            case "用量统计": DesktopUsageView(model: model)
            case "日志": logs
            case "更新": updates
            case "设置": settings
            default: overview
            }
          }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 12)
        }
        if model.selected != "更新" {
          rule.padding(.top, 12)
          HStack {
            DesktopStatus(text: model.newVersion ? "有新版本可用" : "服务\(model.serviceLabel) · 网关\(model.gatewayLabel)", tone: model.newVersion ? DesktopStyle.mint : (model.healthy ? DesktopStyle.mint : DesktopStyle.secondary))
            Spacer()
            Button(model.newVersion ? "查看更新" : "检查更新") { model.selected = "更新"; model.checkUpdates() }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
          }.padding(.top, 12)
        }
      }.padding(.horizontal, 28).padding(.top, 22).padding(.bottom, 18)
    }
    .background(DesktopStyle.background).foregroundStyle(DesktopStyle.primary)
    .preferredColorScheme(model.colorScheme).frame(minWidth: 880, minHeight: model.preview ? 620 : 540)
    .alert(confirm == "logout" ? "退出当前账号？" : confirm == "connect-gateway" ? "连接官方网关？" : confirm == "upgrade" ? "安装更新？" : "\(confirm == "stop" ? "停止" : "重启")本机服务？", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } })) {
      Button("取消", role: .cancel) { confirm = nil }
      Button("继续", role: .destructive) {
        if let action = confirm { if action == "upgrade" { model.upgrade() } else if action == "logout" || action == "connect-gateway" { model.accountAction(action) } else { model.action(action) } }
        confirm = nil
      }
    } message: { Text(confirm == "logout" ? "当前电脑将退出账号，账号关联的远程连接可能断开。本机会话和配对记录会保留。" : confirm == "connect-gateway" ? "将切换到官方网关，手机登录同一账号即可发现这台 Mac。官方网关需要 Pro，现有远程连接可能断开。" : "正在执行的代理任务、终端与远程连接可能中断。会话记录和配对信息会保留。") }
  }

  private var subtitle: String {
    switch model.selected {
    case "设备": return "扫描二维码配对手机，或管理已配对的设备"
    case "用量统计": return "这台电脑的 Token 用量与模型分布"
    case "日志": return "Host 最近 64 KB 日志 · 每 5 秒刷新"
    case "更新": return "检查版本与管理现有安装"
    case "设置": return "本机权限、启动项与应用偏好"
    default: return model.healthy ? "LinkShell 后台服务正在运行，随时可从手机或工作台连接" : "本机服务\(model.serviceLabel)"
    }
  }
  private var rule: some View { Rectangle().fill(DesktopStyle.line).frame(height: 1) }
  private func navigation(_ title: String, _ symbol: String) -> some View {
    let selected = model.selected == title
    return Button {
      model.selected = title
      if title == "日志" { model.readLog() }
    } label: {
      HStack(spacing: 10) {
        Image(systemName: symbol).font(.system(size: 15, weight: selected ? .semibold : .regular)).frame(width: 20)
        Text(title).font(.system(size: 13, weight: selected ? .semibold : .medium))
        Spacer()
        if title == "更新" && model.newVersion { Circle().fill(DesktopStyle.mint).frame(width: 6, height: 6) }
      }.padding(.horizontal, 10).frame(height: 34).contentShape(Rectangle())
        .background(RoundedRectangle(cornerRadius: 8).fill(selected ? DesktopStyle.selection : .clear))
    }.buttonStyle(.plain).foregroundStyle(selected ? DesktopStyle.primary : DesktopStyle.secondary)
  }
  private func row(_ title: String, _ value: String, good: Bool = false, warning: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Text(title).font(.system(size: 13.5, weight: .medium)).lineLimit(1)
        Spacer()
        DesktopStatus(text: value, tone: warning ? .orange : good ? DesktopStyle.mint : DesktopStyle.secondary)
          .lineLimit(1)
      }.frame(height: 46)
      rule
    }
  }
  private func valueRow(_ title: String, _ value: String, monospaced: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Text(title).font(.system(size: 13.5, weight: .medium)).lineLimit(1)
        Spacer()
        Text(value)
          .font(.system(size: 13, design: monospaced ? .monospaced : .default))
          .foregroundStyle(DesktopStyle.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
      }.frame(height: 46)
      rule
    }
  }
  private var overview: some View {
    VStack(alignment: .leading, spacing: 0) {
      accountSection
      if model.snapshot?.status == "stopped" {
        HStack {
          Text("启动后台服务后，即可从手机连接这台 Mac。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineLimit(1)
          Spacer()
          Button("启动服务") { model.action("start") }.disabled(model.busy || model.preview)
        }.padding(.bottom, 14)
      }
      if model.externalHost {
        HStack {
          Text("当前服务由另一套 CLI 启动").font(.system(size: 12)).foregroundStyle(.orange).lineLimit(1)
          Spacer()
          Button("切换到 App 内置服务…") { confirm = "restart" }.disabled(model.busy)
        }.padding(.bottom, 14)
      }
      row("本机服务", model.serviceLabel, good: model.healthy)
      row("网关连接", model.gatewayLabel, good: model.healthy && model.snapshot?.gateway?.status == "online")
      HStack(spacing: 12) {
        Text("屏幕与控制").font(.system(size: 13.5, weight: .medium)).lineLimit(1); Spacer()
        Button { model.permissions() } label: {
          DesktopStatus(text: !model.permissionsKnown ? "检查中" : model.recording && model.control ? "权限已就绪" : "需要授权", tone: !model.permissionsKnown ? DesktopStyle.secondary : model.recording && model.control ? DesktopStyle.mint : .orange)
            .lineLimit(1)
        }.buttonStyle(.plain).disabled(model.preview)
      }.frame(height: 46)
      rule
      HStack(spacing: 12) {
        Text("已配对设备").font(.system(size: 13.5, weight: .medium)).lineLimit(1)
        Spacer()
        DesktopStatus(
          text: model.devices.isEmpty ? "暂无设备" : "\(model.devices.count) 台设备 · \(model.devices.filter(\.online).count) 台在线",
          tone: model.devices.contains(where: \.online) ? DesktopStyle.mint : DesktopStyle.secondary
        ).lineLimit(1)
        Button("配对或管理…") { model.selected = "设备" }
          .controlSize(.small)
      }.frame(height: 46)
      rule
      Text("最近活动").font(.system(size: 15, weight: .semibold)).padding(.top, 22).padding(.bottom, 12)
      if model.activity.isEmpty { empty("尚无活动", "连接服务后，状态变化会显示在这里。") }
      ForEach(Array(model.activity.prefix(4).enumerated()), id: \.offset) { _, event in
        HStack(spacing: 16) {
          Text(event.0, style: .time).font(.system(size: 12, design: .monospaced)).lineLimit(1)
          Text(event.1).font(.system(size: 13)).lineLimit(1)
        }.foregroundStyle(DesktopStyle.secondary).frame(height: 28)
      }
    }
  }
  private var devices: some View {
    VStack(alignment: .leading, spacing: 0) {
      DesktopPairingView(model: model).padding(.bottom, 22)
      Text("已配对设备").font(.system(size: 14, weight: .semibold)).padding(.bottom, 8)
      rule
      if model.devices.isEmpty { empty("暂无已配对设备", "在手机中打开「电脑 → 添加电脑」，扫描上方生成的二维码。") }
      ForEach(model.devices) { device in row(device.name, device.online ? "在线" : "离线", good: device.online) }
      if let url = model.snapshot?.gateway?.url { Text(url).font(.system(size: 12, design: .monospaced)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled).padding(.top, 20) }
      if let error = model.snapshot?.gateway?.error?.message { Text(error).font(.footnote).foregroundStyle(.orange).padding(.top, 12) }
    }
  }
  private var logs: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Button("刷新日志") { model.readLog() }
        Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: model.home + "/host.log")]) }.disabled(model.preview)
      }
      Text(model.preview ? "设计预览不读取本机日志。" : model.log)
        .font(.system(size: 11.5, design: .monospaced))
        .foregroundStyle(DesktopStyle.secondary)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(DesktopStyle.card))
        .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(DesktopStyle.line, lineWidth: 1) }
    }
  }
  private var updates: some View {
    VStack(alignment: .leading, spacing: 0) {
      valueRow("安装来源", model.standalone ? "独立 App · 内置运行环境" : model.snapshot?.source == "homebrew" ? "Homebrew" : model.snapshot?.source == "npm" ? "npm / CLI" : "未知")
      valueRow("CLI 版本", model.snapshot?.cliVersion ?? "未知", monospaced: true)
      valueRow("运行中的 Host", model.snapshot?.machine?.hostVersion ?? "未连接", monospaced: true)
      valueRow("Mac 界面版本", Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版", monospaced: true)
      if model.standalone {
        HStack(spacing: 12) {
          Text("更新通道").font(.system(size: 13.5, weight: .medium)).lineLimit(1); Spacer()
          Picker("更新通道", selection: $model.updateChannel) { Text("稳定版").tag("stable"); Text("测试版").tag("beta") }.labelsHidden().pickerStyle(.segmented).frame(width: 200).disabled(model.busy || model.checking)
        }.frame(height: 46)
        rule
      } else { valueRow("更新通道", "稳定版 · latest") }
      HStack(spacing: 12) {
        Text("自动检查更新").font(.system(size: 13.5, weight: .medium)).lineLimit(1)
        Spacer()
        Toggle("自动检查更新", isOn: $model.autoCheck).labelsHidden().toggleStyle(.switch).disabled(model.preview)
      }.frame(height: 46)
      rule
      Text(model.updateMessage).font(.system(size: 13.5, weight: .medium)).padding(.top, 20).textSelection(.enabled)
      Text(model.standalone ? "App、内置 CLI、Host 与运行时作为整体更新。下载期间服务保持连接；仅在确认安装并重启时短暂重启服务，完成后自动恢复。" : "此安装通过 npm 或 Homebrew 更新。安装时可能重启后台服务，请先完成正在执行的任务。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineSpacing(4).padding(.top, 8)
      HStack(spacing: 12) {
        Button(model.checking ? "正在检查…" : "检查更新") { model.checkUpdates() }.disabled(model.checking || model.preview)
        if model.newVersion {
          Button(model.standalone ? "下载并更新 App…" : "安装更新…") {
            if model.standalone { model.upgrade() } else { confirm = "upgrade" }
          }
            .buttonStyle(.borderedProminent).tint(DesktopStyle.accent).foregroundStyle(DesktopStyle.onAccent)
            .disabled(model.busy || model.checking || model.preview)
        }
      }.padding(.top, 18)
    }
  }
  private var accountSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 5) {
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
          Button("登录 / 注册") { model.login() }
            .buttonStyle(.borderedProminent).tint(DesktopStyle.accent).foregroundStyle(DesktopStyle.onAccent)
            .disabled(model.busy || model.preview)
        }
      }
      if !model.accountMessage.isEmpty { Text(model.accountMessage).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled) }
      if model.signedIn {
        accountMembership
        if !model.redemptionMessage.isEmpty {
          Text(model.redemptionMessage).font(.system(size: 12))
            .foregroundStyle(model.redemptionIsError ? Color.orange : DesktopStyle.mint).textSelection(.enabled)
        }
        HStack {
          Text("网关：\(model.gatewayLabel)").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
          if model.snapshot?.gateway?.status != "online" {
            Button("连接官方网关…") { confirm = "connect-gateway" }.disabled(model.busy || model.preview)
          }
        }
        if let error = model.snapshot?.gateway?.error?.message { Text(error).font(.system(size: 12)).foregroundStyle(.orange).textSelection(.enabled) }
      } else {
        Text("官方网关需要 Pro；自建网关仍可通过配对使用。").font(.system(size: 11.5)).foregroundStyle(DesktopStyle.secondary)
      }
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 12).fill(DesktopStyle.card))
    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(DesktopStyle.line, lineWidth: 1) }
    .padding(.bottom, 16)
  }

  private var accountMembership: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        switch model.membership {
        case .pro(let expiresAt):
          Image(systemName: "checkmark.seal.fill").foregroundStyle(DesktopStyle.mint)
          Text("Pro 账户").fontWeight(.medium)
          Text("有效期至 \(expiresAt.formatted(date: .abbreviated, time: .omitted))").foregroundStyle(DesktopStyle.secondary)
        case .free:
          Text("普通账户").foregroundStyle(DesktopStyle.secondary)
        default:
          Text(model.checkingMembership ? "正在查询会员状态…" : "会员状态暂不可用").foregroundStyle(DesktopStyle.secondary)
        }
        if model.checkingMembership { ProgressView().controlSize(.mini) }
        else {
          Button { model.refreshAccount() } label: { Image(systemName: "arrow.clockwise") }
            .buttonStyle(.plain).foregroundStyle(DesktopStyle.secondary)
            .disabled(model.busy || model.preview).help("刷新会员状态").accessibilityLabel("刷新会员状态")
        }
      }.font(.system(size: 12))
      if model.membership == .free {
        HStack(spacing: 8) {
          TextField("输入激活码", text: $model.redemptionCode)
            .textFieldStyle(.roundedBorder).disableAutocorrection(true).frame(maxWidth: 280)
            .disabled(model.busy || model.preview).onSubmit { model.redeemPro() }
            .accessibilityLabel("Pro 激活码")
          Button(model.redeeming ? "正在兑换…" : "兑换 Pro") { model.redeemPro() }
            .buttonStyle(.borderedProminent).tint(DesktopStyle.accent).foregroundStyle(DesktopStyle.onAccent)
            .disabled(!model.canRedeem)
        }
        HStack(spacing: 3) {
          Text("没有激活码？").foregroundStyle(DesktopStyle.secondary)
          SwiftUI.Link("前往链动小铺", destination: URL(string: "https://pay.ldxp.cn/item/7lgv1s")!).foregroundStyle(DesktopStyle.secondary)
        }.font(.system(size: 11))
      }
    }
  }

  private var settings: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 12) {
        Text("外观").font(.system(size: 13.5, weight: .medium)).lineLimit(1); Spacer()
        Picker("外观", selection: $model.appearance) {
          Text("跟随系统").tag("system")
          Text("浅色").tag("light")
          Text("深色").tag("dark")
        }.labelsHidden().pickerStyle(.segmented).frame(width: 240)
      }.frame(height: 46)
      rule
      if model.standalone {
        HStack(spacing: 12) {
          Text("登录 Mac 时自动启动").font(.system(size: 13.5, weight: .medium)).lineLimit(1)
          Spacer()
          Toggle("登录 Mac 时自动启动", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
            .labelsHidden().toggleStyle(.switch).disabled(model.preview)
        }.frame(height: 46)
        Text("登录 Mac 后自动打开 LinkShell。每次打开桌面版都会启动后台服务并连接已配置的网关，无需再点“启动服务”。")
          .font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).padding(.bottom, 12)
        if model.loginApprovalRequired {
          Text("等待系统允许，请在“登录项”中启用 LinkShell。").font(.system(size: 12)).foregroundStyle(.orange)
          Button("打开系统登录项设置") { model.openLoginItems() }.padding(.vertical, 10).disabled(model.preview)
        }
        if !model.loginItemMessage.isEmpty {
          Text(model.loginItemMessage).font(.system(size: 12)).foregroundStyle(.orange).textSelection(.enabled).padding(.bottom, 10)
        }
        rule
      }
      row("屏幕录制", !model.permissionsKnown ? "未知" : model.recording ? "已授权" : "未授权", good: model.permissionsKnown && model.recording)
      row("辅助功能", !model.permissionsKnown ? "未知" : model.control ? "已授权" : "未授权", good: model.permissionsKnown && model.control)
      HStack(spacing: 12) {
        Text("需要修改系统授权时，可打开权限向导或系统设置。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineLimit(1)
        Spacer()
        Button("打开权限设置") { model.permissions() }.disabled(model.preview)
      }.frame(height: 46)
      rule
      valueRow("数据目录", model.home, monospaced: true)
      Text("窗口关闭后，LinkShell 留在菜单栏。退出界面不会停止 Host 或代理任务。")
        .font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineSpacing(4).padding(.top, 16)
      if model.standalone {
        rule.padding(.top, 16)
        Text("命令行工具").font(.system(size: 13.5, weight: .semibold)).padding(.top, 16)
        Text("使用 App 内置 CLI，与 App 一起升级。已有 npm / Homebrew 安装不会被改动。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).padding(.top, 6)
        HStack(spacing: 12) {
          Button("安装到 ~/.local/bin") { model.installCommand() }.disabled(model.preview)
          Button("重试恢复后台服务") { Task { await model.appUpdater.recover() } }.disabled(model.busy || model.preview)
        }.padding(.top, 12)
        if !model.commandMessage.isEmpty { Text(model.commandMessage).font(.system(size: 12)).textSelection(.enabled).padding(.top, 8) }
      }
      HStack {
        Button("退出 LinkShell 界面") { NSApp.terminate(nil) }
      }.padding(.top, 18)
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
      entry("bubble.left", "会话", model.healthy ? "\(model.running) 个运行中" : "未知")
      if model.pending > 0 {
        Divider()
        DesktopStatus(text: "\(model.pending) 个请求等待确认", tone: .orange).padding(.vertical, 18)
      }
      Divider().padding(.bottom, 10)
      link("arrow.up.forward.square", "打开工作台", "工作台")
      link("arrow.triangle.2.circlepath", "检查更新…", "更新")
      link("chart.bar", "用量统计", "用量统计")
      link("gearshape", "设置…", "设置")
    }.padding(22).frame(width: 300).background(DesktopStyle.sidebar).foregroundStyle(DesktopStyle.primary).preferredColorScheme(model.colorScheme)
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
