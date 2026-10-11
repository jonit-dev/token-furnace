import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compose } from "../src/compose";
import { main } from "../src/cli";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(argv: string[]) {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-cli-"));
  roots.push(root);
  const app = compose({ HOME: root }, { noCache: true });
  const out: string[] = [];
  const err: string[] = [];
  const original = process.stdout.write;
  const originalError = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { code: await main(argv, app), output: out.join(""), error: err.join("") };
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalError;
    app.budgets.close();
  }
}

describe("budget CLI", () => {
  it("reports the same default Off state as the dashboard", async () => {
    const result = await run(["budgets", "status"]);
    expect(result.code).toBe(0);
    const status = JSON.parse(result.output) as { sources: Array<{ source: string; policy: unknown }> };
    expect(status.sources.map((source) => source.source).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(status.sources.every((source) => source.policy === null)).toBe(true);
  });

  it("keeps stop preview as the default and requires explicit confirmation for mutation", async () => {
    const preview = await run(["budgets", "stop", "--provider", "anthropic"]);
    expect(preview.code).toBe(0);
    expect(preview.output).toMatch(/preview|confirm/i);
    const missing = await run(["budgets", "unlock", "--provider", "anthropic"]);
    expect(missing.code).toBe(2);
    expect(missing.error).toMatch(/confirm/i);
  });
});
