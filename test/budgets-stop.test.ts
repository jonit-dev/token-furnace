import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentControl, parsePsProcesses, type ControlTarget, type ProcessIdentity } from "../src/services/agent-control";

const testStoreRoot = mkdtempSync(join(tmpdir(), "tf-control-tests-"));
const TEST_EXECUTABLE = "/usr/bin/token-furnace-test-agent";
let testStoreNumber = 0;
const controls: AgentControl[] = [];
afterAll(() => rmSync(testStoreRoot, { recursive: true, force: true }));
afterEach(() => {
  closeControls();
});
function testStore(): string {
  return join(testStoreRoot, `${testStoreNumber++}.sqlite`);
}

function makeControl(options: ConstructorParameters<typeof AgentControl>[0] = {}): AgentControl {
  const control = new AgentControl(options);
  controls.push(control);
  return control;
}

function closeControls(): void {
  for (const control of controls.splice(0)) control.close();
}

function target(overrides: Partial<ControlTarget> = {}): ControlTarget {
  return {
    id: "session-1",
    source: "claude",
    provider: "anthropic",
    model: "claude-opus",
    pid: 4321,
    processStartTime: 10,
    ownerUid: 7,
    executable: TEST_EXECUTABLE,
    ...overrides,
  };
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

type WindowsStopTiming = { name: string; startedAt: number; stages: Record<string, number> };

function windowsStopTiming(name: string): WindowsStopTiming {
  return { name, startedAt: Date.now(), stages: {} };
}

function markWindowsStopStage(timing: WindowsStopTiming, stage: string): void {
  if (process.platform === "win32") timing.stages[stage] = Date.now() - timing.startedAt;
}

function emitWindowsStopTiming(timing: WindowsStopTiming): void {
  if (process.platform === "win32") {
    console.info(`TOKEN_FURNACE_WINDOWS_STOP_TIMING ${JSON.stringify({ test: timing.name, ...timing.stages, totalMs: Date.now() - timing.startedAt })}`);
  }
}

describe("AgentControl", () => {
  it("does not spawn a POSIX owner-SID lookup while constructing the controller", () => {
    const inspect = vi.fn(() => ({ pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }));
    const control = makeControl({ inspect, currentUid: 7, currentPid: 9000, storePath: testStore() });
    if (process.platform !== "win32") expect(inspect).not.toHaveBeenCalled();
    control.close();
  });

  it("does not signal a PID whose start identity changed", async () => {
    const signal = vi.fn();
    const inspect = vi.fn((): ProcessIdentity => ({ pid: 4321, processStartTime: 11, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }));
    const control = makeControl({ inspect, signal, currentUid: 7, storePath: testStore() });
    const outcome = await control.cancel(target(), true);
    expect(outcome.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
  });

  it("keeps stop unresolved when either executable identity is missing", async () => {
    for (const [expectedExecutable, observedExecutable] of [[null, TEST_EXECUTABLE], [TEST_EXECUTABLE, null]] as const) {
      const signal = vi.fn();
      const control = makeControl({
        inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: observedExecutable }),
        currentUid: 7,
        signal,
        storePath: testStore(),
      });
      const outcome = await control.cancel(target({ executable: expectedExecutable, exclusive: true }), true);
      expect(outcome.status).toBe("unresolved");
      expect(outcome.detail).toMatch(/executable identity/i);
      expect(signal).not.toHaveBeenCalled();
    }
  });

  it("does not signal a descendant after its image changes in place", async () => {
    const graph: ProcessIdentity[] = [
      { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE },
      { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE },
      { pid: 4322, processStartTime: 11, ownerUid: 7, parentPid: 4321, executable: "/usr/bin/token-furnace-tool" },
    ];
    const fresh = new Map(graph.map((identity) => [identity.pid, identity]));
    const signal = vi.fn((pid: number) => {
      if (pid === 4321) fresh.set(4322, { ...fresh.get(4322)!, executable: "/tmp/replaced-tool" });
    });
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      inspect: (pid) => fresh.get(pid) ?? null,
      listProcesses: () => graph,
      signal,
      graceMs: 0,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ pid: 4321, exclusive: true }), true);
    expect(outcome.status).toBe("unresolved");
    expect(signal.mock.calls.map(([pid]) => pid)).toEqual([4321]);
  });

  it("rejects deceptive executable suffixes but accepts exact and resolved images", async () => {
    const deceptive = new Map<number, ProcessIdentity>([
      [9000, { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
      [4321, { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: "/tmp/evil/usr/bin/claude" }],
    ]);
    const rejectedSignal = vi.fn();
    const rejected = makeControl({
      currentPid: 9000,
      currentUid: 7,
      inspect: (pid) => deceptive.get(pid) ?? null,
      listProcesses: () => [...deceptive.values()],
      signal: rejectedSignal,
      storePath: testStore(),
    });
    const rejectedOutcome = await rejected.cancel(target({ pid: 4321, executable: "/usr/bin/claude", exclusive: true }), true);
    expect(rejectedOutcome.status).toBe("unresolved");
    expect(rejectedSignal).not.toHaveBeenCalled();

    const resolvedExecutable = realpathSync(process.execPath);
    const exact = new Map<number, ProcessIdentity>([
      [9000, { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: resolvedExecutable }],
      [4322, { pid: 4322, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: process.execPath }],
    ]);
    const acceptedSignal = vi.fn((pid: number) => exact.delete(pid));
    const accepted = makeControl({
      currentPid: 9000,
      currentUid: 7,
      inspect: (pid) => exact.get(pid) ?? null,
      listProcesses: () => [...exact.values()],
      signal: acceptedSignal,
      graceMs: 0,
      storePath: testStore(),
    });
    const acceptedOutcome = await accepted.cancel(target({ pid: 4322, executable: resolvedExecutable, exclusive: true }), true);
    expect(acceptedOutcome.status).toBe("terminated");
    expect(acceptedSignal).toHaveBeenCalledWith(4322, "SIGKILL");
  });

  it("matches canonical provider/model identity without substring aliases", () => {
    const control = makeControl({
      inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }),
      currentUid: 7,
      signal: vi.fn(),
      storePath: testStore(),
    });
    control.register(target({ id: "opus", model: "claude-opus" }));
    control.register(target({ id: "sonnet", model: "claude-sonnet" }));
    expect(control.discover({ kind: "model", provider: "Anthropic", model: "Claude-Opus" }).map((item) => item.id)).toEqual(["opus"]);
  });

  it("refuses Token Furnace itself even when the PID is otherwise owned", async () => {
    const signal = vi.fn();
    const control = makeControl({
      inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }),
      currentUid: 7,
      signal,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ pid: process.pid }), true);
    expect(outcome.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
  });

  it("protects Token Furnace ancestors but permits a verified worker child", async () => {
    const signal = vi.fn();
    const currentPid = 9000;
    const identities = new Map<number, ProcessIdentity>([
      [currentPid, { pid: currentPid, processStartTime: 3, ownerUid: 7, parentPid: 8000, executable: TEST_EXECUTABLE }],
      [8000, { pid: 8000, processStartTime: 2, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
      [7000, { pid: 7000, processStartTime: 4, ownerUid: 7, parentPid: currentPid, executable: TEST_EXECUTABLE }],
    ]);
    const control = makeControl({ currentPid, currentUid: 7, signal, graceMs: 0, inspect: (pid) => identities.get(pid) ?? null, storePath: testStore() });
    const ancestor = await control.cancel(target({ id: "ancestor", pid: 8000, processStartTime: 2, exclusive: true }), true);
    expect(ancestor.status).toBe("unresolved");
    expect(signal).not.toHaveBeenCalled();
    const child = await control.cancel(target({ id: "child", pid: 7000, processStartTime: 4, exclusive: true }), true);
    expect(child.status).toBe("unresolved");
    expect(signal).toHaveBeenCalledWith(7000, "SIGKILL");
  });

  it("treats a successfully absent ancestor as the end of the protection chain", async () => {
    const identities = new Map<number, ProcessIdentity>([
      [9000, { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 8000, executable: TEST_EXECUTABLE }],
      [7000, { pid: 7000, processStartTime: 3, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
    ]);
    const signal = vi.fn((pid: number) => identities.delete(pid));
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      inspect: (pid) => identities.get(pid) ?? null,
      listProcesses: () => [...identities.values()],
      signal,
      graceMs: 0,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ id: "absent-ancestor", pid: 7000, processStartTime: 3, exclusive: true }), true);
    expect(outcome.status).toBe("terminated");
    expect(signal).toHaveBeenCalledWith(7000, "SIGKILL");
  });

  it("keeps an ancestor lookup failure unresolved", async () => {
    const identity: ProcessIdentity = { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 8000, executable: TEST_EXECUTABLE };
    const signal = vi.fn();
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      inspect: (pid) => {
        if (pid === 8000) throw new Error("ancestor query denied");
        return pid === 9000 ? identity : { pid, processStartTime: 3, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE };
      },
      listProcesses: () => [identity, { pid: 7000, processStartTime: 3, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
      signal,
      graceMs: 0,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ id: "failed-ancestor", pid: 7000, processStartTime: 3, exclusive: true }), true);
    expect(outcome.status).toBe("unresolved");
    expect(outcome.detail).toMatch(/identity lookup is unavailable/i);
    expect(signal).not.toHaveBeenCalled();
  });

  it("rejects a parent PID reused by a newer process generation", async () => {
    const graph: ProcessIdentity[] = [
      { pid: 9000, processStartTime: 10, ownerUid: 7, parentPid: 8000, executable: TEST_EXECUTABLE },
      { pid: 8000, processStartTime: 20, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE },
      { pid: 7000, processStartTime: 30, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE },
    ];
    const signal = vi.fn();
    const byPid = new Map(graph.map((item) => [item.pid, item]));
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      inspect: (pid) => byPid.get(pid) ?? null,
      listProcesses: () => graph,
      signal,
      graceMs: 0,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ id: "reused-parent", pid: 7000, processStartTime: 30, exclusive: true }), true);
    expect(outcome.status).toBe("unresolved");
    expect(outcome.detail).toMatch(/generation|ancestor/i);
    expect(signal).not.toHaveBeenCalled();
  });

  it("uses one metadata graph for ancestry instead of owner queries per parent", async () => {
    const graph: ProcessIdentity[] = [
      { pid: 9000, processStartTime: 10, ownerUid: 7, parentPid: 8000, executable: TEST_EXECUTABLE },
      { pid: 8000, processStartTime: 9, ownerUid: 7, parentPid: 7000, executable: TEST_EXECUTABLE },
      { pid: 7000, processStartTime: 8, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE },
      { pid: 4321, processStartTime: 30, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE },
    ];
    const byPid = new Map(graph.map((item) => [item.pid, item]));
    const inspect = vi.fn((pid: number) => byPid.get(pid) ?? null);
    const listProcesses = vi.fn(() => [...byPid.values()]);
    const signal = vi.fn((pid: number) => byPid.delete(pid));
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      inspect,
      listProcesses,
      signal,
      graceMs: 0,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ pid: 4321, processStartTime: 30, exclusive: true }), true);
    expect(outcome.status).toBe("terminated");
    expect(inspect.mock.calls.filter(([pid]) => pid === 8000 || pid === 7000)).toHaveLength(0);
    expect(listProcesses).toHaveBeenCalledTimes(1);
  });

  it("revalidates ownerless descendant metadata before signalling", async () => {
    const graph: ProcessIdentity[] = [
      { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE },
      { pid: 4321, processStartTime: 10, ownerUid: null, parentPid: 1, executable: "C:\\agent.exe" },
      { pid: 4322, processStartTime: 11, ownerUid: null, parentPid: 4321, executable: "C:\\tool.exe" },
    ];
    const fresh = new Map<number, ProcessIdentity>([
      [9000, { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1 }],
      [4321, { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: "C:\\agent.exe" }],
      [4322, { pid: 4322, processStartTime: 11, ownerUid: 7, parentPid: 4321, executable: "C:\\tool.exe" }],
    ]);
    const signal = vi.fn((pid: number) => fresh.delete(pid));
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      inspect: (pid) => fresh.get(pid) ?? null,
      listProcesses: () => graph,
      signal,
      graceMs: 0,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ pid: 4321, ownerUid: 7, executable: "C:\\agent.exe", exclusive: true }), true);
    expect(outcome.status).toBe("terminated");
    expect(signal.mock.calls.map(([pid]) => pid)).toEqual([4321, 4322]);
  });

  it("rejects a foreign or reused descendant from a metadata-only graph", async () => {
    for (const observedDescendant of [
      { pid: 4322, processStartTime: 11, ownerUid: 8, parentPid: 4321, executable: "C:\\tool.exe" },
      { pid: 4322, processStartTime: 12, ownerUid: 7, parentPid: 4321, executable: "C:\\tool.exe" },
    ]) {
      const graph: ProcessIdentity[] = [
        { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE },
        { pid: 4321, processStartTime: 10, ownerUid: null, parentPid: 1, executable: "C:\\agent.exe" },
        { pid: 4322, processStartTime: 11, ownerUid: null, parentPid: 4321, executable: "C:\\tool.exe" },
      ];
      const fresh = new Map<number, ProcessIdentity>([
        [9000, { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
        [4321, { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: "C:\\agent.exe" }],
        [4322, observedDescendant],
      ]);
      const signal = vi.fn((pid: number) => { fresh.delete(pid); });
      const control = makeControl({
        currentPid: 9000,
        currentUid: 7,
        inspect: (pid) => fresh.get(pid) ?? null,
        listProcesses: () => graph,
        signal,
        graceMs: 0,
        storePath: testStore(),
      });
      const outcome = await control.cancel(target({ pid: 4321, ownerUid: 7, executable: "C:\\agent.exe", exclusive: true }), true);
      expect(outcome.status).toBe("unresolved");
      expect(signal).not.toHaveBeenCalled();
    }
  });

  it("does not report force termination until process exit is observed", async () => {
    const signal = vi.fn();
    const inspect = () => ({ pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE });
    const control = makeControl({ inspect, signal, currentUid: 7, graceMs: 0, storePath: testStore() });
    const outcome = await control.cancel(target({ exclusive: true, nativeState: async () => true }), true);
    expect(outcome.status).toBe("unresolved");
    expect(outcome.detail).toMatch(/exit was not verified/i);
  });

  it("does not treat a failed exit lookup as proof that force termination succeeded", async () => {
    const signal = vi.fn(() => { lookupFailed = true; });
    let lookupFailed = false;
    const identity: ProcessIdentity = { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE };
    const inspect = (pid: number) => {
      if (lookupFailed && pid === identity.pid) throw new Error("native process lookup unavailable");
      if (pid === 9000) return { pid, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE };
      return pid === identity.pid ? identity : null;
    };
    const control = makeControl({ inspect, signal, currentUid: 7, currentPid: 9000, graceMs: 0, listProcesses: () => [identity], storePath: testStore() });
    const outcome = await control.cancel(target({ exclusive: true }), true);
    expect(outcome.status).toBe("unresolved");
    expect(outcome.detail).toMatch(/exit was not verified/i);
  });

  it("keeps macOS executable paths with spaces separate from command lines", () => {
    const executable = "/Applications/Claude Code.app/Contents/MacOS/claude";
    const commandLine = `${executable} --model claude-sonnet`;
    const rows = parsePsProcesses(
      `123 1 7 Sun Oct 11 02:55:17 2026 ${executable}\n`,
      `123 ${commandLine}\n`,
    );
    expect(rows).toEqual([expect.objectContaining({ pid: 123, executable, commandLine })]);
  });

  it("terminates verified owned descendants without widening to an unrelated sibling", async () => {
    const identities = new Map<number, ProcessIdentity>([
      [9000, { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
      [4321, { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
      [4322, { pid: 4322, processStartTime: 11, ownerUid: 7, parentPid: 4321, executable: TEST_EXECUTABLE }],
      [4333, { pid: 4333, processStartTime: 12, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
    ]);
    const signal = vi.fn((pid: number) => { identities.delete(pid); });
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      signal,
      inspect: (pid) => identities.get(pid) ?? null,
      listProcesses: () => [...identities.values()],
      graceMs: 100,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ pid: 4321, processStartTime: 10, exclusive: true }), true);
    expect(outcome.status).toBe("terminated");
    expect(signal.mock.calls.map(([pid]) => pid)).toEqual([4321, 4322]);
    expect(identities.has(4333)).toBe(true);
  });

  it("accepts a native tree signal that already removed the verified descendants", async () => {
    const identities = new Map<number, ProcessIdentity>([
      [9000, { pid: 9000, processStartTime: 1, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
      [4321, { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }],
      [4322, { pid: 4322, processStartTime: 11, ownerUid: 7, parentPid: 4321, executable: TEST_EXECUTABLE }],
    ]);
    const signal = vi.fn((pid: number) => {
      if (pid === 4321) {
        identities.delete(4321);
        identities.delete(4322);
      }
    });
    const control = makeControl({
      currentPid: 9000,
      currentUid: 7,
      signal,
      inspect: (pid) => identities.get(pid) ?? null,
      listProcesses: () => [...identities.values()],
      graceMs: 0,
      storePath: testStore(),
    });
    const outcome = await control.cancel(target({ pid: 4321, processStartTime: 10, exclusive: true }), true);
    expect(outcome.status).toBe("terminated");
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(4321, "SIGKILL");
  });

  it("uses the owning OpenCode session and Basic auth before aborting", async () => {
    let busy = true;
    let aborts = 0;
    const authorization: string[] = [];
    const server = createServer((request, response) => {
      authorization.push(String(request.headers.authorization ?? ""));
      if (request.url === "/session/native-session" && request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "native-session" }));
      } else if (request.url === "/session/status" && request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ "native-session": { type: busy ? "busy" : "idle" } }));
      } else if (request.url === "/session/native-session/abort" && request.method === "POST") {
        busy = false;
        aborts++;
        response.statusCode = 200;
        response.end("ok");
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const inspect = () => ({ pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: "/usr/bin/opencode" });
      const control = makeControl({
        env: { HOME: testStoreRoot, OPENCODE_SERVER_PASSWORD: "secret" },
        inspect,
        currentUid: 7,
        currentPid: 9000,
        signal: vi.fn(),
        storePath: testStore(),
      });
      const registered = target({
        id: "native-session",
        source: "opencode",
        provider: "anthropic",
        model: "claude-sonnet",
        executable: "/usr/bin/opencode",
        native: { kind: "opencode", endpoint, transport: "http", sessionId: "native-session", auth: { scheme: "basic", passwordEnv: "OPENCODE_SERVER_PASSWORD" } },
      });
      expect(control.register(registered)).toBe(true);
      const selected = control.preview({ kind: "source", source: "opencode" }).targets[0];
      expect(selected).toBeDefined();
      const outcome = await control.cancel(selected!, false);
      expect(outcome.status).toBe("cancelled");
      expect(aborts).toBe(1);
      expect(authorization.length).toBeGreaterThanOrEqual(4);
      expect(new Set(authorization)).toEqual(new Set([`Basic ${Buffer.from("opencode:secret").toString("base64")}`]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("force-stops a real owned child while an unrelated sibling remains live", async () => {
    const timing = windowsStopTiming("force-stops a real owned child");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const control = makeControl({ currentUid: typeof process.getuid === "function" ? process.getuid() : null, graceMs: 1_000, storePath: testStore() });
    markWindowsStopStage(timing, "controlConstruction");
    try {
      const identity = await new Promise<ProcessIdentity>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const poll = () => {
          const current = child.pid ? control.processIdentity(child.pid) : null;
          if (current) return resolve(current);
          if (Date.now() >= deadline) return reject(new Error("real child identity was not discoverable"));
          setTimeout(poll, 25);
        };
        poll();
      });
      markWindowsStopStage(timing, "identity");
      expect(child.pid).toBeDefined();
      expect(unrelated.pid).toBeDefined();
      expect(identity.ownerUid !== null || identity.ownerIdentity || identity.ownerSid).toBeTruthy();
      expect(control.register({ ...target({ id: "real-child", pid: child.pid!, processStartTime: identity.processStartTime, ownerUid: identity.ownerUid, ownerIdentity: identity.ownerIdentity, ownerSid: identity.ownerSid, executable: identity.executable, exclusive: true }) })).toBe(true);
      markWindowsStopStage(timing, "registration");
      const outcome = await control.cancel({ ...target({ id: "real-child", pid: child.pid!, processStartTime: identity.processStartTime, ownerUid: identity.ownerUid, ownerIdentity: identity.ownerIdentity, ownerSid: identity.ownerSid, executable: identity.executable, exclusive: true }) }, true);
      markWindowsStopStage(timing, "cancelAndVerification");
      if (process.platform === "win32") console.info(`TOKEN_FURNACE_WINDOWS_STOP_OUTCOME ${JSON.stringify(outcome)}`);
      expect(outcome.status, JSON.stringify(outcome)).toBe("terminated");
      await waitForExit(child);
      expect(unrelated.exitCode).toBeNull();
    } finally {
      markWindowsStopStage(timing, "cleanupStart");
      control.close();
      if (child.exitCode === null) child.kill("SIGKILL");
      if (unrelated.exitCode === null) unrelated.kill("SIGTERM");
      await Promise.all([waitForExit(child), waitForExit(unrelated)]);
      markWindowsStopStage(timing, "cleanupDone");
      emitWindowsStopTiming(timing);
    }
  });

  it("force-stops a real owned child tree while an unrelated sibling remains live", async () => {
    const timing = windowsStopTiming("force-stops a real owned child tree");
    const tree = spawn(process.execPath, ["-e", "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const control = makeControl({ currentUid: typeof process.getuid === "function" ? process.getuid() : null, graceMs: 1_000, storePath: testStore() });
    markWindowsStopStage(timing, "controlConstruction");
    let grandchildPid: number | null = null;
    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("real grandchild PID was not reported")), 2_000);
        tree.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const pid = Number(output.trim());
          if (Number.isInteger(pid) && pid > 0) { clearTimeout(timeout); resolve(pid); }
        });
        tree.on("error", (error) => { clearTimeout(timeout); reject(error); });
      });
      const identity = await new Promise<ProcessIdentity>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const poll = () => {
          const current = tree.pid ? control.processIdentity(tree.pid) : null;
          if (current) return resolve(current);
          if (Date.now() >= deadline) return reject(new Error("real tree identity was not discoverable"));
          setTimeout(poll, 25);
        };
        poll();
      });
      markWindowsStopStage(timing, "identity");
      expect(tree.pid).toBeDefined();
      expect(unrelated.pid).toBeDefined();
      expect(grandchildPid).toBeDefined();
      expect(control.register({ ...target({ id: "real-tree", pid: tree.pid!, processStartTime: identity.processStartTime, ownerUid: identity.ownerUid, ownerIdentity: identity.ownerIdentity, ownerSid: identity.ownerSid, executable: identity.executable, exclusive: true }) })).toBe(true);
      markWindowsStopStage(timing, "registration");
      const outcome = await control.cancel({ ...target({ id: "real-tree", pid: tree.pid!, processStartTime: identity.processStartTime, ownerUid: identity.ownerUid, ownerIdentity: identity.ownerIdentity, ownerSid: identity.ownerSid, executable: identity.executable, exclusive: true }) }, true);
      markWindowsStopStage(timing, "cancelAndVerification");
      if (process.platform === "win32") console.info(`TOKEN_FURNACE_WINDOWS_STOP_OUTCOME ${JSON.stringify(outcome)}`);
      expect(outcome.status, JSON.stringify(outcome)).toBe("terminated");
      await waitForExit(tree);
      expect(control.processIdentity(grandchildPid!)).toBeNull();
      expect(unrelated.exitCode).toBeNull();
    } finally {
      markWindowsStopStage(timing, "cleanupStart");
      control.close();
      if (tree.exitCode === null) tree.kill("SIGKILL");
      if (unrelated.exitCode === null) unrelated.kill("SIGTERM");
      await Promise.all([waitForExit(tree), waitForExit(unrelated)]);
      if (grandchildPid !== null) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already exited */ }
      }
      markWindowsStopStage(timing, "cleanupDone");
      emitWindowsStopTiming(timing);
    }
  }, 20_000);

  it("reloads durable owned registrations for a later preview", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-"));
    try {
      const statePath = join(root, "control.json");
      const inspect = (pid: number) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE });
      const first = makeControl({ statePath, inspect, currentUid: 7, currentPid: 9000 });
      expect(first.register(target({ pid: 4321, exclusive: true }))).toBe(true);
      first.close();
      const second = makeControl({ statePath, inspect, currentUid: 7, currentPid: 9000 });
      expect(second.discover({ kind: "source", source: "claude" }).map((item) => item.id)).toEqual(["session-1"]);
      second.close();
    } finally {
      closeControls();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads registrations written after construction and merges concurrent writers", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-live-"));
    try {
      const storePath = join(root, "control.sqlite");
      const inspect = (pid: number) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE });
      const serverStartedFirst = makeControl({ storePath, inspect, currentUid: 7, currentPid: 9000 });
      const hookOne = makeControl({ storePath, inspect, currentUid: 7, currentPid: 9001 });
      const hookTwo = makeControl({ storePath, inspect, currentUid: 7, currentPid: 9002 });
      expect(hookOne.register(target({ id: "hook-one", pid: 4321 }))).toBe(true);
      expect(hookTwo.register(target({ id: "hook-two", pid: 4322 }))).toBe(true);
      expect(serverStartedFirst.discover({ kind: "source", source: "claude" }).map((item) => item.id)).toEqual(["hook-one", "hook-two"]);
      serverStartedFirst.close(); hookOne.close(); hookTwo.close();
    } finally {
      closeControls();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads registrations from concurrent real hook processes after the server starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-hooks-"));
    const storePath = join(root, "state", "token-furnace", "control.sqlite");
    const cliPath = join(process.cwd(), "dist", "cli.js");
    const nativeWorkers = [
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "claude"], { stdio: "ignore" }),
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "claude"], { stdio: "ignore" }),
    ];
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const control = makeControl({
      env: { ...process.env, HOME: root, TOKEN_FURNACE_STATE_HOME: join(root, "state") },
      storePath,
      currentUid,
    });
    try {
      expect(existsSync(cliPath)).toBe(true);
      const pids = nativeWorkers.map((worker) => worker.pid);
      expect(pids.every((pid): pid is number => typeof pid === "number")).toBe(true);
      const runHook = (pid: number, sessionId: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const hook = spawn(process.execPath, [cliPath, "hook", "budget", "--source", "claude"], {
          env: {
            ...process.env,
            HOME: root,
            TOKEN_FURNACE_STATE_HOME: join(root, "state"),
            TOKEN_FURNACE_CONFIG_HOME: join(root, "config"),
            TOKEN_FURNACE_CACHE_HOME: join(root, "cache"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        hook.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        hook.on("error", reject);
        hook.on("close", (code) => resolve({ code, output }));
        hook.stdin?.end(JSON.stringify({
          provider: "anthropic",
          model: "claude-opus",
          pid,
          session_id: sessionId,
          exclusive: true,
        }));
      });
      const results = await Promise.all(pids.map((pid, index) => runHook(pid!, `real-hook-${index}`)));
      expect(results.every((result) => result.code === 0 && /"allow":true/.test(result.output))).toBe(true);
      expect(control.discover({ kind: "source", source: "claude" }).map((item) => item.id)).toEqual(["real-hook-0", "real-hook-1"]);
    } finally {
      control.close();
      for (const worker of nativeWorkers) if (worker.exitCode === null) worker.kill("SIGKILL");
      await Promise.all(nativeWorkers.map(waitForExit));
      closeControls();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("initializes cold shared budget and control stores for concurrent hook processes", async () => {
    const cliPath = join(process.cwd(), "dist", "cli.js");
    expect(existsSync(cliPath)).toBe(true);
    for (let batch = 0; batch < 5; batch++) {
      const root = mkdtempSync(join(tmpdir(), "tf-control-cold-hooks-"));
      const state = join(root, "state");
      const config = join(root, "config");
      const cache = join(root, "cache");
      const environment = { ...process.env, HOME: root, TOKEN_FURNACE_STATE_HOME: state, TOKEN_FURNACE_CONFIG_HOME: config, TOKEN_FURNACE_CACHE_HOME: cache };
      const nativeWorkers = [
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "claude"], { env: environment, stdio: "ignore" }),
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "claude"], { env: environment, stdio: "ignore" }),
      ];
      try {
        const pids = nativeWorkers.map((worker) => worker.pid);
        expect(pids.every((pid): pid is number => typeof pid === "number")).toBe(true);
        const runHook = (pid: number, sessionId: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const hook = spawn(process.execPath, [cliPath, "hook", "budget", "--source", "claude"], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          const timeout = setTimeout(() => { hook.kill("SIGTERM"); reject(new Error(`cold hook timed out: ${sessionId}`)); }, 10_000);
          hook.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
          hook.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          hook.on("error", (error) => { clearTimeout(timeout); reject(error); });
          hook.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
          hook.stdin?.end(JSON.stringify({ provider: "anthropic", model: "claude-opus", pid, session_id: sessionId, exclusive: true }));
        });
        const results = await Promise.all(pids.map((pid, index) => runHook(pid!, `cold-hook-${batch}-${index}`)));
        const failures = results.filter((result) => result.code !== 0 || !/"allow":true/.test(result.stdout));
        if (failures.length) {
          throw new Error(failures.map((failure) => `cold hook failed: exit=${failure.code} stdout=${failure.stdout} stderr=${failure.stderr}`).join("\n"));
        }
      } finally {
        for (const worker of nativeWorkers) if (worker.exitCode === null) worker.kill("SIGKILL");
        await Promise.all(nativeWorkers.map(waitForExit));
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it("reports same-user unmanaged native executables as unresolved instead of signalling them", () => {
    const identity: ProcessIdentity = { pid: 4321, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: "/usr/local/bin/claude" };
    const control = makeControl({
      inspect: (pid) => pid === 4321 ? identity : null,
      listProcesses: () => [identity],
      currentUid: 7,
      currentPid: 9000,
      storePath: testStore(),
    });
    const preview = control.preview({ kind: "source", source: "claude" });
    expect(preview.targets).toHaveLength(0);
    expect(preview.unverified[0]?.detail).toMatch(/unmanaged/i);
    control.close();
  });

  it("surfaces control-store write failures as unresolved state", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-control-failure-"));
    try {
      const control = makeControl({
        statePath: root,
        inspect: (pid) => ({ pid, processStartTime: 10, ownerUid: 7, parentPid: 1, executable: TEST_EXECUTABLE }),
        currentUid: 7,
        currentPid: 9000,
      });
      expect(control.register(target())).toBe(false);
      expect(control.preview({ kind: "source", source: "claude" }).unverified.some((item) => item.id === "control-store")).toBe(true);
      control.close();
    } finally {
      closeControls();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
