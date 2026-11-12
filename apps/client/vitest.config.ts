import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The app's own logic, tested without a phone: what needs React Native is replaced in each test.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url).href),
      // The packages' sources, as Metro takes them: no build needed first.
      "@linkshell/wire": fileURLToPath(new URL("../../packages/wire/src/index.ts", import.meta.url).href),
      "@linkshell/client-core": fileURLToPath(new URL("../../packages/client-core/src/index.ts", import.meta.url).href),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
