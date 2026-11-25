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
  var isWidthLimited = false

  private var minTapHeight: CGFloat { isWidthLimited ? 32 : 36 }

  var body: some View {
    Group {
      if state.runningCount + state.waitingCount + state.failedCount > 1 {
        ViewThatFits(in: .horizontal) {
          if !isWidthLimited {
            countsRow(spacing: 10, runningLabel: "进行中", waitingLabel: "等你处理", failedLabel: "出错")
          }
          countsRow(spacing: isWidthLimited ? 6 : 8, runningLabel: "运行", waitingLabel: "待处理", failedLabel: "出错")
          compactDotCountsRow
        }
      } else {
        Link(destination: activityURL(state.deepLink) ?? collectionURL(computerKey)) {
          ViewThatFits(in: .horizontal) {
            if !isWidthLimited {
              detailLabel("查看详情")
            }
            detailLabel("详情")
          }
          .foregroundColor(.white.opacity(0.62))
          .frame(minHeight: minTapHeight)
        }
      }
    }
    .font(.system(size: isWidthLimited ? 10.5 : 11, weight: .medium))
  }

  private func detailLabel(_ title: String) -> some View {
    HStack(spacing: 4) {
      Text(title).lineLimit(1)
      Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .medium))
    }
    .fixedSize(horizontal: true, vertical: false)
  }

  private func countsRow(spacing: CGFloat, runningLabel: String, waitingLabel: String, failedLabel: String) -> some View {
    HStack(spacing: spacing) {
      count(state.runningCount, color: .white.opacity(0.58), label: runningLabel, accessibilityLabel: "进行中", filter: "running")
      count(state.waitingCount, color: ActivityPalette.waiting, label: waitingLabel, accessibilityLabel: "等你处理", filter: "attention")
      count(state.failedCount, color: ActivityPalette.danger, label: failedLabel, accessibilityLabel: "出错", filter: "failed")
    }
    .fixedSize(horizontal: true, vertical: false)
  }

  private var compactDotCountsRow: some View {
    HStack(spacing: 7) {
      dotCount(state.runningCount, color: .white.opacity(0.62), accessibilityLabel: "进行中", filter: "running")
      dotCount(state.waitingCount, color: ActivityPalette.waiting, accessibilityLabel: "等你处理", filter: "attention")
      dotCount(state.failedCount, color: ActivityPalette.danger, accessibilityLabel: "出错", filter: "failed")
    }
    .fixedSize(horizontal: true, vertical: false)
  }

  @ViewBuilder private func count(_ value: Int, color: Color, label: String, accessibilityLabel: String, filter: String) -> some View {
    if value > 0 {
      Link(destination: collectionURL(computerKey, filter: filter)) {
        Text("\(value) \(label)").monospacedDigit()
          .lineLimit(1)
          .foregroundColor(color)
          .frame(minHeight: minTapHeight)
      }
      .accessibilityLabel("查看 \(value) 个\(accessibilityLabel)任务")
    }
  }

  @ViewBuilder private func dotCount(_ value: Int, color: Color, accessibilityLabel: String, filter: String) -> some View {
    if value > 0 {
      Link(destination: collectionURL(computerKey, filter: filter)) {
        HStack(spacing: 3) {
          Circle().fill(color).frame(width: 5, height: 5)
          Text("\(value)").monospacedDigit().lineLimit(1)
        }
        .foregroundColor(color)
        .frame(minHeight: minTapHeight)
      }
      .accessibilityLabel("查看 \(value) 个\(accessibilityLabel)任务")
    }
  }
}

@available(iOS 16.2, *)
struct TaskPagerView: View {
  let activityID: String
  let state: LinkShellAttentionAttributes.ContentState
  let computerKey: String?
  var isWidthLimited = false
  var showsArrows = true

  var body: some View {
    if let tasks = state.tasks, tasks.count > 1 {
      let currentIndex = (state.selectedIndex(activityID: activityID) ?? 0) + 1
      let tapHeight: CGFloat = isWidthLimited ? 32 : 36
      HStack(spacing: 0) {
        if showsArrows, #available(iOS 17.0, *) { pageButton(-1, symbol: "chevron.left", label: "上一个任务") }
        Link(destination: collectionURL(computerKey)) {
          if isWidthLimited {
            Text("\(currentIndex)/\(tasks.count)")
              .font(.system(size: 10.5, weight: .semibold, design: .rounded))
              .monospacedDigit()
              .lineLimit(1)
              .padding(.horizontal, showsArrows ? 4 : 7)
              .frame(minWidth: 22, minHeight: showsArrows ? tapHeight : 24)
              .background {
                if !showsArrows {
                  Capsule().fill(Color.white.opacity(0.10))
                }
              }
              .frame(minHeight: tapHeight)
          } else {
            HStack(spacing: 4) {
              ForEach(tasks.indices, id: \.self) { index in
                Capsule()
                  .fill(.white.opacity(index == state.selectedIndex(activityID: activityID) ? 0.85 : 0.22))
                  .frame(width: index == state.selectedIndex(activityID: activityID) ? 10 : 4, height: 4)
              }
            }
            .frame(minWidth: 24, minHeight: tapHeight)
          }
        }
        .accessibilityLabel("当前第 \(currentIndex) 个，共 \(tasks.count) 个任务，查看全部任务")
        if showsArrows, #available(iOS 17.0, *) { pageButton(1, symbol: "chevron.right", label: "下一个任务") }
      }
      .foregroundColor(.white.opacity(0.72))
      .fixedSize()
    }
  }

