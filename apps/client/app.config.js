// Release builds are the LinkShell app (com.bd.linkshell, the App Store / APK
// listing). Development builds (APP_VARIANT=development) install beside it.
module.exports = ({ config }) => {
  const development = process.env.APP_VARIANT === "development";
  const scheme = development ? "linkshell-dev" : "linkshell";
  const existingBonjour = Array.isArray(config.ios?.infoPlist?.NSBonjourServices)
    ? config.ios.infoPlist.NSBonjourServices
    : [];
  const bonjourServices = existingBonjour.includes("_linkshell._tcp")
    ? existingBonjour
    : [...existingBonjour, "_linkshell._tcp"];
  const existingAndroidPermissions = Array.isArray(config.android?.permissions)
    ? config.android.permissions
    : [];
  const androidPermissions = Array.from(
    new Set([
      ...existingAndroidPermissions,
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
      "android.permission.CHANGE_WIFI_MULTICAST_STATE",
    ]),
  );
  config = {
    ...config,
    scheme,
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios?.infoPlist,
        LinkShellURLScheme: scheme,
        NSBonjourServices: bonjourServices,
        NSLocalNetworkUsageDescription:
          config.ios?.infoPlist?.NSLocalNetworkUsageDescription ||
          "LinkShell 需要在本地网络中发现并直连同一局域网内的电脑，以降低终端交互与远程屏幕延迟",
      },
    },
    android: {
      ...config.android,
      permissions: androidPermissions,
    },
  };
  if (process.env.LINKSHELL_LIVE_ACTIVITY_PUSH === "1") {
    const serviceUrl = process.env.LINKSHELL_PUSH_SERVICE_URL || "https://push.itool.tech";
    if (development && serviceUrl === "https://push.itool.tech") throw new Error("Development Live Activities require a separate sandbox push service URL");
    const url = new URL(serviceUrl);
    if (url.protocol !== "https:" || url.origin !== serviceUrl || url.username || url.password) throw new Error("LINKSHELL_PUSH_SERVICE_URL must be an HTTPS origin without a path");
    config = { ...config, ios: {
      ...config.ios,
      entitlements: { ...config.ios?.entitlements, "aps-environment": development ? "development" : "production" },
      infoPlist: { ...config.ios?.infoPlist, LinkShellLiveActivityPushURL: serviceUrl },
    } };
  }
  if (!development) return config;
  const id = process.env.LINKSHELL_DEV_BUNDLE_ID || "com.bd.linkshell.v2";
  return {
    ...config,
    name: "LinkShell Dev",
    ios: { ...config.ios, bundleIdentifier: id },
    android: { ...config.android, package: id },
  };
};
