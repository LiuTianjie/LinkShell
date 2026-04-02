const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.unstable_enableSymlinks = true;
config.resolver.resolveRequest = MetroSymlinksResolver();

module.exports = config;