import { defineConfig } from "tsup";

// The binary is dist/cli.js; the server and the renderers come with it in the same bundle.
// dist/scan-worker.js is the parse worker the scan starts in threads.
// Watch mode keeps dist/web, which vite builds and the server serves.
export default defineConfig((options) => ({
  entry: ["src/cli.ts", "src/scan-worker.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: !options.watch,
}));
