import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// One configuration for the whole workspace. TypeScript already catches what the compiler can; this is for
// what it lets through: promises nobody waits for, hooks that miss a dependency, code left unused.
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "tmp/**",
      "temp/**",
      ".claude/worktrees/**",
      "**/.expo/**",
      "apps/client/ios/**",
      "apps/client/android/**",
      "apps/client/modules/*/ios/**",
      "apps/client/modules/*/android/**",
      "apps/mac/**",
      "docs/**",
      "promo/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // An unused argument is often part of a signature; a leading underscore says it is deliberate.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // `catch {}` is how the code says "this may fail and that is fine", usually with the reason beside it.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Cases that share a result are listed one under another, sometimes with a comment between them.
      "no-fallthrough": ["error", { allowEmptyCase: true }],
      // Two things that refer to each other: one has to be named before it exists.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // The rules that need types: the ones that find real bugs in asynchronous code.
    // Sources only: tests and scripts are outside the packages' tsconfig projects.
    files: ["packages/*/src/**/*.ts", "apps/client/src/**/*.{ts,tsx}", "apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    files: ["apps/client/src/**/*.{ts,tsx}", "apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // How React Native takes an image, and how a development-only module stays out of release bundles.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx,js}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["**/*.cjs", "apps/client/*.js", "apps/client/plugins/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
