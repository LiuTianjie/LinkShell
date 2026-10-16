const { withXcodeProject, withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const TARGET_NAME = "LinkShellLiveActivity";
const SOURCE_FILE = "LinkShellLiveActivity.swift";
const ACTION_FILE = "LinkShellActivityActionIntent.swift";
const INFO_PLIST_FILE = "LinkShellLiveActivity-Info.plist";

const INFO_PLIST_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>LinkShell</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`;

const SWIFT_SOURCE_CONTENT = `import ActivityKit
import SwiftUI
import UIKit
import WidgetKit

private func activityURL(_ value: String) -> URL? {
  guard var parts = URLComponents(string: value) else { return nil }
  parts.scheme = Bundle.main.object(forInfoDictionaryKey: "LinkShellURLScheme") as? String ?? "linkshell"
  return parts.url
}

@available(iOS 16.2, *)
struct ActivityAgent: Identifiable {
  let id: String

  var name: String {
    switch id {
    case "claude": return "Claude"
    case "codex": return "Codex"
    case "antigravity": return "Antigravity"
    case "cursor": return "Cursor"
    case "gemini": return "Gemini"
    case "copilot": return "Copilot"
    case "grok": return "Grok"
    case "opencode": return "OpenCode"
    case "terminal": return "终端"
    default: return id.isEmpty ? "Agent" : id.capitalized
    }
  }

  var symbolName: String {
    switch id {
    case "terminal": return "terminal.fill"
    case "antigravity": return "sparkles"
    case "codex": return "cpu.fill"
    case "claude": return "brain.head.profile"
    default: return "bolt.horizontal.fill"
    }
  }

  var accentColor: Color {
    switch id {
    case "claude": return Color(red: 0.85, green: 0.47, blue: 0.34)
    case "codex": return Color(red: 0.39, green: 0.40, blue: 0.95)
    case "antigravity": return Color(red: 0.26, green: 0.52, blue: 0.96)
    case "cursor": return Color(red: 0.13, green: 0.77, blue: 0.69)
    case "gemini": return Color(red: 0.31, green: 0.55, blue: 0.97)
    case "terminal": return Color(red: 0.20, green: 0.78, blue: 0.35)
    default: return Color(red: 0.39, green: 0.40, blue: 0.95)
    }
  }
}

@available(iOS 16.2, *)
extension LinkShellAttentionAttributes.ContentState {
  var displayAgents: [ActivityAgent] {
    var seen = Set<String>()
    // Older activities contain only the featured agent.
    return ([agent] + (agents ?? [])).compactMap { raw in
      let id = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard !id.isEmpty, seen.insert(id).inserted else { return nil }
      return ActivityAgent(id: id)
    }
  }

  var phaseSymbolName: String {
    switch phase {
    case "waiting_for_approval": return "hand.raised.fill"
    case "waiting_for_input": return "questionmark.bubble.fill"
    case "failed": return "exclamationmark.triangle.fill"
    case "running": return "waveform"
    case "starting": return "sparkles"
    case "completed": return "checkmark.circle.fill"
    default: return "clock.badge.exclamationmark"
    }
  }

  var phaseCount: Int {
    switch phase {
    case "waiting_for_approval", "waiting_for_input": return waitingCount
    case "failed": return failedCount
    case "running", "starting": return runningCount
    default: return 0
    }
  }

  var phaseAccessibilityLabel: String {
    switch phase {
    case "waiting_for_approval": return "等待确认"
    case "waiting_for_input": return "等待回答"
    case "failed": return "执行出错"
    case "running": return "正在运行"
    case "starting": return "正在启动"
    case "completed": return "已完成"
    default: return "连接暂时中断"
    }
  }

  var phaseColor: Color {
    switch phase {
    case "waiting_for_approval", "waiting_for_input":
      return Color(red: 0.98, green: 0.65, blue: 0.10)
    case "failed":
      return Color(red: 0.95, green: 0.30, blue: 0.30)
    case "running", "starting":
      return Color(red: 0.22, green: 0.84, blue: 0.42)
    case "completed":
      return Color.white.opacity(0.75)
    default:
      return Color.white.opacity(0.55)
    }
  }

  var effectiveSubtitle: String {
    if phase == "stale" { return "正在重新连接电脑…" }
    let trimmed = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { return trimmed }
    switch phase {
    case "waiting_for_approval": return "需要你的权限确认"
    case "waiting_for_input": return "Agent 正在等待你的回答"
    case "failed": return "点击查看错误详情"
    case "running", "starting": return "Agent 正在后台执行任务…"
    default: return project
    }
  }
}

@available(iOS 16.2, *)
extension ActivityViewContext where Attributes == LinkShellAttentionAttributes {
  var displayState: LinkShellAttentionAttributes.ContentState {
    state.displayingSelection(activityID: activityID, computerKey: attributes.computerKey)
  }
}

@available(iOS 16.2, *)
struct AgentBadgeView: View {
  let agent: ActivityAgent
  var size: CGFloat = 22

  private static let icons: [String: UIImage] = {
    let raw: [String: String] = [
    "codex": "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",
    "gemini": "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",
    "claude": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAABmJLR0QA/wD/AP+gvaeTAAAC0klEQVR4nO3bvWsTcRzH8W/TI82DjTE1MYnVFimWxgdKRNBBV2cnJx1cnET/DWeH0kUQHAV3RxcHKZRoKUWp1dbGJjGPXh4uudQh7alH20/85ecD+HlNx4/yvcu7/LjehQ6lZk4L7c/zty/gX8dAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEGBonHXU7z0zFtQ4UM3SF7PQsHRN0xloKhy4n57UOFDNg1fvNQbiFgMYCGAggIEABgIYCNB5m9/PfGa9anVE5Fhg5FYqOeC0x0ubuUZLREJe4875Exqu70B/ItDCVjXfsETk1OHA4NMW89W1akNEon7v4NMgbjGAgQAGAhgIYCBA8S52fSqWCPpci7HA3reVm6lks9MVkVHvsNrpfnRjOl6zbBHxGXv/dq9NjqVjIddi1mw+e5dTOJ1ioIvx8Eyk31c/V44fUTvLni4lwgf/wGzUXUdEloumWiBuMYCBAAYCGAhgIICBgCG1f+oNGsOGxx33Qjx0d/akjqsayMPFjwufq67FTrdrdmyFaYp/B5kdW8R9vnpb5Qq0q7ftitXWNY1bDGAggIEABgIYCND50j5Xt56vFXrH56KjieBI7/jFRnH3dYdxObnzLP6h2lwpfu1z8nTk0ERo5+3Ky81yzeqIiM/wXB2P9BazZut1vuZchoYPs0tnoNVKfS5T7x3fS084gZ4sZ51vNZxAmULt0ZuNPiffPjvuBHr6dmu1UheRqN/rBFopmXOZdU2f4yfcYgADAQwEMBDAQMDv+m6+1Gh/qjV7x/b2du/AsrvOYrn1C8+T5db3aZbddcY6i6WGtqdTF8XXHf8PbjGAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAr4BYsSy8kPcyT0AAAAASUVORK5CYII=",
    "copilot": "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",
    "grok": "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",
    "opencode": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAABmJLR0QA/wD/AP+gvaeTAAABXklEQVR4nO3cMQrCMBhAYRUHu3To0imjXka8iPQ44kXEyyi6dCq4mKWOnsA8qI11eN+en/AgEGjo/Pl4zPTZYuoN/DsDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBA4FljqH7pmnbNsfkhBDC8XAYfWyWQNfL5Xa/55ic8Or7HGM9YsBAwEDAQMBAwEDAQMBAIMtFMe18OpVlOWBhjHG7242+n7QJAtV1XVXVgIVFUYy+GeQRAwYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgITfJvvuq4f9CI1xjj6ZtAEgX7/QuMbHjFgIGAgYCBgIGAgYCBgIJDlorjebFY/f5EaQsgxdu6PJtM8YsBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQOANaTslQLfSOEUAAAAASUVORK5CYII=",
    "cursor": "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",
    "antigravity": "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",
    ]
    var out: [String: UIImage] = [:]
    for (key, b64) in raw {
      if let data = Data(base64Encoded: b64), let image = UIImage(data: data, scale: 3.0) {
        out[key] = image
      }
    }
    return out
  }()

  var body: some View {
    let corner = size * 0.26
    if let uiImage = Self.icons[agent.id] {
      Image(uiImage: uiImage)
        .resizable()
        .interpolation(.high)
        .antialiased(true)
        .aspectRatio(contentMode: .fill)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: corner, style: .continuous)
            .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
        )
    } else {
      ZStack {
        RoundedRectangle(cornerRadius: corner, style: .continuous)
          .fill(agent.accentColor.opacity(0.24))
        RoundedRectangle(cornerRadius: corner, style: .continuous)
          .strokeBorder(agent.accentColor.opacity(0.65), lineWidth: 1)
        Image(systemName: agent.symbolName)
          .font(.system(size: size * 0.5, weight: .semibold))
          .foregroundColor(agent.accentColor)
      }
      .frame(width: size, height: size)
    }
  }
}

