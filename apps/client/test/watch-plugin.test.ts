import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { materializeWatchDirectory, WATCH_SOURCE_FILES } = require("../plugins/with-apple-watch.js") as {
  materializeWatchDirectory: (
    root: string,
    opts: { bundleId: string; appGroup: string; scheme: string },
  ) => string;
  WATCH_SOURCE_FILES: string[];
};

type ProjectReference = { value: string };
type ProjectTarget = {
  isa: string; name: string; productReference: string;
  buildPhases: ProjectReference[]; buildConfigurationList: string;
};

describe("Watch release target graph", () => {
  it.each(["com.bd.linkshell", "com.bd.linkshell.v2"])("embeds app and widgets once for %s", (bundleId) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "linkshell-watch-graph-"));
    try {
      const pluginRequire = createRequire(require.resolve("expo/config-plugins"));
      const xcode = pluginRequire("xcode");
      const proj = xcode.project(path.join(tmp, "project.pbxproj"));
      proj.hash = { project: { rootObject: "PROJECT", objects: {
        PBXProject: { PROJECT: { isa: "PBXProject", mainGroup: "MAIN", targets: [{ value: "HOST" }] } },
        PBXNativeTarget: { HOST: { isa: "PBXNativeTarget", name: "Host", buildPhases: [], dependencies: [] } },
        PBXGroup: { MAIN: { isa: "PBXGroup", children: [] } },
        PBXBuildFile: {}, PBXFileReference: {}, XCBuildConfiguration: {}, XCConfigurationList: {},
      } } };
      const { configureWatchProject } = require("../plugins/with-apple-watch.js");
      const config = { version: "2.3.32", ios: { bundleIdentifier: bundleId, buildNumber: "20332" }, modRequest: { platformProjectRoot: tmp } };
      configureWatchProject(proj, config);
      const serialized = proj.writeSync();
      configureWatchProject(proj, config);
      expect(proj.writeSync()).toBe(serialized);
      const objects = proj.hash.project.objects;
      const targets = (Object.values(objects.PBXNativeTarget) as ProjectTarget[]).filter((v) => v.isa === "PBXNativeTarget");
      expect(targets).toHaveLength(3);
      const watch = targets.find((v) => v.name === '"LinkShellWatch"');
      const widget = targets.find((v) => v.name === '"LinkShellWatchWidgets"');
      const embeddedProducts = (target: ProjectTarget) => target.buildPhases.flatMap(({ value }: ProjectReference) =>
        (objects.PBXCopyFilesBuildPhase[value]?.files ?? []).map((file: ProjectReference) => objects.PBXBuildFile[file.value].fileRef));
      expect(embeddedProducts(objects.PBXNativeTarget.HOST)).toEqual([watch.productReference]);
      expect(embeddedProducts(watch)).toEqual([widget.productReference]);
      const settings = objects.XCConfigurationList[widget.buildConfigurationList].buildConfigurations.map(({ value }: ProjectReference) => objects.XCBuildConfiguration[value].buildSettings);
      expect(settings).toHaveLength(2);
      for (const setting of settings) {
        expect(setting.PRODUCT_BUNDLE_IDENTIFIER).toBe(`"${bundleId}.watchkitapp.widgets"`);
        expect(setting.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toContain("WIDGET_EXTENSION");
        expect(setting.SDKROOT).toBe("watchos");
        expect(setting.CURRENT_PROJECT_VERSION).toBe("20332");
      }
      expect(fs.existsSync(path.join(tmp, "LinkShellWatch/Assets.xcassets/AppIcon.appiconset/icon.png"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Apple Watch Expo plugin and Swift typechecking", () => {
  it("materializes LinkShellWatch Info.plist, entitlements, and all watchOS Swift sources", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "linkshell-watch-test-"));
    try {
      const watchDir = materializeWatchDirectory(tmpRoot, {
        bundleId: "com.bd.linkshell",
        appGroup: "group.com.bd.linkshell",
        scheme: "linkshell",
      });

      const infoPlist = fs.readFileSync(path.join(watchDir, "LinkShellWatch-Info.plist"), "utf8");
      expect(infoPlist).toContain("<key>WKApplication</key>");
      expect(infoPlist).toContain("<key>WKRunsIndependentlyOfCompanionApp</key>\n  <true/>");
      expect(infoPlist).toContain("<key>LinkShellAuthURL</key>");
      expect(infoPlist).toContain("<key>LinkShellAuthAnonKey</key>");
      expect(infoPlist).toContain("<string>com.bd.linkshell</string>");
      expect(infoPlist).toContain("<string>group.com.bd.linkshell</string>");

      const widgetsInfoPlist = fs.readFileSync(path.join(watchDir, "LinkShellWatchWidgets-Info.plist"), "utf8");
      expect(widgetsInfoPlist).toContain("<string>com.apple.widgetkit-extension</string>");
      expect(widgetsInfoPlist).toContain("<string>XPC!</string>");
      expect(widgetsInfoPlist).toContain("<string>group.com.bd.linkshell</string>");

      const entitlements = fs.readFileSync(path.join(watchDir, "LinkShellWatch.entitlements"), "utf8");
      expect(entitlements).toContain("group.com.bd.linkshell");

      for (const file of WATCH_SOURCE_FILES) {
        const filePath = path.join(watchDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.statSync(filePath).size).toBeGreaterThan(100);
      }

      if (process.platform === "darwin") {
        const swiftFiles = WATCH_SOURCE_FILES.map((file) => path.join(watchDir, file));
        execFileSync(
          "xcrun",
          [
            "--sdk",
            "watchsimulator",
            "swiftc",
            "-typecheck",
            "-target",
            "arm64-apple-watchos10.0-simulator",
            ...swiftFiles,
          ],
          { stdio: "pipe" },
        );

        execFileSync(
          "xcrun",
          [
            "--sdk",
            "watchsimulator",
            "swiftc",
            "-typecheck",
            "-parse-as-library",
            "-application-extension",
            "-DWIDGET_EXTENSION",
            "-target",
            "arm64-apple-watchos10.0-simulator",
            path.join(watchDir, "WatchModels.swift"),
            path.join(watchDir, "WatchComplications.swift"),
          ],
          { stdio: "pipe" },
        );

        const clientRoot = path.resolve(import.meta.dirname, "..");
        execFileSync(
          "xcrun",
          [
            "--sdk",
            "iphonesimulator",
            "swiftc",
            "-typecheck",
            "-target",
            "arm64-apple-ios18.0-simulator",
            path.join(clientRoot, "modules/link-layout/ios/WatchSessionBridge.swift"),
          ],
          { stdio: "pipe" },
        );

        const pluginFile = fs.readFileSync(path.join(clientRoot, "plugins/with-live-activity.js"), "utf8");
        const match = pluginFile.match(/const SWIFT_SOURCE_CONTENT = (`[\s\S]*?`)\s*\+\s*fs\.readFileSync/);
        expect(match).toBeTruthy();
        const prefix = new Function(`return ${match![1]};`)() as string;
        const views = fs.readFileSync(path.join(clientRoot, "plugins/live-activity/LiveActivityViews.swift"), "utf8");
        const laSource = path.join(tmpRoot, "LinkShellLiveActivity.swift");
        const laModel = path.join(tmpRoot, "LiveActivityModel.swift");
        const laAction = path.join(tmpRoot, "LinkShellActivityActionIntent.swift");
        fs.writeFileSync(laSource, prefix + views);
        fs.copyFileSync(path.join(clientRoot, "modules/link-layout/ios/LiveActivityModel.swift"), laModel);
        fs.writeFileSync(
          laAction,
          [
            fs.readFileSync(path.join(clientRoot, "modules/link-layout/ios/LiveActivityAction.swift"), "utf8"),
            fs.readFileSync(path.join(clientRoot, "plugins/live-activity/LiveActivityActionIntent.swift"), "utf8"),
            fs.readFileSync(path.join(clientRoot, "plugins/live-activity/LiveActivityBrowseIntent.swift"), "utf8"),
          ].join("\n"),
        );
        execFileSync(
          "xcrun",
          [
            "--sdk",
            "iphonesimulator",
            "swiftc",
            "-typecheck",
            "-parse-as-library",
            "-target",
            "arm64-apple-ios18.0-simulator",
            laSource,
            laModel,
            laAction,
          ],
          { stdio: "pipe" },
        );
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
