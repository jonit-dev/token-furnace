import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("keeps native call IDs distinct while correlating and reconciling session usage", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-native-correlation-"));
    roots.push(root);
    const app = compose({ HOME: root, TOKEN_FURNACE_QUALIFY_REQUEST_ID: "qualification-run" }, { noCache: true });
    stubNoNativeHost(app);
    app.budgets.savePolicies([{
      scope: { kind: "source", source: "opencode" }, mode: "manual", unit: "tokens-total", limit: 100,
      deadline: "2099-10-11T12:00:00.000Z",
    }], 0);
    const output: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let db: DatabaseSync | undefined;
    const invoke = (event: Record<string, unknown>): Record<string, unknown> => {
      expect(runBudgetHook(JSON.stringify(event), app, "opencode")).toBe(0);
      return JSON.parse(output.pop()!) as Record<string, unknown>;
    };
    try {
      const first = invoke({ source: "opencode", session_id: "session-a", callID: "native-call-a", estimatedCost: 10, costUnit: "tokens-total" });
      const second = invoke({ source: "opencode", session_id: "session-a", callID: "native-call-b", estimatedCost: 10, costUnit: "tokens-total" });
      expect(first.reservationId).toBeTruthy();
      expect(second.reservationId).toBeTruthy();
      expect(second.reservationId).not.toBe(first.reservationId);

      db = new DatabaseSync(app.budgets.dbPath);
      const decisions = db.prepare("SELECT request_id, correlation_id, session_id FROM admission_decisions WHERE source = 'opencode' ORDER BY at, id").all() as Array<{ request_id: string; correlation_id: string; session_id: string }>;
      expect(decisions.slice(-2)).toEqual(expect.arrayContaining([
        { request_id: "native-call-a", correlation_id: "qualification-run", session_id: "session-a" },
        { request_id: "native-call-b", correlation_id: "qualification-run", session_id: "session-a" },
      ]));

      invoke({ source: "opencode", phase: "complete", reservationId: first.reservationId, eventId: "native-message-a", usage: { total_tokens: 10 } });
      invoke({ source: "opencode", phase: "complete", reservationId: first.reservationId, eventId: "native-message-a", usage: { total_tokens: 10 } });
      invoke({ source: "opencode", phase: "complete", reservationId: second.reservationId, eventId: "native-message-b", usage: { total_tokens: 10 } });
      const usage = db.prepare("SELECT event_id, amount FROM usage_events WHERE scope_key = 'source:opencode' ORDER BY event_id").all() as Array<{ event_id: string; amount: number }>;
      expect(usage).toHaveLength(2);
      expect(usage.reduce((sum, row) => sum + row.amount, 0)).toBe(20);

      const pending = invoke({ source: "opencode", session_id: "session-pending", callID: "native-call-pending", estimatedCost: 10, costUnit: "tokens-total" });
      const pendingSibling = invoke({ source: "opencode", session_id: "session-pending", callID: "native-call-pending-sibling", estimatedCost: 10, costUnit: "tokens-total" });
      const pendingReservationId = String(pending.reservationId);
      const pendingSiblingReservationId = String(pendingSibling.reservationId);
      invoke({ source: "opencode", phase: "complete", completed: true, reservationId: pending.reservationId, eventId: "native-tool-after" });
      expect((db.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(pendingReservationId) as { status: string }).status).toBe("reserved");
      invoke({ source: "opencode", phase: "complete", completed: true, session_id: "session-pending", reservationIds: [pendingReservationId, pendingSiblingReservationId], eventId: "native-assistant-message", usage: { total_tokens: 7 }, usageUnit: "tokens" });
      expect((db.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(pendingReservationId) as { status: string }).status).toBe("completed");
      expect((db.prepare("SELECT status FROM reservations WHERE reservation_id = ?").get(pendingSiblingReservationId) as { status: string }).status).toBe("completed");
      expect(db.prepare("SELECT amount FROM usage_events WHERE event_id LIKE 'native-assistant-message:%'").all()).toHaveLength(1);

      const repeatedFirst = invoke({ source: "opencode", session_id: "session-repeated", estimatedCost: 1, costUnit: "tokens-total" });
      const repeatedSecond = invoke({ source: "opencode", session_id: "session-repeated", estimatedCost: 1, costUnit: "tokens-total" });
      expect(repeatedFirst.reason).toBe("Admitted.");
      expect(repeatedSecond.reason).toBe("Admitted.");
      expect(repeatedSecond.reservationId).not.toBe(repeatedFirst.reservationId);
    } finally {
      process.stdout.write = original;
      db?.close();
      app.close();
    }
  });

  it("keeps real-shaped Codex transcript provider and model identity", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-codex-metadata-"));
    roots.push(root);
    const codexHome = join(root, ".codex");
    const transcript = join(codexHome, "sessions", "2026", "10", "rollout-openrouter.jsonl");
    const siblingTranscript = join(root, ".codex-other", "sessions", "2026", "10", "rollout-openrouter.jsonl");
    mkdirSync(join(codexHome, "sessions", "2026", "10"), { recursive: true });
    mkdirSync(join(root, ".codex-other", "sessions", "2026", "10"), { recursive: true });
    const app = compose({ HOME: root, CODEX_HOME: codexHome }, { noCache: true });
    stubNoNativeHost(app);
    app.budgets.savePolicies([{
      scope: { kind: "source", source: "codex" }, mode: "manual", unit: "tokens-total", limit: 100,
      deadline: "2099-10-11T12:00:00.000Z",
    }], 0);
    const admit = vi.spyOn(app.budgets, "admit");
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const run = (requestId: string, transcriptPath = transcript) => {
      expect(runBudgetHook(JSON.stringify({ transcript_path: transcriptPath, estimatedCost: 1, costUnit: "tokens-total", requestId }), app, "codex")).toBe(0);
      return admit.mock.calls.at(-1)?.[0].identity;
    };
    try {
      writeFileSync(transcript, [
        JSON.stringify({ type: "session_meta", payload: { model_provider: "openrouter" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "nvidia/nemotron-3.5-lightning:free" } }),
      ].join("\n") + "\n");
      expect(run("codex-openrouter")).toMatchObject({ source: "codex", provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free" });

      writeFileSync(transcript, [
        JSON.stringify({ type: "session_meta", payload: { model_provider: "openrouter" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "openrouter/nvidia/nemotron-3.5-lightning:free" } }),
      ].join("\n") + "\n");
      expect(run("codex-openrouter-prefixed")).toMatchObject({ source: "codex", provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free" });

      writeFileSync(siblingTranscript, [
        JSON.stringify({ type: "session_meta", payload: { model_provider: "untrusted" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "untrusted/should-not-be-read" } }),
      ].join("\n") + "\n");
      expect(run("codex-relative-path", "relative-rollout.jsonl")).toMatchObject({ source: "codex", provider: null, model: null });
      expect(run("codex-sibling-root", siblingTranscript)).toMatchObject({ source: "codex", provider: null, model: null });
    } finally {
      process.stdout.write = original;
      app.close();
    }
  });

  it("resolves Claude identity from the configured upstream and each subagent's own transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-claude-identity-"));
    roots.push(root);
    const dir = join(root, ".claude", "projects", "p");
    mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
    const transcript = join(dir, "s1.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { id: "m1", model: "parent/model-a" } })}\n`);
    writeFileSync(join(dir, "s1", "subagents", "agent-a1.jsonl"), `${JSON.stringify({ type: "assistant", message: { id: "m2", model: "child/model-b" } })}\n`);
    const app = compose({ HOME: root, ANTHROPIC_BASE_URL: "https://openrouter.ai/api" }, { noCache: true });
    stubNoNativeHost(app);
    const out: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const decide = (event: Record<string, unknown>): string => {
      out.length = 0;
      expect(runBudgetHook(JSON.stringify({ transcript_path: transcript, session_id: "s1", hook_event_name: "PreToolUse", ...event }), app, "claude")).toBe(0);
      return out.join("");
    };
    try {
      const preview = app.budgets.previewStop({ kind: "model", provider: "openrouter", model: "child/model-b" }, []);
      app.budgets.commitStop(preview.id, preview.fingerprint, []);
      // The parent's own tool call is a different model under the same OpenRouter upstream: allowed.
      expect(decide({ tool_name: "Bash", tool_use_id: "p1" })).not.toContain("deny");
      // The child's tool call reads the child's transcript and hits the model stop.
      expect(decide({ tool_name: "Bash", tool_use_id: "c1", agent_id: "a1" })).toContain("deny");
      // A spawn with only a bare alias cannot inherit the parent's model: unresolved under a model stop.
      expect(decide({ tool_name: "Agent", tool_use_id: "s1", tool_input: { model: "sonnet", prompt: "x" } })).toContain("deny");
    } finally {
      process.stdout.write = original;
      app.close();
    }
  });

  it("charges one native message once across several PostToolUse hooks and skips discovery while Off", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-native-once-"));
    roots.push(root);
    const transcript = join(root, ".claude", "projects", "p", "session.jsonl");
    mkdirSync(join(root, ".claude", "projects", "p"), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { id: "msg_1", model: "claude-opus-4", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0 } } })}\n`);
    const app = compose({ HOME: root }, { noCache: true });
    stubNoNativeHost(app);
    const owningProcess = vi.spyOn(app.control, "owningProcess");
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let db: DatabaseSync | undefined;
    const hook = (event: Record<string, unknown>) => expect(runBudgetHook(JSON.stringify({ transcript_path: transcript, session_id: "s1", ...event }), app, "claude")).toBe(0);
    try {
      hook({ hook_event_name: "PreToolUse", tool_use_id: "t0" });
      hook({ hook_event_name: "Stop" });
      expect(owningProcess).not.toHaveBeenCalled();
      app.budgets.savePolicies([{ scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 1000, deadline: "2099-10-11T12:00:00.000Z" }], 0);
      for (const id of ["t1", "t2"]) hook({ hook_event_name: "PreToolUse", tool_use_id: id, estimatedCost: 20, costUnit: "tokens-total" });
      for (const id of ["t1", "t2"]) hook({ hook_event_name: "PostToolUse", tool_use_id: id });
      db = new DatabaseSync(app.budgets.dbPath);
      const rows = db.prepare("SELECT amount FROM usage_events WHERE scope_key = 'source:claude'").all() as Array<{ amount: number }>;
      expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(15);
    } finally {
      process.stdout.write = original;
      db?.close();
      app.close();
    }
  });

  it.each(["Stop", "SubagentStop", "SessionEnd"])("does not block a malformed %s hook with exit 2", (hookEvent) => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-stop-malformed-"));
    roots.push(root);
    const app = compose({ HOME: root }, { noCache: true });
    try {
      expect(runBudgetHook(`{"hook_event_name":"${hookEvent}","session_id":`, app, "claude")).toBe(0);
      expect(runBudgetHook(`{"hook_event_name":"PreToolUse","tool_name":`, app, "claude")).toBe(2);
    } finally {
      app.close();
    }
  });

  it.each(["claude", "codex", "opencode"] as const)("fails closed for non-object hook input from %s", (source) => {
    const root = mkdtempSync(join(tmpdir(), `tf-budget-${source}-invalid-hook-`));
    roots.push(root);
    const app = compose({ HOME: root }, { noCache: true });
    stubNoNativeHost(app);
    const output: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      for (const input of ["null", "[]", "\"text\"", "42", "true", "{"]) {
        const code = runBudgetHook(input, app, source);
        if (source === "claude" || source === "codex") {
          expect(code).toBe(2);
          expect(output).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(JSON.parse(output.pop()!)).toEqual({ decision: "deny", allow: false, reason: "Malformed budget hook input." });
        }
      }
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
