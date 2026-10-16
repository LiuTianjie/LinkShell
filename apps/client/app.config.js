// Release builds are the LinkShell app (com.bd.linkshell, the App Store / APK
// listing). Development builds (APP_VARIANT=development) install beside it.
module.exports = ({ config }) => {
  const development = process.env.APP_VARIANT === "development";
  const scheme = development ? "linkshell-dev" : "linkshell";
  config = { ...config, scheme, ios: { ...config.ios, infoPlist: { ...config.ios?.infoPlist, LinkShellURLScheme: scheme } } };
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
