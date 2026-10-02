import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@linkshell/wire": fileURLToPath(new URL("../wire/src/index.ts", import.meta.url)),
    },
  },
});
