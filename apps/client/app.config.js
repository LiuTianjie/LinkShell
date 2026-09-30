// Release builds are the LinkShell app (com.bd.linkshell, the App Store / APK
// listing). Development builds (APP_VARIANT=development) install beside it.
module.exports = ({ config }) => {
  if (process.env.APP_VARIANT !== "development") return config;
  const id = "com.bd.linkshell.v2";
  return {
    ...config,
    name: "LinkShell Dev",
    ios: { ...config.ios, bundleIdentifier: id },
    android: { ...config.android, package: id },
  };
};
