const { withXcodeProject } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const TARGET_NAME = "LinkShellLiveActivity";
const SOURCE_FILE = "LinkShellLiveActivity.swift";
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
import WidgetKit

@available(iOS 16.2, *)
public struct LinkShellAttentionAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var phase: String
    public var title: String
    public var subtitle: String
    public var project: String
    public var agent: String
    public var waitingCount: Int
    public var runningCount: Int
    public var failedCount: Int
    public var deepLink: String
  }
  public var computerName: String
}

@available(iOS 16.2, *)
extension LinkShellAttentionAttributes.ContentState {
  var agentDisplayName: String {
    switch agent.lowercased() {
    case "claude": return "Claude"
    case "codex": return "Codex"
    case "antigravity": return "Antigravity"
    case "cursor": return "Cursor"
    case "gemini": return "Gemini"
    case "opencode": return "OpenCode"
    case "terminal": return "终端"
    default: return agent.isEmpty ? "Agent" : agent.capitalized
    }
  }

  var agentShortBadge: String {
    switch agent.lowercased() {
    case "claude": return "C"
    case "codex": return "Cx"
    case "antigravity": return "Ag"
    case "cursor": return "Cu"
    case "gemini": return "G"
    case "opencode": return "OC"
    case "terminal": return ">_"
    default: return String(agentDisplayName.prefix(2))
    }
  }

  var agentSymbolName: String {
    switch agent.lowercased() {
    case "terminal": return "terminal.fill"
    case "antigravity": return "sparkles"
    case "codex": return "cpu.fill"
    case "claude": return "brain.head.profile"
    default: return "bolt.horizontal.fill"
    }
  }

  var agentAccentColor: Color {
    switch agent.lowercased() {
    case "claude": return Color(red: 0.85, green: 0.47, blue: 0.34)
    case "codex": return Color(red: 0.39, green: 0.40, blue: 0.95)
    case "antigravity": return Color(red: 0.26, green: 0.52, blue: 0.96)
    case "cursor": return Color(red: 0.13, green: 0.77, blue: 0.69)
    case "gemini": return Color(red: 0.31, green: 0.55, blue: 0.97)
    case "terminal": return Color(red: 0.20, green: 0.78, blue: 0.35)
    default: return Color(red: 0.39, green: 0.40, blue: 0.95)
    }
  }

  var phaseSymbolName: String {
    switch phase {
    case "waiting_for_approval": return "hand.raised.fill"
    case "waiting_for_input": return "questionmark.bubble.fill"
    case "failed": return "exclamationmark.triangle.fill"
    case "running": return "bolt.horizontal.circle.fill"
    case "starting": return "sparkles"
    case "completed": return "checkmark.circle.fill"
    default: return "clock.badge.exclamationmark"
    }
  }

  var phaseShortLabel: String {
    switch phase {
    case "waiting_for_approval":
      return waitingCount > 1 ? "\\(waitingCount) 待确认" : "待确认"
    case "waiting_for_input":
      return waitingCount > 1 ? "\\(waitingCount) 待回答" : "待回答"
    case "failed":
      return failedCount > 1 ? "\\(failedCount) 出错" : "出错"
    case "running":
      return runningCount > 1 ? "\\(runningCount) 运行中" : "运行中"
    case "starting":
      return "启动中"
    case "completed":
      return "已完成"
    default:
      return "待刷新"
    }
  }

  var phasePillLabel: String {
    switch phase {
    case "waiting_for_approval": return "等待确认"
    case "waiting_for_input": return "等待回答"
    case "failed": return "执行出错"
    case "running": return "正在运行"
    case "starting": return "正在启动"
    case "completed": return "已完成"
    default: return "状态已过期"
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
    if phase == "stale" { return "状态已过期，打开 App 刷新" }
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
    // The system can expire content while the app is suspended and cannot send an update.
    var display = state
    if isStale { display.phase = "stale" }
    return display
  }
}

@available(iOS 16.2, *)
struct AgentBadgeView: View {
  let state: LinkShellAttentionAttributes.ContentState
  var size: CGFloat = 22

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        .fill(state.agentAccentColor.opacity(0.24))
      RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        .strokeBorder(state.agentAccentColor.opacity(0.65), lineWidth: 1)
      Image(systemName: state.agentSymbolName)
        .font(.system(size: size * 0.5, weight: .semibold))
        .foregroundColor(state.agentAccentColor)
    }
    .frame(width: size, height: size)
  }
}

