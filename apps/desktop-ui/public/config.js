// Public deployment settings. Never put tokens or private keys in this file.
// The Gateway overrides /config.js dynamically at runtime; static hosts can replace this file without rebuilding.
window.__LINKSHELL_CONFIG__ = window.__LINKSHELL_CONFIG__ ?? {
  deployment: "official",
  gatewayUrl: "",
};
