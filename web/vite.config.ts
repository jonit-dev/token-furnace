import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The page source lives in web/. The npm scripts run from the project root.
export default defineConfig({
  root: "web",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    // Dev only. The live report comes from the CLI server on port 8765, or TF_API_PORT (pnpm dev uses 8766).
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.TF_API_PORT ?? 8765}`, changeOrigin: true } },
  },
});
