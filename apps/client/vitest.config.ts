import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The app's own logic, tested without a phone: what needs React Native is replaced in each test.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The packages' sources, as Metro takes them: no build needed first.
      "@linkshell/wire": fileURLToPath(new URL("../../packages/wire/src/index.ts", import.meta.url)),
      "@linkshell/client-core": fileURLToPath(new URL("../../packages/client-core/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
