import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("native qualification contracts", () => {
  it("does not treat a delayed native launch as denial or stop evidence", () => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "qualify-budgets.mjs"), "--self-test"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("qualification contract ok");
  });
});
