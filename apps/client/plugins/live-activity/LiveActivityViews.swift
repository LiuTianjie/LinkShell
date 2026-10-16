private func collectionURL(_ computerKey: String?, filter: String = "all") -> URL {
  var url = URLComponents()
  url.scheme = Bundle.main.object(forInfoDictionaryKey: "LinkShellURLScheme") as? String ?? "linkshell"
  url.host = ""
  url.path = "/activity"
  url.queryItems = [URLQueryItem(name: "computer", value: computerKey ?? ""), URLQueryItem(name: "filter", value: filter)]
  return url.url!
}

@available(iOS 16.2, *)
struct ActivityCountsView: View {
  let state: LinkShellAttentionAttributes.ContentState
  let computerKey: String?

  var body: some View {
    HStack(spacing: 10) {
      if state.runningCount + state.waitingCount + state.failedCount > 1 {
        count(state.runningCount, color: .white.opacity(0.58), label: "进行中", filter: "running")
        count(state.waitingCount, color: .orange.opacity(0.9), label: "待处理", filter: "attention")
        count(state.failedCount, color: .red.opacity(0.9), label: "出错", filter: "failed")
      } else {
        Link(destination: activityURL(state.deepLink) ?? collectionURL(computerKey)) {
          HStack(spacing: 4) {
            Text("查看详情")
            Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .medium))
          }
          .foregroundColor(.white.opacity(0.6))
          .frame(minHeight: 36)
        }
      }
    }
    .font(.system(size: 11, weight: .medium))
  }

  @ViewBuilder private func count(_ value: Int, color: Color, label: String, filter: String) -> some View {
    if value > 0 {
      Link(destination: collectionURL(computerKey, filter: filter)) {
        Text("\(value) \(label)").monospacedDigit()
          .foregroundColor(color)
          .frame(minHeight: 36)
      }
      .accessibilityLabel("查看 \(value) 个\(label)任务")
    }
  }
}

@available(iOS 16.2, *)
struct TaskPagerView: View {
  let activityID: String
  let state: LinkShellAttentionAttributes.ContentState
  let computerKey: String?

  var body: some View {
    if let tasks = state.tasks, tasks.count > 1 {
      HStack(spacing: 0) {
        if #available(iOS 17.0, *) { pageButton(-1, symbol: "chevron.left", label: "上一个任务") }
        Link(destination: collectionURL(computerKey)) {
          HStack(spacing: 4) {
            ForEach(tasks.indices, id: \.self) { index in
              Capsule()
                .fill(.white.opacity(index == state.selectedIndex(activityID: activityID) ? 0.85 : 0.22))
                .frame(width: index == state.selectedIndex(activityID: activityID) ? 10 : 4, height: 4)
            }
          }
          .frame(minWidth: 24, minHeight: 36)
        }
        .accessibilityLabel("当前第 \((state.selectedIndex(activityID: activityID) ?? 0) + 1) 个任务，查看全部任务")
        if #available(iOS 17.0, *) { pageButton(1, symbol: "chevron.right", label: "下一个任务") }
      }
      .foregroundColor(.white.opacity(0.7))
      .fixedSize()
    }
  }

