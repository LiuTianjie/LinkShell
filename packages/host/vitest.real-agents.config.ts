import { mergeConfig, defineConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(base, defineConfig({
  test: {
    include: ["test/real-agents/*.contract.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
  },
}));