  @available(iOS 17.0, *)
  private func pageButton(_ direction: Int, symbol: String, label: String) -> some View {
    Button(intent: LinkShellActivityBrowseIntent(activityID: activityID, direction: direction)) {
      Image(systemName: symbol)
        .font(.system(size: isWidthLimited ? 10 : 11, weight: .semibold))
        .frame(width: isWidthLimited ? 28 : 36, height: isWidthLimited ? 32 : 36)
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
  var isWidthLimited = false

  var body: some View {
    let hasActions = !(state.actions ?? []).isEmpty || state.hasMoreActions == true
    let hasMultipleTasks = (state.tasks?.count ?? 0) > 1
    HStack(spacing: isWidthLimited ? 4 : 8) {
      if hasActions {
        ActivityActionsView(state: state)
          .layoutPriority(1)
      } else {
        ActivityCountsView(state: state, computerKey: computerKey, isWidthLimited: isWidthLimited)
          .layoutPriority(1)
      }
      Spacer(minLength: 0)
      // On narrow Dynamic Island widths (e.g. cover screens), collapse arrows when direct
      // approval buttons are shown so interactive controls never get squeezed out.
      if isWidthLimited && hasActions && hasMultipleTasks {
        TaskPagerView(
          activityID: activityID,
          state: state,
          computerKey: computerKey,
          isWidthLimited: true,
          showsArrows: false
        )
      } else {
        TaskPagerView(
          activityID: activityID,
          state: state,
          computerKey: computerKey,
          isWidthLimited: isWidthLimited
        )
      }
    }
    .frame(height: isWidthLimited ? 32 : 36)
  }
}

@available(iOS 16.2, *)
struct ActivityStatusLink: View {
  let state: LinkShellAttentionAttributes.ContentState
  let computerKey: String?
  var size: CGFloat = 22

  var body: some View {
    let filter = state.phase == "failed" ? "failed" : state.phase.hasPrefix("waiting") ? "attention" : state.phase == "completed" ? "completed" : "running"
    Link(destination: collectionURL(computerKey, filter: filter)) {
      StatusIndicatorView(state: state, size: size, showsCount: false)
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

@available(iOS 18.0, *)
struct WatchSmartStackBannerView: View {
  let context: ActivityViewContext<LinkShellAttentionAttributes>

  var body: some View {
    let state = context.displayState
    let actions = Array((state.actions ?? []).prefix(2))
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        AgentBadgeView(agent: ActivityAgent(id: state.agent), size: 20)
        ActivityTextView(text: state.project.isEmpty ? context.attributes.computerName : state.project)
          .font(.system(size: 11, weight: .medium, design: .rounded))
          .foregroundColor(.white.opacity(0.62))
          .lineLimit(1)
        Spacer(minLength: 2)
        StatusIndicatorView(state: state, size: 20, showsCount: true)
      }
      VStack(alignment: .leading, spacing: 2) {
        ActivityTextView(text: state.title)
          .font(.system(size: 13, weight: .semibold, design: .rounded))
          .foregroundColor(.white)
          .lineLimit(1)
        ActivityTextView(text: state.effectiveSubtitle)
          .font(.system(size: 11.5))
          .foregroundColor(.white.opacity(0.70))
          .lineLimit(actions.isEmpty ? 2 : 1)
      }
      if state.phase != "stale", !actions.isEmpty {
        HStack(spacing: 6) {
          ForEach(actions) { action in
            Button(intent: LinkShellActivityActionIntent(action: action)) {
              Text(action.label)
                .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 26)
                // Only 允许 is filled; 拒绝 and 停止 are quiet like the rest, never red.
                .foregroundColor(Color.white.opacity(action.role == "allow" ? 1 : 0.95))
                .background(Capsule().fill(action.role == "allow" ? ActivityPalette.accentFill : Color.white.opacity(0.14)))
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
    .padding(.horizontal, 11)
    .padding(.vertical, 8)
    .activityBackgroundTint(Color(red: 0.055, green: 0.06, blue: 0.075).opacity(0.96))
    .activitySystemActionForegroundColor(.white)
  }
}

@available(iOS 18.0, *)
struct ActivityAdaptiveBannerView: View {
  let context: ActivityViewContext<LinkShellAttentionAttributes>
  @Environment(\.activityFamily) private var activityFamily

  var body: some View {
    switch activityFamily {
    case .small:
      WatchSmartStackBannerView(context: context)
    case .medium:
      LockScreenBannerView(context: context)
    @unknown default:
      LockScreenBannerView(context: context)
    }
  }
}

@available(iOS 16.2, *)
struct CompactIslandRegion<Content: View>: View {
  @ViewBuilder let content: (Bool) -> Content

  var body: some View {
    #if compiler(>=6.4)
    if #available(iOS 27.0, *) {
      WidthAwareCompactIslandRegion(content: content)
    } else {
      content(false)
    }
    #else
    content(false)
    #endif
  }
}

#if compiler(>=6.4)
@available(iOS 27.0, *)
private struct WidthAwareCompactIslandRegion<Content: View>: View {
  @Environment(\.isDynamicIslandLimitedInWidth) private var isWidthLimited
  @ViewBuilder let content: (Bool) -> Content

  var body: some View { content(isWidthLimited) }
}
#endif

@available(iOS 16.2, *)
struct LinkShellAttentionWidget: Widget {
  var body: some WidgetConfiguration {
    let configuration = ActivityConfiguration(for: LinkShellAttentionAttributes.self) { context in
      Group {
        if #available(iOS 18.0, *) {
          ActivityAdaptiveBannerView(context: context)
        } else {
          LockScreenBannerView(context: context)
        }
      }
      .widgetURL(activityURL(context.displayState.deepLink))
    } dynamicIsland: { context in
      let state = context.displayState
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          CompactIslandRegion { isWidthLimited in
            let header = state.project.isEmpty ? context.attributes.computerName : state.project
            HStack(spacing: isWidthLimited ? 5 : 7) {
              AgentBadgeView(agent: ActivityAgent(id: state.agent), size: isWidthLimited ? 22 : 24)
              ActivityTextView(text: header)
                .font(.system(size: isWidthLimited ? 11.5 : 12, weight: .medium))
                .foregroundColor(.white.opacity(0.60))
                .lineLimit(1)
                .truncationMode(.tail)
            }
            .padding(.leading, isWidthLimited ? 2 : 4)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          CompactIslandRegion { isWidthLimited in
            ActivityStatusLink(
              state: state,
              computerKey: context.attributes.computerKey,
              size: isWidthLimited ? 20 : 22
            )
            .padding(.trailing, isWidthLimited ? 2 : 4)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          CompactIslandRegion { isWidthLimited in
            VStack(alignment: .leading, spacing: isWidthLimited ? 4 : 6) {
              Link(destination: activityURL(state.deepLink) ?? collectionURL(context.attributes.computerKey)) {
                VStack(alignment: .leading, spacing: isWidthLimited ? 2 : 4) {
                  ActivityTextView(text: state.title)
                    .font(.system(size: isWidthLimited ? 13.5 : 14, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                  ActivityTextView(text: state.effectiveSubtitle)
                    .font(.system(size: isWidthLimited ? 11.5 : 12))
                    .foregroundColor(.white.opacity(0.66))
                    .lineLimit(isWidthLimited ? 1 : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .multilineTextAlignment(.leading)
              }
              ActivityFooterView(
                activityID: context.activityID,
                state: state,
                computerKey: context.attributes.computerKey,
                isWidthLimited: isWidthLimited
              )
            }
            .padding(.horizontal, isWidthLimited ? 2 : 6)
            .padding(.top, isWidthLimited ? 2 : 4)
          }
        }
      } compactLeading: {
        CompactIslandRegion { isWidthLimited in
          AgentStackView(state: state, size: 20, limit: isWidthLimited ? 1 : 2, showsOverflow: !isWidthLimited)
            .padding(.leading, isWidthLimited ? 0 : 2)
            .frame(width: isWidthLimited ? 24 : nil, height: 24)
        }
      } compactTrailing: {
        CompactIslandRegion { isWidthLimited in
          StatusIndicatorView(state: state, size: 22, showsCount: !isWidthLimited)
            .padding(.trailing, isWidthLimited ? 0 : 2)
            .frame(width: isWidthLimited ? 24 : nil, height: 24)
        }
      } minimal: {
        StatusIndicatorView(state: state, size: 22, showsCount: false)
      }
      .widgetURL(state.waitingCount + state.runningCount + state.failedCount > 1
        ? collectionURL(context.attributes.computerKey) : activityURL(state.deepLink))
      .keylineTint(state.phaseColor)
    }
    if #available(iOS 18.0, *) {
      return configuration.supplementalActivityFamilies([.small])
    } else {
      return configuration
    }
  }
}

@main
@available(iOS 16.2, *)
struct LinkShellLiveActivityBundle: WidgetBundle {
  var body: some Widget { LinkShellAttentionWidget() }
}
