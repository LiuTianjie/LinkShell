import AppKit
import SwiftUI

struct DesktopBrand: View {
  var size: CGFloat = 40
  var body: some View {
    HStack(spacing: 13) {
      Image(nsImage: NSImage(named: NSImage.applicationIconName) ?? NSImage()).resizable().frame(width: size, height: size)
      Text("LinkShell").font(.system(size: 17, weight: .semibold))
    }
  }
}
struct DesktopStatus: View {
  let text: String
  var tone: Color = DesktopStyle.secondary
  var body: some View {
    HStack(spacing: 7) { Circle().fill(tone).frame(width: 6, height: 6); Text(text).foregroundStyle(DesktopStyle.secondary) }
      .font(.system(size: 13)).accessibilityElement(children: .combine)
  }
}

struct DesktopView: View {
  @ObservedObject var model: DesktopModel
  @State private var confirm: String?
  @State private var editingPassword = false
  @State private var newPassword = ""
  @State private var confirmPassword = ""
  private let mainPages = [("总览", "house"), ("设备", "iphone"), ("访问密码", "lock"), ("用量统计", "chart.bar"), ("日志", "text.alignleft")]
  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .top, spacing: DesktopStyle.gutter) {
        sidebar.frame(width: DesktopStyle.sidebarWidth).frame(maxHeight: .infinity).panelSurface()
        page.frame(maxWidth: .infinity, maxHeight: .infinity).panelSurface()
      }
      .padding(.horizontal, DesktopStyle.gutter)
      statusLine.frame(height: DesktopStyle.statusBarHeight)
    }
    .background(DesktopStyle.background).foregroundStyle(DesktopStyle.primary)
    .preferredColorScheme(model.colorScheme).frame(minWidth: 880, minHeight: model.preview ? 560 : 520)
    .alert(confirm == "remove-password" ? "移除访问密码？" : confirm == "logout" ? "退出当前账号？" : confirm == "connect-gateway" ? "连接官方网关？" : confirm == "upgrade" ? "安装更新？" : "\(confirm == "stop" ? "停止" : "重启")本机服务？", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } })) {
      Button("取消", role: .cancel) { confirm = nil }
      Button("继续", role: .destructive) {
        if let action = confirm { if action == "remove-password" { model.setAccessPassword(nil) } else if action == "upgrade" { model.upgrade() } else if action == "logout" || action == "connect-gateway" { model.accountAction(action) } else { model.action(action) } }
        confirm = nil
      }
    } message: { Text(confirm == "remove-password" ? "其他设备将可以直接打开这台 Mac，不再需要输入密码。" : confirm == "logout" ? "当前电脑将退出账号，账号关联的远程连接可能断开。本机会话和配对记录会保留。" : confirm == "connect-gateway" ? "将切换到官方网关，手机登录同一账号即可发现这台 Mac。官方网关需要 Pro，现有远程连接可能断开。" : "正在执行的代理任务、终端与远程连接可能中断。会话记录和配对信息会保留。") }
  }

  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 10) {
        // The dot takes the icon column so the name starts on the same edge as the pages below it.
        Circle().fill(model.healthy ? DesktopStyle.mint : DesktopStyle.tertiary).frame(width: 7, height: 7).frame(width: 18)
        VStack(alignment: .leading, spacing: 1) {
          Text(model.snapshot?.machine?.hostname.replacingOccurrences(of: ".local", with: "") ?? "这台 Mac")
            .font(.system(size: 13.5, weight: .semibold)).lineLimit(1).truncationMode(.middle)
          Text("本机服务\(model.serviceLabel)").font(.system(size: 12)).foregroundStyle(DesktopStyle.tertiary).lineLimit(1)
        }
      }.padding(.horizontal, 10).frame(height: 46, alignment: .leading).padding(.bottom, 6)
      ForEach(mainPages, id: \.0) { page in navigation(page.0, page.1) }
      Spacer(minLength: 12)
      navigation("更新", "arrow.down.circle")
      navigation("设置", "gearshape")
      if model.preview { Text("设计预览 · 示例数据").font(.system(size: 11)).foregroundStyle(DesktopStyle.tertiary).padding(.horizontal, 10).padding(.top, 8) }
    }
    .padding(10)
  }

  private var page: some View {
    VStack(alignment: .leading, spacing: 0) {
      if model.selected != "用量统计" {
        HStack(alignment: .center, spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text(model.selected == "总览" ? "这台 Mac" : model.selected).font(.system(size: 20, weight: .semibold)).tracking(-0.4)
            Text(subtitle).font(.system(size: 13)).foregroundStyle(DesktopStyle.secondary).lineLimit(1)
          }
          Spacer()
          if model.busy { ProgressView().controlSize(.small) }
          Menu {
            Button("刷新状态") { model.refresh() }
            Button("启动服务") { model.action("start") }.disabled(model.healthy)
            Button("重启服务…") { confirm = "restart" }.disabled(!model.healthy)
            Button("停止服务…") { confirm = "stop" }.disabled(!model.healthy)
          } label: {
            Label("本机服务", systemImage: "ellipsis")
          }
          .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
          .padding(.horizontal, 12).frame(height: 30)
          .overlay { Capsule().strokeBorder(DesktopStyle.controlStroke, lineWidth: 1) }
          .disabled(model.busy || model.preview).accessibilityLabel("服务操作")
        }.padding(.bottom, 18)
      }
      if let problem = model.problem {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "exclamationmark.circle").foregroundStyle(DesktopStyle.waiting)
          Text(problem).font(.system(size: 12.5)).foregroundStyle(DesktopStyle.waiting).textSelection(.enabled)
          Spacer()
          Button("重试") { model.refresh() }.buttonStyle(DesktopPillStyle(.secondary, compact: true))
        }.padding(12).background(RoundedRectangle(cornerRadius: 10).fill(DesktopStyle.tint(DesktopStyle.waiting))).padding(.bottom, 14)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          switch model.selected {
          case "设备": devices
          case "访问密码": accessPassword
          case "用量统计": DesktopUsageView(model: model)
          case "日志": logs
          case "更新": updates
          case "设置": settings
          default: overview
          }
        }.frame(maxWidth: 880, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 12)
      }
    }.padding(.horizontal, 28).padding(.top, 22)
  }

  private var statusLine: some View {
    ZStack {
      WindowDragArea()
      HStack(spacing: 8) {
        Circle().fill(model.healthy ? DesktopStyle.mint : DesktopStyle.tertiary).frame(width: 6, height: 6)
        Text("服务\(model.serviceLabel) · 网关\(model.gatewayLabel)").foregroundStyle(DesktopStyle.tertiary)
        if let version = model.snapshot?.machine?.hostVersion { Text("Host \(version)").font(DesktopStyle.mono(11)).foregroundStyle(DesktopStyle.tertiary) }
        Spacer()
        Button(model.newVersion ? "有新版本 · 查看" : "检查更新") { model.selected = "更新"; model.checkUpdates() }
          .buttonStyle(.plain).foregroundStyle(model.newVersion ? DesktopStyle.mint : DesktopStyle.tertiary)
      }.font(.system(size: 12)).padding(.horizontal, DesktopStyle.gutter + 8)
    }
  }

  private var subtitle: String {
    switch model.selected {
    case "设备": return "扫描二维码配对手机，或管理已配对的设备"
    case "访问密码": return "其他设备打开这台电脑前，要先输入这台电脑的密码"
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
        Image(systemName: symbol).font(.system(size: 14)).frame(width: 18)
          .foregroundStyle(selected ? DesktopStyle.primary : DesktopStyle.tertiary)
        Text(title).font(.system(size: 13, weight: selected ? .medium : .regular))
        Spacer()
        if title == "更新" && model.newVersion { Circle().fill(DesktopStyle.mint).frame(width: 6, height: 6) }
      }.padding(.horizontal, 10).frame(height: 30).contentShape(Rectangle())
        .background { if selected { RoundedRectangle(cornerRadius: 8, style: .continuous).fill(DesktopStyle.selection) } }
    }.buttonStyle(.plain).foregroundStyle(selected ? DesktopStyle.primary : DesktopStyle.secondary)
  }
  private func row(_ title: String, _ value: String, good: Bool = false, warning: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Text(title).font(.system(size: 13)).lineLimit(1)
        Spacer()
        DesktopStatus(text: value, tone: warning ? DesktopStyle.waiting : good ? DesktopStyle.mint : DesktopStyle.tertiary)
          .lineLimit(1)
      }.frame(height: 44)
      rule
    }
  }
  private func valueRow(_ title: String, _ value: String, monospaced: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Text(title).font(.system(size: 13)).lineLimit(1)
        Spacer()
        Text(value)
          .font(monospaced ? DesktopStyle.mono(12) : .system(size: 13))
          .foregroundStyle(DesktopStyle.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
      }.frame(height: 44)
      rule
    }
  }
  private var overview: some View {
    VStack(alignment: .leading, spacing: 0) {
      accountSection
      if model.snapshot?.status == "stopped" {
        HStack {
          Text("启动后台服务后，即可从手机连接这台 Mac。").font(.system(size: 12.5)).foregroundStyle(DesktopStyle.secondary).lineLimit(1)
          Spacer()
          Button("启动服务") { model.action("start") }.buttonStyle(DesktopPillStyle(.primary, compact: true)).disabled(model.busy || model.preview)
        }.padding(.bottom, 14)
      }
      if model.externalHost {
        HStack {
          Text("当前服务由另一套 CLI 启动").font(.system(size: 12.5)).foregroundStyle(DesktopStyle.waiting).lineLimit(1)
          Spacer()
          Button("切换到 App 内置服务…") { confirm = "restart" }.buttonStyle(DesktopPillStyle(.secondary, compact: true)).disabled(model.busy)
        }.padding(.bottom, 14)
      }
      DesktopGroupLabel(title: "这台 Mac 的状态")
      // Four facts in one divided well: a label, the value as type, why, and the fix when there is one.
      HStack(alignment: .top, spacing: 0) {
        fact("本机服务", model.serviceLabel,
             model.healthy ? "手机和工作台随时可以连接" : "启动后，即可从手机连接这台 Mac",
             tone: model.healthy ? DesktopStyle.primary : DesktopStyle.waiting) {
          if !model.healthy { Button("启动") { model.action("start") }.buttonStyle(DesktopPillStyle(.primary, compact: true)).disabled(model.busy || model.preview) }
        }
        divider
        fact("网关", model.gatewayLabel,
             model.snapshot?.gateway?.error?.message ?? (model.snapshot?.gateway?.status == "online" ? "不在同一网络也能连上" : "只能在同一网络内连接"),
             tone: model.healthy && model.snapshot?.gateway?.status == "online" ? DesktopStyle.primary : DesktopStyle.secondary) { EmptyView() }
        divider
        fact("屏幕与控制", !model.permissionsKnown ? "检查中" : model.recording && model.control ? "已就绪" : "需要授权",
             model.recording && model.control ? "可以从手机查看和操作屏幕" : "需要录屏与辅助功能两项权限",
             tone: !model.permissionsKnown || (model.recording && model.control) ? DesktopStyle.primary : DesktopStyle.waiting) {
          if model.permissionsKnown && !(model.recording && model.control) { Button("授权") { model.permissions() }.buttonStyle(DesktopPillStyle(.secondary, compact: true)).disabled(model.preview) }
        }
        divider
        fact("已配对设备", model.devices.isEmpty ? "0" : "\(model.devices.count)",
             model.devices.isEmpty ? "扫码配对手机，或用同一账号登录" : "\(model.devices.filter(\.online).count) 台在线",
             unit: "台", tone: DesktopStyle.primary) {
          Button("管理设备") { model.selected = "设备" }.buttonStyle(DesktopPillStyle(.secondary, compact: true))
        }
      }.desktopCard(padding: 0)
      DesktopGroupLabel(title: "最近活动", trailing: model.activity.isEmpty ? nil : "最近 \(min(5, model.activity.count)) 条").padding(.top, 22)
      VStack(alignment: .leading, spacing: 0) {
        if model.activity.isEmpty { empty("尚无活动", "连接服务后，状态变化会显示在这里。").padding(.horizontal, 14) }
        ForEach(Array(model.activity.prefix(5).enumerated()), id: \.offset) { index, event in
          if index > 0 { rule }
          HStack(spacing: 16) {
            Text(event.0, style: .time).font(.system(size: 12).monospacedDigit()).foregroundStyle(DesktopStyle.tertiary).frame(width: 44, alignment: .leading)
            Text(event.1).font(.system(size: 13)).foregroundStyle(DesktopStyle.primary).lineLimit(1)
            Spacer(minLength: 0)
          }.frame(height: 38).padding(.horizontal, 14)
        }
      }.desktopCard(padding: 0)
    }
  }
  private var divider: some View { Rectangle().fill(DesktopStyle.line).frame(width: 1).padding(.vertical, 14) }
  private func fact<Action: View>(_ label: String, _ value: String, _ caption: String, unit: String? = nil, tone: Color, @ViewBuilder action: () -> Action) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(value).font(.system(size: 22, weight: .medium)).tracking(-0.4).foregroundStyle(tone).lineLimit(1).minimumScaleFactor(0.7)
        if let unit { Text(unit).font(.system(size: 12)).foregroundStyle(DesktopStyle.tertiary) }
      }
      Text(caption).font(.system(size: 12)).foregroundStyle(DesktopStyle.tertiary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
      action().padding(.top, 2)
    }.frame(maxWidth: .infinity, alignment: .topLeading).padding(16)
  }
  private var devices: some View {
    VStack(alignment: .leading, spacing: 0) {
      DesktopPairingView(model: model).padding(.bottom, 22)
      DesktopGroupLabel(title: "已配对设备", trailing: model.devices.isEmpty ? nil : "\(model.devices.count) 台")
      VStack(alignment: .leading, spacing: 0) {
        if model.devices.isEmpty { empty("暂无已配对设备", "在手机中打开「电脑 → 添加电脑」，扫描上方生成的二维码。") }
        ForEach(model.devices) { device in row(device.name, device.online ? "在线" : "离线", good: device.online) }
      }.rowsCard()
      if let url = model.snapshot?.gateway?.url { Text(url).font(DesktopStyle.mono(12)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled).padding(.top, 20) }
      if let error = model.snapshot?.gateway?.error?.message { Text(error).font(.footnote).foregroundStyle(DesktopStyle.waiting).padding(.top, 12) }
    }
  }
  private var accessPassword: some View {
    let enabled = model.snapshot?.access?.password ?? false
    let mismatch = !confirmPassword.isEmpty && confirmPassword != newPassword
    return VStack(alignment: .leading, spacing: 0) {
      DesktopGroupLabel(title: "这台电脑的密码")
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: enabled ? "lock.fill" : "lock.open").font(.system(size: 13)).foregroundStyle(enabled ? DesktopStyle.primary : DesktopStyle.tertiary).frame(width: 18).padding(.top, 1)
          VStack(alignment: .leading, spacing: 3) {
            Text(enabled ? "已开启" : "未设置").font(.system(size: 13, weight: .medium))
            Text(enabled ? "其他设备（手机、其他电脑）打开这台 Mac 前要先输入密码。这台 Mac 自己不用输。" : "设置后，同一账号或已配对的其他设备打开这台 Mac 前要先输入密码。随时可以修改或移除。")
              .font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 8)
          if !editingPassword {
            HStack(spacing: 6) {
              Button(enabled ? "修改" : "设置密码") { newPassword = ""; confirmPassword = ""; model.passwordMessage = ""; editingPassword = true }
                .buttonStyle(DesktopPillStyle(.secondary, compact: true)).disabled(model.busy || model.preview)
              if enabled {
                Button("移除") { confirm = "remove-password" }.buttonStyle(DesktopPillStyle(.quiet, compact: true)).disabled(model.busy || model.preview)
              }
            }
          }
        }
        if editingPassword {
          VStack(alignment: .leading, spacing: 8) {
            SecureField(enabled ? "新密码（至少 4 位）" : "密码（至少 4 位）", text: $newPassword).desktopField().frame(maxWidth: 280).accessibilityLabel("新密码")
            SecureField("再输一次", text: $confirmPassword).desktopField().frame(maxWidth: 280).accessibilityLabel("再输一次密码")
              .onSubmit { if newPassword.count >= 4 && newPassword == confirmPassword { model.setAccessPassword(newPassword); editingPassword = false } }
            if mismatch { Text("两次输入不一致").font(.system(size: 12)).foregroundStyle(DesktopStyle.waiting) }
            HStack(spacing: 8) {
              Button(model.savingPassword ? "正在保存…" : "保存") { model.setAccessPassword(newPassword); editingPassword = false }
                .buttonStyle(DesktopPillStyle(.primary, compact: true))
                .disabled(model.busy || newPassword.count < 4 || newPassword != confirmPassword)
              Button("取消") { editingPassword = false; newPassword = ""; confirmPassword = "" }.buttonStyle(DesktopPillStyle(.quiet, compact: true))
            }
          }.padding(.leading, 30)
        }
        if !model.passwordMessage.isEmpty {
          Text(model.passwordMessage).font(.system(size: 12)).foregroundStyle(model.passwordIsError ? DesktopStyle.waiting : DesktopStyle.secondary).padding(.leading, 30)
        }
      }.desktopCard(padding: 14)
      DesktopGroupLabel(title: "怎么生效").padding(.top, 22)
      VStack(alignment: .leading, spacing: 0) {
        valueRow("其他设备", "手机、网页和其他电脑上，这台电脑会带一把锁")
        valueRow("打开时", "先输入密码；输错 5 次要等 5 分钟")
        valueRow("记住多久", "同一台设备解锁后 7 天内不用再输")
        valueRow("修改或移除", "已连接的设备会断开，按新设置重新连接")
        valueRow("这台 Mac", "本机的工作台和命令行不需要密码")
      }.rowsCard()
      Text("每台电脑各自设置自己的密码，互不影响；没设密码的电脑照常使用。命令行也可以设置：linkshell password set")
        .font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled).padding(.top, 12)
    }
  }
  private var logs: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Button("刷新日志") { model.readLog() }.buttonStyle(DesktopPillStyle(.secondary))
        Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: model.home + "/host.log")]) }.buttonStyle(DesktopPillStyle(.quiet)).disabled(model.preview)
      }
      Text(model.preview ? "设计预览不读取本机日志。" : model.log)
        .font(DesktopStyle.mono(11.5)).lineSpacing(2)
        .foregroundStyle(DesktopStyle.secondary)
        .textSelection(.enabled)
        .desktopCard(padding: 14)
    }
  }
  private var updates: some View {
    VStack(alignment: .leading, spacing: 0) {
      DesktopGroupLabel(title: "版本")
      VStack(alignment: .leading, spacing: 0) {
      valueRow("安装来源", model.standalone ? "独立 App · 内置运行环境" : model.snapshot?.source == "homebrew" ? "Homebrew" : model.snapshot?.source == "npm" ? "npm / CLI" : "未知")
      valueRow("CLI 版本", model.snapshot?.cliVersion ?? "未知", monospaced: true)
      valueRow("运行中的 Host", model.snapshot?.machine?.hostVersion ?? "未连接", monospaced: true)
      valueRow("Mac 界面版本", Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版", monospaced: true)
      if model.standalone {
        HStack(spacing: 12) {
          Text("更新通道").font(.system(size: 13)).lineLimit(1); Spacer()
          DesktopSegmented(options: [("stable", "稳定版"), ("beta", "测试版")], selection: $model.updateChannel).disabled(model.busy || model.checking).accessibilityLabel("更新通道")
        }.frame(height: 44)
        rule
      } else { valueRow("更新通道", "稳定版 · latest") }
      HStack(spacing: 12) {
        Text("自动检查更新").font(.system(size: 13)).lineLimit(1)
        Spacer()
        Toggle("自动检查更新", isOn: $model.autoCheck).labelsHidden().toggleStyle(DesktopSwitchStyle()).disabled(model.preview).accessibilityLabel("自动检查更新")
      }.frame(height: 44)
      rule
      }.rowsCard()
      Text(model.updateMessage).font(.system(size: 13.5, weight: .medium)).padding(.top, 20).textSelection(.enabled)
      Text(model.standalone ? "App、内置 CLI、Host 与运行时作为整体更新。下载期间服务保持连接；仅在确认安装并重启时短暂重启服务，完成后自动恢复。" : "此安装通过 npm 或 Homebrew 更新。安装时可能重启后台服务，请先完成正在执行的任务。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineSpacing(4).padding(.top, 8)
      HStack(spacing: 12) {
        Button(model.checking ? "正在检查…" : "检查更新") { model.checkUpdates() }.buttonStyle(DesktopPillStyle(model.newVersion ? .secondary : .primary)).disabled(model.checking || model.preview)
        if model.newVersion {
          Button(model.standalone ? "下载并更新 App…" : "安装更新…") {
            if model.standalone { model.upgrade() } else { confirm = "upgrade" }
          }
            .buttonStyle(DesktopPillStyle(.primary))
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
          Button("取消登录") { model.cancelLogin() }.buttonStyle(DesktopPillStyle(.secondary))
        } else if model.signedIn {
          Button("退出登录…") { confirm = "logout" }.buttonStyle(DesktopPillStyle(.secondary)).disabled(model.busy)
        } else {
          Button("登录 / 注册") { model.login() }
            .buttonStyle(DesktopPillStyle(.primary))
            .disabled(model.busy || model.preview)
        }
      }
      if !model.accountMessage.isEmpty { Text(model.accountMessage).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled) }
      if model.signedIn {
        accountMembership
        if !model.redemptionMessage.isEmpty {
          Text(model.redemptionMessage).font(.system(size: 12))
            .foregroundStyle(model.redemptionIsError ? DesktopStyle.waiting : DesktopStyle.mint).textSelection(.enabled)
        }
        HStack {
          Text("网关：\(model.gatewayLabel)").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
          if model.snapshot?.gateway?.status != "online" {
            Button("连接官方网关…") { confirm = "connect-gateway" }.buttonStyle(DesktopPillStyle(.secondary, compact: true)).disabled(model.busy || model.preview)
          }
        }
        if let error = model.snapshot?.gateway?.error?.message { Text(error).font(.system(size: 12)).foregroundStyle(DesktopStyle.waiting).textSelection(.enabled) }
      } else {
        Text("官方网关需要 Pro；自建网关仍可通过配对使用。").font(.system(size: 11.5)).foregroundStyle(DesktopStyle.secondary)
      }
    }
    .desktopCard()
    .padding(.bottom, 22)
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
            .desktopField().disableAutocorrection(true).frame(maxWidth: 280)
            .disabled(model.busy || model.preview).onSubmit { model.redeemPro() }
            .accessibilityLabel("Pro 激活码")
          Button(model.redeeming ? "正在兑换…" : "兑换 Pro") { model.redeemPro() }
            .buttonStyle(DesktopPillStyle(.primary))
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
      DesktopGroupLabel(title: "外观与启动")
      VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 12) {
        Text("外观").font(.system(size: 13)).lineLimit(1); Spacer()
        DesktopSegmented(options: [("system", "跟随系统"), ("light", "浅色"), ("dark", "深色")], selection: $model.appearance).accessibilityLabel("外观")
      }.frame(height: 44)
      rule
      if model.standalone {
        HStack(spacing: 12) {
          Text("登录 Mac 时自动启动").font(.system(size: 13)).lineLimit(1)
          Spacer()
          Toggle("登录 Mac 时自动启动", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
            .labelsHidden().toggleStyle(DesktopSwitchStyle()).disabled(model.preview).accessibilityLabel("登录 Mac 时自动启动")
        }.frame(height: 44)
        Text("登录 Mac 后自动打开 LinkShell。每次打开桌面版都会启动后台服务并连接已配置的网关，无需再点“启动服务”。")
          .font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).padding(.bottom, 12)
        if model.loginApprovalRequired {
          Text("等待系统允许，请在“登录项”中启用 LinkShell。").font(.system(size: 12)).foregroundStyle(DesktopStyle.waiting)
          Button("打开系统登录项设置") { model.openLoginItems() }.buttonStyle(DesktopPillStyle(.secondary, compact: true)).padding(.vertical, 10).disabled(model.preview)
        }
        if !model.loginItemMessage.isEmpty {
          Text(model.loginItemMessage).font(.system(size: 12)).foregroundStyle(DesktopStyle.waiting).textSelection(.enabled).padding(.bottom, 10)
        }
      }
      }.rowsCard()
      DesktopGroupLabel(title: "让手机查看和控制这台 Mac").padding(.top, 22)
      VStack(alignment: .leading, spacing: 0) {
      row("屏幕录制", !model.permissionsKnown ? "未知" : model.recording ? "已授权" : "未授权", good: model.permissionsKnown && model.recording)
      row("辅助功能", !model.permissionsKnown ? "未知" : model.control ? "已授权" : "未授权", good: model.permissionsKnown && model.control)
      HStack(spacing: 12) {
        Text("需要修改系统授权时，可打开权限向导或系统设置。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineLimit(1)
        Spacer()
        Button("打开权限设置") { model.permissions() }.buttonStyle(DesktopPillStyle(.secondary, compact: true)).disabled(model.preview)
      }.frame(height: 44)
      rule
      }.rowsCard()
      DesktopGroupLabel(title: "数据").padding(.top, 22)
      VStack(alignment: .leading, spacing: 0) { valueRow("数据目录", model.home, monospaced: true) }.rowsCard()
      Text("窗口关闭后，LinkShell 留在菜单栏。退出界面不会停止 Host 或代理任务。")
        .font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).lineSpacing(4).padding(.top, 16)
      if model.standalone {
        DesktopGroupLabel(title: "命令行工具").padding(.top, 22)
        VStack(alignment: .leading, spacing: 0) {
        Text("使用 App 内置 CLI，与 App 一起升级。已有 npm / Homebrew 安装不会被改动。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary).padding(.top, 6)
        HStack(spacing: 12) {
          Button("安装到 ~/.local/bin") { model.installCommand() }.buttonStyle(DesktopPillStyle(.secondary)).disabled(model.preview)
          Button("重试恢复后台服务") { Task { await model.appUpdater.recover() } }.buttonStyle(DesktopPillStyle(.quiet)).disabled(model.busy || model.preview)
        }.padding(.top, 12)
        if !model.commandMessage.isEmpty { Text(model.commandMessage).font(.system(size: 12)).textSelection(.enabled).padding(.top, 8) }
        }.desktopCard()
      }
      HStack {
        Button("退出 LinkShell 界面") { NSApp.terminate(nil) }.buttonStyle(DesktopPillStyle(.quiet))
      }.padding(.top, 18)
    }
  }
  private func empty(_ title: String, _ detail: String) -> some View {
    VStack(alignment: .leading, spacing: 6) { Text(title).font(.system(size: 13, weight: .medium)); Text(detail).font(.system(size: 12)).foregroundStyle(DesktopStyle.tertiary) }.padding(.vertical, 18)
  }
}