@available(iOS 16.2, *)
struct AgentStackView: View {
  let state: LinkShellAttentionAttributes.ContentState
  var size: CGFloat = 26
  var limit: Int = 3
  @Environment(\\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\\.isLuminanceReduced) private var isLuminanceReduced

  var body: some View {
    let agents = state.displayAgents
    let visible = Array(agents.prefix(limit))
    HStack(spacing: -size * 0.38) {
      ForEach(Array(visible.enumerated()), id: \\.element.id) { index, agent in
        AgentBadgeView(agent: agent, size: size)
          .padding(2)
          .background(RoundedRectangle(cornerRadius: size * 0.26 + 2).fill(Color.black))
          .zIndex(Double(limit - index))
          .transition(.opacity)
      }
      if agents.count > limit {
        Text("+\\(agents.count - limit)")
          .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
          .foregroundColor(.white.opacity(0.9))
          .minimumScaleFactor(0.7)
          .frame(width: size, height: size)
          .background(RoundedRectangle(cornerRadius: size * 0.26).fill(Color(white: 0.2)))
          .padding(2)
          .background(RoundedRectangle(cornerRadius: size * 0.26 + 2).fill(Color.black))
          .padding(.leading, size * 0.38)
      }
    }
    .fixedSize()
    .animation(reduceMotion || isLuminanceReduced ? nil : .easeInOut(duration: 0.35), value: agents.map(\\.id))
    .opacity(state.phase == "stale" ? 0.55 : 1)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(agents.map(\\.name).joined(separator: "、"))
  }
}

