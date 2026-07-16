import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // The protocol package is a workspace dep shipping ESM from dist/; pre-bundle
  // it (and zod) so Vite dev resolves it cleanly across the monorepo symlink.
  optimizeDeps: {
    include: ["@linkshell/protocol", "zod"],
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavyweight vendors into stable, cacheable chunks so the main
        // bundle stays small and a release only invalidates what changed.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("highlight.js") || id.includes("lowlight")) return "vendor-highlight";
          if (id.includes("@supabase")) return "vendor-supabase";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router") ||
            id.includes("/scheduler/")
          ) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
});
