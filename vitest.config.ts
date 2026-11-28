import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "web/src/**/*.test.tsx"],
    environment: "node",
    // The suite spawns real subprocesses (a SQLite worker, fake `codex`, the CLI). Under a full
    // parallel run one of them can take longer than the 5 s default, which is a slow machine
    // failing a test, not a wrong one.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
