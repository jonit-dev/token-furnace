import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compose } from "../src/compose";
import { main, runBudgetHook } from "../src/cli";

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

  it("returns reservation IDs and reconciles attributable usage exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-hook-"));
    roots.push(root);
    const app = compose({ HOME: root }, { noCache: true });
    app.budgets.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 100,
      deadline: "2099-10-11T12:00:00.000Z",
    }], 0);
    const output: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(runBudgetHook(JSON.stringify({ estimatedCost: 20, costUnit: "tokens-total", requestId: "turn-1" }), app, "claude")).toBe(0);
      const admitted = JSON.parse(output.pop()!) as { allow: boolean; reservationId: string };
      expect(admitted.allow).toBe(true);
      expect(admitted.reservationId).toMatch(/[0-9a-f-]{20}/);
      expect(runBudgetHook(JSON.stringify({ phase: "complete", reservationId: admitted.reservationId, actualCost: 15, eventId: "turn-1" }), app, "claude")).toBe(0);
      expect(runBudgetHook(JSON.stringify({ phase: "complete", reservationId: admitted.reservationId, actualCost: 15, eventId: "turn-1" }), app, "claude")).toBe(0);
      expect(runBudgetHook(JSON.stringify({ estimatedCost: 85, costUnit: "tokens-total", requestId: "turn-2" }), app, "claude")).toBe(0);
      expect((JSON.parse(output.pop()!) as { allow: boolean }).allow).toBe(true);
      expect(runBudgetHook(JSON.stringify({ estimatedCost: 1, costUnit: "tokens-total", requestId: "turn-3" }), app, "claude")).toBe(0);
      expect((JSON.parse(output.pop()!) as { allow: boolean; reason: string }).allow).toBe(false);
    } finally {
      process.stdout.write = original;
      app.budgets.close();
      app.control.close();
    }
  });

  it("maps native Claude lifecycle payloads to the shared reservation", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-native-hook-"));
    roots.push(root);
    const app = compose({ HOME: root }, { noCache: true });
    app.budgets.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 10,
      deadline: "2099-10-11T12:00:00.000Z",
    }], 0);
    const output: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      runBudgetHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_use_id: "native-tool", estimatedCost: 5, costUnit: "tokens-total" }), app, "claude");
      expect((JSON.parse(output.pop()!) as { allow: boolean }).allow).toBe(true);
      runBudgetHook(JSON.stringify({ hook_event_name: "PostToolUse", tool_use_id: "native-tool" }), app, "claude");
      expect(JSON.parse(output.pop()!)).toMatchObject({ allow: true, reason: expect.stringMatching(/completion/i) });
      runBudgetHook(JSON.stringify({ estimatedCost: 5, costUnit: "tokens-total", requestId: "completed-without-usage" }), app, "claude");
      const completed = JSON.parse(output.pop()!) as { allow: boolean; reservationId: string };
      expect(completed.allow).toBe(true);
      runBudgetHook(JSON.stringify({ phase: "complete", completed: true, reservationId: completed.reservationId }), app, "claude");
      expect(JSON.parse(output.pop()!)).toMatchObject({ allow: true, reason: expect.stringMatching(/completion/i) });
      runBudgetHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-session", estimatedCost: 20, costUnit: "tokens-total" }), app, "claude");
      expect(JSON.parse(output.pop()!)).toMatchObject({ decision: "block", allow: false });
    } finally {
      process.stdout.write = original;
      app.budgets.close();
      app.control.close();
    }
  });

  it("does not release a reservation from an unverified cancellation payload", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-untrusted-cancel-"));
    roots.push(root);
    const app = compose({ HOME: root }, { noCache: true });
    app.budgets.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 100,
      deadline: "2099-10-11T12:00:00.000Z",
    }], 0);
    const output: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      runBudgetHook(JSON.stringify({ estimatedCost: 90, costUnit: "tokens-total", requestId: "owned-request" }), app, "claude");
      const admitted = JSON.parse(output.pop()!) as { reservationId: string };
      runBudgetHook(JSON.stringify({ phase: "cancel", reservationId: admitted.reservationId, session_id: "forged-session" }), app, "claude");
      expect(JSON.parse(output.pop()!)).toMatchObject({ allow: false, decision: "deny" });
      runBudgetHook(JSON.stringify({ estimatedCost: 20, costUnit: "tokens-total", requestId: "second-request" }), app, "claude");
      expect(JSON.parse(output.pop()!)).toMatchObject({ allow: false });
    } finally {
      process.stdout.write = original;
      app.budgets.close();
      app.control.close();
    }
  });
});
