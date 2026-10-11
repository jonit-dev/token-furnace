import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { compose } from "../src/compose";
import { nativeUsageTokens } from "../src/core/budgets";
import { startServer } from "../src/server";
import { BudgetService } from "../src/services/budget-service";
import type { Env } from "../src/sources/agent-source";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-concurrency-"));
  roots.push(root);
  const now = new Date("2026-10-10T12:00:00.000Z");
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  return { env, now };
}

describe("durable budget concurrency", () => {
  it("serializes two real SQLite service writers so only one reservation uses the same allowance", () => {
    const { env, now } = setup();
    const first = new BudgetService(env, { now: () => now });
    first.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 100, deadline: "2026-10-11T12:00:00.000Z",
    }], 0);
    const second = new BudgetService(env, { now: () => now });
    const decisions = [first, second].map((service) => service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 80, now }));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);
    first.close();
    second.close();
  });

  it("denies every admission when an enabled settings file is malformed", () => {
    const { env, now } = setup();
    const service = new BudgetService(env, { now: () => now });
    service.savePolicies([{
      scope: { kind: "source", source: "claude" }, mode: "manual", unit: "tokens-total", limit: 100, deadline: "2026-10-11T12:00:00.000Z",
    }], 0);
    writeFileSync(service.settingsPath, "{not-json", { mode: 0o600 });
    expect(service.snapshot().error).toMatch(/malformed|JSON/i);
    expect(service.admit({ identity: { source: "claude", provider: null, model: null }, estimatedCost: 1, now }).allowed).toBe(false);
    service.close();
  });
});

// AC-3: real `hook budget` OS processes against one temporary real SQLite store (dist/cli.js, as in budgets-stop.test.ts).
const CLI = join(process.cwd(), "dist", "cli.js");
const DEADLINE = "2099-01-01T00:00:00.000Z";
const CLAUDE = { source: "claude" as const, provider: "anthropic", model: null, account: null };

function rig(extra: Env = {}) {
  const root = mkdtempSync(join(tmpdir(), "tf-budget-hooks-"));
  roots.push(root);
  const env: Env = {
    ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
    TOKEN_FURNACE_CONFIG_HOME: join(root, "config"), TOKEN_FURNACE_STATE_HOME: join(root, "state"),
    TOKEN_FURNACE_CACHE_HOME: join(root, "cache"), TOKEN_FURNACE_NO_CACHE: "0",
  };
  // Pin the Claude upstream and clock so the host environment cannot change provider resolution.
  for (const key of ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "TOKEN_FURNACE_SOURCE", "TOKEN_FURNACE_NOW", "TOKEN_FURNACE_QUALIFY_REQUEST_ID", "XDG_CACHE_HOME"]) delete env[key];
  Object.assign(env, extra);
  return { root, env };
}

interface HookRun { code: number | null; stderr: string; denied: boolean; reason: string }

function runHook(env: Env, event: Record<string, unknown>): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const hook = spawn(process.execPath, [CLI, "hook", "budget", "--source", "claude"], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    hook.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    hook.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    hook.on("error", reject);
    hook.on("close", (code) => {
      const output = (stdout.trim() ? JSON.parse(stdout) : {}) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      resolve({ code, stderr, denied: output.hookSpecificOutput?.permissionDecision === "deny", reason: output.hookSpecificOutput?.permissionDecisionReason ?? "" });
    });
    hook.stdin?.end(JSON.stringify(event));
  });
}

const pre = (id: string, extra: Record<string, unknown> = {}) =>
  ({ hook_event_name: "PreToolUse", session_id: "session-1", tool_use_id: id, tool_name: "Bash", ...extra });

function rows<T>(env: Env, sql: string): T[] {
  const db = new DatabaseSync(join(env.TOKEN_FURNACE_STATE_HOME!, "token-furnace", "budgets.sqlite"));
  try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
}

function withService<T>(env: Env, fn: (service: BudgetService) => T): T {
  const service = new BudgetService(env);
  try { return fn(service); } finally { service.close(); }
}

const claudeSourcePolicy = (limit: number) => ({
  scope: { kind: "source" as const, source: "claude" as const }, mode: "manual" as const, unit: "tokens-total" as const, limit, deadline: DEADLINE,
});

