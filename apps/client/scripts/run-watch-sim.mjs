#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, "..");
const watchDir = join(clientRoot, "plugins", "watch");
const outDir = process.env.LINKSHELL_WATCH_OUTPUT_DIR || join(clientRoot, "build");
const watchAppBundle = join(outDir, "LinkShellWatch.app");
const watchPlugInsDir = join(watchAppBundle, "PlugIns");
const watchWidgetAppex = join(watchPlugInsDir, "LinkShellWatchWidgets.appex");
const entitlementsPath = join(outDir, "LinkShellWatch.entitlements");

mkdirSync(watchWidgetAppex, { recursive: true });

const watchSdkPath = execFileSync("xcrun", ["--sdk", "watchsimulator", "--show-sdk-path"], {
  encoding: "utf8",
}).trim();

console.log("1. Compiling native watchOS SwiftUI app (LinkShellWatch.app)...");
const require = createRequire(import.meta.url);
const plugin = require("../plugins/with-apple-watch.js");
const account = require("../config/account.json");
const swiftFiles = plugin.WATCH_SOURCE_FILES.map(file => join(watchDir, file));

execFileSync(
  "xcrun",
  [
    "--sdk",
    "watchsimulator",
    "swiftc",
    "-target",
    "arm64-apple-watchos10.0-simulator",
    "-sdk",
    watchSdkPath,
    "-parse-as-library",
    ...swiftFiles,
    "-o",
    join(watchAppBundle, "LinkShellWatch"),
  ],
  { stdio: "inherit" },
);

console.log("2. Compiling standalone watchOS WidgetKit extension (PlugIns/LinkShellWatchWidgets.appex)...");
execFileSync(
  "xcrun",
  [
    "--sdk",
    "watchsimulator",
    "swiftc",
    "-target",
    "arm64-apple-watchos10.0-simulator",
    "-sdk",
    watchSdkPath,
    "-parse-as-library",
    "-application-extension",
    "-DWIDGET_EXTENSION",
    "-Xlinker",
    "-e",
    "-Xlinker",
    "_NSExtensionMain",
    join(watchDir, "WatchModels.swift"),
    join(watchDir, "WatchComplications.swift"),
    "-o",
    join(watchWidgetAppex, "LinkShellWatchWidgets"),
  ],
  { stdio: "inherit" },
);

const watchEntitlements = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>group.com.bd.linkshell</string>
  </array>
</dict>
</plist>
`;
writeFileSync(entitlementsPath, watchEntitlements, "utf8");

const widgetInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>LinkShell</string>
  <key>CFBundleExecutable</key>
  <string>LinkShellWatchWidgets</string>
  <key>CFBundleIdentifier</key>
  <string>com.bd.linkshell.watchkitapp.widgets</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>LinkShellWatchWidgets</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.4</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>MinimumOSVersion</key>
  <string>10.0</string>
  <key>UIDeviceFamily</key>
  <array>
    <integer>4</integer>
  </array>
  <key>LinkShellWatchAppGroup</key>
  <string>group.com.bd.linkshell</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`;
writeFileSync(join(watchWidgetAppex, "Info.plist"), widgetInfoPlist, "utf8");

const watchInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>LinkShell</string>
  <key>CFBundleExecutable</key>
  <string>LinkShellWatch</string>
  <key>CFBundleIdentifier</key>
  <string>com.bd.linkshell.watchkitapp</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>LinkShellWatch</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.4</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>MinimumOSVersion</key>
  <string>10.0</string>
  <key>UIDeviceFamily</key>
  <array>
    <integer>4</integer>
  </array>
  <key>WKApplication</key>
  <true/>
  <key>WKCompanionAppBundleIdentifier</key>
  <string>com.bd.linkshell</string>
  <key>WKRunsIndependentlyOfCompanionApp</key><true/>
  <key>LinkShellAuthURL</key><string>${account.url}</string>
  <key>LinkShellAuthAnonKey</key><string>${account.anonKey}</string>
  <key>LinkShellWatchAppGroup</key>
  <string>group.com.bd.linkshell</string>
</dict>
</plist>
`;

writeFileSync(join(watchAppBundle, "Info.plist"), watchInfoPlist, "utf8");
execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlementsPath, watchWidgetAppex], {
  stdio: "inherit",
});
execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlementsPath, watchAppBundle], {
  stdio: "inherit",
});

function findWatchSimulatorUdid() {
  const raw = execFileSync("xcrun", ["simctl", "list", "devices", "available", "-j"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);
  const devicesByRuntime = parsed.devices || {};
  for (const [runtime, list] of Object.entries(devicesByRuntime)) {
    if (!runtime.includes("watchOS")) continue;
    const booted = list.find((d) => d.state === "Booted");
    if (booted) return booted.udid;
  }
  for (const [runtime, list] of Object.entries(devicesByRuntime)) {
    if (!runtime.includes("watchOS")) continue;
    const preferred =
      list.find((d) => d.name.includes("Series") && d.name.includes("46mm")) ||
      list[0];
    if (preferred) {
      execFileSync("xcrun", ["simctl", "boot", preferred.udid], { stdio: "inherit" });
      return preferred.udid;
    }
  }
  throw new Error("No available watchOS Simulator found.");
}

const watchUdid = findWatchSimulatorUdid();
console.log(`3. Installing LinkShellWatch.app (+ LinkShellWatchWidgets.appex) into watchOS Simulator (${watchUdid})...`);
spawnSync("open", [
  "-a",
  "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app",
  "--args",
  "-CurrentDeviceUDID",
  watchUdid,
]);
execFileSync("xcrun", ["simctl", "install", watchUdid, watchAppBundle], { stdio: "inherit" });

let liveSnapshotJSON = "";
try {
  liveSnapshotJSON = execFileSync("curl", ["-s", "http://127.0.0.1:7879/snapshot"], {
    encoding: "utf8",
  }).trim();
} catch {
  // Fallback if bridge not reachable
}

// Launch the app for functional checks; do not generate screenshot galleries.
spawnSync("xcrun", ["simctl", "terminate", watchUdid, "com.bd.linkshell.watchkitapp"]);
execFileSync(
  "xcrun",
  ["simctl", "launch", watchUdid, "com.bd.linkshell.watchkitapp"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      SIMCTL_CHILD_LINKSHELL_WATCH_MODE: "companion",
      ...(liveSnapshotJSON ? { SIMCTL_CHILD_LINKSHELL_WATCH_SNAPSHOT_JSON: liveSnapshotJSON } : {}),
    },
  },
);