@available(iOS 16.2, *)
struct LockScreenBannerView: View {
  let context: ActivityViewContext<LinkShellAttentionAttributes>

  var body: some View {
    let state = context.displayState
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        AgentBadgeView(state: state, size: 24)
        Text(state.agentDisplayName)
          .font(.system(size: 13, weight: .semibold))
          .foregroundColor(.white)
        if !state.project.isEmpty {
          Text("· \\(state.project)")
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(.white.opacity(0.68))
            .lineLimit(1)
        }
        Spacer(minLength: 4)
        HStack(spacing: 4) {
          Image(systemName: state.phaseSymbolName)
            .font(.system(size: 11, weight: .semibold))
          Text(state.phasePillLabel)
            .font(.system(size: 11, weight: .semibold))
        }
        .foregroundColor(state.phaseColor)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(state.phaseColor.opacity(0.18))
        .clipShape(Capsule())
      }

      Text(state.title)
        .font(.system(size: 15, weight: .semibold))
        .foregroundColor(.white)
        .lineLimit(1)

      HStack(spacing: 6) {
        Text(state.effectiveSubtitle)
          .font(.system(size: 13))
          .foregroundColor(.white.opacity(0.78))
          .lineLimit(1)
        Spacer(minLength: 4)
        Text(context.attributes.computerName)
          .font(.system(size: 11, weight: .medium))
          .foregroundColor(.white.opacity(0.5))
          .lineLimit(1)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .activityBackgroundTint(Color.black.opacity(0.85))
    .activitySystemActionForegroundColor(.white)
  }
}

@available(iOS 16.2, *)
struct LinkShellAttentionWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LinkShellAttentionAttributes.self) { context in
      LockScreenBannerView(context: context)
        .widgetURL(URL(string: context.state.deepLink))
    } dynamicIsland: { context in
      let state = context.displayState
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 7) {
            AgentBadgeView(state: state, size: 24)
            VStack(alignment: .leading, spacing: 1) {
              Text(state.agentDisplayName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(1)
              Text(state.project.isEmpty ? context.attributes.computerName : state.project)
                .font(.system(size: 11))
                .foregroundColor(.white.opacity(0.65))
                .lineLimit(1)
            }
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          HStack(spacing: 4) {
            Image(systemName: state.phaseSymbolName)
              .font(.system(size: 11, weight: .semibold))
            Text(state.phasePillLabel)
              .font(.system(size: 12, weight: .semibold))
          }
          .foregroundColor(state.phaseColor)
          .padding(.horizontal, 9)
          .padding(.vertical, 5)
          .background(state.phaseColor.opacity(0.18))
          .clipShape(Capsule())
          .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Text(state.title)
              .font(.system(size: 14, weight: .semibold))
              .foregroundColor(.white)
              .lineLimit(1)
            HStack(spacing: 6) {
              Image(systemName: state.phaseSymbolName)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(state.phaseColor)
              Text(state.effectiveSubtitle)
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.8))
                .lineLimit(1)
              Spacer(minLength: 4)
              if state.phase != "stale" && state.waitingCount + state.runningCount > 1 {
                Text("\\(state.runningCount) 运行 · \\(state.waitingCount) 待处理")
                  .font(.system(size: 11, weight: .medium))
                  .foregroundColor(.white.opacity(0.55))
              } else {
                Text(context.attributes.computerName)
                  .font(.system(size: 11, weight: .medium))
                  .foregroundColor(.white.opacity(0.55))
                  .lineLimit(1)
              }
            }
          }
          .padding(.horizontal, 6)
          .padding(.top, 4)
        }
      } compactLeading: {
        HStack(spacing: 5) {
          AgentBadgeView(state: state, size: 20)
          Text(state.agentShortBadge)
            .font(.system(size: 12, weight: .bold, design: .rounded))
            .foregroundColor(.white)
        }
        .padding(.leading, 2)
      } compactTrailing: {
        HStack(spacing: 4) {
          Image(systemName: state.phaseSymbolName)
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(state.phaseColor)
          Text(state.phaseShortLabel)
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(state.phaseColor)
            .lineLimit(1)
        }
        .padding(.trailing, 2)
      } minimal: {
        ZStack {
          Circle()
            .fill(state.phaseColor.opacity(0.22))
          Image(systemName: state.phaseSymbolName)
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(state.phaseColor)
        }
      }
      .widgetURL(URL(string: state.deepLink))
      .keylineTint(state.phaseColor)
    }
  }
}

