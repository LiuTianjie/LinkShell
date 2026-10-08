import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/@xterm/")) return "terminal";
          if (id.includes("/@supabase/")) return "account";
          if (
            /node_modules.*(remark-|rehype-|micromark|mdast-|hast-|react-markdown|unified)/.test(
              id,
            )
          )
            return "markdown";
        },
      },
    },
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
