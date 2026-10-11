import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentControl, type ControlTarget, type ProcessIdentity } from "../src/services/agent-control";

function target(overrides: Partial<ControlTarget> = {}): ControlTarget {
  return {
    id: "session-1",
    source: "claude",
    provider: "anthropic",
    model: "claude-opus",
    pid: 4321,
    processStartTime: 10,
    ownerUid: 7,
    ...overrides,
  };
}

describe("AgentControl", () => {
  it("does not signal a PID whose start identity changed", async () => {
    const signal = vi.fn();
    const inspect = vi.fn((): ProcessIdentity => ({ pid: 4321, processStartTime: 11, ownerUid: 7, parentPid: 1 }));
    const control = new AgentControl({ inspect, signal, currentUid: 7 });
    const outcome = await control.cancel(target(), true);
    expect(outcome.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
  });

  it("matches canonical provider/model identity without substring aliases", () => {
    const control = new AgentControl({
      inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1 }),
      currentUid: 7,
      signal: vi.fn(),
    });
    control.register(target({ id: "opus", model: "claude-opus" }));
    control.register(target({ id: "sonnet", model: "claude-sonnet" }));
    expect(control.discover({ kind: "model", provider: "Anthropic", model: "Claude-Opus" }).map((item) => item.id)).toEqual(["opus"]);
  });

  it("refuses Token Furnace itself even when the PID is otherwise owned", async () => {
    const signal = vi.fn();
    const control = new AgentControl({
      inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1 }),
      currentUid: 7,
      signal,
    });
    const outcome = await control.cancel(target({ pid: process.pid }), true);
    expect(outcome.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
  });

  it("protects Token Furnace ancestors but permits a verified worker child", async () => {
    const signal = vi.fn();
    const currentPid = 9000;
    const identities = new Map<number, ProcessIdentity>([
      [currentPid, { pid: currentPid, processStartTime: 1, ownerUid: 7, parentPid: 8000 }],
      [8000, { pid: 8000, processStartTime: 2, ownerUid: 7, parentPid: 1 }],
      [7000, { pid: 7000, processStartTime: 3, ownerUid: 7, parentPid: currentPid }],
    ]);
    const control = new AgentControl({ currentPid, currentUid: 7, signal, graceMs: 0, inspect: (pid) => identities.get(pid) ?? null });
    const ancestor = await control.cancel(target({ id: "ancestor", pid: 8000, processStartTime: 2, exclusive: true }), true);
    expect(ancestor.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
    const child = await control.cancel(target({ id: "child", pid: 7000, processStartTime: 3, exclusive: true }), true);
    expect(child.status).toBe("unresolved");
    expect(signal).toHaveBeenCalledWith(7000, "SIGKILL");
  });

  it("does not report force termination until process exit is observed", async () => {
    const signal = vi.fn();
    const inspect = () => ({ pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1 });
    const control = new AgentControl({ inspect, signal, currentUid: 7, graceMs: 0 });
    const outcome = await control.cancel(target({ exclusive: true }), true);
    expect(outcome.status).toBe("unresolved");
    expect(outcome.detail).toMatch(/exit was not verified/i);
  });

  it("reloads durable owned registrations for a later preview", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-"));
    try {
      const statePath = join(root, "control.json");
      const inspect = (pid: number) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1 });
      const first = new AgentControl({ statePath, inspect, currentUid: 7, currentPid: 9000 });
      expect(first.register(target({ pid: 4321, exclusive: true }))).toBe(true);
      first.close();
      const second = new AgentControl({ statePath, inspect, currentUid: 7, currentPid: 9000 });
      expect(second.discover({ kind: "source", source: "claude" }).map((item) => item.id)).toEqual(["session-1"]);
      second.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
