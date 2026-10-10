import { defineConfig } from "tsup";

// PRD-003 narrows `entry` to src/cli.ts once the binary exists.
export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
});