@available(iOS 16.2, *)
struct StatusGlyphView: View {
  let state: LinkShellAttentionAttributes.ContentState
  @Environment(\\.isLuminanceReduced) private var isLuminanceReduced
  @Environment(\\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if #available(iOS 17.0, *), !isLuminanceReduced && !reduceMotion {
      Image(systemName: state.phaseSymbolName)
        .contentTransition(.symbolEffect(.replace))
        // Live Activities animate data updates, not an indefinitely running timer.
        .symbolEffect(.pulse, options: .nonRepeating, value: state.phase == "running" ? state.subtitle : state.phase)
    } else {
      Image(systemName: state.phaseSymbolName)
    }
  }
}

@available(iOS 16.2, *)
struct StatusIndicatorView: View {
  let state: LinkShellAttentionAttributes.ContentState
  var size: CGFloat = 28
  var showsCount = true

  var body: some View {
    HStack(spacing: 5) {
      StatusGlyphView(state: state)
        .font(.system(size: size * 0.48, weight: .semibold))
      if showsCount && state.phaseCount > 1 {
        Text(state.phaseCount > 99 ? "99+" : String(state.phaseCount))
          .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .contentTransition(.numericText())
      }
    }
    .foregroundColor(state.phaseColor)
    .padding(.horizontal, showsCount && state.phaseCount > 1 ? 8 : 0)
    .frame(minWidth: size, minHeight: size)
    .background(Capsule().fill(state.phaseColor.opacity(0.15)))
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(state.phaseAccessibilityLabel)
    .accessibilityValue(state.phaseCount > 1 ? "\\(state.phaseCount) 个任务" : "")
  }
}

@available(iOS 16.2, *)
struct ActivityTextView: View {
  let text: String
  @Environment(\\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\\.isLuminanceReduced) private var isLuminanceReduced

  var body: some View {
    Text(text)
      .contentTransition(.opacity)
      .animation(reduceMotion || isLuminanceReduced ? nil : .easeInOut(duration: 0.3), value: text)
  }
}

@available(iOS 16.2, *)
struct ActivityActionsView: View {
  let state: LinkShellAttentionAttributes.ContentState

