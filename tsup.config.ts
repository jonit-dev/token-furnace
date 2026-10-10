import { defineConfig } from "tsup";

// The binary is dist/cli.js; the server and the renderers come with it in the same bundle.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
});