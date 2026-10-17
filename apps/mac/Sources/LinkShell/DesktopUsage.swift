import SwiftUI

struct DesktopUsageTotals: Decodable {
  let records: Double
  let sessions: Double
  let inputTokens: Double
  let outputTokens: Double
  let cacheReadTokens: Double
  let cacheWriteTokens: Double
  let totalTokens: Double
}
struct DesktopUsageDay: Decodable, Identifiable {
  let date: String
  let totalTokens: Double
  var id: String { date }
}
struct DesktopUsageModel: Decodable, Identifiable {
  let agent: String
  let model: String
  let totalTokens: Double
  let records: Double
  var id: String { agent + ":" + model }
}
struct DesktopUsageReport: Decodable {
  let generatedAt: Double
  let timezone: String
  let totals: DesktopUsageTotals
  let daily: [DesktopUsageDay]
  let models: [DesktopUsageModel]
  let warnings: [String]
}

struct DesktopUsageView: View {
  @ObservedObject var model: DesktopModel
  @State private var days = 7
  @State private var agent = "all"
  @State private var report: DesktopUsageReport?
  @State private var error: String?
  @State private var loading = false
  private var query: String { "usage-\(days)-\(agent)" }
  private func number(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0))) }
  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack {
        Picker("时间范围", selection: $days) { Text("今天").tag(1); Text("7 天").tag(7); Text("30 天").tag(30) }
          .pickerStyle(.segmented).frame(width: 210)
        Picker("代理", selection: $agent) { Text("全部").tag("all"); Text("Codex").tag("codex"); Text("Claude").tag("claude") }
          .frame(width: 180)
        Spacer()
        Button("刷新") { Task { await refresh() } }.disabled(loading || model.preview)
      }
      Text("来自这台电脑的 Codex / Claude 本地会话记录，包含终端和子代理；最多每分钟同步一次。")
        .font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
      if loading { ProgressView("正在读取用量…") }
      if let error { Text(error).foregroundStyle(.orange).font(.system(size: 13)).textSelection(.enabled) }
      if let report {
        HStack(spacing: 32) {
          metric("总 Token", report.totals.totalTokens)
          metric("用量记录", report.totals.records)
          metric("会话", report.totals.sessions)
        }
        HStack(spacing: 24) {
          metric("输入（不含缓存）", report.totals.inputTokens)
          metric("输出", report.totals.outputTokens)
          metric("缓存读取", report.totals.cacheReadTokens)
          metric("缓存写入", report.totals.cacheWriteTokens)
        }
        Text("每日用量").font(.headline)
        ForEach(report.daily) { day in
          HStack(spacing: 14) {
            Text(day.date).font(.system(size: 11, design: .monospaced)).frame(width: 85, alignment: .leading)
            GeometryReader { geometry in
              RoundedRectangle(cornerRadius: 3).fill(DesktopStyle.mint.opacity(0.7))
                .frame(width: geometry.size.width * day.totalTokens / max(1, report.daily.map(\.totalTokens).max() ?? 1))
            }.frame(height: 8)
            Text(number(day.totalTokens)).font(.system(size: 11, design: .monospaced)).frame(width: 90, alignment: .trailing)
          }.accessibilityElement(children: .combine)
        }
        Text("模型分布").font(.headline)
        if report.models.isEmpty { Text("所选时间内暂无用量记录。").foregroundStyle(DesktopStyle.secondary) }
        ForEach(report.models) { entry in
          HStack {
            VStack(alignment: .leading, spacing: 5) {
              Text(entry.model).font(.system(size: 13))
              Text("\(entry.agent) · \(number(entry.records)) 条记录").font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
            }
            Spacer()
            Text("\(number(entry.totalTokens)) Token").font(.system(size: 13, design: .monospaced))
          }
        }
        ForEach(report.warnings, id: \.self) { Text($0).font(.system(size: 12)).foregroundStyle(.orange) }
        Text("按电脑时区 \(report.timezone) 汇总 · \(Date(timeIntervalSince1970: report.generatedAt / 1000).formatted(date: .omitted, time: .shortened)) 更新。仅统计日志已记录的 Token，不代表订阅剩余额度或实际账单；其他代理暂未纳入。")
          .font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
      }
    }.task(id: query) { await refresh() }
  }
  private func metric(_ title: String, _ value: Double) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(title).font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
      Text(number(value)).font(.system(size: 21, weight: .semibold, design: .rounded)).minimumScaleFactor(0.6).lineLimit(1)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  private func refresh() async {
    guard !model.preview else { return }
    let requested = query
    loading = true; error = nil; report = nil
    do {
      let data = try await Task.detached { try DesktopCommand.run(["desktop", "--action", requested], timeout: 125) }.value
      guard !Task.isCancelled, requested == query else { return }
      report = try JSONDecoder().decode(DesktopUsageReport.self, from: data)
    } catch {
      guard !Task.isCancelled, requested == query else { return }
      self.error = "无法读取用量，请确认后台服务已启动且为新版：\(error.localizedDescription)"
    }
    if requested == query { loading = false }
  }
}
