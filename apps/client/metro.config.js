// Metro config for the LinkShell client inside the pnpm monorepo.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const packagesDir = path.join(workspaceRoot, "packages") + path.sep;

// Shared packages are consumed from TypeScript source on every platform.
const sources = {
  "@linkshell/wire": path.join(workspaceRoot, "packages/wire/src/index.ts"),
  "@linkshell/client-core": path.join(workspaceRoot, "packages/client-core/src/index.ts"),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const source = sources[moduleName];
  if (source) return { type: "sourceFile", filePath: source };
  // The shared packages are ESM TypeScript and import siblings as "./x.js".
  if (moduleName.startsWith(".") && moduleName.endsWith(".js") && context.originModulePath.startsWith(packagesDir)) {
    try {
      return context.resolveRequest(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // Fall through to the default resolution.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
