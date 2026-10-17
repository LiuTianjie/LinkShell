const { withXcodeProject, withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const accountConfig = require("../config/account.json");

const TARGET_NAME = "LinkShellWatch";
const INFO_PLIST_FILE = "LinkShellWatch-Info.plist";
const ENTITLEMENTS_FILE = "LinkShellWatch.entitlements";
const WATCH_SOURCE_FILES = [
  "WatchModels.swift",
  "WatchCrypto.swift",
  "WatchAccount.swift",
  "WatchRelay.swift",
  "WatchDirectClient.swift",
  "WatchSnapshotBuilder.swift",
  "WatchConnectionViews.swift",
  "WatchSessionStore.swift",
  "WatchViews.swift",
  "WatchComplications.swift",
];

function buildWatchInfoPlist({ bundleId, appGroup, scheme }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
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
  <key>WKApplication</key>
  <true/>
  <key>WKRunsIndependentlyOfCompanionApp</key>
  <true/>
  <key>LinkShellAuthURL</key>
  <string>${accountConfig.url}</string>
  <key>LinkShellAuthAnonKey</key>
  <string>${accountConfig.anonKey}</string>
  <key>WKCompanionAppBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>LinkShellWatchAppGroup</key>
  <string>${appGroup}</string>
  <key>LinkShellURLScheme</key>
  <string>${scheme}</string>
</dict>
</plist>
`;
}

function buildWatchWidgetsInfoPlist({ appGroup }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
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
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>LinkShellWatchAppGroup</key>
  <string>${appGroup}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`;
}

function buildWatchEntitlements(appGroup) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroup}</string>
  </array>
