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
});
