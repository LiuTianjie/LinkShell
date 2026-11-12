import SwiftUI

struct WatchConnectionView: View {
  @ObservedObject var store: WatchSessionStore
  @State private var confirmLogout = false

  var body: some View {
    List {
      Section("连接方式") {
        Toggle("腕表独立连接", isOn: Binding(get: { store.independent }, set: { store.setIndependent($0) }))
          .disabled(store.pendingCommandId != nil)
        Text(store.independent ? "通过 Wi-Fi 或蜂窝网络连接电脑，打开腕表 App 时同步。" : "通过已配对的 iPhone 同步，请在手机上打开 LinkShell。")
          .font(.caption).foregroundStyle(.secondary)
      }
      if store.independent {
        Section("连接状态") {
          Text(store.direct.status).font(.caption)
          Button("重新连接") { store.direct.reconnect() }
        }
        Section("账号与配对") {
          if store.direct.signedIn {
            Text(store.direct.email ?? "已登录").font(.caption)
            if let account = store.direct.account {
              NavigationLink("iTool 会员") { WatchMembershipView(account: account) }
            }
            Button("退出账号", role: .destructive) { confirmLogout = true }
          } else {
            NavigationLink("登录账号") { WatchLoginView(client: store.direct) }
          }
          NavigationLink("配对电脑") { WatchPairView(client: store.direct) }
        }
      }
    }
    .navigationTitle("连接设置")
    .confirmationDialog("退出腕表上的账号？", isPresented: $confirmLogout) {
      Button("退出账号", role: .destructive) {
        do { try store.direct.signOut() }
        catch { store.showNotice(ok: false, text: error.localizedDescription) }
      }
    }
  }
}

struct WatchMembershipView: View {
  @ObservedObject var account: WatchAccount

  var body: some View {
    List {
      if account.session != nil {
        Section("账户权益") {
          switch account.membership {
          case .unknown:
            Text(account.membershipLoading ? "正在查询…" : "账户状态未确认").font(.caption)
          case .free:
            Label("基础账户", systemImage: "person.crop.circle")
          case .trial(let expiry, let days):
            Label("7 天免费试用 · 剩余 \(days) 天", systemImage: "clock.badge.checkmark")
            Text("有效期至 \(expiry.formatted(date: .abbreviated, time: .omitted))")
              .font(.caption).foregroundStyle(.secondary)
          case .pro(let expiry, let yearly):
            Label(yearly ? "iTool 年度会员" : "iTool 月度会员", systemImage: "checkmark.seal.fill")
            Text("有效期至 \(expiry.formatted(date: .abbreviated, time: .omitted))")
              .font(.caption).foregroundStyle(.secondary)
          }
          Button(account.membershipLoading ? "正在刷新…" : "刷新账户状态") {
            Task { await account.refreshMembership() }
          }.disabled(account.membershipLoading)
        }
        if account.membership == .free {
          // Text only: the watch sells nothing and never links to any purchase page (App Store 3.1.1).
          Text("可在电脑端 LinkShell 管理账户状态")
            .font(.caption2).foregroundStyle(.secondary)
        }
        if let error = account.membershipError {
          Text(error).font(.caption).foregroundStyle(WatchPalette.danger)
        }
      } else {
        Text("请先登录账号").font(.caption).foregroundStyle(.secondary)
      }
    }
    .navigationTitle("iTool 会员")
    .task(id: account.session?.userID) {
      await account.refreshMembership()
    }
  }
}

struct WatchLoginView: View {
  @ObservedObject var client: WatchDirectClient
  @Environment(\.dismiss) private var dismiss
  @State private var email = ""
  @State private var password = ""
  @State private var errorText: String?

  var body: some View {
    List {
      Text("使用 iTool 账号登录，同账号的电脑会自动显示。")
        .font(.caption).foregroundStyle(.secondary)
      TextField("邮箱", text: $email).textContentType(.emailAddress)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
      SecureField("密码", text: $password).textContentType(.password)
      if let errorText { Text(errorText).font(.caption).foregroundStyle(WatchPalette.danger) }
      Button(client.working ? "正在登录…" : "登录") {
        Task {
          do {
            try await client.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            password = ""; dismiss()
          } catch { errorText = error.localizedDescription }
        }
      }.disabled(client.working || email.isEmpty || password.isEmpty)
      Text("使用第三方登录的账号也可以选择配对电脑，无需输入密码。")
        .font(.caption).foregroundStyle(.secondary)
    }.navigationTitle("登录账号")
  }
}

struct WatchPairView: View {
  @ObservedObject var client: WatchDirectClient
  @Environment(\.dismiss) private var dismiss
  @State private var code = ""
  @State private var errorText: String?
  @State private var gateway = ""

  var body: some View {
    List {
      Text("在电脑运行 linkshell pair，将六位配对码填入下方。")
        .font(.caption).foregroundStyle(.secondary)
      TextField("六位配对码", text: $code).textContentType(.oneTimeCode)
      Text(client.status).font(.caption).foregroundStyle(.secondary)
      if let errorText { Text(errorText).font(.caption).foregroundStyle(WatchPalette.danger) }
      Button(client.working ? "正在配对…" : "配对电脑") {
        Task {
          do { try await client.pair(code: code); dismiss() }
          catch { errorText = error.localizedDescription }
        }
      }.disabled(client.working || !client.gatewayReady || code.filter(\.isNumber).count != 6)
      Section("网关") {
        TextField("HTTPS 网关地址", text: $gateway)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
        Button("连接此网关") { client.gatewayText = gateway; client.reconnect() }
        Text("电脑和腕表需要使用同一网关。自建网关需要支持腕表连接。")
          .font(.caption).foregroundStyle(.secondary)
      }
    }.navigationTitle("配对电脑")
      .onAppear { gateway = client.gatewayText }
  }
}
