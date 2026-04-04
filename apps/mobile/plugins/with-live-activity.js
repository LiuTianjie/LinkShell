const { withInfoPlist, withEntitlementsPlist, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const WIDGET_TARGET_NAME = "LinkShellWidgets";
const APP_GROUP_ID = "group.com.bd.linkshell";

function withLiveActivity(config) {
  // 1. Add NSSupportsLiveActivities to Info.plist
  config = withInfoPlist(config, (config) => {
    config.modResults.NSSupportsLiveActivities = true;
    config.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    return config;
  });

  // 2. Add App Group entitlement to main app
  config = withEntitlementsPlist(config, (config) => {
    if (!config.modResults["com.apple.security.application-groups"]) {
      config.modResults["com.apple.security.application-groups"] = [];
    }
    const groups = config.modResults["com.apple.security.application-groups"];
    if (!groups.includes(APP_GROUP_ID)) {
      groups.push(APP_GROUP_ID);
    }
    return config;
  });

  // 3. Copy files + patch pbxproj directly (more reliable than xcode-project API)
  config = withDangerousMod(config, [
    "ios",
    async (config) => {
      const iosPath = config.modRequest.platformProjectRoot;
      const sourceDir = path.join(config.modRequest.projectRoot, "ios-widgets");
      const widgetDir = path.join(iosPath, WIDGET_TARGET_NAME);
      const mainAppDir = path.join(iosPath, "LinkShell");
      const pbxprojPath = path.join(iosPath, "LinkShell.xcodeproj", "project.pbxproj");

      // ── Copy files ──────────────────────────────────────────────

      fs.mkdirSync(widgetDir, { recursive: true });

      // Widget extension files
      const widgetFiles = ["ActivityAttributes.swift", "LinkShellLiveActivity.swift", "LinkShellWidgetBundle.swift"];
      for (const file of widgetFiles) {
        const src = path.join(sourceDir, file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(widgetDir, file));
      }

      // Native module files → main app
      const mainAppFiles = ["LiveActivityModule.swift", "LiveActivityModuleBridge.m", "ActivityAttributes.swift"];
      for (const file of mainAppFiles) {
        const src = path.join(sourceDir, file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(mainAppDir, file));
      }

      // Widget Info.plist
      fs.writeFileSync(path.join(widgetDir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
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
</plist>`);

      // Widget entitlements
      fs.writeFileSync(path.join(widgetDir, `${WIDGET_TARGET_NAME}.entitlements`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${APP_GROUP_ID}</string>
  </array>
</dict>
</plist>`);

      // ── Patch pbxproj to add widget target + native module files ──

      let pbx = fs.readFileSync(pbxprojPath, "utf8");

      // Skip if already patched
      if (pbx.includes(WIDGET_TARGET_NAME)) {
        // Just add native module files to main app Sources if not present
        pbx = addMainAppNativeModuleFiles(pbx);
        fs.writeFileSync(pbxprojPath, pbx);
        return config;
      }

      // Generate UUIDs (deterministic for reproducibility)
      const uuids = {
        widgetTarget: "W1000000000000000000001",
        widgetProduct: "W1000000000000000000002",
        widgetConfigList: "W1000000000000000000003",
        widgetDebugConfig: "W1000000000000000000004",
        widgetReleaseConfig: "W1000000000000000000005",
        widgetSourcesPhase: "W1000000000000000000006",
        widgetFrameworksPhase: "W1000000000000000000007",
        widgetResourcesPhase: "W1000000000000000000008",
        widgetGroup: "W1000000000000000000009",
        // Widget source file refs
        attrFileRef: "W100000000000000000000A",
        liveActFileRef: "W100000000000000000000B",
        bundleFileRef: "W100000000000000000000C",
        // Widget source build files
        attrBuildFile: "W100000000000000000000D",
        liveActBuildFile: "W100000000000000000000E",
        bundleBuildFile: "W100000000000000000000F",
        // Main app native module file refs
        moduleFileRef: "W1000000000000000000010",
        moduleBridgeFileRef: "W1000000000000000000011",
        mainAttrFileRef: "W1000000000000000000012",
        // Main app native module build files
        moduleBuildFile: "W1000000000000000000013",
        moduleBridgeBuildFile: "W1000000000000000000014",
        mainAttrBuildFile: "W1000000000000000000015",
        // Embed phase
        embedPhase: "W1000000000000000000016",
        embedBuildFile: "W1000000000000000000017",
        // Container item proxy + dependency
        containerProxy: "W1000000000000000000018",
        targetDependency: "W1000000000000000000019",
      };

      const bundleId = config.ios?.bundleIdentifier ?? "com.bd.linkshell";
      const widgetBundleId = bundleId + ".widgets";
      const teamId = config.ios?.appleTeamId ?? "L95PYLFT86";

      // ── PBXBuildFile entries ──
      const buildFileEntries = `
		${uuids.attrBuildFile} /* ActivityAttributes.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${uuids.attrFileRef} /* ActivityAttributes.swift */; };
		${uuids.liveActBuildFile} /* LinkShellLiveActivity.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${uuids.liveActFileRef} /* LinkShellLiveActivity.swift */; };
		${uuids.bundleBuildFile} /* LinkShellWidgetBundle.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${uuids.bundleFileRef} /* LinkShellWidgetBundle.swift */; };
		${uuids.moduleBuildFile} /* LiveActivityModule.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${uuids.moduleFileRef} /* LiveActivityModule.swift */; };
		${uuids.moduleBridgeBuildFile} /* LiveActivityModuleBridge.m in Sources */ = {isa = PBXBuildFile; fileRef = ${uuids.moduleBridgeFileRef} /* LiveActivityModuleBridge.m */; };
		${uuids.mainAttrBuildFile} /* ActivityAttributes.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${uuids.mainAttrFileRef} /* ActivityAttributes.swift */; };
		${uuids.embedBuildFile} /* ${WIDGET_TARGET_NAME}.appex in Embed App Extensions */ = {isa = PBXBuildFile; fileRef = ${uuids.widgetProduct} /* ${WIDGET_TARGET_NAME}.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`;

      pbx = pbx.replace(
        "/* End PBXBuildFile section */",
        `${buildFileEntries}\n/* End PBXBuildFile section */`,
      );

      // ── PBXFileReference entries ──
      const fileRefEntries = `
		${uuids.widgetProduct} /* ${WIDGET_TARGET_NAME}.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = "${WIDGET_TARGET_NAME}.appex"; sourceTree = BUILT_PRODUCTS_DIR; };
		${uuids.attrFileRef} /* ActivityAttributes.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ActivityAttributes.swift; sourceTree = "<group>"; };
		${uuids.liveActFileRef} /* LinkShellLiveActivity.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = LinkShellLiveActivity.swift; sourceTree = "<group>"; };
		${uuids.bundleFileRef} /* LinkShellWidgetBundle.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = LinkShellWidgetBundle.swift; sourceTree = "<group>"; };
		${uuids.moduleFileRef} /* LiveActivityModule.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; name = LiveActivityModule.swift; path = LinkShell/LiveActivityModule.swift; sourceTree = "<group>"; };
		${uuids.moduleBridgeFileRef} /* LiveActivityModuleBridge.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; name = LiveActivityModuleBridge.m; path = LinkShell/LiveActivityModuleBridge.m; sourceTree = "<group>"; };
		${uuids.mainAttrFileRef} /* ActivityAttributes.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; name = ActivityAttributes.swift; path = LinkShell/ActivityAttributes.swift; sourceTree = "<group>"; };`;

      pbx = pbx.replace(
        "/* End PBXFileReference section */",
        `${fileRefEntries}\n/* End PBXFileReference section */`,
      );

      // ── PBXGroup: widget group ──
      const widgetGroupEntry = `
		${uuids.widgetGroup} /* ${WIDGET_TARGET_NAME} */ = {
			isa = PBXGroup;
			children = (
				${uuids.attrFileRef} /* ActivityAttributes.swift */,
				${uuids.liveActFileRef} /* LinkShellLiveActivity.swift */,
				${uuids.bundleFileRef} /* LinkShellWidgetBundle.swift */,
			);
			name = ${WIDGET_TARGET_NAME};
			path = ${WIDGET_TARGET_NAME};
			sourceTree = "<group>";
		};`;

      pbx = pbx.replace(
        "/* End PBXGroup section */",
        `${widgetGroupEntry}\n/* End PBXGroup section */`,
      );

      // Add widget group + native module files to main group
      pbx = pbx.replace(
        /(\s*children = \(\s*)((?:.*\n)*?)(.*\/\* LinkShell \*\/)/m,
        (match, prefix, children, linkshellLine) => {
          return `${prefix}${children}				${uuids.widgetGroup} /* ${WIDGET_TARGET_NAME} */,\n				${uuids.moduleFileRef} /* LiveActivityModule.swift */,\n				${uuids.moduleBridgeFileRef} /* LiveActivityModuleBridge.m */,\n				${uuids.mainAttrFileRef} /* ActivityAttributes.swift */,\n${linkshellLine}`;
        },
      );

      // Add widget product to Products group
      pbx = pbx.replace(
        /(\/\* LinkShell\.app \*\/,)/,
        `$1\n				${uuids.widgetProduct} /* ${WIDGET_TARGET_NAME}.appex */,`,
      );

      // ── Widget Sources build phase ──
      const widgetSourcesPhase = `
		${uuids.widgetSourcesPhase} /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				${uuids.attrBuildFile} /* ActivityAttributes.swift in Sources */,
				${uuids.liveActBuildFile} /* LinkShellLiveActivity.swift in Sources */,
				${uuids.bundleBuildFile} /* LinkShellWidgetBundle.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};`;

      pbx = pbx.replace(
        "/* End PBXSourcesBuildPhase section */",
        `${widgetSourcesPhase}\n/* End PBXSourcesBuildPhase section */`,
      );

      // ── Add native module files to main app Sources build phase ──
      pbx = addMainAppNativeModuleFiles(pbx, uuids);

      // ── Widget Frameworks build phase ──
      const widgetFrameworksPhase = `
		${uuids.widgetFrameworksPhase} /* Frameworks */ = {
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};`;

      pbx = pbx.replace(
        "/* End PBXFrameworksBuildPhase section */",
        `${widgetFrameworksPhase}\n/* End PBXFrameworksBuildPhase section */`,
      );

      // ── Widget Resources build phase ──
      const widgetResourcesPhase = `
		${uuids.widgetResourcesPhase} /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};`;

      pbx = pbx.replace(
        "/* End PBXResourcesBuildPhase section */",
        `${widgetResourcesPhase}\n/* End PBXResourcesBuildPhase section */`,
      );

      // ── Embed App Extensions build phase on main target ──
      const embedPhase = `
		${uuids.embedPhase} /* Embed App Extensions */ = {
			isa = PBXCopyFilesBuildPhase;
			buildActionMask = 2147483647;
			dstPath = "";
			dstSubfolderSpec = 13;
			files = (
				${uuids.embedBuildFile} /* ${WIDGET_TARGET_NAME}.appex in Embed App Extensions */,
			);
			name = "Embed App Extensions";
			runOnlyForDeploymentPostprocessing = 0;
		};`;

      // Add embed phase to the file and to main target's buildPhases
      pbx = pbx.replace(
        "/* End PBXCopyFilesBuildPhase section */",
        `${embedPhase}\n/* End PBXCopyFilesBuildPhase section */`,
      );

      // If no PBXCopyFilesBuildPhase section exists, create one
      if (!pbx.includes("/* Begin PBXCopyFilesBuildPhase section */")) {
        pbx = pbx.replace(
          "/* Begin PBXFileReference section */",
          `/* Begin PBXCopyFilesBuildPhase section */\n${embedPhase.trim()}\n/* End PBXCopyFilesBuildPhase section */\n\n/* Begin PBXFileReference section */`,
        );
      }

      // Add embed phase to main target's buildPhases
      pbx = pbx.replace(
        /(\/\* Sources \*\/,\s*\n)/,
        `$1				${uuids.embedPhase} /* Embed App Extensions */,\n`,
      );

      // ── Container item proxy + target dependency ──
      // Find main target UUID
      const mainTargetMatch = pbx.match(/(\w{24}) \/\* LinkShell \*\/ = \{\s*isa = PBXNativeTarget/);
      const mainTargetUuid = mainTargetMatch ? mainTargetMatch[1] : "13B07F861A680F5B00A75B9A";
      const projectUuid = pbx.match(/rootObject = (\w{24})/)?.[1] ?? "83CBB9F71A601CBA00E9B192";

      const containerProxy = `
		${uuids.containerProxy} /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = ${projectUuid} /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = ${uuids.widgetTarget};
			remoteInfo = ${WIDGET_TARGET_NAME};
		};`;

      const targetDependency = `
		${uuids.targetDependency} /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = ${uuids.widgetTarget} /* ${WIDGET_TARGET_NAME} */;
			targetProxy = ${uuids.containerProxy} /* PBXContainerItemProxy */;
		};`;

      // Add container proxy
      if (pbx.includes("/* End PBXContainerItemProxy section */")) {
        pbx = pbx.replace(
          "/* End PBXContainerItemProxy section */",
          `${containerProxy}\n/* End PBXContainerItemProxy section */`,
        );
      } else {
        pbx = pbx.replace(
          "/* Begin PBXCopyFilesBuildPhase section */",
          `/* Begin PBXContainerItemProxy section */\n${containerProxy.trim()}\n/* End PBXContainerItemProxy section */\n\n/* Begin PBXCopyFilesBuildPhase section */`,
        );
      }

      // Add target dependency
      if (pbx.includes("/* End PBXTargetDependency section */")) {
        pbx = pbx.replace(
          "/* End PBXTargetDependency section */",
          `${targetDependency}\n/* End PBXTargetDependency section */`,
        );
      } else {
        pbx = pbx.replace(
          "/* Begin PBXSourcesBuildPhase section */",
          `/* Begin PBXTargetDependency section */\n${targetDependency.trim()}\n/* End PBXTargetDependency section */\n\n/* Begin PBXSourcesBuildPhase section */`,
        );
      }

      // Add dependency to main target
      const depRegex = new RegExp(`(${mainTargetUuid}[^}]*?dependencies = \\()`);
      pbx = pbx.replace(depRegex, `$1\n				${uuids.targetDependency} /* PBXTargetDependency */,`);

      // ── Widget native target ──
      const widgetNativeTarget = `
		${uuids.widgetTarget} /* ${WIDGET_TARGET_NAME} */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${uuids.widgetConfigList} /* Build configuration list for PBXNativeTarget "${WIDGET_TARGET_NAME}" */;
			buildPhases = (
				${uuids.widgetSourcesPhase} /* Sources */,
				${uuids.widgetFrameworksPhase} /* Frameworks */,
				${uuids.widgetResourcesPhase} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = ${WIDGET_TARGET_NAME};
			productName = ${WIDGET_TARGET_NAME};
			productReference = ${uuids.widgetProduct} /* ${WIDGET_TARGET_NAME}.appex */;
			productType = "com.apple.product-type.app-extension";
		};`;

      pbx = pbx.replace(
        "/* End PBXNativeTarget section */",
        `${widgetNativeTarget}\n/* End PBXNativeTarget section */`,
      );

      // Add widget target to project targets list
      pbx = pbx.replace(
        /(targets = \(\s*\n\s*\w{24} \/\* LinkShell \*\/,)/,
        `$1\n				${uuids.widgetTarget} /* ${WIDGET_TARGET_NAME} */,`,
      );

      // ── Widget build configurations ──
      const widgetBuildSettings = `
				ASSETCATALOG_COMPILER_WIDGET_BACKGROUND_COLOR_NAME = WidgetBackground;
				CODE_SIGN_ENTITLEMENTS = "${WIDGET_TARGET_NAME}/${WIDGET_TARGET_NAME}.entitlements";
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				DEVELOPMENT_TEAM = ${teamId};
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_FILE = "${WIDGET_TARGET_NAME}/Info.plist";
				IPHONEOS_DEPLOYMENT_TARGET = 16.2;
				LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks";
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = "${widgetBundleId}";
				PRODUCT_NAME = "$(TARGET_NAME)";
				SKIP_INSTALL = YES;
				SWIFT_EMIT_LOC_STRINGS = YES;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";`;

      const widgetConfigs = `
		${uuids.widgetDebugConfig} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {${widgetBuildSettings}
			};
			name = Debug;
		};
		${uuids.widgetReleaseConfig} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {${widgetBuildSettings}
			};
			name = Release;
		};`;

      pbx = pbx.replace(
        "/* End XCBuildConfiguration section */",
        `${widgetConfigs}\n/* End XCBuildConfiguration section */`,
      );

      const widgetConfigList = `
		${uuids.widgetConfigList} /* Build configuration list for PBXNativeTarget "${WIDGET_TARGET_NAME}" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${uuids.widgetDebugConfig} /* Debug */,
				${uuids.widgetReleaseConfig} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};`;

      pbx = pbx.replace(
        "/* End XCConfigurationList section */",
        `${widgetConfigList}\n/* End XCConfigurationList section */`,
      );

      fs.writeFileSync(pbxprojPath, pbx);
      return config;
    },
  ]);

  return config;
}

/**
 * Add LiveActivityModule.swift, LiveActivityModuleBridge.m, and ActivityAttributes.swift
 * to the main app's Sources build phase.
 */
function addMainAppNativeModuleFiles(pbx, uuids) {
  const u = uuids || {
    moduleBuildFile: "W1000000000000000000013",
    moduleBridgeBuildFile: "W1000000000000000000014",
    mainAttrBuildFile: "W1000000000000000000015",
  };

  // Find the main app's Sources build phase (the one with AppDelegate.swift)
  if (pbx.includes("LiveActivityModule.swift in Sources")) return pbx;

  pbx = pbx.replace(
    /(AppDelegate\.swift in Sources \*\/,)/,
    `$1\n				${u.moduleBuildFile} /* LiveActivityModule.swift in Sources */,\n				${u.moduleBridgeBuildFile} /* LiveActivityModuleBridge.m in Sources */,\n				${u.mainAttrBuildFile} /* ActivityAttributes.swift in Sources */,`,
  );

  return pbx;
}

module.exports = withLiveActivity;