  @available(iOS 17.0, *)
  private func pageButton(_ direction: Int, symbol: String, label: String) -> some View {
    Button(intent: LinkShellActivityBrowseIntent(activityID: activityID, direction: direction)) {
      Image(systemName: symbol)
        .font(.system(size: 11, weight: .semibold))
        .frame(width: 36, height: 36)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

@available(iOS 16.2, *)
struct ActivityFooterView: View {
  let activityID: String
  let state: LinkShellAttentionAttributes.ContentState
  let computerKey: String?

  var body: some View {
    HStack(spacing: 8) {
      if !(state.actions ?? []).isEmpty || state.hasMoreActions == true {
        ActivityActionsView(state: state)
      } else {
        ActivityCountsView(state: state, computerKey: computerKey)
      }
      Spacer(minLength: 0)
      TaskPagerView(activityID: activityID, state: state, computerKey: computerKey)
    }
    .frame(height: 36)
  }
}

@available(iOS 16.2, *)
struct ActivityStatusLink: View {
  let state: LinkShellAttentionAttributes.ContentState
  let computerKey: String?

  var body: some View {
    let filter = state.phase == "failed" ? "failed" : state.phase.hasPrefix("waiting") ? "attention" : state.phase == "completed" ? "completed" : "running"
    Link(destination: collectionURL(computerKey, filter: filter)) {
      StatusIndicatorView(state: state, size: 22, showsCount: false)
    }
    .accessibilityHint("查看这类任务")
  }
}

@available(iOS 16.2, *)
struct LockScreenBannerView: View {
  let context: ActivityViewContext<LinkShellAttentionAttributes>

  var body: some View {
    let state = context.displayState
    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 8) {
        AgentBadgeView(agent: ActivityAgent(id: state.agent), size: 26)
        ActivityTextView(text: state.project.isEmpty ? context.attributes.computerName : "\(state.project) · \(context.attributes.computerName)")
          .font(.system(size: 12, weight: .medium))
          .foregroundColor(.white.opacity(0.56))
          .lineLimit(1)
        Spacer(minLength: 2)
        ActivityStatusLink(state: state, computerKey: context.attributes.computerKey)
      }
      Link(destination: activityURL(state.deepLink) ?? collectionURL(context.attributes.computerKey)) {
        VStack(alignment: .leading, spacing: 4) {
          ActivityTextView(text: state.title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundColor(.white)
            .lineLimit(1)
          ActivityTextView(text: state.effectiveSubtitle)
            .font(.system(size: 13))
            .foregroundColor(.white.opacity(0.65))
            .lineLimit(2, reservesSpace: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .multilineTextAlignment(.leading)
      }
      .accessibilityHint("打开当前任务详情")
      ActivityFooterView(activityID: context.activityID, state: state, computerKey: context.attributes.computerKey)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .activityBackgroundTint(Color(red: 0.055, green: 0.06, blue: 0.07).opacity(0.96))
    .activitySystemActionForegroundColor(.white)
  }
}

@available(iOS 16.2, *)
struct LinkShellAttentionWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LinkShellAttentionAttributes.self) { context in
      LockScreenBannerView(context: context)
        .widgetURL(activityURL(context.displayState.deepLink))
    } dynamicIsland: { context in
      let state = context.displayState
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 7) {
            AgentBadgeView(agent: ActivityAgent(id: state.agent), size: 24)
            ActivityTextView(text: state.project)
              .font(.system(size: 12, weight: .medium))
              .foregroundColor(.white.opacity(0.56))
              .lineLimit(1)
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          ActivityStatusLink(state: state, computerKey: context.attributes.computerKey).padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Link(destination: activityURL(state.deepLink) ?? collectionURL(context.attributes.computerKey)) {
              VStack(alignment: .leading, spacing: 4) {
                ActivityTextView(text: state.title)
                  .font(.system(size: 14, weight: .semibold)).foregroundColor(.white).lineLimit(1)
                ActivityTextView(text: state.effectiveSubtitle)
                  .font(.system(size: 12)).foregroundColor(.white.opacity(0.65)).lineLimit(2)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
              .multilineTextAlignment(.leading)
            }
            ActivityFooterView(activityID: context.activityID, state: state, computerKey: context.attributes.computerKey)
          }
          .padding(.horizontal, 6)
          .padding(.top, 4)
        }
      } compactLeading: {
        AgentStackView(state: state, size: 20, limit: 2).padding(.leading, 2)
      } compactTrailing: {
        StatusIndicatorView(state: state, size: 22).padding(.trailing, 2)
      } minimal: {
        StatusIndicatorView(state: state, size: 22, showsCount: false)
      }
      .widgetURL(state.waitingCount + state.runningCount + state.failedCount > 1
        ? collectionURL(context.attributes.computerKey) : activityURL(state.deepLink))
      .keylineTint(state.phaseColor)
    }
  }
}

@main
@available(iOS 16.2, *)
struct LinkShellLiveActivityBundle: WidgetBundle {
  var body: some Widget { LinkShellAttentionWidget() }
}