function writeTranscript(root: string, ...lines: unknown[]): string {
  const path = join(root, ".claude", "projects", "proj", "session-1.jsonl");
  mkdirSync(join(root, ".claude", "projects", "proj"), { recursive: true });
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

describe("AC-3 concurrent real hook processes", () => {
  it("admits exactly the reservations the allowance fits across 8 concurrent processes", async () => {
    const { env } = rig();
    expect(existsSync(CLI)).toBe(true);
    withService(env, (service) => service.savePolicies([claudeSourcePolicy(100)], 0));
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runHook(env, pre(`tool-${index}`, { estimatedCost: 30 }))));
    expect(results.map((result) => result.code)).toEqual(Array(8).fill(0));
    const allowedIds = results.flatMap((result, index) => result.denied ? [] : [`tool-${index}`]);
    expect(allowedIds).toHaveLength(3);
    expect(results.filter((result) => result.denied).map((result) => result.reason)).toEqual(Array(5).fill("Budget allowance is exhausted."));
    const reservations = rows<{ request_id: string; status: string; amount: number }>(env, "SELECT request_id, status, amount FROM reservations");
    expect(reservations).toHaveLength(3);
    expect(reservations.every((row) => row.status === "reserved" && row.amount === 30)).toBe(true);
    expect(reservations.map((row) => row.request_id).sort()).toEqual(allowedIds);
  });

  it("reconciles one native message once across concurrent PostToolUse processes and a replay", async () => {
    const { root, env } = rig();
    withService(env, (service) => {
      service.savePolicies([claudeSourcePolicy(100_000)], 0);
      for (let index = 0; index < 4; index++) {
        expect(service.admit({ identity: CLAUDE, estimatedCost: 100, requestId: `tool-${index}`, sessionId: "session-1" }).allowed).toBe(true);
      }
    });
    const usage = { input_tokens: 1000, output_tokens: 200 };
    const transcript = writeTranscript(root,
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { id: "msg_shared_1", model: "claude-opus-4", usage } });
    const post = (index: number) => ({ hook_event_name: "PostToolUse", session_id: "session-1", tool_use_id: `tool-${index}`, tool_name: "Bash", transcript_path: transcript });
    const results = await Promise.all([0, 1, 2, 3].map((index) => runHook(env, post(index))));
    expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0]);
    expect(results.some((result) => result.denied)).toBe(false);
    const expected = nativeUsageTokens(usage)!;
    const events = () => rows<{ event_id: string; scope_key: string; amount: number; unit: string }>(env, "SELECT event_id, scope_key, amount, unit FROM usage_events WHERE event_id LIKE 'usage:claude:msg_shared_1:%'");
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ amount: expected, unit: "tokens-total" });
    expect(rows<{ status: string }>(env, "SELECT status FROM reservations").map((row) => row.status)).toEqual(Array(4).fill("completed"));
    // A later hook for the same message cannot charge it again.
    expect((await runHook(env, post(0))).code).toBe(0);
    expect(events()).toHaveLength(1);
    expect(rows<{ total: number }>(env, "SELECT SUM(amount) AS total FROM usage_events WHERE unit = 'tokens-total'")[0].total).toBe(expected);
  });

  it("denies an Auto policy because its meter is older than five minutes, not for any other reason", async () => {
    const { env } = rig();
    const meter = (observedAt: Date) => ({
      id: "anthropic:weekly", source: "claude" as const, provider: "anthropic", account: "acct-1", usedPercentagePoints: 10,
      resetAt: new Date(Date.now() + 100 * 3_600_000), observedAt, authoritative: true, window: "7d",
    });
    withService(env, (service) => {
      service.savePolicies([{ scope: { kind: "source", source: "claude" }, mode: "auto", unit: "percentage-per-hour", limit: null, deadline: null }], 0);
      service.setMeters([meter(new Date(Date.now() - 6 * 60_000))]);
    });
    const stale = await runHook(env, pre("tool-stale", { estimatedCost: 0.1 }));
    expect(stale.code).toBe(0);
    expect(stale.denied).toBe(true);
    expect(stale.reason).toMatch(/stale/i);
    expect(rows(env, "SELECT 1 FROM reservations")).toHaveLength(0);
    // Control: the same policy and meter, observed now, no longer fails the staleness gate (Auto may still deny for calibration).
    withService(env, (service) => service.setMeters([meter(new Date())]));
    const fresh = await runHook(env, pre("tool-fresh", { estimatedCost: 0.1 }));
    expect(fresh.code).toBe(0);
    expect(fresh.reason).not.toMatch(/stale|unconfirmed/);
  });

  it("denies every admission while the enabled settings file is malformed", async () => {
    const { env } = rig();
    withService(env, (service) => {
      service.savePolicies([claudeSourcePolicy(100)], 0);
      writeFileSync(service.settingsPath, "{not-json", { mode: 0o600 });
    });
    const result = await runHook(env, pre("tool-malformed", { estimatedCost: 1 }));
    expect(result.code).toBe(0);
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/malformed|JSON/i);
    expect(rows(env, "SELECT 1 FROM reservations")).toHaveLength(0);
  });

  it("denies a provider-scoped policy when the Claude upstream is unknown, and allows it when resolved", async () => {
    const { env } = rig();
    withService(env, (service) => service.savePolicies([{ scope: { kind: "provider", provider: "anthropic" }, mode: "manual", unit: "tokens-total", limit: 100, deadline: DEADLINE }], 0));
    const unknown = await runHook({ ...env, ANTHROPIC_BASE_URL: "https://llm.internal.example" }, pre("tool-unknown", { estimatedCost: 10 }));
    expect(unknown.code).toBe(0);
    expect(unknown.denied).toBe(true);
    expect(unknown.reason).toBe("Enabled provider/model budget requires resolved identity.");
    expect(rows(env, "SELECT 1 FROM reservations")).toHaveLength(0);
    expect(await runHook(env, pre("tool-known", { estimatedCost: 10 }))).toMatchObject({ denied: false, reason: "" });
    expect(rows(env, "SELECT 1 FROM reservations")).toHaveLength(1);
  });

  it("denies a model-scoped policy until the transcript names the model", async () => {
    const { root, env } = rig();
    withService(env, (service) => service.savePolicies([{ scope: { kind: "model", provider: "anthropic", model: "claude-opus-4" }, mode: "manual", unit: "tokens-total", limit: 100, deadline: DEADLINE }], 0));
    const unknown = await runHook(env, pre("tool-no-model", { estimatedCost: 10 }));
    expect(unknown.denied).toBe(true);
    expect(unknown.reason).toBe("Enabled provider/model budget requires resolved identity.");
    expect(rows(env, "SELECT 1 FROM reservations")).toHaveLength(0);
    const transcript = writeTranscript(root, { type: "assistant", message: { id: "msg_model_1", model: "claude-opus-4", usage: { input_tokens: 1, output_tokens: 1 } } });
    expect(await runHook(env, pre("tool-with-model", { estimatedCost: 10, transcript_path: transcript }))).toMatchObject({ denied: false, reason: "" });
    expect(rows(env, "SELECT 1 FROM reservations")).toHaveLength(1);
  });

  it("keeps a stop latch and an outstanding reservation across server restarts and report-cache deletion", async () => {
    const { env } = rig();
    withService(env, (service) => {
      service.savePolicies([claudeSourcePolicy(100)], 0);
      expect(service.admit({ identity: CLAUDE, estimatedCost: 40, requestId: "tool-outstanding" }).allowed).toBe(true);
      const preview = service.previewStop({ kind: "source", source: "claude" });
      service.commitStop(preview.id, preview.fingerprint, []);
    });
    const cacheDir = env.TOKEN_FURNACE_CACHE_HOME!;
    for (let restart = 0; restart < 2; restart++) {
      const server = await startServer(compose(env), { days: 7, source: "all", weeklyBudget: null, planUsage: false, port: 0 });
      const snapshot = await (await fetch(`${server.url}/api/budgets`)).json() as { stops: unknown[]; policies: unknown[] };
      await server.close();
      expect(snapshot.stops).toHaveLength(1);
      expect(snapshot.policies).toHaveLength(1);
      expect(existsSync(join(cacheDir, "token-furnace", "cache.sqlite"))).toBe(true);
      rmSync(cacheDir, { recursive: true, force: true });
      expect(existsSync(cacheDir)).toBe(false);
    }
    const result = await runHook(env, pre("tool-after-restart", { estimatedCost: 1 }));
    expect(result.code).toBe(0);
    expect(result.denied).toBe(true);
    expect(result.reason).toBe("Emergency stop is active for this scope.");
    expect(rows<{ request_id: string; status: string; amount: number }>(env, "SELECT request_id, status, amount FROM reservations"))
      .toEqual([{ request_id: "tool-outstanding", status: "reserved", amount: 40 }]);
  });
});
