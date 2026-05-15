import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@linkshell/protocol": resolve(packageDir, "../shared-protocol/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