  var body: some View {
    if state.phase != "stale", let url = activityURL(state.deepLink),
       !(state.actions ?? []).isEmpty || state.hasMoreActions == true {
      if #available(iOS 17.0, *), !(state.actions ?? []).isEmpty {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) {
            ForEach(state.actions ?? []) { action in
              Button(intent: LinkShellActivityActionIntent(action: action)) {
                Text(action.label)
                  .font(.system(size: 13, weight: .semibold))
                  .lineLimit(1)
                  .fixedSize()
                  .padding(.horizontal, 14)
                  .frame(minHeight: 36)
                  .foregroundColor(action.role == "allow" ? Color.black : Color.white.opacity(0.94))
                  .background(Capsule().fill(action.role == "allow" ? state.phaseColor : Color.white.opacity(0.12)))
              }
              .buttonStyle(.plain)
            }
            if state.hasMoreActions == true {
              Link(destination: url) { Image(systemName: "ellipsis").frame(width: 36, height: 36) }
                .foregroundColor(state.phaseColor)
                .accessibilityLabel("查看全部选项")
            }
          }
          .fixedSize(horizontal: true, vertical: false)
          detailsLink(url)
        }
      } else {
        detailsLink(url)
      }
    }
  }

  private func detailsLink(_ url: URL) -> some View {
    Link(destination: url) {
      HStack(spacing: 5) {
        Text("查看全部选项")
        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
      }
      .font(.system(size: 12, weight: .medium))
      .foregroundColor(state.phaseColor)
      .frame(minHeight: 28)
    }
  }
}