@main
@available(iOS 16.2, *)
struct LinkShellLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    LinkShellAttentionWidget()
  }
}
`;

module.exports = function withLiveActivity(config) {
  return withXcodeProject(config, (config) => {
    const projectRoot = config.modRequest.platformProjectRoot;
    const extDir = path.join(projectRoot, TARGET_NAME);
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, INFO_PLIST_FILE), INFO_PLIST_CONTENT);
    fs.writeFileSync(path.join(extDir, SOURCE_FILE), SWIFT_SOURCE_CONTENT);

    const proj = config.modResults;
    if (proj.pbxTargetByName(TARGET_NAME)) {
      return config;
    }

    const bundleId = config.ios?.bundleIdentifier || "com.bd.linkshell";
    const extBundleId = `${bundleId}.LiveActivity`;
    const marketingVersion = config.version || "2.3.26";
    const buildNumber = config.ios?.buildNumber || "1";

    // Ensure PBXTargetDependency and PBXContainerItemProxy sections exist before addTarget.
    proj.hash.project.objects.PBXTargetDependency = proj.hash.project.objects.PBXTargetDependency || {};
    proj.hash.project.objects.PBXContainerItemProxy = proj.hash.project.objects.PBXContainerItemProxy || {};

    const target = proj.addTarget(TARGET_NAME, "app_extension", TARGET_NAME, extBundleId);

    // Create PBXGroup for extension files and attach to main project group.
    const extGroup = proj.addPbxGroup([SOURCE_FILE, INFO_PLIST_FILE], TARGET_NAME, TARGET_NAME);
    const mainGroupId = proj.getFirstProject().firstProject.mainGroup;
    proj.addToPbxGroup(extGroup.uuid, mainGroupId);

    // Add Sources, Frameworks, and Resources build phases to the extension target.
    proj.addBuildPhase(
      [`${TARGET_NAME}/${SOURCE_FILE}`],
      "PBXSourcesBuildPhase",
      "Sources",
      target.uuid,
    );
    proj.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
    proj.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);

    // Ensure the Copy Files phase on the main app target embeds the .appex with RemoveHeadersOnCopy.
    const buildFiles = proj.pbxBuildFileSection();
    for (const key of Object.keys(buildFiles)) {
      const bf = buildFiles[key];
      if (bf && typeof bf === "object" && bf.fileRef_comment === `${TARGET_NAME}.appex`) {
        bf.settings = { ATTRIBUTES: ["RemoveHeadersOnCopy"] };
      }
    }

    // Configure build settings on the extension target's Debug and Release configurations.
    const configListUuid = target.pbxNativeTarget.buildConfigurationList;
    const configLists = proj.pbxXCConfigurationList();
    const configList = configLists[configListUuid];
    const buildConfigs = proj.pbxXCBuildConfigurationSection();
    if (configList && Array.isArray(configList.buildConfigurations)) {
      for (const entry of configList.buildConfigurations) {
        const bc = buildConfigs[entry.value];
        if (!bc || !bc.buildSettings) continue;
        Object.assign(bc.buildSettings, {
          APPLICATION_EXTENSION_API_ONLY: "YES",
          CLANG_ENABLE_MODULES: "YES",
          CODE_SIGN_STYLE: "Automatic",
          CURRENT_PROJECT_VERSION: buildNumber,
          DEVELOPMENT_TEAM: "L95PYLFT86",
          GENERATE_INFOPLIST_FILE: "NO",
          INFOPLIST_FILE: `"${TARGET_NAME}/${INFO_PLIST_FILE}"`,
          IPHONEOS_DEPLOYMENT_TARGET: "16.2",
          LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
          MARKETING_VERSION: marketingVersion,
          PRODUCT_BUNDLE_IDENTIFIER: `"${extBundleId}"`,
          PRODUCT_NAME: `"$(TARGET_NAME)"`,
          SKIP_INSTALL: "YES",
          SWIFT_EMIT_LOC_STRINGS: "NO",
          SWIFT_VERSION: "5.0",
          TARGETED_DEVICE_FAMILY: '"1,2"',
        });
      }
    }

    return config;
  });
};
