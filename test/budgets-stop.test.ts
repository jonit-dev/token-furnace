import { describe, expect, it, vi } from "vitest";
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
});