</dict>
</plist>
`;
}

function ensureSource(proj, targetId, groupId, filename) {
  const group = proj.getPBXGroupByKey(groupId);
  const refs = proj.pbxFileReferenceSection();
  let fileRef = group?.children?.find(({ value }) =>
    String(refs[value]?.path || "").replaceAll('"', "") === filename,
  )?.value;
  if (!fileRef) fileRef = proj.addFile(filename, groupId).fileRef;

  if (!targetId) return;
  const sources = proj.hash.project.objects.PBXSourcesBuildPhase || {};
  const files = proj.pbxBuildFileSection();
  const target = proj.pbxNativeTargetSection()[targetId];
  if (!target) return;
  const present = (target.buildPhases || []).some(({ value }) =>
    sources[value]?.files?.some((file) => files[file.value]?.fileRef === fileRef),
  );
  if (present) return;
  if (!(target.buildPhases || []).some(({ value }) => sources[value])) {
    proj.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", targetId);
  }
  const file = { uuid: proj.generateUuid(), fileRef, basename: filename, group: "Sources", target: targetId };
  proj.addToPbxBuildFileSection(file);
  proj.addToPbxSourcesBuildPhase(file);
}

function materializeWatchDirectory(platformProjectRoot, { bundleId, appGroup, scheme }) {
  const watchDir = path.join(platformProjectRoot, TARGET_NAME);
  fs.mkdirSync(watchDir, { recursive: true });
  fs.writeFileSync(path.join(watchDir, INFO_PLIST_FILE), buildWatchInfoPlist({ bundleId, appGroup, scheme }));
  fs.writeFileSync(path.join(watchDir, ENTITLEMENTS_FILE), buildWatchEntitlements(appGroup));
  fs.writeFileSync(path.join(watchDir, "LinkShellWatchWidgets-Info.plist"), buildWatchWidgetsInfoPlist({ appGroup }));
  fs.writeFileSync(path.join(watchDir, "LinkShellWatchWidgets.entitlements"), buildWatchEntitlements(appGroup));
  for (const filename of WATCH_SOURCE_FILES) {
    fs.copyFileSync(path.join(__dirname, "watch", filename), path.join(watchDir, filename));
  }
  const assets = path.join(watchDir, "Assets.xcassets");
  const icon = path.join(assets, "AppIcon.appiconset");
  fs.mkdirSync(icon, { recursive: true });
  fs.writeFileSync(path.join(assets, "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }));
  fs.copyFileSync(path.join(__dirname, "../assets/icon.png"), path.join(icon, "icon.png"));
  fs.writeFileSync(path.join(icon, "Contents.json"), JSON.stringify({
    images: [{ filename: "icon.png", idiom: "universal", platform: "watchos", size: "1024x1024" }],
    info: { author: "xcode", version: 1 },
  }));
  return watchDir;
}

// Explicit embedding keeps the WidgetKit extension inside the watch app rather
// than node-xcode's default (the first, iPhone target).
function embedTarget(proj, parentId, childId, name, destination, destinationPath = '""') {
  const objects = proj.hash.project.objects;
  const parent = objects.PBXNativeTarget[parentId];
  const child = objects.PBXNativeTarget[childId];
  const existing = parent.buildPhases.find(({ value }) => objects.PBXCopyFilesBuildPhase?.[value]?.name === `"${name}"`);
  if (!existing) {
    const phase = proj.addBuildPhase([], "PBXCopyFilesBuildPhase", name, parentId).buildPhase;
    phase.dstSubfolderSpec = destination;
    phase.dstPath = destinationPath;
    const id = proj.generateUuid();
    objects.PBXBuildFile[id] = {
      isa: "PBXBuildFile", fileRef: child.productReference,
      settings: { ATTRIBUTES: ["RemoveHeadersOnCopy"] },
    };
    phase.files.push({ value: id, comment: name });
  }
  if (!parent.dependencies.some(({ value }) => objects.PBXTargetDependency[value]?.target === childId)) {
    proj.addTargetDependency(parentId, [childId]);
  }
}

function configureWatchProject(proj, config) {
  const bundleId = config.ios?.bundleIdentifier || "com.bd.linkshell";
  const appGroup = bundleId === "com.bd.linkshell" ? "group.com.bd.linkshell" : `group.${bundleId}.liveactivity`;
  const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme || "linkshell";
  materializeWatchDirectory(config.modRequest.platformProjectRoot, { bundleId, appGroup, scheme });
  const objects = proj.hash.project.objects;
  objects.PBXTargetDependency ||= {};
  objects.PBXContainerItemProxy ||= {};
  let groupId = Object.keys(objects.PBXGroup).find((key) => objects.PBXGroup[key] === proj.pbxGroupByName(TARGET_NAME));
  if (!groupId) {
    groupId = proj.addPbxGroup([], TARGET_NAME, TARGET_NAME).uuid;
    proj.addToPbxGroup(groupId, proj.getFirstProject().firstProject.mainGroup);
  }
  const hostId = proj.getFirstTarget().uuid;
  function target(name, extension) {
    let id = Object.keys(proj.pbxNativeTargetSection()).find((key) => String(proj.pbxNativeTargetSection()[key]?.name || "").replaceAll('"', "") === name);
    if (!id) {
      const host = objects.PBXNativeTarget[hostId];
      const phases = [...host.buildPhases];
      const dependencies = [...host.dependencies];
      id = proj.addTarget(name, extension ? "app_extension" : "application", TARGET_NAME).uuid;
      for (const added of host.buildPhases.filter((entry) => !phases.includes(entry))) {
        delete objects.PBXCopyFilesBuildPhase[added.value];
        delete objects.PBXCopyFilesBuildPhase[`${added.value}_comment`];
      }
      host.buildPhases = phases;
      host.dependencies = dependencies;
      proj.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", id);
      proj.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", id);
    }
    for (const filename of extension ? ["WatchModels.swift", "WatchComplications.swift"] : WATCH_SOURCE_FILES) {
      ensureSource(proj, id, groupId, filename);
    }
    const list = proj.pbxXCConfigurationList()[objects.PBXNativeTarget[id].buildConfigurationList];
    for (const entry of list.buildConfigurations) {
      const bc = proj.pbxXCBuildConfigurationSection()[entry.value];
      Object.assign(bc.buildSettings, {
        CLANG_ENABLE_MODULES: "YES", CODE_SIGN_STYLE: "Automatic",
        CODE_SIGN_ENTITLEMENTS: `"${TARGET_NAME}/${name}.entitlements"`,
        CURRENT_PROJECT_VERSION: config.ios?.buildNumber || "1",
        DEVELOPMENT_TEAM: config.ios?.appleTeamId || "L95PYLFT86",
        GENERATE_INFOPLIST_FILE: "NO", INFOPLIST_FILE: `"${TARGET_NAME}/${name}-Info.plist"`,
        MARKETING_VERSION: config.version || "1.0.0",
        PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}.watchkitapp${extension ? ".widgets" : ""}"`,
        PRODUCT_NAME: '"$(TARGET_NAME)"', SDKROOT: "watchos",
        SUPPORTED_PLATFORMS: '"watchos watchsimulator"', SKIP_INSTALL: "YES",
        SWIFT_EMIT_LOC_STRINGS: "NO", SWIFT_VERSION: "5.0",
        TARGETED_DEVICE_FAMILY: '"4"', WATCHOS_DEPLOYMENT_TARGET: "10.0",
        ...(extension ? {
          APPLICATION_EXTENSION_API_ONLY: "YES",
          SWIFT_ACTIVE_COMPILATION_CONDITIONS: '"$(inherited) WIDGET_EXTENSION"',
        } : { ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon" }),
      });
    }
    return id;
  }
  const watchId = target(TARGET_NAME, false);
  const widgetsId = target("LinkShellWatchWidgets", true);
  const resources = proj.buildPhaseObject("PBXResourcesBuildPhase", "Resources", watchId);
  if (!resources.files.some((entry) => entry.comment === "Assets.xcassets in Resources")) {
    // Fresh Expo projects need not have the legacy Resources group expected by
    // node-xcode.addResourceFile; attach the catalog to our own group directly.
    const asset = proj.addFile("Assets.xcassets", groupId);
    const id = proj.generateUuid();
    objects.PBXBuildFile[id] = { isa: "PBXBuildFile", fileRef: asset.fileRef };
    objects.PBXBuildFile[`${id}_comment`] = "Assets.xcassets in Resources";
    resources.files.push({ value: id, comment: "Assets.xcassets in Resources" });
  }
  embedTarget(proj, watchId, widgetsId, "Embed Watch Widgets", 13);
  embedTarget(proj, hostId, watchId, "Embed Watch Content", 16, '"$(CONTENTS_FOLDER_PATH)/Watch"');
  return proj;
}

module.exports = function withAppleWatch(config) {
  const bundleId = config.ios?.bundleIdentifier || "com.bd.linkshell";
  const appGroup = bundleId === "com.bd.linkshell" ? "group.com.bd.linkshell" : `group.${bundleId}.liveactivity`;
  config = withEntitlementsPlist(config, (config) => {
    config.modResults["com.apple.security.application-groups"] = [
      ...new Set([...(config.modResults["com.apple.security.application-groups"] || []), appGroup]),
    ];
    return config;
  });
  config = withInfoPlist(config, (config) => {
    config.modResults.LinkShellWatchCompanionEnabled = true;
    config.modResults.LinkShellWatchBundleIdentifier = `${bundleId}.watchkitapp`;
    config.modResults.LinkShellWatchAppGroup = appGroup;
    return config;
  });
  return withXcodeProject(config, (config) => {
    configureWatchProject(config.modResults, config);
    return config;
  });
};
module.exports.configureWatchProject = configureWatchProject;
module.exports.materializeWatchDirectory = materializeWatchDirectory;
module.exports.WATCH_SOURCE_FILES = WATCH_SOURCE_FILES;