struct DesktopPopover: View {
  @ObservedObject var model: DesktopModel
  let open: (String) -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(nsImage: NSImage(named: NSImage.applicationIconName) ?? NSImage()).resizable().frame(width: 28, height: 28)
        VStack(alignment: .leading, spacing: 1) {
          Text("LinkShell").font(.system(size: 14, weight: .semibold))
          Text(model.healthy ? "本机服务运行中" : "本机服务\(model.serviceLabel)").font(.system(size: 12)).foregroundStyle(DesktopStyle.tertiary)
        }
        Spacer()
        Circle().fill(model.healthy ? DesktopStyle.mint : DesktopStyle.tertiary).frame(width: 7, height: 7)
      }
      VStack(spacing: 0) {
        fact("网关", model.gatewayLabel, tone: model.snapshot?.gateway?.status == "online" ? DesktopStyle.mint : nil)
        Rectangle().fill(DesktopStyle.line).frame(height: 1).padding(.leading, 12)
        fact("会话", model.healthy ? "\(model.running) 个运行中" : "未知", tone: model.running > 0 ? DesktopStyle.mint : nil)
        if model.pending > 0 {
          Rectangle().fill(DesktopStyle.line).frame(height: 1).padding(.leading, 12)
          fact("等待确认", "\(model.pending) 个请求", tone: DesktopStyle.waiting)
        }
      }.desktopCard(padding: 0)
      VStack(spacing: 1) {
        link("macwindow", "打开工作台", "工作台", shortcut: "⌘1")
        link("chart.bar", "用量统计", "用量统计")
        link("arrow.triangle.2.circlepath", model.newVersion ? "有新版本…" : "检查更新…", "更新")
        link("gearshape", "设置…", "设置")
      }
    }
    .padding(14).frame(width: 300).background(DesktopStyle.panel).foregroundStyle(DesktopStyle.primary).preferredColorScheme(model.colorScheme)
  }
  private func fact(_ title: String, _ value: String, tone: Color? = nil) -> some View {
    HStack(spacing: 10) {
      Text(title).foregroundStyle(DesktopStyle.secondary)
      Spacer()
      if let tone { Circle().fill(tone).frame(width: 6, height: 6) }
      Text(value).foregroundStyle(tone == DesktopStyle.waiting ? DesktopStyle.waiting : DesktopStyle.primary)
    }.font(.system(size: 13)).padding(.horizontal, 12).frame(height: 38)
  }
  private func link(_ icon: String, _ title: String, _ page: String, shortcut: String? = nil) -> some View {
    PopoverRow(icon: icon, title: title, shortcut: shortcut) { open(page); if page == "更新" { model.checkUpdates() } }
  }
}

/// A menu row in the popover: a grey step under the pointer, the shortcut at the end.
private struct PopoverRow: View {
  let icon: String
  let title: String
  let shortcut: String?
  let action: () -> Void
  @State private var hovered = false
  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: icon).font(.system(size: 13)).foregroundStyle(DesktopStyle.tertiary).frame(width: 18)
        Text(title).font(.system(size: 13))
        Spacer()
        if let shortcut { Text(shortcut).font(.system(size: 12)).foregroundStyle(DesktopStyle.tertiary) }
      }
      .padding(.horizontal, 8).frame(height: 30).contentShape(Rectangle())
      .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(hovered ? DesktopStyle.raised : .clear))
    }
    .buttonStyle(.plain).onHover { hovered = $0 }
  }
}