` + fs.readFileSync(path.join(__dirname, "live-activity/LiveActivityViews.swift"), "utf8");

function ensureSource(proj, targetId, groupId, filename) {
  const group = proj.getPBXGroupByKey(groupId);
  const refs = proj.pbxFileReferenceSection();
  let fileRef = group.children.find(({ value }) =>
    String(refs[value]?.path || "").replaceAll('"', "") === filename,
  )?.value;
  if (!fileRef) fileRef = proj.addFile(filename, groupId).fileRef;

  const sources = proj.hash.project.objects.PBXSourcesBuildPhase || {};
  const files = proj.pbxBuildFileSection();
  const target = proj.pbxNativeTargetSection()[targetId];
  const present = (target.buildPhases || []).some(({ value }) =>
    sources[value]?.files?.some((file) => files[file.value]?.fileRef === fileRef),
  );
  if (present) return;
  if (!(target.buildPhases || []).some(({ value }) => sources[value])) {
    proj.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", targetId);
  }
  // Share the grouped file reference, but give each target its own build file.
  // addBuildPhase(paths) creates ungrouped references and reuses build files.
  const file = { uuid: proj.generateUuid(), fileRef, basename: filename, group: "Sources", target: targetId };
  proj.addToPbxBuildFileSection(file);
  proj.addToPbxSourcesBuildPhase(file);
}

module.exports = function withLiveActivity(config) {
  const bundleId = config.ios?.bundleIdentifier || "com.bd.linkshell";
  // The released app already shares this group with its other extensions.
  const appGroup = bundleId === "com.bd.linkshell" ? "group.com.bd.linkshell" : `group.${bundleId}.liveactivity`;
  config = withEntitlementsPlist(config, (config) => {
    config.modResults["com.apple.security.application-groups"] = [...new Set([
      ...(config.modResults["com.apple.security.application-groups"] || []), appGroup,
    ])];
    return config;
  });
  config = withInfoPlist(config, (config) => {
    config.modResults.LinkShellLiveActivityAppGroup = appGroup;
    return config;
  });
  return withXcodeProject(config, (config) => {
    const extDir = path.join(config.modRequest.platformProjectRoot, TARGET_NAME);
    const modelFile = "LiveActivityModel.swift";
    const entitlementsFile = `${TARGET_NAME}.entitlements`;
    fs.mkdirSync(extDir, { recursive: true });
    const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme || "linkshell";
    fs.writeFileSync(path.join(extDir, INFO_PLIST_FILE), INFO_PLIST_CONTENT.replace("  <key>NSExtension</key>",
      `  <key>LinkShellURLScheme</key>\n  <string>${scheme}</string>\n  <key>LinkShellLiveActivityAppGroup</key>\n  <string>${appGroup}</string>\n  <key>NSExtension</key>`));
    fs.writeFileSync(path.join(extDir, entitlementsFile), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.application-groups</key><array><string>${appGroup}</string></array></dict></plist>
`);
    fs.writeFileSync(path.join(extDir, SOURCE_FILE), SWIFT_SOURCE_CONTENT);
    fs.copyFileSync(path.join(__dirname, "../modules/link-layout/ios/LiveActivityModel.swift"), path.join(extDir, modelFile));
    const actionSource = fs.readFileSync(path.join(__dirname, "../modules/link-layout/ios/LiveActivityAction.swift"), "utf8")
      + "\n" + fs.readFileSync(path.join(__dirname, "live-activity/LiveActivityActionIntent.swift"), "utf8")
      + "\n" + fs.readFileSync(path.join(__dirname, "live-activity/LiveActivityBrowseIntent.swift"), "utf8");
    fs.writeFileSync(path.join(extDir, ACTION_FILE), actionSource);

    const proj = config.modResults;
    let targetId, groupId;
    const existing = proj.pbxTargetByName(TARGET_NAME);
    if (existing) {
      targetId = Object.keys(proj.pbxNativeTargetSection()).find((key) => proj.pbxNativeTargetSection()[key] === existing);
      const group = proj.pbxGroupByName(TARGET_NAME);
      groupId = Object.keys(proj.hash.project.objects.PBXGroup).find((key) => proj.hash.project.objects.PBXGroup[key] === group);
    } else {
      proj.hash.project.objects.PBXTargetDependency ||= {};
      proj.hash.project.objects.PBXContainerItemProxy ||= {};
      const target = proj.addTarget(TARGET_NAME, "app_extension", TARGET_NAME, `${bundleId}.LiveActivity`);
      targetId = target.uuid;
      const group = proj.addPbxGroup([INFO_PLIST_FILE, entitlementsFile], TARGET_NAME, TARGET_NAME);
      groupId = group.uuid;
      proj.addToPbxGroup(groupId, proj.getFirstProject().firstProject.mainGroup);
      proj.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", targetId);
      proj.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", targetId);
    }
    ensureSource(proj, targetId, groupId, SOURCE_FILE);
    const project = proj.getFirstProject().firstProject;
    project.attributes.TargetAttributes ||= {};
    for (const id of [targetId, proj.getFirstTarget().uuid]) {
      const attributes = project.attributes.TargetAttributes[id] ||= {};
      attributes.SystemCapabilities ||= {};
      attributes.SystemCapabilities["com.apple.ApplicationGroups.iOS"] = { enabled: 1 };
    }
    for (const filename of [modelFile, ACTION_FILE]) {
      ensureSource(proj, targetId, groupId, filename);
      ensureSource(proj, proj.getFirstTarget().uuid, groupId, filename);
    }

    for (const bf of Object.values(proj.pbxBuildFileSection())) {
      if (bf && typeof bf === "object" && bf.fileRef_comment === `${TARGET_NAME}.appex`) bf.settings = { ATTRIBUTES: ["RemoveHeadersOnCopy"] };
    }
    const configList = proj.pbxXCConfigurationList()[proj.pbxNativeTargetSection()[targetId].buildConfigurationList];
    const buildConfigs = proj.pbxXCBuildConfigurationSection();
    for (const entry of configList?.buildConfigurations || []) {
      const bc = buildConfigs[entry.value];
      if (!bc?.buildSettings) continue;
      Object.assign(bc.buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: "YES", CLANG_ENABLE_MODULES: "YES", CODE_SIGN_STYLE: "Automatic",
        CODE_SIGN_ENTITLEMENTS: `"${TARGET_NAME}/${entitlementsFile}"`,
        CURRENT_PROJECT_VERSION: config.ios?.buildNumber || "1", DEVELOPMENT_TEAM: "L95PYLFT86",
        GENERATE_INFOPLIST_FILE: "NO", INFOPLIST_FILE: `"${TARGET_NAME}/${INFO_PLIST_FILE}"`, IPHONEOS_DEPLOYMENT_TARGET: "16.2",
        LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
        MARKETING_VERSION: config.version || "2.3.30", PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}.LiveActivity"`,
        PRODUCT_NAME: '"$(TARGET_NAME)"', SKIP_INSTALL: "YES", SWIFT_EMIT_LOC_STRINGS: "NO", SWIFT_VERSION: "5.0", TARGETED_DEVICE_FAMILY: '"1,2"',
      });
    }
    return config;
  });
};
