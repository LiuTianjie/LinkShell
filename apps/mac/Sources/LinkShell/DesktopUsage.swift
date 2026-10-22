import SwiftUI
import Charts

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
  let records: Double?
  let date: String
  let totalTokens: Double
  var id: String { date }
}
struct DesktopUsageModel: Decodable, Identifiable {
  let inputTokens: Double?
  let outputTokens: Double?
  let cacheReadTokens: Double?
  let agent: String
  let model: String
  let totalTokens: Double
  let records: Double
  var id: String { agent + ":" + model }
}
struct DesktopUsageAgent: Decodable, Identifiable {
  let id: String
  let label: String
  let source: String
  let status: String
  let records: Double
  let totalTokens: Double
  let note: String
}
struct DesktopUsageReport: Decodable {
  let generatedAt: Double
  let timezone: String
  let totals: DesktopUsageTotals
  let daily: [DesktopUsageDay]
  let models: [DesktopUsageModel]
  let warnings: [String]
  let agents: [DesktopUsageAgent]?
}

struct DesktopUsageView: View {
  @ObservedObject var model: DesktopModel
  @State private var days = 7
  @State private var agent = "all"
  @State private var agents: [DesktopUsageAgent] = []
  @State private var report: DesktopUsageReport?
  @State private var error: String?
  @State private var loading = false
  private var query: String { "usage-\(days)-\(agent)" }
  @State private var selectedDate: String?
  @State private var chartMetric = "tokens"
  private func number(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0))) }
  private func compact(_ value: Double) -> String {
    for (scale, suffix) in [(1e9, "B"), (1e6, "M"), (1e3, "K")] {
      if value >= scale { return String(format: "%.1f%@", value / scale, suffix) }
    }
    return number(value)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      HStack(alignment: .center, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text("用量统计").font(.system(size: 20, weight: .semibold)).tracking(-0.4)
          Text("这台电脑的 Token 用量与模型分布").font(.system(size: 13)).foregroundStyle(DesktopStyle.secondary)
        }
        Spacer()
        Text(model.preview ? "示例数据" : "本机统计").font(.system(size: 11.5)).foregroundStyle(DesktopStyle.secondary)
        if loading { ProgressView().controlSize(.small) }
        Button { Task { await refresh() } } label: { Label("立即同步", systemImage: "arrow.clockwise") }
          .buttonStyle(DesktopPillStyle(.secondary)).disabled(loading || model.preview)
      }.padding(.bottom, 9)
      HStack(spacing: 6) {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 2) {
            agentTab("全部", "all")
            ForEach(agents) { entry in agentTab(entry.label, entry.id) }
          }.padding(2).background(Capsule().fill(DesktopStyle.raised))
        }.fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 4)
        Picker("时间", selection: $days) { Text("今天").tag(1); Text("最近 7 天").tag(7); Text("最近 30 天").tag(30) }.labelsHidden().frame(width: 98)
      }
      if let error { Text(error).foregroundStyle(DesktopStyle.waiting).font(.system(size: 12)) }
      if let report {
        if report.totals.records == 0 {
          Text("所选范围暂无可用数据；未上报用量不等于零消耗。").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
        }
        HStack(spacing: 0) {
          metric("总用量", compact(report.totals.totalTokens), "Token", exact: number(report.totals.totalTokens) + " Token")
          Rectangle().fill(DesktopStyle.line).frame(width: 1).padding(.vertical, 12)
          metric("用量记录", number(report.totals.records), "条", exact: "本地日志中的去重用量记录，并非网络请求数")
          Rectangle().fill(DesktopStyle.line).frame(width: 1).padding(.vertical, 12)
          metric("会话", number(report.totals.sessions), "个", exact: "所选 Agent 和时间范围内的会话")
          Rectangle().fill(DesktopStyle.line).frame(width: 1).padding(.vertical, 12)
          metric("缓存读取占比", String(format: "%.1f", report.totals.cacheReadTokens / max(1, report.totals.totalTokens) * 100), "%", exact: "缓存读取 Token / 总 Token，不等同于请求缓存命中率")
        }.desktopCard(padding: 0)
        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text("使用趋势").font(.system(size: 13.5, weight: .semibold))
            Text(agents.first(where: { $0.id == agent })?.label ?? "全部 Agent").font(.system(size: 11.5)).foregroundStyle(DesktopStyle.secondary)
            Circle().fill(DesktopStyle.accent).frame(width: 7, height: 7)
            Text(chartMetric == "tokens" ? "Token" : "记录（条）").font(.system(size: 11.5)).foregroundStyle(DesktopStyle.secondary)
            Spacer()
            Picker("趋势指标", selection: $chartMetric) { Text("Token").tag("tokens"); Text("记录").tag("records") }.pickerStyle(.segmented).labelsHidden().frame(width: 135)
          }
          Chart(report.daily) { day in
            BarMark(x: .value("日期", day.date), y: .value(chartMetric == "tokens" ? "Token" : "记录（条）", chartMetric == "tokens" ? day.totalTokens : (day.records ?? 0)))
              .foregroundStyle(DesktopStyle.accent.opacity(selectedDate == nil || selectedDate == day.date ? 0.85 : 0.35)).cornerRadius(4)
              .accessibilityLabel(day.date).accessibilityValue("\(number(chartMetric == "tokens" ? day.totalTokens : (day.records ?? 0))) \(chartMetric == "tokens" ? "Token" : "条")")
          }
          .chartYAxis { AxisMarks(position: .leading) { value in AxisGridLine(); AxisValueLabel { if let n = value.as(Double.self) { Text(compact(n)) } } } }
          .chartXAxis { AxisMarks(values: report.daily.enumerated().filter { $0.offset % max(1, days / 7) == 0 }.map { $0.element.date }) { value in AxisValueLabel { if let date = value.as(String.self) { Text(String(date.suffix(5))) } } } }
          .chartOverlay { proxy in
            GeometryReader { geo in
              Rectangle().fill(.clear).contentShape(Rectangle()).onContinuousHover { phase in
                switch phase {
                case .active(let point): selectedDate = proxy.value(atX: point.x - geo[proxy.plotAreaFrame].origin.x, as: String.self)
                case .ended: selectedDate = nil
                }
              }
            }
          }.frame(height: 96)
          HStack {
            if let day = report.daily.first(where: { $0.date == selectedDate }) {
              Text("\(day.date) · \(number(chartMetric == "tokens" ? day.totalTokens : (day.records ?? 0))) \(chartMetric == "tokens" ? "Token" : "条")")
            } else { Text(report.totals.totalTokens == 0 ? "暂无用量记录" : "按日汇总 · 悬停查看完整数值") }
            Spacer()
            Text("K = 千 · M = 百万 · B = 十亿")
          }.font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
        }
        .desktopCard(padding: 12)
        VStack(alignment: .leading, spacing: 0) {
          HStack {
            Text("模型明细").font(.system(size: 13.5, weight: .semibold))
            Text("\(report.models.count)").font(.system(size: 11.5)).foregroundStyle(DesktopStyle.secondary)
            Spacer()
            Text("按 Agent / 模型汇总 · Token").font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
          }.padding(.top, 2).padding(.bottom, 6)
          Rectangle().fill(DesktopStyle.line).frame(height: 1)
          HStack(spacing: 12) {
            Text("Agent").frame(width: 120, alignment: .leading)
            Text("模型").frame(maxWidth: .infinity, alignment: .leading)
            column("记录（条）"); column("输入"); column("输出"); column("缓存读取"); column("总 Token")
          }.font(.system(size: 11.5, weight: .medium)).foregroundStyle(DesktopStyle.secondary).frame(height: 32)
          ForEach(report.models) { entry in
            Rectangle().fill(DesktopStyle.line.opacity(0.6)).frame(height: 1)
            HStack(spacing: 12) {
              HStack(spacing: 8) {
                DesktopAgentMark(agent: entry.agent, size: 17)
                Text(agents.first(where: { $0.id == entry.agent })?.label ?? entry.agent)
                  .lineLimit(1)
              }.frame(width: 120, alignment: .leading)
              Text(entry.model).lineLimit(1).help(entry.model).frame(maxWidth: .infinity, alignment: .leading)
              column(number(entry.records)); column(compact(entry.inputTokens ?? 0)); column(compact(entry.outputTokens ?? 0)); column(compact(entry.cacheReadTokens ?? 0)); column(compact(entry.totalTokens))
            }.font(.system(size: 12)).monospacedDigit().frame(height: 36)
          }
          if report.models.isEmpty { Text("所选范围暂无模型用量").font(.footnote).foregroundStyle(DesktopStyle.secondary).padding(.vertical, 16) }
        }
        if agent == "all", !agents.filter({ $0.status == "no_data" }).isEmpty {
          Text(agents.filter { $0.status == "no_data" }.map(\.label).joined(separator: "、") + " 暂无用量数据")
            .font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
        }
        ForEach(report.warnings, id: \.self) { Text($0).font(.system(size: 11)).foregroundStyle(DesktopStyle.waiting) }
        if let selected = agents.first(where: { $0.id == agent }) {
          Text(selected.note).font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
        }
        Text("\(model.preview ? "示例数据 · " : "")\(report.timezone) · 输入不含缓存 · 本地日志统计，不代表账单或剩余额度").font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary).padding(.bottom, 4)
      }
    }.task(id: query) { selectedDate = nil; await refresh() }
  }
  private func agentTab(_ title: String, _ value: String) -> some View {
    let selected = agent == value
    return Button { agent = value } label: {
      HStack(spacing: 3.5) {
        if value != "all" { DesktopAgentMark(agent: value, size: 13) }
        Text(title)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(selected ? DesktopStyle.primary : DesktopStyle.secondary)
          .lineLimit(1)
          .fixedSize(horizontal: true, vertical: false)
      }
      .padding(.horizontal, 9)
      .frame(height: 26)
      .background(Capsule().fill(selected ? DesktopStyle.selection : .clear))
      .contentShape(Capsule())
    }.buttonStyle(.plain).help(title).accessibilityLabel(title).accessibilityAddTraits(selected ? [.isSelected] : [])
  }
  private func column(_ text: String) -> some View { Text(text).frame(width: 68, alignment: .trailing).lineLimit(1).minimumScaleFactor(0.85).help(text) }
  private func metric(_ title: String, _ value: String, _ unit: String, exact: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(report?.totals.records == 0 ? "—" : value).font(.system(size: 22, weight: .medium)).monospacedDigit().minimumScaleFactor(0.7).lineLimit(1)
        Text(unit).font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
      }
    }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
      .help(exact)
  }
  private func refresh() async {
    guard !model.preview else {
      let fixture = #"{"generatedAt":0,"timezone":"Asia/Shanghai","totals":{"records":1248,"sessions":86,"inputTokens":3200000,"outputTokens":1280000,"cacheReadTokens":7680000,"cacheWriteTokens":640000,"totalTokens":12800000},"daily":[{"date":"2026-10-11","totalTokens":1200000,"records":116},{"date":"2026-10-12","totalTokens":1800000,"records":176},{"date":"2026-10-13","totalTokens":950000,"records":92},{"date":"2026-10-14","totalTokens":2400000,"records":234},{"date":"2026-10-15","totalTokens":1650000,"records":161},{"date":"2026-10-16","totalTokens":3100000,"records":303},{"date":"2026-10-17","totalTokens":1700000,"records":166}],"models":[{"agent":"codex","model":"gpt-5.4","records":580,"inputTokens":1275000.0,"outputTokens":510000.0,"cacheReadTokens":3060000.0,"totalTokens":5100000},{"agent":"claude","model":"claude-opus-4-6","records":260,"inputTokens":800000.0,"outputTokens":320000.0,"cacheReadTokens":1920000.0,"totalTokens":3200000},{"agent":"gemini","model":"gemini-2.5-pro","records":160,"inputTokens":450000.0,"outputTokens":180000.0,"cacheReadTokens":1080000.0,"totalTokens":1800000},{"agent":"antigravity","model":"gemini-2.5-pro","records":128,"inputTokens":350000.0,"outputTokens":140000.0,"cacheReadTokens":840000.0,"totalTokens":1400000},{"agent":"copilot","model":"gpt-5.4","records":80,"inputTokens":212500.0,"outputTokens":85000.0,"cacheReadTokens":510000.0,"totalTokens":850000},{"agent":"opencode","model":"claude-sonnet-4-6","records":40,"inputTokens":112500.0,"outputTokens":45000.0,"cacheReadTokens":270000.0,"totalTokens":450000}],"warnings":[],"agents":[{"id":"codex","label":"Codex","source":"native","status":"available","records":580,"totalTokens":5100000,"note":"本机原生日志"},{"id":"claude","label":"Claude","source":"native","status":"available","records":260,"totalTokens":3200000,"note":"本机原生日志"},{"id":"gemini","label":"Gemini","source":"acp","status":"available","records":160,"totalTokens":1800000,"note":"LinkShell 已记录的 Agent 用量"},{"id":"antigravity","label":"Antigravity","source":"acp","status":"available","records":128,"totalTokens":1400000,"note":"LinkShell 已记录的 Agent 用量"},{"id":"copilot","label":"Copilot","source":"acp","status":"available","records":80,"totalTokens":850000,"note":"LinkShell 已记录的 Agent 用量"},{"id":"grok","label":"Grok","source":"acp","status":"no_data","records":0,"totalTokens":0,"note":"LinkShell 已记录的 Agent 用量"},{"id":"opencode","label":"OpenCode","source":"acp","status":"available","records":40,"totalTokens":450000,"note":"LinkShell 已记录的 Agent 用量"},{"id":"cursor","label":"Cursor","source":"acp","status":"no_data","records":0,"totalTokens":0,"note":"LinkShell 已记录的 Agent 用量"}]}"#
      report = try? JSONDecoder().decode(DesktopUsageReport.self, from: Data(fixture.utf8)); agents = report?.agents ?? []; return
    }
    let requested = query
    loading = true; error = nil; report = nil
    do {
      let data = try await Task.detached { try DesktopCommand.run(["desktop", "--action", requested], timeout: 125) }.value
      guard !Task.isCancelled, requested == query else { return }
      report = try JSONDecoder().decode(DesktopUsageReport.self, from: data)
      agents = report?.agents ?? []
    } catch {
      guard !Task.isCancelled, requested == query else { return }
      self.error = "无法读取用量，请确认后台服务已启动且为新版：\(error.localizedDescription)"
    }
    if requested == query { loading = false }
  }
}
