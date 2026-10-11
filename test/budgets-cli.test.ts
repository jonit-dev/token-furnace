import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compose } from "../src/compose";
import { main, runBudgetHook } from "../src/cli";
import type { App } from "../src/compose";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stubNoNativeHost(app: App): void {
  vi.spyOn(app.control, "owningProcess").mockReturnValue(null);
  vi.spyOn(app.control, "preview").mockReturnValue({ targets: [], unverified: [], collateral: [] });
}

async function run(argv: string[]) {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-cli-"));
  roots.push(root);
  const app = compose({ HOME: root }, { noCache: true });
  stubNoNativeHost(app);
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
    app.close();
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
    stubNoNativeHost(app);
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
      app.close();
    }
  });

  it.each(["claude", "codex"] as const)("emits the strict %s native hook contract", (source) => {
    const root = mkdtempSync(join(tmpdir(), `tf-budget-${source}-native-hook-`));
    roots.push(root);
    const app = compose({ HOME: root }, { noCache: true });
    stubNoNativeHost(app);
    app.budgets.savePolicies([{
      scope: { kind: "source", source }, mode: "manual", unit: "tokens-total", limit: 10,
      deadline: "2099-10-11T12:00:00.000Z",
    }], 0);
    const output: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const invoke = (event: Record<string, unknown>): Record<string, unknown> => {
      expect(runBudgetHook(JSON.stringify(event), app, source)).toBe(0);
      return JSON.parse(output.pop()!) as Record<string, unknown>;
    };
    const expectStrict = (body: Record<string, unknown>) => {
      expect(body).not.toHaveProperty("allow");
      expect(body).not.toHaveProperty("retryAt");
      expect(body).not.toHaveProperty("reservationId");
    };
    try {
      expect(runBudgetHook("{", app, source)).toBe(2);
      expect(output).toEqual([]);

      const allowedPreToolUse = invoke({ hook_event_name: "PreToolUse", tool_use_id: `${source}-native-tool`, estimatedCost: 5, costUnit: "tokens-total" });
      expectStrict(allowedPreToolUse);
      expect(allowedPreToolUse).toEqual({});

      const reconciledPostToolUse = invoke({ hook_event_name: "PostToolUse", tool_use_id: `${source}-native-tool`, actualCost: 5 });
      expectStrict(reconciledPostToolUse);
      expect(reconciledPostToolUse).toEqual({});

      const allowedPrompt = invoke({ hook_event_name: "UserPromptSubmit", session_id: `${source}-native-session`, estimatedCost: 1, costUnit: "tokens-total" });
      expectStrict(allowedPrompt);
      expect(allowedPrompt).toEqual({});

      const blockedPreToolUse = invoke({ hook_event_name: "PreToolUse", tool_use_id: `${source}-blocked-tool`, estimatedCost: 20, costUnit: "tokens-total" });
      expectStrict(blockedPreToolUse);
      if (source === "claude") {
        expect(blockedPreToolUse).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.any(String) } });
      } else {
        expect(blockedPreToolUse).toMatchObject({ decision: "block", reason: expect.any(String) });
      }

      const blockedPrompt = invoke({ hook_event_name: "UserPromptSubmit", session_id: `${source}-blocked-session`, estimatedCost: 20, costUnit: "tokens-total" });
      expectStrict(blockedPrompt);
      expect(blockedPrompt).toMatchObject({ decision: "block", reason: expect.any(String) });

      const stop = invoke({ hook_event_name: "Stop", session_id: `${source}-native-session` });
      const sessionEnd = invoke({ hook_event_name: "SessionEnd", session_id: `${source}-native-session` });
      expectStrict(stop);
      expectStrict(sessionEnd);
      expect(stop).toEqual({});
      expect(sessionEnd).toEqual({});
    } finally {
      process.stdout.write = original;
      app.close();
    }
  });

  it("keeps OpenCode's generic reservation contract", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-opencode-hook-"));
    roots.push(root);
    const app = compose({ HOME: root }, { noCache: true });
    stubNoNativeHost(app);
    app.budgets.savePolicies([{
      scope: { kind: "source", source: "opencode" }, mode: "manual", unit: "tokens-total", limit: 100,
      deadline: "2099-10-11T12:00:00.000Z",
    }], 0);
    const output: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(runBudgetHook(JSON.stringify({ source: "opencode", estimatedCost: 20, costUnit: "tokens-total", requestId: "opencode-call" }), app, "opencode")).toBe(0);
      const admitted = JSON.parse(output.pop()!) as { allow: boolean; reservationId: string; decision: string };
      expect(admitted).toMatchObject({ allow: true, decision: "allow" });
      expect(admitted.reservationId).toMatch(/[0-9a-f-]{20}/);
      expect(runBudgetHook(JSON.stringify({ source: "opencode", phase: "complete", reservationId: admitted.reservationId, actualCost: 20, eventId: "opencode-call" }), app, "opencode")).toBe(0);
      expect(JSON.parse(output.pop()!)).toMatchObject({ allow: true, decision: "allow", reservationId: admitted.reservationId });
    } finally {
      process.stdout.write = original;
      app.close();
    }
  });

  it("does not release a reservation from an unverified cancellation payload", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-untrusted-cancel-"));
    roots.push(root);
    const app = compose({ HOME: root }, { noCache: true });
    stubNoNativeHost(app);
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
      app.close();
    }
  });
});
