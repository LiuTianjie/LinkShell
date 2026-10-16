// Release builds are the LinkShell app (com.bd.linkshell, the App Store / APK
// listing). Development builds (APP_VARIANT=development) install beside it.
module.exports = ({ config }) => {
  if (process.env.LINKSHELL_LIVE_ACTIVITY_PUSH === "1") {
    if (process.env.APP_VARIANT === "development") throw new Error("Live Activity push is configured only for the production app (com.bd.linkshell)");
    const serviceUrl = process.env.LINKSHELL_PUSH_SERVICE_URL || "https://push.itool.tech";
    const url = new URL(serviceUrl);
    if (url.protocol !== "https:" || url.origin !== serviceUrl || url.username || url.password) throw new Error("LINKSHELL_PUSH_SERVICE_URL must be an HTTPS origin without a path");
    config = { ...config, ios: {
      ...config.ios,
      entitlements: { ...config.ios?.entitlements, "aps-environment": "production" },
      infoPlist: { ...config.ios?.infoPlist, LinkShellLiveActivityPushURL: serviceUrl },
    } };
  }
  if (process.env.APP_VARIANT !== "development") return config;
  const id = "com.bd.linkshell.v2";
  return {
    ...config,
    name: "LinkShell Dev",
    ios: { ...config.ios, bundleIdentifier: id },
    android: { ...config.android, package: id },
  };
};
