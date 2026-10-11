import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createContext, Script } from "node:vm";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installBudgetAdapters, rollbackBudgetAdapters } from "../src/setup/agents";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("budget adapter setup", () => {
  it("backs up Claude settings, preserves unrelated hooks, and writes the stable budget command", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-setup-"));
    roots.push(root);
    const claude = join(root, ".claude");
    mkdirSync(claude, { recursive: true });
    const before = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] }] },
    };
    writeFileSync(join(claude, "settings.json"), JSON.stringify(before));
    const output: string[] = [];
    expect(installBudgetAdapters({ HOME: root }, { apply: true }, { write: (text) => output.push(text) })).toBe(0);
    const after = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
    expect(after.hooks.PreToolUse).toEqual(expect.arrayContaining(before.hooks.PreToolUse));
    expect(JSON.stringify(after)).toContain("hook budget");
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(existsSync(join(claude, "settings.json.token-furnace-budget-backup"))).toBe(true);
    const openCodePlugin = readFileSync(join(root, ".config", "opencode", "plugins", "token-furnace-budget.ts"), "utf8");
    expect(openCodePlugin).toMatch(/stdin: new Blob|hasUsage/);
    expect(openCodePlugin).toMatch(/event\.type === "session\.idle"/);
    expect(openCodePlugin).toMatch(/client\.session\.messages/);
    expect(openCodePlugin).toMatch(/reservationIds/);
    expect(openCodePlugin).toMatch(/requestId: input\.callID/);
    expect(openCodePlugin).not.toMatch(/TOKEN_FURNACE_QUALIFY_REQUEST_ID \?\? input\.callID/);
    expect(openCodePlugin).not.toMatch(/executable: process\.execPath/);
    expect(openCodePlugin).toMatch(/scheme: "basic"/);
    expect(openCodePlugin).toMatch(/OPENCODE_SERVER_PASSWORD/);
    expect(JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
    expect(rollbackBudgetAdapters({ HOME: root }, { write: () => undefined })).toBe(0);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(JSON.stringify(before));
    expect(existsSync(join(root, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(root, ".config", "opencode", "plugins", "token-furnace-budget.ts"))).toBe(false);
    expect(output.join("")).toMatch(/Claude|Partial/);
  });

  it("executes generated OpenCode callbacks for message-scoped accounting", async () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-setup-opencode-runtime-"));
    roots.push(root);
    expect(installBudgetAdapters({ HOME: root }, { apply: true }, { write: () => undefined })).toBe(0);
    const pluginPath = join(root, ".config", "opencode", "plugins", "token-furnace-budget.ts");
    const executable = readFileSync(pluginPath, "utf8")
      .replace("export const TokenFurnaceBudget =", "globalThis.TokenFurnaceBudget =")
      .replace("export default TokenFurnaceBudget;", "");
    const hookEvents: Array<Record<string, unknown>> = [];
    let messages: unknown[] = [];
    class TestBlob {
      readonly value: string;
      constructor(parts: unknown[]) { this.value = String(parts[0]); }
    }
    const context = createContext({
      Blob: TestBlob,
      Bun: {
        spawnSync: (_args: unknown, options: { stdin: TestBlob }) => {
          const event = JSON.parse(options.stdin.value) as Record<string, unknown>;
          hookEvents.push(event);
          const reservationIds = Array.isArray(event.reservationIds)
            ? event.reservationIds
            : typeof event.reservationId === "string" ? [event.reservationId] : [];
          const body = {
            allow: true,
            reservationId: typeof event.requestId === "string" && !event.phase ? `reservation-${event.requestId}` : null,
            reconciled: event.phase === "complete",
            reconciledReservationIds: reservationIds,
          };
          return { exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify(body)) };
        },
      },
      TextDecoder,
      TextEncoder,
      process: { pid: 4242, env: {} },
    });
    new Script(executable).runInContext(context);
    const factory = (context as unknown as { TokenFurnaceBudget: (ctx: unknown) => Promise<Record<string, unknown>> }).TokenFurnaceBudget;
    const ctx = {
      serverUrl: "http://127.0.0.1:4096",
      client: { session: { messages: async () => ({ data: messages }) } },
    };
    const callbacks = await factory(ctx);
    const before = callbacks["tool.execute.before"] as (input: Record<string, unknown>) => Promise<void>;
    const after = callbacks["tool.execute.after"] as (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>;
    const onEvent = callbacks.event as (input: { event: Record<string, unknown> }) => Promise<void>;
    const assistant = (id: string, callID: string, providerID: string, modelID: string, input: number, output: number, status?: string) => ({
      info: { id, role: "assistant", providerID, modelID, time: { completed: "2026-10-11T12:00:00.000Z" }, tokens: { input, output } },
      parts: [{ type: "tool", callID, ...(status === undefined ? {} : { state: { status } }) }],
    });

    await before({ sessionID: "multi", callID: "call-a" });
    await before({ sessionID: "multi", callID: "call-b" });
    messages = [assistant("message-a", "call-a", "provider-a", "model-a", 3, 2, "completed"), assistant("message-b", "call-b", "provider-b", "model-b", 4, 1, "completed")];
    await onEvent({ event: { type: "session.idle", properties: { sessionID: "multi" } } });
    const multi = hookEvents.filter((event) => event.phase === "complete" && Array.isArray(event.reservationIds));
    expect(multi).toHaveLength(2);
    expect(multi.reduce((sum, event) => sum + Number((event.usage as { total_tokens: number }).total_tokens), 0)).toBe(10);
    expect(multi.map((event) => [event.provider, event.model])).toEqual([["provider-a", "model-a"], ["provider-b", "model-b"]]);
    const afterFirstIdle = hookEvents.length;
    await onEvent({ event: { type: "session.idle", properties: { sessionID: "multi" } } });
    expect(hookEvents).toHaveLength(afterFirstIdle);

    messages = [];
    await before({ sessionID: "same-session", callID: "metadata-call" });
    await after({ sessionID: "same-session", callID: "metadata-call" }, { metadata: { usage: { total_tokens: 2 } } });
    await before({ sessionID: "same-session", callID: "no-metadata-call" });
    messages = [assistant("message-c", "no-metadata-call", "provider-c", "model-c", 5, 1, "completed")];
    await onEvent({ event: { type: "session.idle", properties: { sessionID: "same-session" } } });
    expect(hookEvents.filter((event) => event.phase === "complete" && event.eventId === "message-c")).toHaveLength(1);

    await before({ sessionID: "background", callID: "background-call" });
    messages = [assistant("message-running", "background-call", "provider-bg", "model-bg", 9, 9, "running")];
    const beforeBackgroundIdle = hookEvents.length;
    await onEvent({ event: { type: "session.idle", properties: { sessionID: "background" } } });
    await onEvent({ event: { type: "session.idle", properties: { sessionID: "background" } } });
    expect(hookEvents).toHaveLength(beforeBackgroundIdle);

    await before({ sessionID: "unknown", callID: "unknown-call" });
    messages = [assistant("message-unknown", "unknown-call", "provider-unknown", "model-unknown", 2, 2, undefined)];
    const beforeUnknownIdle = hookEvents.length;
    await onEvent({ event: { type: "session.idle", properties: { sessionID: "unknown" } } });
    expect(hookEvents).toHaveLength(beforeUnknownIdle);
  });

  it("leaves malformed native config untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-setup-invalid-"));
    roots.push(root);
    const claude = join(root, ".claude");
    mkdirSync(claude, { recursive: true });
    const path = join(claude, "settings.json");
    writeFileSync(path, "{not-json");
    expect(installBudgetAdapters({ HOME: root }, { apply: true }, { write: () => undefined })).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("{not-json");
  });

  it("leaves a non-array Claude PreToolUse hook list untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-setup-hooks-"));
    roots.push(root);
    const claude = join(root, ".claude");
    mkdirSync(claude, { recursive: true });
    const path = join(claude, "settings.json");
    const before = JSON.stringify({ hooks: { PreToolUse: { keep: true } } });
    writeFileSync(path, before);
    expect(installBudgetAdapters({ HOME: root }, { apply: true }, { write: () => undefined })).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
