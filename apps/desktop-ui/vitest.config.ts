import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    environmentMatchGlobs: [["test/**/*.test.tsx", "jsdom"]],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@linkshell/wire": fileURLToPath(
        new URL("../../packages/wire/src/index.ts", import.meta.url),
      ),
      "@linkshell/client-core": fileURLToPath(
        new URL("../../packages/client-core/src/index.ts", import.meta.url),
      ),
    },
  },
});
